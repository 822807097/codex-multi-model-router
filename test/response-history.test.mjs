import test from 'node:test';
import assert from 'node:assert/strict';

import { ResponseToolHistoryStore } from '../lib/response-history.mjs';

function response(id, output) {
  return { id, output };
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

test('previous ID 不存在时仅用唯一 call_id 兜底', () => {
  const store = new ResponseToolHistoryStore();
  store.recordResponse(response('resp_1', [
    { type: 'tool_search_call', call_id: 'search_1', query: 'gmail', execution: 'client' },
  ]));
  const restored = store.restoreRequest({
    previous_response_id: 'missing',
    input: [{ type: 'tool_search_output', call_id: 'search_1', tools: [] }],
  });
  assert.deepEqual(restored.restoredCallIds, ['search_1']);
  assert.equal(restored.input[0].type, 'tool_search_call');

  store.recordResponse(response('resp_2', [
    { type: 'tool_search_call', call_id: 'search_1', query: 'other', execution: 'client' },
  ]));
  const ambiguous = store.restoreRequest({
    previous_response_id: 'missing',
    input: [{ type: 'tool_search_output', call_id: 'search_1', tools: [] }],
  });
  assert.deepEqual(ambiguous.restoredCallIds, []);
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
