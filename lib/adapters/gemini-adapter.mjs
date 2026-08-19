import { Transform } from 'node:stream';

/**
 * Google Gemini 协议适配器
 * 吸收 Antigravity Tools 与 sub2api 的双向协议映射与 Thinking / Tool 调用设计
 */

const MODEL_MAP = {
  'gemini-2.5-pro': 'models/gemini-2.5-pro',
  'gemini-2.5-flash': 'models/gemini-2.5-flash',
  'gemini-3.7-thinking': 'models/gemini-2.5-pro',
  'gemini-1.5-pro': 'models/gemini-1.5-pro',
  'gemini-1.5-flash': 'models/gemini-1.5-flash',
};

export function createGeminiAdapter(options = {}) {
  /**
   * 将 Codex Responses 请求体转为 Gemini generateContent 载荷
   */
  function transformRequest(responsesBody) {
    const rawModel = responsesBody.model || 'gemini-2.5-pro';
    const targetModel = MODEL_MAP[rawModel] || rawModel;

    const payload = {
      contents: [],
    };

    // 系统提示词
    if (responsesBody.instructions) {
      payload.systemInstruction = {
        parts: [{ text: String(responsesBody.instructions) }],
      };
    }

    // 工具转换
    const tools = Array.isArray(responsesBody.tools) ? responsesBody.tools : [];
    if (tools.length > 0) {
      const functionDeclarations = [];
      for (const t of tools) {
        if (t.type === 'function' || t.name) {
          functionDeclarations.push({
            name: t.name || t.function?.name,
            description: t.description || t.function?.description || '',
            parameters: t.parameters || t.function?.parameters || { type: 'object' },
          });
        }
      }
      if (functionDeclarations.length > 0) {
        payload.tools = [{ functionDeclarations }];
      }
    }

    // 对话历史
    const input = Array.isArray(responsesBody.input) ? responsesBody.input : [];
    let pendingFunctionName = 'tool';

    for (const item of input) {
      if (item.role === 'user') {
        const parts = [];
        if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'input_text' || c.type === 'text') {
              parts.push({ text: c.text });
            } else if (c.type === 'input_image' || c.type === 'image_url') {
              // 多模态图片支持
              parts.push({
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: c.image_url?.url?.replace(/^data:image\/[a-z]+;base64,/, '') || '',
                },
              });
            }
          }
        } else if (typeof item.content === 'string') {
          parts.push({ text: item.content });
        }
        if (parts.length > 0) payload.contents.push({ role: 'user', parts });
      } else if (item.role === 'assistant') {
        const parts = [];
        if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.type === 'output_text' || c.type === 'text') {
              parts.push({ text: c.text });
            }
          }
        } else if (typeof item.content === 'string') {
          parts.push({ text: item.content });
        }
        if (parts.length > 0) payload.contents.push({ role: 'model', parts });
      } else if (item.type === 'function_call') {
        pendingFunctionName = item.name || 'tool';
        let args = {};
        try {
          args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
        } catch { /* 容错 */ }
        payload.contents.push({
          role: 'model',
          parts: [{ functionCall: { name: item.name, args } }],
        });
      } else if (item.type === 'function_call_output') {
        payload.contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: pendingFunctionName,
              response: { content: item.output },
            },
          }],
        });
      }
    }

    return payload;
  }

  /**
   * 创建流式转换器：Gemini SSE -> Codex Responses SSE
   */
  function createStreamTransform(context = {}) {
    const responseId = context.responseId || `resp_gemini_${Date.now()}`;
    const model = context.model || 'gemini-2.5-pro';
    const messageId = `msg_gemini_${Date.now()}`;
    const reasoningId = `rs_gemini_${Date.now()}`;

    let buffer = '';
    let started = false;
    let textItemAdded = false;
    let reasoningItemAdded = false;
    let accumulatedText = '';
    let accumulatedReasoning = '';
    let functionCallItems = [];
    let usageMetadata = null;

    const transform = new Transform({
      transform(chunk, encoding, callback) {
        buffer += chunk.toString('utf8');

        if (!started) {
          started = true;
          this.push(`data: ${JSON.stringify({
            type: 'response.created',
            response: { id: responseId, status: 'in_progress', model },
          })}\n\n`);
        }

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
              if (data.usageMetadata) usageMetadata = data.usageMetadata;

              const candidate = data.candidates?.[0];
              const parts = candidate?.content?.parts || [];

              for (const part of parts) {
                // 1. Thinking 思考过程
                if (part.thought && part.text) {
                  if (!reasoningItemAdded) {
                    reasoningItemAdded = true;
                    this.push(`data: ${JSON.stringify({
                      type: 'response.output_item.added',
                      output_index: 0,
                      item: { id: reasoningId, type: 'reasoning', content: [] },
                    })}\n\n`);
                  }
                  accumulatedReasoning += part.text;
                  this.push(`data: ${JSON.stringify({
                    type: 'response.reasoning.delta',
                    item_id: reasoningId,
                    output_index: 0,
                    content_index: 0,
                    delta: part.text,
                  })}\n\n`);
                }
                // 2. 普通回答文本
                else if (part.text) {
                  if (!textItemAdded) {
                    textItemAdded = true;
                    const outputIdx = reasoningItemAdded ? 1 : 0;
                    this.push(`data: ${JSON.stringify({
                      type: 'response.output_item.added',
                      output_index: outputIdx,
                      item: { id: messageId, type: 'message', role: 'assistant', content: [] },
                    })}\n\n`);
                  }
                  accumulatedText += part.text;
                  const outputIdx = reasoningItemAdded ? 1 : 0;
                  this.push(`data: ${JSON.stringify({
                    type: 'response.text.delta',
                    item_id: messageId,
                    output_index: outputIdx,
                    content_index: 0,
                    delta: part.text,
                  })}\n\n`);
                }
                // 3. 函数/工具调用
                else if (part.functionCall) {
                  const callId = `call_${Date.now()}_${functionCallItems.length}`;
                  const fcItem = {
                    type: 'function_call',
                    call_id: callId,
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {}),
                  };
                  functionCallItems.push(fcItem);
                  const outputIdx = (reasoningItemAdded ? 1 : 0) + (textItemAdded ? 1 : 0) + (functionCallItems.length - 1);
                  this.push(`data: ${JSON.stringify({
                    type: 'response.output_item.added',
                    output_index: outputIdx,
                    item: fcItem,
                  })}\n\n`);
                }
              }
            } catch {
              // 容错忽略单个不合法 JSON
            }
          }
        }
        callback();
      },

      flush(callback) {
        const usage = {
          input_tokens: usageMetadata?.promptTokenCount || Math.ceil(accumulatedReasoning.length / 4),
          output_tokens: usageMetadata?.candidatesTokenCount || Math.ceil(accumulatedText.length / 4),
          reasoning_tokens: Math.ceil(accumulatedReasoning.length / 4),
          total_tokens: usageMetadata?.totalTokenCount || (Math.ceil(accumulatedText.length / 4) + Math.ceil(accumulatedReasoning.length / 4)),
        };

        const outputList = [];
        if (reasoningItemAdded) {
          outputList.push({
            id: reasoningId,
            type: 'reasoning',
            content: [{ type: 'text', text: accumulatedReasoning }],
          });
        }
        if (textItemAdded) {
          this.push(`data: ${JSON.stringify({
            type: 'response.text.done',
            item_id: messageId,
            output_index: reasoningItemAdded ? 1 : 0,
            content_index: 0,
            text: accumulatedText,
          })}\n\n`);
          outputList.push({
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: accumulatedText }],
          });
        }
        for (const fc of functionCallItems) {
          outputList.push(fc);
        }

        const completedEvent = {
          type: 'response.completed',
          response: {
            id: responseId,
            status: 'completed',
            model,
            output: outputList,
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
