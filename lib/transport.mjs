import net from 'node:net';
import tls from 'node:tls';
import { PassThrough, Transform } from 'node:stream';

// ---------- 零依赖 HTTP/1.1 传输与分层超时 ----------
export const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 15_000,
  responseHeaderMs: 120_000,
  streamIdleMs: 10 * 60_000,
  requestMs: 10 * 60_000,
});
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// 给任意 Promise 加超时：先到先得，未用完的定时器必须清理，避免悬空句柄。
export function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export function resolveTimeouts(defaults = {}, overrides = {}) {
  // 单目标覆盖全局配置，缺失项回落到安全默认值。
  return { ...DEFAULT_TIMEOUTS, ...defaults, ...overrides };
}

function abortError(host) {
  // 使用标准 AbortError 名称，让上层明确禁止对客户端取消执行 failover。
  const error = new Error(`request ${host} aborted`);
  error.name = 'AbortError';
  return error;
}

// 直连或通过本地 HTTP CONNECT 代理建立 TLS；超时覆盖 DNS、TCP、CONNECT 与 TLS 握手全阶段。
export function connectTls(options) {
  const {
    host,
    port = 443,
    viaProxy = false,
    proxy,
    timeoutMs = DEFAULT_TIMEOUTS.connectMs,
    signal,
  } = options;
  return new Promise((resolve, reject) => {
    let rawSocket = null;
    let secureSocket = null;
    let settled = false;

    const destroySockets = () => {
      if (secureSocket && !secureSocket.destroyed) secureSocket.destroy();
      if (rawSocket && rawSocket !== secureSocket && !rawSocket.destroyed) rawSocket.destroy();
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroySockets();
      reject(error);
    };
    const succeed = (socket) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };
    const onAbort = () => fail(abortError(host));
    const timer = setTimeout(() => fail(new Error(`TLS connect timeout for ${host}`)), timeoutMs);
    timer.unref?.();

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    if (!viaProxy) {
      secureSocket = tls.connect({ host, port, servername: host });
      secureSocket.once('secureConnect', () => succeed(secureSocket));
      secureSocket.once('error', fail);
      return;
    }

    if (!proxy?.host || !proxy?.port) {
      fail(new Error('启用 viaProxy 时必须配置代理 host 和 port'));
      return;
    }
    rawSocket = net.connect(proxy.port, proxy.host);
    rawSocket.once('connect', () => {
      rawSocket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    rawSocket.once('error', fail);
    let connectHead = Buffer.alloc(0);
    const onProxyData = (chunk) => {
      connectHead = Buffer.concat([connectHead, chunk]);
      if (connectHead.length > 64 * 1024) {
        fail(new Error(`CONNECT ${host} response header too large`));
        return;
      }
      const end = connectHead.indexOf('\r\n\r\n');
      if (end === -1) return;
      rawSocket.removeListener('data', onProxyData);
      const statusLine = connectHead.subarray(0, end).toString('latin1').split('\r\n')[0];
      if (!/^HTTP\/\d(?:\.\d)? 200\b/.test(statusLine)) {
        fail(new Error(`CONNECT ${host} failed: ${statusLine}`));
        return;
      }
      rawSocket.removeListener('error', fail);
      secureSocket = tls.connect({ socket: rawSocket, servername: host });
      secureSocket.once('secureConnect', () => succeed(secureSocket));
      secureSocket.once('error', fail);
    };
    rawSocket.on('data', onProxyData);
  });
}

// 隔离测试或明确配置的内网网关可使用明文 HTTP；生产目标默认仍为 TLS。
export function connectTcp(options) {
  const { host, port = 80, timeoutMs = DEFAULT_TIMEOUTS.connectMs, signal } = options;
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('error', fail);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(abortError(host));
    const timer = setTimeout(() => fail(new Error(`TCP connect timeout for ${host}`)), timeoutMs);
    timer.unref?.();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', fail);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    });
  });
}

function requestHead(method, host, path, headers, body) {
  // 裸写请求时主动补齐长度，避免上游等待永远不会到来的 chunked 尾块。
  const normalizedHeaders = { ...headers };
  const hasContentLength = Object.keys(normalizedHeaders).some((key) => key.toLowerCase() === 'content-length');
  const hasContentType = Object.keys(normalizedHeaders).some((key) => key.toLowerCase() === 'content-type');
  if (!hasContentLength) normalizedHeaders['content-length'] = Buffer.byteLength(body);
  if (!hasContentType) normalizedHeaders['content-type'] = 'application/json';
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
  for (const [key, value] of Object.entries(normalizedHeaders)) {
    if (Array.isArray(value)) value.forEach((item) => lines.push(`${key}: ${item}`));
    else if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

function parseResponseHead(buffer) {
  // 响应头名统一小写；重复头保留数组，交由下游按需处理。
  const text = buffer.toString('latin1');
  const lines = text.split('\r\n');
  const statusMatch = lines.shift()?.match(/^HTTP\/\d(?:\.\d)? (\d{3})/);
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (headers[key] === undefined) headers[key] = value;
    else headers[key] = [].concat(headers[key], value);
  }
  return { status: statusMatch ? Number(statusMatch[1]) : 0, headers };
}

// 增量解码 HTTP/1.1 chunked，避免再由 ServerResponse 套一层 chunked。
export class DechunkTransform extends Transform {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.chunkSize = -1;
    this.finished = false;
  }

  _transform(chunk, _encoding, callback) {
    if (this.finished) {
      callback();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.chunkSize === -1) {
        const lineEnd = this.buffer.indexOf('\r\n');
        if (lineEnd === -1) break;
        const sizeText = this.buffer.subarray(0, lineEnd).toString('latin1').split(';')[0].trim();
        if (!/^[0-9a-f]+$/i.test(sizeText)) {
          callback(new Error(`invalid chunk size: ${sizeText}`));
          return;
        }
        this.chunkSize = Number.parseInt(sizeText, 16);
        this.buffer = this.buffer.subarray(lineEnd + 2);
        if (this.chunkSize === 0) {
          this.finished = true;
          this.buffer = Buffer.alloc(0);
          break;
        }
      }
      if (this.buffer.length < this.chunkSize + 2) break;
      if (this.buffer[this.chunkSize] !== 13 || this.buffer[this.chunkSize + 1] !== 10) {
        callback(new Error('invalid chunk terminator'));
        return;
      }
      this.push(this.buffer.subarray(0, this.chunkSize));
      this.buffer = this.buffer.subarray(this.chunkSize + 2);
      this.chunkSize = -1;
    }
    callback();
  }
}

function bodyStreamFor(socket, headers, initialBody, idleMs, signal, host) {
  // 响应头解析完成后立即返回流，并把客户端取消继续传播到 socket。
  const output = new PassThrough();
  const chunked = /chunked/i.test(String(headers['transfer-encoding'] || ''));
  const decoder = chunked ? new DechunkTransform() : new PassThrough();
  delete headers['transfer-encoding'];
  delete headers['content-length'];

  const onAbort = () => socket.destroy(abortError(host));
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.setTimeout(idleMs, () => socket.destroy(new Error(`stream idle timeout for ${host}`)));
  socket.once('close', () => signal?.removeEventListener('abort', onAbort));
  socket.once('error', (error) => decoder.destroy(error));
  decoder.once('error', (error) => output.destroy(error));
  decoder.pipe(output);
  if (initialBody.length) decoder.write(initialBody);
  socket.pipe(decoder);
  return output;
}

// 打开真正的流式 HTTPS 请求；Promise 只等待响应头，不等待完整响应体。
export async function openHttpsStream(options) {
  const {
    host,
    port = 443,
    path,
    method = 'POST',
    viaProxy = false,
    proxy,
    headers = {},
    body = '',
    signal,
    connector = connectTls,
  } = options;
  const timeouts = resolveTimeouts(options.timeouts);
  const selectedConnector = options.connector || (options.protocol === 'http' ? connectTcp : connector);
  const socket = await selectedConnector({ host, port, viaProxy, proxy, timeoutMs: timeouts.connectMs, signal });
  return new Promise((resolve, reject) => {
    let responseBuffer = Buffer.alloc(0);
    let settled = false;
    const headerTimer = setTimeout(() => {
      fail(new Error(`response header timeout for ${host}`));
    }, timeouts.responseHeaderMs);
    headerTimer.unref?.();

    const cleanupBeforeHead = () => {
      clearTimeout(headerTimer);
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      socket.removeListener('end', onEndBeforeHead);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanupBeforeHead();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(abortError(host));
    const onEndBeforeHead = () => fail(new Error(`upstream ${host} closed before response header`));
    const onData = (chunk) => {
      responseBuffer = Buffer.concat([responseBuffer, chunk]);
      if (responseBuffer.length > 64 * 1024 && responseBuffer.indexOf('\r\n\r\n') === -1) {
        fail(new Error(`response header too large for ${host}`));
        return;
      }
      const end = responseBuffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      settled = true;
      cleanupBeforeHead();
      const { status, headers: responseHeaders } = parseResponseHead(responseBuffer.subarray(0, end));
      const initialBody = responseBuffer.subarray(end + 4);
      const stream = bodyStreamFor(socket, responseHeaders, initialBody, timeouts.streamIdleMs, signal, host);
      resolve({ status, headers: responseHeaders, stream, socket });
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('data', onData);
    socket.once('error', fail);
    socket.once('end', onEndBeforeHead);
    socket.write(requestHead(method, host, path, headers, body));
  });
}

function dechunkBuffer(buffer) {
  // 非流式控制请求已收齐全部数据，可用简单游标一次性解 chunked。
  const chunks = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', cursor);
    if (lineEnd === -1) break;
    const size = Number.parseInt(buffer.subarray(cursor, lineEnd).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    chunks.push(buffer.subarray(start, start + size));
    cursor = start + size + 2;
  }
  return Buffer.concat(chunks);
}

// 控制类和视觉中继使用的一次性请求，保留整体等待超时。
export async function rawHttpsRequest(options) {
  const timeouts = resolveTimeouts(options.timeouts);
  const configuredLimit = Number(options.maxResponseBytes);
  const maxResponseBytes = Number.isFinite(configuredLimit)
    ? Math.max(0, Math.floor(configuredLimit))
    : DEFAULT_MAX_RESPONSE_BYTES;
  const socket = await (options.connector || (options.protocol === 'http' ? connectTcp : connectTls))({
    host: options.host,
    port: options.port || 443,
    viaProxy: options.viaProxy,
    proxy: options.proxy,
    timeoutMs: timeouts.connectMs,
    signal: options.signal,
  });
  // 连接器可能在取消与返回之间竞态完成；进入请求状态机前必须再次检查。
  if (options.signal?.aborted) {
    socket.destroy();
    throw abortError(options.host);
  }
  return new Promise((resolve, reject) => {
    let headBuffer = Buffer.alloc(0);
    let responseHead = null;
    const bodyChunks = [];
    let responseBodyBytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`request timeout for ${options.host}`)), timeouts.requestMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => finish(abortError(options.host));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const onData = (chunk) => {
      if (responseHead !== null) {
        if (responseBodyBytes + chunk.length > maxResponseBytes) {
          finish(new Error(`response body too large for ${options.host}: limit ${maxResponseBytes} bytes`));
          return;
        }
        responseBodyBytes += chunk.length;
        bodyChunks.push(chunk);
        return;
      }
      headBuffer = Buffer.concat([headBuffer, chunk]);
      const responseHeadEnd = headBuffer.indexOf('\r\n\r\n');
      if (responseHeadEnd === -1) {
        if (headBuffer.length > 64 * 1024) finish(new Error(`response header too large for ${options.host}`));
        return;
      }
      responseHead = headBuffer.subarray(0, responseHeadEnd);
      const initialBody = headBuffer.subarray(responseHeadEnd + 4);
      headBuffer = Buffer.alloc(0);
      responseBodyBytes = initialBody.length;
      if (responseBodyBytes > maxResponseBytes) {
        finish(new Error(`response body too large for ${options.host}: limit ${maxResponseBytes} bytes`));
        return;
      }
      if (initialBody.length) bodyChunks.push(initialBody);
    };
    socket.on('data', onData);
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      let responseBody = responseHead === null
        ? headBuffer
        : Buffer.concat(bodyChunks, responseBodyBytes);
      const parsed = parseResponseHead(responseHead || Buffer.alloc(0));
      if (/chunked/i.test(String(parsed.headers['transfer-encoding'] || ''))) responseBody = dechunkBuffer(responseBody);
      finish(null, { status: parsed.status, headers: parsed.headers, bodyText: responseBody.toString('utf8') });
    });
    socket.write(requestHead(options.method || 'POST', options.host, options.path, options.headers || {}, options.body || ''));
  });
}
