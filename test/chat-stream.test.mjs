import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createChatSseToResponsesTransform } from '../lib/chat-stream.mjs';

async function convert(chunks, model = 'test-model') {
  const transform = createChatSseToResponsesTransform(model);
  const output = [];
  for await (const chunk of Readable.from(chunks).pipe(transform)) output.push(chunk);
  return Buffer.concat(output).toString('utf8').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .map((payload) => payload === '[DONE]' ? payload : JSON.parse(payload));
}

async function convertWithToolContext(chunks, toolContext, options) {
  const transform = createChatSseToResponsesTransform('test-model', toolContext, options);
  const output = [];
  for await (const chunk of Readable.from(chunks).pipe(transform)) output.push(chunk);
  return Buffer.concat(output).toString('utf8').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .map((payload) => payload === '[DONE]' ? payload : JSON.parse(payload));
}

async function convertRaw(chunks, model = 'test-model') {
  const output = [];
  for await (const chunk of Readable.from(chunks).pipe(createChatSseToResponsesTransform(model))) output.push(chunk);
  return Buffer.concat(output).toString('utf8');
}

test('Chat 文本分片转换为完整 Responses 生命周期', async () => {
  const events = await convert([
    'data: {"id":"chat_1","model":"upstream","choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ]);

  assert.equal(events[0].type, 'response.created');
  assert.deepEqual(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta), ['你', '好']);
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(completed.response.output[0].content[0].text, '你好');
  assert.equal(completed.response.model, 'test-model');
  assert.equal(completed.response.usage.input_tokens, 3);
  assert.equal(events.at(-1), '[DONE]');
});

test('并行 tool_calls 按上游 index 独立重组名称和参数', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read_","arguments":"{\\"path\\":\\""}},{"index":1,"id":"call_b","type":"function","function":{"name":"run","arguments":"{\\"cmd\\":\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"pwd\\"}"}},{"index":0,"function":{"name":"file","arguments":"a.js\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const completed = events.find((event) => event.type === 'response.completed');
  assert.deepEqual(completed.response.output.map((item) => ({
    call_id: item.call_id,
    name: item.name,
    arguments: item.arguments,
  })), [
    { call_id: 'call_a', name: 'read_file', arguments: '{"path":"a.js"}' },
    { call_id: 'call_b', name: 'run', arguments: '{"cmd":"pwd"}' },
  ]);
  assert.deepEqual(events.filter((event) => event.type === 'response.output_item.added').map((event) => event.output_index), [0, 1]);
  assert.equal(events.filter((event) => event.type === 'response.function_call_arguments.done').length, 2);
});

test('上游未发送 DONE 而正常关闭时仍补发 response.completed', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"完成"}}]}\n\n',
  ]);

  const completed = events.find((event) => event.type === 'response.completed');
  assert.ok(completed);
  assert.equal(completed.response.status, 'incomplete');
  assert.deepEqual(completed.response.incomplete_details, { reason: 'max_output_tokens' });
  assert.deepEqual(completed.response.output.map((item) => item.type), ['reasoning', 'message']);
  assert.deepEqual(completed.response.output[0].summary, [{ type: 'summary_text', text: '先分析' }]);
  assert.equal(events.at(-1), '[DONE]');
});

test('推理分片使用 Responses reasoning_summary 生命周期并带标准 event 行', async () => {
  const raw = await convertRaw([
    'data: {"choices":[{"delta":{"reasoning_content":"分析"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  assert.match(raw, /event: response\.created\ndata: /);
  assert.match(raw, /event: response\.reasoning_summary_part\.added\ndata: /);
  assert.match(raw, /event: response\.reasoning_summary_text\.delta\ndata: /);
  assert.match(raw, /event: response\.reasoning_summary_text\.done\ndata: /);
});

test('省略 tool_calls.index 时不同 call_id 不会合并', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","function":{"name":"read","arguments":"{\\"a\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"1}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_b","function":{"name":"run","arguments":"{\\"b\\":2}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const completed = events.find((event) => event.type === 'response.completed');
  assert.deepEqual(completed.response.output.map((item) => [item.call_id, item.arguments]), [
    ['call_a', '{"a":1}'],
    ['call_b', '{"b":2}'],
  ]);
});

test('网关重复完整工具名和累计参数时不会重复拼接', async () => {
  const events = await convertWithToolContext([
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.js\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ], {}, { cumulativeToolCallDeltas: true });
  const item = events.find((event) => event.type === 'response.completed').response.output[0];
  assert.equal(item.name, 'read_file');
  assert.equal(item.arguments, '{"path":"a.js"}');
});

test('无输出且没有 finish_reason 的截断流返回 response.failed', async () => {
  const events = await convert(['data: {"choices":[{"delta":{}}]}\n\n']);
  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  assert.equal(events.some((event) => event.type === 'response.failed'), true);
  assert.equal(events.at(-1), '[DONE]');
});

test('成功停流但只有推理没有正文或工具调用时返回 empty_stop_response', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"reasoning_content":"let me try searching for it with tool_search"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  const failed = events.find((event) => event.type === 'response.failed');
  assert.equal(failed.response.error.code, 'empty_stop_response');
  assert.equal(failed.response.error.type, 'upstream_error');
  assert.equal(events.at(-1), '[DONE]');
});

test('成功停流且完全没有任何输出时返回 empty_stop_response', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  const failed = events.find((event) => event.type === 'response.failed');
  assert.equal(failed.response.error.code, 'empty_stop_response');
});

test('纯推理 + tool_calls 停流但未实际发出工具调用同样判 empty_stop_response', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"reasoning_content":"准备调用工具"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  assert.equal(events.find((event) => event.type === 'response.failed').response.error.code, 'empty_stop_response');
});

test('length 截断的纯推理响应保持 incomplete 语义不受空停判定影响', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"reasoning_content":"思考中途被截断"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(completed.response.status, 'incomplete');
  assert.deepEqual(completed.response.incomplete_details, { reason: 'max_output_tokens' });
});

test('纯推理空停响应发布 failed 状态供上层记录', async () => {
  const transform = createChatSseToResponsesTransform('test-model');
  let response;
  transform.once('response', (value) => { response = value; });
  for await (const _chunk of Readable.from([
    'data: {"choices":[{"delta":{"reasoning_content":"let me search"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]).pipe(transform)) { /* 消费输出，驱动转换完成 */ }

  assert.ok(response);
  assert.equal(response.status, 'failed');
  assert.equal(response.error.code, 'empty_stop_response');
});

test('content 中跨分片的 think 标签拆分为推理摘要和正文', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"nk>思考"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"过程</think>\\n答案"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const output = events.find((event) => event.type === 'response.completed').response.output;
  assert.deepEqual(output.map((item) => item.type), ['reasoning', 'message']);
  assert.equal(output[0].summary[0].text, '思考过程');
  assert.equal(output[1].content[0].text, '\n答案');
});

test('Chat function 调用按上下文还原为 custom_tool_call', async () => {
  const events = await convertWithToolContext([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_patch","function":{"name":"apply_patch","arguments":"{\\"input\\":\\"*** Begin"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" Patch\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ], { byChatName: { apply_patch: { type: 'custom', name: 'apply_patch' } } });
  const item = events.find((event) => event.type === 'response.completed').response.output[0];
  assert.deepEqual(item, {
    id: item.id,
    type: 'custom_tool_call',
    status: 'completed',
    call_id: 'call_patch',
    name: 'apply_patch',
    input: '*** Begin Patch',
  });
  assert.ok(events.some((event) => event.type === 'response.custom_tool_call_input.delta'));
  assert.ok(events.some((event) => event.type === 'response.custom_tool_call_input.done'));
  assert.equal(events.some((event) => event.type === 'response.function_call_arguments.done'), false);
});

test('扁平化 namespace function 在完成事件中恢复 namespace 和原名', async () => {
  const chatName = 'mcp__gmail___search_emails';
  const events = await convertWithToolContext([
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_gmail","function":{"name":"${chatName}","arguments":"{\\"query\\":\\"in:inbox\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
    'data: [DONE]\n\n',
  ], { byChatName: { [chatName]: { type: 'function', name: 'search_emails', namespace: 'mcp__gmail' } } });
  const item = events.find((event) => event.type === 'response.completed').response.output[0];
  assert.equal(item.type, 'function_call');
  assert.equal(item.namespace, 'mcp__gmail');
  assert.equal(item.name, 'search_emails');
});

test('tool_search function 还原为客户端执行的 tool_search_call', async () => {
  const events = await convertWithToolContext([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"search_1","function":{"name":"tool_search","arguments":"{\\"query\\":\\"Gmail search\\",\\"limit\\":5}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ], { byChatName: { tool_search: { type: 'tool_search', name: 'tool_search' } } });
  const item = events.find((event) => event.type === 'response.completed').response.output[0];
  assert.equal(item.type, 'tool_search_call');
  assert.equal(item.execution, 'client');
  assert.equal(item.call_id, 'search_1');
  assert.equal(item.query, 'Gmail search');
  assert.equal(item.limit, 5);
});

test('完成时向路由发布完整响应供有界工具历史缓存记录', async () => {
  const transform = createChatSseToResponsesTransform('test-model');
  let response;
  transform.once('response', (value) => { response = value; });
  for await (const _chunk of Readable.from([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]).pipe(transform)) { /* 消费输出，驱动转换完成 */ }

  assert.ok(response);
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].call_id, 'call_1');
});

test('工具名恰好也是另一工具前缀时等待名称分片完成再发布', async () => {
  const context = {
    byChatName: {
      read: { type: 'function', name: 'read' },
      read_file: { type: 'function', name: 'read_file' },
    },
  };
  const events = await convertWithToolContext([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"_file","arguments":"\\"a.js\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ], context);

  const added = events.find((event) => event.type === 'response.output_item.added');
  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(added.item.name, 'read_file');
  assert.equal(completed.response.output[0].name, 'read_file');
});

test('真实 delta 的重复工具参数片段不会被当成累计帧吞掉', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_repeat","function":{"name":"echo","arguments":"a"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"a"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const item = events.find((event) => event.type === 'response.completed').response.output[0];
  assert.equal(item.arguments, 'aa');
});

test('首帧有 index 而后续帧省略 index 和 id 时仍归并到同一工具', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mixed","function":{"name":"read","arguments":"{\\"x\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const output = events.find((event) => event.type === 'response.completed').response.output;
  assert.equal(output.length, 1);
  assert.equal(output[0].call_id, 'call_mixed');
  assert.equal(output[0].arguments, '{"x":1}');
});

test('疑似 JSON 的畸形 data 帧会失败而不是静默丢失后成功', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\n',
    'data: {bad json}\n\n',
    'data: {"choices":[{"delta":{"content":"C"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  const failed = events.find((event) => event.type === 'response.failed');
  assert.equal(failed.response.error.code, 'invalid_sse_json');
});

test('content_filter 终止原因返回 incomplete 而不是 completed 状态', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const completed = events.find((event) => event.type === 'response.completed');
  assert.equal(completed.response.status, 'incomplete');
  assert.deepEqual(completed.response.incomplete_details, { reason: 'content_filter' });
});

test('未知 finish_reason 保守失败而不是标记 completed', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"content":"部分输出"},"finish_reason":"provider_abort"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  const failed = events.find((event) => event.type === 'response.failed');
  assert.equal(failed.response.error.code, 'unknown_finish_reason');
});

test('单个 SSE 事件超过硬上限时明确失败', async () => {
  const events = await convert([
    `data: ${'x'.repeat(1024 * 1024 + 1)}`,
  ]);

  const failed = events.find((event) => event.type === 'response.failed');
  assert.equal(failed.response.error.code, 'sse_event_too_large');
  assert.equal(events.some((event) => event.type === 'response.completed'), false);
});

test('标准真 delta 即使后片段以前片段为前缀也必须完整拼接', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_prefix","function":{"name":"echo","arguments":"a"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ab"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const item = events.find((event) => event.type === 'response.completed').response.output[0];
  assert.equal(item.arguments, 'aab');
});

test('标准真 delta 的重复工具名称片段不得被吞掉', async () => {
  const events = await convert([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_name","function":{"name":"a","arguments":"{}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"a"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  assert.equal(events.find((event) => event.type === 'response.completed').response.output[0].name, 'aa');
});

test('显式累计模式下重复的完整参数帧不得二次拼接', async () => {
  const frame = '{\\"value\\":1}';
  const events = await convertWithToolContext([
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_cumulative","function":{"name":"tool","arguments":"${frame}"}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"${frame}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
    'data: [DONE]\n\n',
  ], {}, { cumulativeToolCallDeltas: true });

  assert.equal(events.find((event) => event.type === 'response.completed').response.output[0].arguments, '{"value":1}');
});

test('Chat SSE 的非 JSON data 帧必须失败而不是静默跳过', async () => {
  const events = await convert([
    'data: provider overloaded\n\n',
    'data: {"choices":[{"delta":{"content":"错误后的文本"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  assert.equal(events.find((event) => event.type === 'response.failed').response.error.code, 'invalid_sse_json');
});

test('累计正文、推理和工具参数共享响应级内存硬上限', async () => {
  const transform = createChatSseToResponsesTransform('test-model', {}, { maxAccumulatedBytes: 8 });
  const output = [];
  for await (const chunk of Readable.from([
    'data: {"choices":[{"delta":{"content":"12345"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"6789"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]).pipe(transform)) output.push(chunk);
  const events = Buffer.concat(output).toString('utf8').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .map((payload) => payload === '[DONE]' ? payload : JSON.parse(payload));

  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  assert.equal(events.find((event) => event.type === 'response.failed').response.error.code, 'response_too_large');
});

test('空参数工具调用数量也有独立硬上限', async () => {
  const transform = createChatSseToResponsesTransform('test-model', {}, { maxToolCalls: 1 });
  const output = [];
  for await (const chunk of Readable.from([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"a","arguments":""}},{"index":1,"id":"call_2","function":{"name":"b","arguments":""}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]).pipe(transform)) output.push(chunk);
  const events = Buffer.concat(output).toString('utf8').split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .map((payload) => payload === '[DONE]' ? payload : JSON.parse(payload));

  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  assert.equal(events.find((event) => event.type === 'response.failed').response.error.code, 'too_many_tool_calls');
});
