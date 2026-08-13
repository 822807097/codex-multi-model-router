import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  copyResponseHeaders,
  createResponsePipeline,
} from '../lib/response-pipeline.mjs';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.destroyed = false;
    this.writableEnded = false;
    this.heads = [];
    this.writes = [];
    this.flushCount = 0;
  }

  writeHead(status, headers) {
    this.headersSent = true;
    this.heads.push({ status, headers });
  }

  flushHeaders() {
    this.flushCount += 1;
  }

  write(value) {
    this.writes.push(String(value));
    return true;
  }

  end(value) {
    if (value !== undefined) this.writes.push(String(value));
    this.writableEnded = true;
    this.emit('finish');
  }
}

function responseEvents(response) {
  return response.writes.join('').split(/\r?\n/)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

test('SSE 心跳立即提交一次响应头并可幂等停止定时器', () => {
  const timers = [];
  const cleared = [];
  const pipeline = createResponsePipeline({
    heartbeatMs: 15_000,
    setIntervalFn(callback, delay) {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { cleared.push(timer); },
  });
  const response = new FakeResponse();

  const stop = pipeline.startResponsesSse(response);
  timers[0].callback();
  stop();
  stop();

  assert.equal(response.heads.length, 1);
  assert.equal(response.heads[0].status, 200);
  assert.equal(response.flushCount, 1);
  assert.equal(timers[0].delay, 15_000);
  assert.equal(timers[0].unrefCalled, true);
  assert.deepEqual(response.writes, [': keep-alive\n\n']);
  assert.deepEqual(cleared, [timers[0]]);
});

test('已提交响应头后的错误发送 Responses 失败终态和 DONE', () => {
  const pipeline = createResponsePipeline({ heartbeatMs: 15_000 });
  const response = new FakeResponse();
  response.headersSent = true;

  pipeline.emitResponsesErrorSse(response, '上游失败', '429', 'kimi-k3');

  assert.equal(response.heads.length, 0);
  const text = response.writes.join('');
  const events = text.split(/\r?\n/)
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice('data: '.length)));
  const failed = events.find((event) => event.type === 'response.failed');
  assert.equal(failed.response.status, 'failed');
  assert.equal(failed.response.model, 'kimi-k3');
  assert.equal(failed.response.error.code, '429');
  assert.equal(events.filter((event) => event.type === 'response.failed').length, 1);
  assert.match(text, /data: \[DONE\]/);
  assert.equal(response.writableEnded, true);
});

test('原生响应头过滤 hop-by-hop 和 content-length', () => {
  assert.deepEqual(copyResponseHeaders({
    'content-type': 'text/event-stream',
    connection: 'keep-alive',
    'content-length': '123',
    'x-request-id': 'safe',
  }), {
    'content-type': 'text/event-stream',
    'x-request-id': 'safe',
  });
});

test('Chat 上游流错误通过窄回调标记诊断状态', async () => {
  const pipeline = createResponsePipeline({ heartbeatMs: 15_000 });
  const response = new FakeResponse();
  response.headersSent = true;
  const upstream = new PassThrough();
  const failures = [];

  pipeline.pipeChatResponse(
    { stream: upstream },
    response,
    'test-model',
    'test-tag',
    () => {},
    { byChatName: {}, byOriginalName: {} },
    {},
    null,
    { streamError: (fields) => failures.push(fields) },
  );
  const error = new Error('socket closed');
  error.code = 'ECONNRESET';
  upstream.emit('error', error);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(failures, [{
    error_code: 'ECONNRESET',
    error_stage: 'chat_response_stream',
  }]);
  assert.equal(response.writableEnded, true);
});

test('Chat 已开始响应后的流错误以同一 response id 发送唯一失败终态', async () => {
  const pipeline = createResponsePipeline({ heartbeatMs: 15_000 });
  const response = new FakeResponse();
  response.headersSent = true;
  const upstream = new PassThrough();

  pipeline.pipeChatResponse(
    { stream: upstream, socket: { destroy() {} } },
    response,
    'kimi-k3',
    'test-tag',
    () => {},
    { byChatName: {}, byOriginalName: {} },
    {},
  );
  upstream.write('data: {"id":"chat_partial","choices":[{"delta":{"content":"一半"}}]}\n\n');
  const error = new Error('socket closed');
  error.code = 'ECONNRESET';
  upstream.emit('error', error);
  await new Promise((resolve) => setImmediate(resolve));

  const events = responseEvents(response);
  const created = events.find((event) => event.type === 'response.created');
  const terminal = events.filter((event) => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, 'response.failed');
  assert.equal(terminal[0].response.id, created.response.id);
  assert.equal(terminal[0].response.error.code, 'ECONNRESET');
  assert.equal((response.writes.join('').match(/data: \[DONE\]/g) || []).length, 1);
});

test('Chat 完成后晚到的上游错误不追加第二个终态', async () => {
  const pipeline = createResponsePipeline({ heartbeatMs: 15_000 });
  const response = new FakeResponse();
  response.headersSent = true;
  const upstream = new PassThrough();
  let heartbeatStops = 0;
  let socketDestroys = 0;

  pipeline.pipeChatResponse(
    { stream: upstream, socket: { destroy() { socketDestroys += 1; } } },
    response,
    'kimi-k3',
    'test-tag',
    () => { heartbeatStops += 1; },
    { byChatName: {}, byOriginalName: {} },
    {},
  );
  upstream.write('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  const lateError = new Error('late socket error');
  lateError.code = 'ECONNRESET';
  upstream.emit('error', lateError);
  await new Promise((resolve) => setImmediate(resolve));

  const terminal = responseEvents(response)
    .filter((event) => ['response.completed', 'response.failed', 'response.incomplete'].includes(event.type));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type, 'response.completed');
  assert.equal((response.writes.join('').match(/data: \[DONE\]/g) || []).length, 1);
  assert.equal(response.writableEnded, true);
  assert.equal(heartbeatStops, 1);
  assert.equal(socketDestroys, 1);
});

test('原生非 SSE 上游空闲超时通过窄回调标记 timeout', () => {
  const pipeline = createResponsePipeline({ heartbeatMs: 15_000 });
  const response = new FakeResponse();
  response.destroy = () => { response.destroyed = true; };
  const upstream = new PassThrough();
  const failures = [];

  pipeline.pipeNativeResponse(
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
      stream: upstream,
      socket: { destroy() {} },
    },
    response,
    'native-tag',
    null,
    { streamError: (fields) => failures.push(fields) },
  );
  const error = new Error('stream idle timeout for provider');
  error.code = 'ETIMEDOUT';
  upstream.emit('error', error);

  assert.deepEqual(failures, [{
    outcome: 'timeout',
    error_code: 'ETIMEDOUT',
    error_stage: 'native_response_stream',
  }]);
  assert.equal(response.destroyed, true);
});
