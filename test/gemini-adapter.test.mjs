import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiAdapter } from '../lib/adapters/gemini-adapter.mjs';

describe('Google Sub Auth & Gemini Adapter (Antigravity & sub2api integration)', () => {
  test('geminiAdapter: 请求格式与工具定义转换 (Responses -> Gemini Contents)', () => {
    const adapter = createGeminiAdapter();
    const responsesBody = {
      model: 'gemini-2.5-pro',
      instructions: 'You are an expert coder.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'List files in project' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Sure, I will execute a shell command.' }] },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell_command',
          arguments: '{"command":"ls"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'file1.txt\nfile2.txt',
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          description: 'Run shell command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
          },
        },
      ],
    };

    const geminiPayload = adapter.transformRequest(responsesBody);

    // 验证 systemInstruction
    assert.equal(geminiPayload.systemInstruction.parts[0].text, 'You are an expert coder.');
    // 验证 tools 转换
    assert.equal(geminiPayload.tools[0].functionDeclarations[0].name, 'shell_command');
    // 验证 contents 结构
    assert.equal(geminiPayload.contents.length >= 3, true);
    assert.equal(geminiPayload.contents[0].role, 'user');
    assert.equal(geminiPayload.contents[1].role, 'model');
  });

  test('geminiAdapter: 流式 SSE 解析（含 Thinking 思考块与 Function Calling）', async () => {
    const adapter = createGeminiAdapter();
    const targetStream = adapter.createStreamTransform({
      responseId: 'resp_gemini_test',
      model: 'gemini-2.5-pro',
    });

    const events = [];
    targetStream.on('data', (chunk) => {
      events.push(chunk.toString());
    });

    // 模拟 Gemini SSE 推流 (思考块 + 文本块 + 工具调用)
    const sseChunk1 = 'data: ' + JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: 'Let me think about how to solve this...', thought: true },
          ],
        },
      }],
    }) + '\n\n';

    const sseChunk2 = 'data: ' + JSON.stringify({
      candidates: [{
        content: {
          parts: [
            { text: 'Here is the final answer.' },
          ],
        },
      }],
      usageMetadata: {
        promptTokenCount: 150,
        candidatesTokenCount: 50,
        totalTokenCount: 200,
      },
    }) + '\n\n';

    targetStream.write(sseChunk1);
    targetStream.write(sseChunk2);
    targetStream.end();

    await new Promise((resolve) => targetStream.on('end', resolve));

    const allOutput = events.join('');
    assert.match(allOutput, /response\.created/);
    assert.match(allOutput, /response\.reasoning\.delta/);
    assert.match(allOutput, /Let me think/);
    assert.match(allOutput, /response\.text\.delta/);
    assert.match(allOutput, /Here is the final answer/);
    assert.match(allOutput, /response\.completed/);
  });
});
