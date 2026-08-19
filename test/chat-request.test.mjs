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

const VALID_CHECKPOINT = `目标
持续完成工具任务

硬性约束
不得丢失未完成调用

已完成
早期工具周期已整理

进行中
继续当前任务

待完成
剩余工具步骤

关键决定
保留最近四个周期

当前工作集
路由请求

失败与原因
无

下一步
执行下一工具`;

function responsesToolCycle(index, output = `工具结果 ${index}`) {
  return [
    {
      type: 'function_call',
      call_id: `call_${index}`,
      name: 'run_task',
      arguments: JSON.stringify({ index }),
    },
    { type: 'function_call_output', call_id: `call_${index}`, output },
  ];
}

function compactionConfig() {
  return {
    goalCheckpoint: { enabled: true, maxOutputTokens: 2_048 },
    modelCapabilities: [{
      match: '^large-model$',
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      safetyRatio: 0.9,
      protocolReserveTokens: 512,
      imageTokens: 2_048,
    }],
  };
}

function emptyCheckpointStore(previous = null) {
  return {
    getTask: () => previous,
    getExact: () => null,
  };
}

test('Chat 请求装配不会重放模型已查看的大型 data image', async () => {
  const currentTarget = target();
  const events = [];
  const builder = createChatRequestBuilder({
    config: { goalCheckpoint: { enabled: false } },
    goalCheckpoints: {},
    proxy: null,
    request: async () => { throw new Error('检查点已关闭，不应调用上游'); },
    flog: (event) => events.push(event),
  });
  const largeImage = `data:image/png;base64,${'a'.repeat(500_000)}`;

  const result = await builder.buildChatRequest({
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '生成并检查图片' }] },
      ...responsesToolCycle(1, [{ type: 'input_image', image_url: largeImage }]),
      { type: 'reasoning', summary: [] },
      ...responsesToolCycle(2),
    ],
  }, currentTarget, resolveProvider(currentTarget), 'large-model', {
    requestId: 'req_image', headers: {}, signal: undefined, timeouts: {},
  });

  const serialized = JSON.stringify(result.request);
  assert.doesNotMatch(serialized, /data:image\/png;base64/);
  assert.match(serialized, /图片.*已.*查看.*省略/);
  assert.ok(Buffer.byteLength(serialized) < 20_000);
  assert.deepEqual(events, [{
    event: 'context.images.compacted',
    request_id: 'req_image',
    model: 'large-model',
    target: 'chat-target',
    wire_api: 'chat',
  }]);
});

test('第五个完整工具周期在硬上下文裁剪前触发检查点并只保留最近四个', async () => {
  const checkpointBodies = [];
  const currentTarget = target();
  const builder = createChatRequestBuilder({
    config: compactionConfig(),
    goalCheckpoints: emptyCheckpointStore(),
    proxy: null,
    request: async ({ body }) => {
      checkpointBodies.push(JSON.parse(body));
      return {
        status: 200,
        bodyText: JSON.stringify({ choices: [{ message: { content: VALID_CHECKPOINT } }] }),
      };
    },
  });
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: '连续执行工具任务' }] },
    ...responsesToolCycle(1),
    ...responsesToolCycle(2),
    ...responsesToolCycle(3),
    ...responsesToolCycle(4),
    ...responsesToolCycle(5),
  ];

  const result = await builder.buildChatRequest({ input }, currentTarget,
    resolveProvider(currentTarget), 'large-model', {
      taskKey: 'task:tool-cycles', requestId: 'req_cycles', requestSequence: 1,
      headers: {}, signal: undefined, timeouts: {},
    });

  assert.equal(checkpointBodies.length, 1);
  assert.match(checkpointBodies[0].messages[1].content, /工具结果 1/);
  assert.equal(result.checkpointInfo?.persistCheckpoint, true);
  assert.deepEqual(
    result.request.messages
      .filter((message) => message.role === 'assistant' && message.tool_calls)
      .map((message) => message.tool_calls[0].id),
    ['call_2', 'call_3', 'call_4', 'call_5'],
  );
  assert.equal(result.request.messages.some((message) => message.content === result.checkpointInfo.checkpoint), true);
});

test('主动工具周期检查点失败时回退完整历史且不丢失任何周期', async () => {
  let checkpointRequests = 0;
  const currentTarget = target();
  const builder = createChatRequestBuilder({
    config: compactionConfig(),
    goalCheckpoints: emptyCheckpointStore(VALID_CHECKPOINT),
    proxy: null,
    request: async () => {
      checkpointRequests += 1;
      throw new Error('checkpoint unavailable');
    },
  });
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: '连续执行工具任务' }] },
    ...responsesToolCycle(1),
    ...responsesToolCycle(2),
    ...responsesToolCycle(3),
    ...responsesToolCycle(4),
    ...responsesToolCycle(5),
  ];

  const result = await builder.buildChatRequest({ input }, currentTarget,
    resolveProvider(currentTarget), 'large-model', {
      taskKey: 'task:tool-cycles', requestId: 'req_fallback',
      headers: {}, signal: undefined, timeouts: {},
    });

  assert.equal(checkpointRequests, 1);
  assert.equal(result.checkpointInfo, null);
  assert.deepEqual(
    result.request.messages
      .filter((message) => message.role === 'assistant' && message.tool_calls)
      .map((message) => message.tool_calls[0].id),
    ['call_1', 'call_2', 'call_3', 'call_4', 'call_5'],
  );
});

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

test('跨模型历史未超过目标模型预算时保留全部兼容轮次且不请求检查点', async () => {
  let checkpointRequests = 0;
  const currentTarget = target({ name: 'switched-target' });
  const builder = createChatRequestBuilder({
    config: {
      goalCheckpoint: { enabled: true },
      modelCapabilities: [{
        match: '^switched-model$',
        contextWindow: 8_000,
        maxOutputTokens: 1_000,
        safetyRatio: 0.9,
        protocolReserveTokens: 100,
      }],
    },
    goalCheckpoints: {},
    proxy: null,
    request: async () => { checkpointRequests += 1; throw new Error('不应请求检查点'); },
  });
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: '最初目标' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: '上一模型已完成分析' }] },
    { role: 'user', content: [{ type: 'input_text', text: '切换模型后继续' }] },
  ];

  const result = await builder.buildChatRequest({ input }, currentTarget,
    resolveProvider(currentTarget), 'switched-model', {
      taskKey: 'header:same-task',
      headers: {}, signal: undefined, timeouts: {},
    });

  assert.deepEqual(result.request.messages
    .filter(({ role }) => role !== 'system')
    .map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '最初目标' },
    { role: 'assistant', content: '上一模型已完成分析' },
    { role: 'user', content: '切换模型后继续' },
  ]);
  assert.equal(result.checkpointInfo, null);
  assert.equal(checkpointRequests, 0);
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
    tokens: 133,
    budget: 620,
  }]);
});
