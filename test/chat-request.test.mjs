import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatRequestBuilder } from '../lib/chat-request.mjs';
import { resolveProvider } from '../lib/provider-adapters.mjs';

function target(overrides = {}) {
  return {
    name: 'chat-target',
    host: 'chat.example.test',
    prefix: '/v1',
    wireApi: 'chat',
    platform: 'generic',
    vision: true,
    ...overrides,
  };
}

test('Chat 请求装配独立完成工具转换、模型映射和上下文预算', async () => {
  const config = {
    goalCheckpoint: { enabled: false },
    modelCapabilities: [{
      match: '^public-model$',
      contextWindow: 16_000,
      maxOutputTokens: 1_000,
      safetyRatio: 0.9,
      protocolReserveTokens: 0,
      imageTokens: 100,
    }],
  };
  const currentTarget = target({ upstreamModel: 'vendor-model' });
  const builder = createChatRequestBuilder({
    config,
    goalCheckpoints: {},
    proxy: null,
    request: async () => { throw new Error('检查点已关闭，不应调用上游'); },
  });

  const result = await builder.buildChatRequest({
    model: 'public-model',
    input: [{ role: 'user', content: [{ type: 'input_text', text: '执行任务' }] }],
    tools: [{ type: 'function', name: 'run_task', parameters: { type: 'object' } }],
  }, currentTarget, resolveProvider(currentTarget), 'public-model', {
    headers: {},
    signal: undefined,
    timeouts: {},
  });

  assert.equal(result.request.model, 'vendor-model');
  assert.equal(result.request.messages.at(-1).content, '执行任务');
  assert.equal(result.request.tools[0].function.name, 'run_task');
  assert.equal(result.toolCount, 1);
  assert.equal(result.checkpointInfo, null);
});

test('最新轮次超过输入预算时返回稳定上下文错误码', async () => {
  const config = {
    goalCheckpoint: { enabled: false },
    modelCapabilities: [{
      match: '^tiny$',
      contextWindow: 128,
      maxOutputTokens: 64,
      safetyRatio: 0.5,
      protocolReserveTokens: 0,
      imageTokens: 1,
    }],
  };
  const currentTarget = target();
  const builder = createChatRequestBuilder({
    config,
    goalCheckpoints: {},
    proxy: null,
    request: async () => { throw new Error('不应调用'); },
  });

  await assert.rejects(
    () => builder.buildChatRequest({
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(4000) }] }],
    }, currentTarget, resolveProvider(currentTarget), 'tiny', {
      headers: {},
      signal: undefined,
      timeouts: {},
    }),
    (error) => error.code === 'context_length_exceeded',
  );
});

test('上下文裁剪只写入带请求关联 ID 的结构化诊断字段', async () => {
  const events = [];
  const config = {
    goalCheckpoint: { enabled: false },
    modelCapabilities: [{
      match: '^trim-model$',
      contextWindow: 800,
      maxOutputTokens: 100,
      safetyRatio: 0.9,
      protocolReserveTokens: 0,
      imageTokens: 1,
    }],
  };
  const currentTarget = target();
  const builder = createChatRequestBuilder({
    config,
    goalCheckpoints: {},
    proxy: null,
    request: async () => { throw new Error('检查点已关闭，不应调用上游'); },
    flog: (event) => events.push(event),
  });

  await builder.buildChatRequest({
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '旧问题'.repeat(500) }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '旧回答'.repeat(500) }] },
      { role: 'user', content: [{ type: 'input_text', text: '继续当前任务' }] },
    ],
  }, currentTarget, resolveProvider(currentTarget), 'trim-model', {
    requestId: 'req_trim',
    headers: {},
    signal: undefined,
    timeouts: {},
  });

  assert.deepEqual(events, [{
    event: 'context.trimmed',
    request_id: 'req_trim',
    model: 'trim-model',
    target: 'chat-target',
    wire_api: 'chat',
    groups: 1,
    tokens: 83,
    budget: 620,
  }]);
});
