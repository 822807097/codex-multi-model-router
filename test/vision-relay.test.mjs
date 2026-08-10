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
