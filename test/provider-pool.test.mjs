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
  // 无标准错误码的网络/传输类错误消息同样可切换备用目标（超时、响应头前断连、挂起、关键词命中）
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

test('会话键优先 previous response，默认不加入跨会话模型键', () => {
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
  ]);
});

test('只有显式启用 modelAffinity 时才加入模型键', () => {
  assert.deepEqual(requestAffinityKeys(
    { model: 'deepseek-chat' },
    {},
    { modelAffinity: true },
  ), ['model:deepseek-chat']);
});

test('未知或空模型默认不选择任何目标', () => {
  const first = { name: 'first', match: /^known$/ };
  const pool = new ProviderPool([first]);

  assert.deepEqual(pool.candidates('missing'), []);
  assert.deepEqual(pool.candidates(''), []);
});

test('仅显式允许时未知模型回退到首个目标', () => {
  const first = { name: 'first', match: /^known$/ };
  const pool = new ProviderPool([first], { allowDefaultTarget: true });

  assert.deepEqual(pool.candidates('missing'), [first]);
  assert.deepEqual(pool.candidates(''), [first]);
});

test('相同 response id 跨供应商碰撞时按强会话作用域解析且无作用域拒绝', () => {
  const targetA = { name: 'a', match: /^model$/ };
  const targetB = { name: 'b', match: /^model$/ };
  const pool = new ProviderPool([targetA, targetB]);

  pool.remember(['conversation:task-a'], targetA, ['response:resp_same']);
  pool.remember(['conversation:task-b'], targetB, ['response:resp_same']);

  assert.equal(pool.getResponseAffinity('response:resp_same', ['conversation:task-a']), targetA);
  assert.equal(pool.getResponseAffinity('response:resp_same', ['conversation:task-b']), targetB);
  assert.equal(pool.getResponseAffinity('response:resp_same', []), null);
  assert.equal(pool.isAffinityAmbiguous('response:resp_same'), true);
});

test('已有强作用域的 response id 首次被另一作用域引用时拒绝 base 回退', () => {
  const target = { name: 'provider-a', match: /^model$/ };
  const pool = new ProviderPool([target]);

  pool.remember(['conversation:task-a'], target, ['response:resp_scoped']);

  assert.equal(pool.getResponseAffinity('response:resp_scoped', ['conversation:task-b']), null);
  assert.equal(pool.isAffinityAmbiguous('response:resp_scoped'), true);
  assert.equal(pool.getResponseAffinity('response:resp_scoped', ['conversation:task-a']), target);
});

test('超长客户端亲和值只以固定长度 SHA-256 内部键写入 Map', () => {
  const target = { name: 'only', match: /^model$/ };
  const pool = new ProviderPool([target]);
  const longValue = 'x'.repeat(100_000);
  const affinityKeys = requestAffinityKeys({
    previous_response_id: `previous-${longValue}`,
    prompt_cache_key: `prompt-${longValue}`,
    metadata: { conversation_id: `conversation-${longValue}` },
  }, { 'x-codex-session-id': `header-${longValue}` });
  const responseAlias = `response:alias-${longValue}`;

  pool.remember(affinityKeys, target, [responseAlias]);

  assert.equal(pool.getAffinity(affinityKeys[0]), target);
  assert.equal(pool.getResponseAffinity(responseAlias, affinityKeys), target);
  assert.deepEqual(pool.candidates('model', [affinityKeys[1]]), [target]);
  const storedKeys = [...pool.affinity.keys()];
  assert.equal(storedKeys.length, affinityKeys.length + 2);
  assert.ok(storedKeys.every((key) => /^affinity:[a-f0-9]{64}$/.test(key)));
  assert.ok(storedKeys.every((key) => !key.includes(longValue)));
});

test('相同值的不同亲和类型使用不同哈希域且查询互不碰撞', () => {
  const promptTarget = { name: 'prompt', match: /^model$/ };
  const conversationTarget = { name: 'conversation', match: /^model$/ };
  const pool = new ProviderPool([promptTarget, conversationTarget]);

  pool.remember(['prompt:same-value'], promptTarget);
  pool.remember(['conversation:same-value'], conversationTarget);

  assert.equal(pool.getAffinity('prompt:same-value'), promptTarget);
  assert.equal(pool.getAffinity('conversation:same-value'), conversationTarget);
  const storedKeys = [...pool.affinity.keys()];
  assert.equal(new Set(storedKeys).size, 2);
  assert.ok(storedKeys.every((key) => /^affinity:[a-f0-9]{64}$/.test(key)));
});

test('作用域命中和 LRU 淘汰不会先丢失 response id 歧义标记', () => {
  const targetA = { name: 'a', match: /^model$/ };
  const targetB = { name: 'b', match: /^model$/ };
  const other = { name: 'other', match: /^model$/ };
  const pool = new ProviderPool([targetA, targetB, other], { maxEntries: 2 });

  pool.remember(['conversation:task-a'], targetA, ['response:resp_same']);
  pool.remember(['conversation:task-b'], targetB, ['response:resp_same']);
  assert.equal(pool.getResponseAffinity('response:resp_same', ['conversation:task-b']), targetB);
  pool.remember(['conversation:other'], other);

  assert.equal(pool.isAffinityAmbiguous('response:resp_same'), true);
  assert.equal(pool.getResponseAffinity('response:resp_same', []), null);
});

test('同一供应商在不同强作用域返回同名 response id 也必须标记歧义', () => {
  const target = { name: 'same-provider', match: /^model$/ };
  const pool = new ProviderPool([target]);

  pool.remember(['conversation:task-a'], target, ['response:resp_same']);
  pool.remember(['conversation:task-b'], target, ['response:resp_same']);

  assert.equal(pool.getResponseAffinity('response:resp_same', ['conversation:task-a']), target);
  assert.equal(pool.getResponseAffinity('response:resp_same', ['conversation:task-b']), target);
  assert.equal(pool.isAffinityAmbiguous('response:resp_same'), true);
  assert.equal(pool.getResponseAffinity('response:resp_same', []), null);
});

test('已解析的 scoped previousTarget 优先于默认候选顺序', () => {
  const fallback = { name: 'fallback', match: /^model$/ };
  const previousTarget = { name: 'previous', match: /^model$/ };
  const pool = new ProviderPool([fallback, previousTarget]);

  assert.deepEqual(pool.candidates('model', [], previousTarget), [previousTarget, fallback]);
});

test('缺少强作用域时同一供应商重复 response id 也按歧义处理', () => {
  const target = { name: 'same-provider', match: /^model$/ };
  const pool = new ProviderPool([target]);

  pool.remember([], target, ['response:resp_duplicate']);
  pool.remember([], target, ['response:resp_duplicate']);

  assert.equal(pool.isAffinityAmbiguous('response:resp_duplicate'), true);
  assert.equal(pool.getResponseAffinity('response:resp_duplicate'), null);
});
