import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

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

test('已提交响应头后的错误只发送 SSE 错误和 DONE', () => {
  const pipeline = createResponsePipeline({ heartbeatMs: 15_000 });
  const response = new FakeResponse();
  response.headersSent = true;

  pipeline.emitResponsesErrorSse(response, '上游失败', 'provider_error');

  assert.equal(response.heads.length, 0);
  assert.match(response.writes.join(''), /"type":"error"/);
  assert.match(response.writes.join(''), /"code":"provider_error"/);
  assert.match(response.writes.join(''), /data: \[DONE\]/);
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
