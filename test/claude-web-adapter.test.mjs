import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createClaudeWebAdapter } from '../lib/adapters/claude-web-adapter.mjs';

describe('Claude Sub Auth & Web Adapter', () => {
  test('claudeWebAdapter: 请求格式转换（Responses 请求转 Claude Web payload）', () => {
    const adapter = createClaudeWebAdapter();
    const responsesBody = {
      model: 'claude-3.7-sonnet',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Hello Claude' }] },
      ],
      tools: [
        {
          type: 'function',
          name: 'shell_command',
          description: 'run shell',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    };

    const claudePayload = adapter.transformRequest(responsesBody);
    assert.match(claudePayload.prompt, /Hello Claude/);
    assert.equal(claudePayload.model, 'claude-3-7-sonnet-20250219');
    // 工具定义被转换并注入提示词或工具列表
    assert.ok(claudePayload.prompt.includes('shell_command') || claudePayload.tools?.length > 0);
  });

  test('claudeWebAdapter: 流式 SSE 解析并转换为 Codex Responses SSE', async () => {
    const adapter = createClaudeWebAdapter();
    const mockClaudeStream = new EventEmitter();

    const outputEvents = [];
    const targetStream = adapter.createStreamTransform({
      responseId: 'resp_claude_1',
      model: 'claude-3.7-sonnet',
    });

    targetStream.on('data', (chunk) => {
      outputEvents.push(chunk.toString());
    });

    // 模拟 Claude Web SSE 事件推流
    targetStream.write('event: completion\ndata: {"completion": "Hello "}\n\n');
    targetStream.write('event: completion\ndata: {"completion": "World!"}\n\n');
    targetStream.write('event: completion\ndata: {"completion": "", "stop_reason": "stop_sequence"}\n\n');
    targetStream.end();

    await new Promise((resolve) => targetStream.on('end', resolve));

    const combined = outputEvents.join('');
    assert.match(combined, /response\.created/);
    assert.match(combined, /response\.output_item\.added/);
    assert.match(combined, /response\.text\.delta/);
    assert.match(combined, /response\.completed/);
    assert.match(combined, /Hello /);
    assert.match(combined, /World!/);
  });
});
