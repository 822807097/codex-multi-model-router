import test from 'node:test';
import assert from 'node:assert/strict';

import { createVisionRelay } from '../lib/vision-relay.mjs';

function relayConfig(overrides = {}) {
  return {
    host: 'vision.example.test',
    prefix: '/v1',
    model: 'vision-model',
    envKey: 'VISION_KEY',
    viaProxy: false,
    concurrency: 1,
    maxImagesPerRequest: 2,
    cacheMaxEntries: 8,
    cacheMaxBytes: 4096,
    maxTokens: 300,
    ...overrides,
  };
}

test('视觉中继只替换用户和工具图片并对单请求图片数执行上限', async () => {
  const requests = [];
  const relay = createVisionRelay({
    config: relayConfig(),
    proxy: { host: '127.0.0.1', port: 10808 },
    timeouts: { requestMs: 1000 },
    getKey: (name) => name === 'VISION_KEY' ? 'test-key' : undefined,
    request: async (options) => {
      requests.push(options);
      return {
        status: 200,
        bodyText: JSON.stringify({ choices: [{ message: { content: `caption-${requests.length}` } }] }),
      };
    },
  });
  const body = {
    input: [
      { role: 'user', content: [
        { type: 'input_text', text: '看图' },
        { type: 'input_image', image_url: 'data:image/png;base64,one' },
      ] },
      { role: 'assistant', content: [
        { type: 'input_image', image_url: 'data:image/png;base64,assistant' },
      ] },
      { type: 'function_call_output', output: [
        { type: 'input_image', image_url: { url: 'data:image/png;base64,two' } },
        { type: 'input_image', image_url: 'data:image/png;base64,three' },
      ] },
    ],
  };

  const stripped = await relay.relayNonTextParts(body);

  assert.equal(stripped, 3);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].host, 'vision.example.test');
  assert.equal(requests[0].headers.authorization, 'Bearer test-key');
  assert.deepEqual(body.input[0].content[1], {
    type: 'input_text',
    text: '[image description: caption-1]',
  });
  assert.equal(body.input[1].content[0].type, 'input_image');
  assert.deepEqual(body.input[2].output[1], {
    type: 'input_text',
    text: '[image omitted: per-request vision limit exceeded]',
  });
});

test('同一图片的并发请求共享一次视觉调用', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const relay = createVisionRelay({
    config: relayConfig(),
    proxy: null,
    timeouts: {},
    getKey: () => 'test-key',
    request: async () => {
      calls += 1;
      await pending;
      return {
        status: 200,
        bodyText: JSON.stringify({ choices: [{ message: { content: 'shared' } }] }),
      };
    },
  });
  const first = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'same' }] }] };
  const second = structuredClone(first);

  const firstPending = relay.relayNonTextParts(first);
  const secondPending = relay.relayNonTextParts(second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([firstPending, secondPending]);
  assert.equal(calls, 1);
});

test('多端点：第一端点额度耗尽自动冷却并切换第二端点', async () => {
  const calls = [];
  const relay = createVisionRelay({
    config: relayConfig({
      endpoints: [
        { host: 'ep1.example.test', prefix: '/v1', model: 'vision-a', envKey: 'VISION_KEY' },
        { host: 'ep2.example.test', prefix: '/v1', model: 'vision-b', envKey: 'VISION_KEY' },
      ],
    }),
    proxy: { host: '127.0.0.1', port: 10808 },
    timeouts: { requestMs: 1000 },
    getKey: () => 'test-key',
    request: async (options) => {
      calls.push(options.host);
      if (options.host === 'ep1.example.test') {
        return { status: 429, bodyText: '{"error":{"message":"insufficient_quota: 5-hour usage limit reached"}}' };
      }
      return { status: 200, bodyText: '{"choices":[{"message":{"content":"ep2 描述"}}]}' };
    },
  });
  const body = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: { url: 'https://x.test/a.png' } }] }] };
  const stripped = await relay.relayNonTextParts(body, new AbortController().signal);
  assert.equal(stripped, 1);
  assert.deepEqual(calls, ['ep1.example.test', 'ep2.example.test'], '先试端点1，额度失败后切端点2');
  const content = body.input[0].content[0];
  assert.equal(content.type, 'input_text');
  assert.match(content.text, /ep2 描述/);

  // 端点1 已冷却：下一次请求直接走端点2
  const body2 = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: { url: 'https://x.test/b.png' } }] }] };
  await relay.relayNonTextParts(body2, new AbortController().signal);
  assert.equal(calls[calls.length - 1], 'ep2.example.test', '冷却中的端点不再尝试');

  // 端点状态查询：端点1 冷却中
  const status = relay.endpointStatus();
  assert.equal(status[0].cooldown, true);
  assert.equal(status[1].cooldown, false);
});

test('多端点：全部失败时抛出聚合错误且不污染缓存', async () => {
  const relay = createVisionRelay({
    config: relayConfig({
      endpoints: [
        { host: 'ep1.example.test', prefix: '/v1', model: 'vision-a', envKey: 'VISION_KEY' },
        { host: 'ep2.example.test', prefix: '/v1', model: 'vision-b', envKey: 'VISION_KEY' },
      ],
    }),
    proxy: { host: '127.0.0.1', port: 10808 },
    timeouts: { requestMs: 1000 },
    getKey: () => 'test-key',
    request: async () => ({ status: 500, bodyText: '{"error":"boom"}' }),
  });
  const body = { input: [{ role: 'user', content: [{ type: 'input_image', image_url: { url: 'https://x.test/c.png' } }] }] };
  await relay.relayNonTextParts(body, new AbortController().signal);
  // 失败降级为占位文本（不抛给上层）
  assert.equal(body.input[0].content[0].type, 'input_text');
  assert.match(body.input[0].content[0].text, /omitted/);
  // 网络类错误不进入额度冷却，端点仍可用
  const status = relay.endpointStatus();
  assert.equal(status[0].cooldown, false);
  assert.equal(status[1].cooldown, false);
});

test('chat completions messages 格式：图片同样走视觉中继转换', async () => {
  const requests = [];
  const relay = createVisionRelay({
    config: relayConfig(),
    proxy: { host: '127.0.0.1', port: 10808 },
    timeouts: { requestMs: 1000 },
    getKey: () => 'test-key',
    request: async (options) => {
      requests.push(options);
      return {
        status: 200,
        bodyText: JSON.stringify({ choices: [{ message: { content: 'chat-caption' } }] }),
      };
    },
  });
  const body = {
    messages: [
      { role: 'user', content: '纯文本' },
      { role: 'user', content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,chat-one' } },
      ] },
      { role: 'assistant', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,chat-two' } },
      ] },
    ],
  };

  const stripped = await relay.relayNonTextParts(body);

  assert.equal(stripped, 2);
  assert.equal(requests.length, 2);
  // 字符串 content 的纯文本消息不得被破坏
  assert.equal(body.messages[0].content, '纯文本');
  // 图片被替换为描述文本（chat 格式用 text 类型保持格式一致）
  assert.equal(body.messages[1].content[1].type, 'text');
  assert.match(body.messages[1].content[1].text, /chat-caption/);
  assert.equal(body.messages[2].content[0].type, 'text');
});
