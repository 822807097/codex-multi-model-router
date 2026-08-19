import { Transform } from 'node:stream';

/**
 * Claude Web 协议适配器
 * 负责将 Codex Responses API 请求双向转换为 Claude Web 网页端协议
 */

const MODEL_MAP = {
  'claude-3.7-sonnet': 'claude-3-7-sonnet-20250219',
  'claude-3-7-sonnet': 'claude-3-7-sonnet-20250219',
  'claude-3.5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3.5-haiku': 'claude-3-5-haiku-20241022',
  'claude-3-opus': 'claude-3-opus-20240229',
};

export function createClaudeWebAdapter(options = {}) {
  /**
   * 将 Responses 请求体转换为 Claude Web 对话请求体
   */
  function transformRequest(responsesBody) {
    const rawModel = responsesBody.model || 'claude-3.7-sonnet';
    const targetModel = MODEL_MAP[rawModel] || rawModel;

    let fullPrompt = '';
    const input = Array.isArray(responsesBody.input) ? responsesBody.input : [];

    // 处理系统提示词
    if (responsesBody.instructions) {
      fullPrompt += `System: ${responsesBody.instructions}\n\n`;
    }

    // 处理工具声明
    const tools = Array.isArray(responsesBody.tools) ? responsesBody.tools : [];
    if (tools.length > 0) {
      fullPrompt += `\n[Available Tools]:\n${JSON.stringify(tools, null, 2)}\nWhen you need to call a tool, output XML tag <tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>.\n\n`;
    }

    // 组装多轮历史
    for (const item of input) {
      if (item.role === 'user') {
        const text = Array.isArray(item.content)
          ? item.content.map((c) => (c.type === 'input_text' || c.type === 'text' ? c.text : '')).join('')
          : String(item.content || '');
        fullPrompt += `Human: ${text}\n\n`;
      } else if (item.role === 'assistant') {
        const text = Array.isArray(item.content)
          ? item.content.map((c) => (c.type === 'output_text' || c.type === 'text' ? c.text : '')).join('')
          : String(item.content || '');
        fullPrompt += `Assistant: ${text}\n\n`;
      } else if (item.type === 'function_call_output') {
        fullPrompt += `Tool Output (${item.call_id}): ${item.output}\n\n`;
      }
    }

    if (!fullPrompt.endsWith('Assistant: ')) {
      fullPrompt += 'Assistant: ';
    }

    return {
      prompt: fullPrompt,
      model: targetModel,
      timezone: 'Asia/Shanghai',
      attachments: [],
      files: [],
    };
  }

  /**
   * 创建流式转换器：Claude Web SSE -> Codex Responses SSE
   */
  function createStreamTransform(context = {}) {
    const responseId = context.responseId || `resp_claude_${Date.now()}`;
    const model = context.model || 'claude-3.7-sonnet';
    const itemId = `msg_claude_${Date.now()}`;

    let buffer = '';
    let started = false;
    let accumulatedText = '';
    let itemAdded = false;

    const transform = new Transform({
      transform(chunk, encoding, callback) {
        buffer += chunk.toString('utf8');

        // 发送 response.created
        if (!started) {
          started = true;
          this.push(`data: ${JSON.stringify({
            type: 'response.created',
            response: { id: responseId, status: 'in_progress', model },
          })}\n\n`);
        }

        // 解析 SSE 行
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === '[DONE]') continue;
            try {
              const data = JSON.parse(jsonStr);
              const textChunk = data.completion || data.delta?.text || '';

              if (textChunk) {
                if (!itemAdded) {
                  itemAdded = true;
                  this.push(`data: ${JSON.stringify({
                    type: 'response.output_item.added',
                    output_index: 0,
                    item: { id: itemId, type: 'message', role: 'assistant', content: [] },
                  })}\n\n`);
                  this.push(`data: ${JSON.stringify({
                    type: 'response.content_part.added',
                    item_id: itemId,
                    output_index: 0,
                    content_index: 0,
                    part: { type: 'text', text: '' },
                  })}\n\n`);
                }

                accumulatedText += textChunk;
                this.push(`data: ${JSON.stringify({
                  type: 'response.text.delta',
                  item_id: itemId,
                  output_index: 0,
                  content_index: 0,
                  delta: textChunk,
                })}\n\n`);
              }
            } catch {
              // 忽略不可解析的片段
            }
          }
        }
        callback();
      },

      flush(callback) {
        // 完成事件
        const usage = {
          input_tokens: Math.ceil(accumulatedText.length / 4),
          output_tokens: Math.ceil(accumulatedText.length / 4),
          total_tokens: Math.ceil(accumulatedText.length / 2),
        };

        if (itemAdded) {
          this.push(`data: ${JSON.stringify({
            type: 'response.text.done',
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            text: accumulatedText,
          })}\n\n`);
          this.push(`data: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: itemId,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: accumulatedText }],
            },
          })}\n\n`);
        }

        const completedEvent = {
          type: 'response.completed',
          response: {
            id: responseId,
            status: 'completed',
            model,
            output: itemAdded ? [{
              id: itemId,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: accumulatedText }],
            }] : [],
            usage,
          },
        };

        this.push(`data: ${JSON.stringify(completedEvent)}\n\n`);
        this.emit('response', completedEvent.response);
        callback();
      },
    });

    return transform;
  }

  return {
    transformRequest,
    createStreamTransform,
  };
}
