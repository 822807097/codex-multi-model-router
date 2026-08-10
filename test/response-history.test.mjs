import test from 'node:test';
import assert from 'node:assert/strict';

import { ResponseToolHistoryStore } from '../lib/response-history.mjs';

function response(id, output) {
  return { id, output };
}

function storedEntryBytes(calls, expiresAt) {
  return Buffer.byteLength(JSON.stringify({
    calls: calls.map((call) => [call.call_id, call]),
    expiresAt,
  }), 'utf8');
}

test('按 previous_response_id 在工具结果前恢复缺失调用', () => {
  const store = new ResponseToolHistoryStore();
  store.recordResponse(response('resp_1', [
    { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' },
  ]));
  const restored = store.restoreRequest({
    previous_response_id: 'resp_1',
    input: [
      { type: 'function_call_output', call_id: 'call_1', output: 'const a = 1;' },
    ],
  });
  assert.deepEqual(restored.restoredCallIds, ['call_1']);
  assert.deepEqual(restored.input, [
    { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'const a = 1;' },
  ]);
});

test('请求已包含调用项时不会重复注入', () => {
  const store = new ResponseToolHistoryStore();
  const call = { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: 'patch' };
  store.recordResponse(response('resp_1', [call]));
  const restored = store.restoreRequest({
    previous_response_id: 'resp_1',
    input: [call, { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Done' }],
  });
  assert.equal(restored.restoredCallIds.length, 0);
  assert.equal(restored.input.length, 2);
});

test('previous ID 未命中时不从其他任务恢复同名 call_id', () => {
  const store = new ResponseToolHistoryStore();
  store.recordResponse(response('resp_1', [
    { type: 'tool_search_call', call_id: 'search_1', query: 'gmail', execution: 'client' },
  ]));
  const restored = store.restoreRequest({
    previous_response_id: 'missing',
    input: [{ type: 'tool_search_output', call_id: 'search_1', tools: [] }],
  });
  assert.equal(restored.historyHit, false);
  assert.deepEqual(restored.restoredCallIds, []);
  assert.deepEqual(restored.input, [
    { type: 'tool_search_output', call_id: 'search_1', tools: [] },
  ]);
});

test('缓存遵守 LRU 数量上限和 TTL', () => {
  let now = 1_000;
  const store = new ResponseToolHistoryStore({ maxEntries: 2, ttlMs: 100, now: () => now });
  store.recordResponse(response('resp_1', [{ type: 'function_call', call_id: 'call_1', name: 'a', arguments: '{}' }]));
  store.recordResponse(response('resp_2', [{ type: 'function_call', call_id: 'call_2', name: 'b', arguments: '{}' }]));
  store.get('resp_1'); // 刷新 resp_1，使 resp_2 成为最旧项。
  store.recordResponse(response('resp_3', [{ type: 'function_call', call_id: 'call_3', name: 'c', arguments: '{}' }]));
  assert.equal(store.get('resp_2'), null);
  assert.ok(store.get('resp_1'));
  now += 101;
  assert.equal(store.get('resp_1'), null);
  assert.equal(store.size, 0);
});

test('相同 response id 的跨任务工具历史按强作用域隔离', () => {
  const store = new ResponseToolHistoryStore();
  store.recordResponse({
    id: 'resp_same',
    output: [{ type: 'function_call', call_id: 'call_a', name: 'tool_a', arguments: '{}' }],
  }, ['conversation:task-a']);
  store.recordResponse({
    id: 'resp_same',
    output: [{ type: 'function_call', call_id: 'call_b', name: 'tool_b', arguments: '{}' }],
  }, ['conversation:task-b']);

  const restoredA = store.restoreRequest({
    previous_response_id: 'resp_same',
    input: [{ type: 'function_call_output', call_id: 'call_a', output: 'a' }],
  }, ['conversation:task-a']);
  const restoredB = store.restoreRequest({
    previous_response_id: 'resp_same',
    input: [{ type: 'function_call_output', call_id: 'call_b', output: 'b' }],
  }, ['conversation:task-b']);
  const ambiguous = store.restoreRequest({
    previous_response_id: 'resp_same',
    input: [{ type: 'function_call_output', call_id: 'call_b', output: 'b' }],
  });

  assert.equal(restoredA.input[0].name, 'tool_a');
  assert.equal(restoredB.input[0].name, 'tool_b');
  assert.deepEqual(ambiguous.restoredCallIds, []);
  assert.equal(ambiguous.historyHit, false);
});

test('已有强作用域的 response id 首次被另一作用域引用时不恢复工具历史', () => {
  const store = new ResponseToolHistoryStore();
  store.recordResponse({
    id: 'resp_scoped',
    output: [{ type: 'function_call', call_id: 'call_a', name: 'tool_a', arguments: '{}' }],
  }, ['conversation:task-a']);

  const mismatched = store.restoreRequest({
    previous_response_id: 'resp_scoped',
    input: [{ type: 'function_call_output', call_id: 'call_a', output: 'task-b' }],
  }, ['conversation:task-b']);
  const original = store.restoreRequest({
    previous_response_id: 'resp_scoped',
    input: [{ type: 'function_call_output', call_id: 'call_a', output: 'task-a' }],
  }, ['conversation:task-a']);

  assert.deepEqual(mismatched.restoredCallIds, []);
  assert.equal(mismatched.historyHit, false);
  assert.equal(original.input[0].name, 'tool_a');
});

test('工具历史字节预算有安全默认值', () => {
  const store = new ResponseToolHistoryStore();

  assert.equal(store.maxEntryBytes, 1024 * 1024);
  assert.equal(store.maxBytes, 16 * 1024 * 1024);
  assert.equal(store.bytes, 0);
});

test('单个工具历史按序列化 UTF-8 字节计费并拒绝超限项', () => {
  const now = 1_000;
  const ttlMs = 100;
  const call = {
    type: 'function_call',
    call_id: 'call_utf8',
    name: '读取文件',
    arguments: JSON.stringify({ path: '中文/测试.js' }),
  };
  const bytes = storedEntryBytes([call], now + ttlMs);
  const rejected = new ResponseToolHistoryStore({ maxEntryBytes: bytes - 1, maxBytes: bytes * 2, ttlMs, now: () => now });
  const accepted = new ResponseToolHistoryStore({ maxEntryBytes: bytes, maxBytes: bytes * 2, ttlMs, now: () => now });

  assert.equal(rejected.recordResponse(response('resp_utf8', [call])), false);
  assert.equal(rejected.size, 0);
  assert.equal(rejected.bytes, 0);
  assert.equal(accepted.recordResponse(response('resp_utf8', [call])), true);
  assert.equal(accepted.bytes, bytes);
});

test('全局字节预算超限时按 LRU 淘汰逻辑历史', () => {
  const now = 1_000;
  const ttlMs = 100;
  const makeCall = (suffix) => ({
    type: 'function_call',
    call_id: `call_${suffix}`,
    name: `tool_${suffix}`,
    arguments: '{}',
  });
  const callA = makeCall('a');
  const entryBytes = storedEntryBytes([callA], now + ttlMs);
  const store = new ResponseToolHistoryStore({
    maxEntries: 10,
    maxEntryBytes: entryBytes,
    maxBytes: entryBytes * 2,
    ttlMs,
    now: () => now,
  });

  store.recordResponse(response('resp_a', [callA]));
  store.recordResponse(response('resp_b', [makeCall('b')]));
  store.get('resp_a'); // 刷新 A，使 B 成为字节超限时的最旧项。
  store.recordResponse(response('resp_c', [makeCall('c')]));

  assert.ok(store.get('resp_a'));
  assert.equal(store.get('resp_b'), null);
  assert.ok(store.get('resp_c'));
  assert.ok(store.bytes <= store.maxBytes);
});

test('base、歧义与 scoped 引用精确计费且 TTL 清理不泄漏', () => {
  let now = 1_000;
  const ttlMs = 100;
  const callA = { type: 'function_call', call_id: 'call_a', name: 'tool_a', arguments: '{}' };
  const callB = { type: 'function_call', call_id: 'call_b', name: 'tool_b', arguments: '{}' };
  const store = new ResponseToolHistoryStore({ maxBytes: 1024 * 1024, ttlMs, now: () => now });

  store.recordResponse(response('resp_same', [callA]), ['conversation:task-a']);
  assert.equal(store.size, 2);
  assert.equal(store.entrySizes.size, 1); // base 与 scoped 共享同一逻辑 entry，不重复计费。

  store.recordResponse(response('resp_same', [callB]), ['conversation:task-b']);
  assert.equal(store.size, 3);
  assert.equal(store.entrySizes.size, 3);
  assert.equal(store.bytes, [...store.entrySizes.values()].reduce((sum, bytes) => sum + bytes, 0));

  now += ttlMs + 1;
  assert.equal(store.size, 0);
  assert.equal(store.bytes, 0);
});

test('超长 response id 与会话作用域只以固定长度内部键持久化', () => {
  const responseId = `resp_${'r'.repeat(100_000)}`;
  const scopeKey = `conversation:${'s'.repeat(100_000)}`;
  const call = { type: 'function_call', call_id: 'call_long_key', name: 'safe_tool', arguments: '{}' };
  const store = new ResponseToolHistoryStore({ maxEntryBytes: 512 * 1024, maxBytes: 1024 * 1024 });

  assert.equal(store.recordResponse(response(responseId, [call]), [scopeKey]), true);
  const restored = store.restoreRequest({
    previous_response_id: responseId,
    input: [{ type: 'function_call_output', call_id: 'call_long_key', output: 'ok' }],
  }, [scopeKey]);

  assert.equal(restored.input[0].name, 'safe_tool');
  assert.ok([...store.entries.keys()].every((key) => /^history:[a-f0-9]{64}$/.test(key)));
  assert.ok([...store.entries.keys()].every((key) => !key.includes(responseId) && !key.includes(scopeKey)));
  assert.ok([...store.entries.values()].every((entry) => !JSON.stringify(entry).includes(responseId)));
});

test('歧义哨兵按 LRU 晚于 scoped 历史淘汰，后续同名 ID 不得变回唯一', () => {
  const store = new ResponseToolHistoryStore({ maxEntries: 3 });
  const call = (suffix) => ({
    type: 'function_call',
    call_id: `call_${suffix}`,
    name: `tool_${suffix}`,
    arguments: '{}',
  });

  store.recordResponse(response('resp_same', [call('a')]), ['conversation:task-a']);
  store.recordResponse(response('resp_same', [call('b')]), ['conversation:task-b']);
  store.get('resp_same', ['conversation:task-b']);
  store.recordResponse(response('resp_other_1', [call('other_1')]));
  store.recordResponse(response('resp_other_2', [call('other_2')]));
  store.get('resp_same', ['conversation:task-b']);
  store.recordResponse(response('resp_same', [call('c')]));

  assert.equal(store.get('resp_same'), null);
});

test('缺少强作用域时重复 response id 不得把后一次工具调用当作唯一历史', () => {
  const store = new ResponseToolHistoryStore();
  store.recordResponse(response('resp_duplicate', [
    { type: 'function_call', call_id: 'call_a', name: 'tool_a', arguments: '{}' },
  ]));
  store.recordResponse(response('resp_duplicate', [
    { type: 'function_call', call_id: 'call_b', name: 'tool_b', arguments: '{}' },
  ]));

  assert.equal(store.get('resp_duplicate'), null);
});
