import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Duplex, Readable } from 'node:stream';

import * as transport from '../lib/transport.mjs';

const {
  DechunkTransform,
  openHttpsStream,
  rawHttpsRequest,
  resolveTimeouts,
  withTimeout,
} = transport;

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

class FakeSocket extends Duplex {
  constructor(responseChunks = []) {
    super();
    this.responseChunks = responseChunks;
    this.request = '';
    this.timeoutHandler = null;
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.request += chunk.toString('utf8');
    callback();
  }

  setTimeout(_milliseconds, handler) {
    this.timeoutHandler = handler || null;
    return this;
  }

  startResponse() {
    for (const chunk of this.responseChunks) this.push(chunk);
    this.push(null);
  }
}

test('分层超时允许目标配置覆盖全局默认值', () => {
  assert.deepEqual(resolveTimeouts(
    { connectMs: 100, responseHeaderMs: 200, streamIdleMs: 300, requestMs: 400 },
    { responseHeaderMs: 250 },
  ), { connectMs: 100, responseHeaderMs: 250, streamIdleMs: 300, requestMs: 400 });
});

test('HTTP CONNECT authority 为 IPv6 字面量补方括号并始终包含端口', () => {
  assert.equal(typeof transport.connectAuthority, 'function');
  assert.equal(transport.connectAuthority('2001:db8::1', 443), '[2001:db8::1]:443');
  assert.equal(transport.connectAuthority('[2001:db8::1]', 8443), '[2001:db8::1]:8443');
  assert.equal(transport.connectAuthority('api.example.com', 443), 'api.example.com:443');
});

test('DechunkTransform 正确处理跨数据块的 chunked 响应', async () => {
  const source = Readable.from(['5\r\nhe', 'llo\r\n6\r\n world\r\n0\r\n\r\n']);
  assert.equal(await collect(source.pipe(new DechunkTransform())), 'hello world');
});

test('DechunkTransform 接受合法 trailer 并拒绝所有截断状态', async () => {
  const validTrailer = Readable.from(['2\r\nok\r\n0\r\nX-Trace: done\r\n', '\r\n']);
  assert.equal(await collect(validTrailer.pipe(new DechunkTransform())), 'ok');

  const malformed = [
    ['5\r\nhe', /truncated chunk data/],
    ['5\r\nhello', /missing chunk terminator/],
    ['5\r\nhello\r\n', /missing final zero chunk/],
    ['0\r\n', /truncated chunk trailer/],
    ['0\r\nX-Trace: done\r\n', /truncated chunk trailer/],
  ];
  for (const [wireBody, expected] of malformed) {
    await assert.rejects(collect(Readable.from([wireBody]).pipe(new DechunkTransform())), expected);
  }
});

test('DechunkTransform 立即拒绝非安全整数或过大的 chunk 声明', async () => {
  await assert.rejects(
    collect(Readable.from(['20000000000000\r\n']).pipe(new DechunkTransform())),
    /invalid chunk size/,
  );
  await assert.rejects(
    collect(Readable.from(['4000001\r\n']).pipe(new DechunkTransform())),
    /chunk size exceeds limit/,
  );
});

test('DechunkTransform 限制无终止的 size 与 trailer 控制行', async () => {
  await assert.rejects(
    collect(Readable.from(['1'.repeat(8_193)]).pipe(new DechunkTransform())),
    /chunk size line too large/,
  );
  await assert.rejects(
    collect(Readable.from([`0\r\nX-Long: ${'a'.repeat(8_193)}`]).pipe(new DechunkTransform())),
    /chunk trailer line too large/,
  );
});

test('DechunkTransform 不等待完整大块即可增量输出正文', async () => {
  const transform = new DechunkTransform();
  const chunks = [];
  transform.on('data', (chunk) => chunks.push(chunk));

  transform.write(`100000\r\n${'x'.repeat(1_024)}`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(Buffer.concat(chunks).length, 1_024);
  transform.destroy();
});

test('openHttpsStream 在响应头到达后立即返回可读流', async () => {
  const socket = new FakeSocket([
    'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n',
    'D\r\ndata: hello\n\n\r\n0\r\n\r\n',
  ]);
  const opened = openHttpsStream({
    host: 'example.com',
    path: '/chat/completions',
    headers: { authorization: 'Bearer test' },
    body: '{"stream":true}',
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async () => socket,
  });
  queueMicrotask(() => socket.startResponse());

  const response = await opened;
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  assert.equal(await collect(response.stream), 'data: hello\n\n');
  assert.match(socket.request, /^POST \/chat\/completions HTTP\/1\.1/);
});

test('openHttpsStream 的非默认端口会写入 Host 请求头', async () => {
  const socket = new FakeSocket(['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok']);
  const opened = openHttpsStream({
    host: 'example.com',
    port: 8443,
    path: '/control',
    body: '{}',
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async () => socket,
  });
  queueMicrotask(() => socket.startResponse());

  const response = await opened;
  assert.equal(await collect(response.stream), 'ok');
  assert.match(socket.request, /\r\nHost: example\.com:8443\r\n/);
});

test('openHttpsStream 严格校验 Content-Length 提前结束和超长正文', async () => {
  for (const [declared, body, expected] of [
    [5, 'hi', /content-length body truncated/],
    [2, 'okay', /content-length body exceeded/],
  ]) {
    const socket = new FakeSocket([`HTTP/1.1 200 OK\r\nContent-Length: ${declared}\r\n\r\n${body}`]);
    const opened = openHttpsStream({
      host: 'example.com',
      path: '/control',
      body: '{}',
      timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
      connector: async () => socket,
    });
    queueMicrotask(() => socket.startResponse());
    const response = await opened;
    await assert.rejects(collect(response.stream), expected);
  }
});

test('openHttpsStream 把每条目标的直连或代理策略原样交给连接器', async () => {
  const socket = new FakeSocket(['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok']);
  let connectionOptions = null;
  const opened = openHttpsStream({
    host: 'custom.example.com',
    path: '/v1/chat/completions',
    viaProxy: true,
    proxy: { host: '127.0.0.1', port: 10808 },
    body: '{}',
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async (options) => {
      connectionOptions = options;
      return socket;
    },
  });
  queueMicrotask(() => socket.startResponse());

  const response = await opened;
  assert.equal(await collect(response.stream), 'ok');
  assert.equal(connectionOptions.viaProxy, true);
  assert.deepEqual(connectionOptions.proxy, { host: '127.0.0.1', port: 10808 });
});

test('openHttpsStream 的响应头超时会销毁上游 socket', async () => {
  const socket = new FakeSocket();
  await assert.rejects(openHttpsStream({
    host: 'example.com',
    path: '/chat/completions',
    headers: {},
    body: '{}',
    timeouts: { connectMs: 50, responseHeaderMs: 5, streamIdleMs: 50, requestMs: 50 },
    connector: async () => socket,
  }), /response header timeout/);
  assert.equal(socket.destroyed, true);
});

test('客户端取消会在响应头前终止请求并销毁 socket', async () => {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const opened = openHttpsStream({
    host: 'example.com',
    path: '/chat/completions',
    headers: {},
    body: '{}',
    signal: controller.signal,
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async () => socket,
  });
  queueMicrotask(() => controller.abort());
  await assert.rejects(opened, { name: 'AbortError' });
  assert.equal(socket.destroyed, true);
});

test('客户端取消会在流式响应期间终止上游 body', async () => {
  const socket = new FakeSocket();
  const controller = new AbortController();
  const opened = openHttpsStream({
    host: 'example.com',
    path: '/chat/completions',
    headers: {},
    body: '{}',
    signal: controller.signal,
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async () => socket,
  });
  queueMicrotask(() => socket.push('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: partial\n\n'));
  const response = await opened;
  const body = collect(response.stream);
  controller.abort();
  await assert.rejects(body, { name: 'AbortError' });
  assert.equal(socket.destroyed, true);
});

test('消费方提前销毁响应流时同步销毁上游 socket', async () => {
  const socket = new FakeSocket();
  const opened = openHttpsStream({
    host: 'example.com',
    path: '/chat/completions',
    headers: {},
    body: '{}',
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async () => socket,
  });
  queueMicrotask(() => socket.push('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\npartial'));
  const response = await opened;

  response.stream.destroy();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.destroyed, true);
});

test('rawHttpsRequest 超过非流式响应体上限时销毁上游 socket', async () => {
  const socket = new FakeSocket([
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n',
    JSON.stringify({ content: 'x'.repeat(1_024) }),
  ]);
  const request = rawHttpsRequest({
    host: 'example.com',
    path: '/chat/completions',
    body: '{}',
    maxResponseBytes: 128,
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async () => socket,
  });
  queueMicrotask(() => socket.startResponse());

  await assert.rejects(request, /response body too large/);
  assert.equal(socket.destroyed, true);
});

test('rawHttpsRequest 严格校验 Content-Length', async () => {
  for (const [declared, body, expected] of [
    [5, 'hi', /content-length body truncated/],
    [2, 'okay', /content-length body exceeded/],
  ]) {
    const socket = new FakeSocket([`HTTP/1.1 200 OK\r\nContent-Length: ${declared}\r\n\r\n${body}`]);
    const request = rawHttpsRequest({
      host: 'example.com',
      path: '/control',
      body: '{}',
      timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
      connector: async () => socket,
    });
    queueMicrotask(() => socket.startResponse());
    await assert.rejects(request, expected);
  }
});

test('rawHttpsRequest 严格拒绝非法或截断的 chunked 并保留合法 trailer', async () => {
  const cases = [
    ['Z\r\nnope\r\n0\r\n\r\n', /invalid chunk size/],
    ['5\r\nhi', /truncated chunk data/],
    ['2\r\nok\r\n', /missing final zero chunk/],
    ['0\r\nX-Trace: done\r\n', /truncated chunk trailer/],
  ];
  for (const [wireBody, expected] of cases) {
    const socket = new FakeSocket([`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${wireBody}`]);
    const request = rawHttpsRequest({
      host: 'example.com',
      path: '/control',
      body: '{}',
      timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
      connector: async () => socket,
    });
    queueMicrotask(() => socket.startResponse());
    await assert.rejects(request, expected);
  }

  const valid = new FakeSocket([
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\nX-Trace: done\r\n\r\n',
  ]);
  const request = rawHttpsRequest({
    host: 'example.com',
    path: '/control',
    body: '{}',
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async () => valid,
  });
  queueMicrotask(() => valid.startResponse());
  assert.equal((await request).bodyText, 'ok');
});

test('rawHttpsRequest 未显式配置时也使用安全的默认响应体上限', async () => {
  const socket = new FakeSocket([
    'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n',
    Buffer.alloc(8 * 1024 * 1024 + 1, 120),
  ]);
  const request = rawHttpsRequest({
    host: 'example.com',
    path: '/control',
    body: '{}',
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 500 },
    connector: async () => socket,
  });
  queueMicrotask(() => socket.startResponse());

  await assert.rejects(request, /limit 8388608 bytes/);
  assert.equal(socket.destroyed, true);
});

test('rawHttpsRequest 在连接器返回前已取消时立即销毁 socket', async () => {
  const socket = new FakeSocket();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(rawHttpsRequest({
    host: 'example.com',
    path: '/control',
    body: '{}',
    signal: controller.signal,
    timeouts: { connectMs: 50, responseHeaderMs: 50, streamIdleMs: 50, requestMs: 50 },
    connector: async () => socket,
  }), { name: 'AbortError' });
  assert.equal(socket.destroyed, true);
});

test('withTimeout 在超时后拒绝，先完成的 Promise 正常返回', async () => {
  const never = new Promise(() => {});
  await assert.rejects(withTimeout(never, 20, 'slow-op'), /slow-op timeout after 20ms/);
  assert.equal(await withTimeout(Promise.resolve('ok'), 50, 'fast-op'), 'ok');
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50, 'bad-op'), /boom/);
});

test('protocol=http 时可连接隔离端口的本地明文上游', async (t) => {
  const upstream = net.createServer((socket) => {
    socket.once('data', () => {
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const port = upstream.address().port;

  const response = await openHttpsStream({
    protocol: 'http',
    host: '127.0.0.1',
    port,
    path: '/test',
    body: '{}',
    timeouts: { connectMs: 100, responseHeaderMs: 100, streamIdleMs: 100, requestMs: 100 },
  });
  assert.equal(response.status, 200);
  assert.equal(await collect(response.stream), 'ok');
});
