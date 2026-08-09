import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProviderPool,
  isRetryableProviderFailure,
  requestAffinityKeys,
} from '../lib/provider-pool.mjs';

test('匹配同一模型的供应商按成功结果保持会话粘性', () => {
  const primary = { name: 'primary', match: /^deepseek-/ };
  const backup = { name: 'backup', match: /^deepseek-/ };
  const pool = new ProviderPool([primary, backup]);

  assert.deepEqual(pool.candidates('deepseek-chat', ['thread-1']), [primary, backup]);
  pool.remember(['thread-1'], backup, ['resp_1']);
  assert.deepEqual(pool.candidates('deepseek-chat', ['resp_1', 'thread-1']), [backup, primary]);
});

test('粘性映射遵守 LRU 数量上限和 TTL', () => {
  let now = 1_000;
  const target = { name: 'only', match: /.*/ };
  const pool = new ProviderPool([target], { maxEntries: 2, ttlMs: 100, now: () => now });
  pool.remember(['a'], target);
  pool.remember(['b'], target);
  pool.candidates('x', ['a']);
  pool.remember(['c'], target);
  assert.equal(pool.hasAffinity('b'), false);
  assert.equal(pool.hasAffinity('a'), true);
  now += 101;
  assert.equal(pool.hasAffinity('a'), false);
});

test('failover 仅重试连接/网络类错误、408、429 和 5xx', () => {
  assert.equal(isRetryableProviderFailure({ status: 408 }), true);
  assert.equal(isRetryableProviderFailure({ status: 429 }), true);
  assert.equal(isRetryableProviderFailure({ status: 503 }), true);
  assert.equal(isRetryableProviderFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), true);
  // 无标准错误码的网络/传输类错误消息同样可换腿（超时、响应头前断连、挂起、关键词命中）
  assert.equal(isRetryableProviderFailure(new Error('request timed out after 30000ms')), true);
  assert.equal(isRetryableProviderFailure(new Error('upstream closed before response header')), true);
  assert.equal(isRetryableProviderFailure(new Error('socket hang up')), true);
  assert.equal(isRetryableProviderFailure(new Error('TLS connect failed for api.example.com')), true);
  assert.equal(isRetryableProviderFailure(new Error('ordinary business error')), false);
  assert.equal(isRetryableProviderFailure(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isRetryableProviderFailure({ status: 400 }), false);
  assert.equal(isRetryableProviderFailure({ status: 401 }), false);
  assert.equal(isRetryableProviderFailure({ status: 403 }), false);
  assert.equal(isRetryableProviderFailure(new Error('context length exceeded')), false);
});

test('会话键优先 previous response，同时保留稳定回退键', () => {
  assert.deepEqual(requestAffinityKeys({
    model: 'deepseek-chat',
    previous_response_id: 'resp_1',
    prompt_cache_key: 'cache_1',
    metadata: { conversation_id: 'conversation_1' },
  }, { 'x-codex-session-id': 'header_1' }), [
    'response:resp_1',
    'prompt:cache_1',
    'conversation:conversation_1',
    'header:header_1',
    'model:deepseek-chat',
  ]);
});
