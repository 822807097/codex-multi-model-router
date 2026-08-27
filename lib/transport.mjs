import net from 'node:net';
import tls from 'node:tls';
import { PassThrough, Transform } from 'node:stream';
import { parseNodeUrl, connectNode, isDirectNodeType } from './proxy-nodes.mjs';

// ---------- 零依赖 HTTP/1.1 传输与分层超时 ----------
export const DEFAULT_TIMEOUTS = Object.freeze({
  connectMs: 15_000,
  responseHeaderMs: 120_000,
  streamIdleMs: 10 * 60_000,
  requestMs: 10 * 60_000,
});
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_CONTROL_LINE_BYTES = 8 * 1024;

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

// 超时合并：通道级覆盖全局默认，缺省字段保留默认值
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

// ---------- SOCKS5 客户端原生轻量协议握手 (RFC 1928, 支持远程域名解析) ----------
export function handshakeSocks5(socket, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    let stage = 0; // 0: auth negotiation, 1: connect request
    // 代理响应可能跨多个 TCP 包到达，必须累积缓冲再判断，不能假设单包完整。
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (stage === 0) {
          // 期望响应: 0x05 (VER) 0x00 (NO_AUTH)
          if (buffer.length < 2) return; // 等待响应完整到达
          if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
            cleanup();
            reject(new Error(`SOCKS5 认证协商失败: ${buffer.toString('hex')}`));
            return;
          }
          buffer = buffer.subarray(2);
          stage = 1;
          // 发送 CONNECT 请求 (CMD=0x01, ATYP=0x03 域名)
          const hostBuf = Buffer.from(targetHost, 'utf8');
          const req = Buffer.alloc(4 + 1 + hostBuf.length + 2);
          req[0] = 0x05; // VER
          req[1] = 0x01; // CMD: CONNECT
          req[2] = 0x00; // RSV
          req[3] = 0x03; // ATYP: DOMAINNAME
          req[4] = hostBuf.length;
          hostBuf.copy(req, 5);
          req.writeUInt16BE(targetPort, 5 + hostBuf.length);
          socket.write(req);
        } else if (stage === 1) {
          // 期望响应: 0x05 0x00 (REP=SUCCESS)
          if (buffer.length < 2) return; // 等待响应完整到达
          if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
            const errCodes = { 0x01: '通用失败', 0x02: '规则拒绝', 0x03: '网络不可达', 0x04: '主机不可达', 0x05: '连接拒绝' };
            cleanup();
            reject(new Error(`SOCKS5 连接目标 ${targetHost}:${targetPort} 失败: ${errCodes[buffer[1]] || buffer[1]}`));
            return;
          }
          buffer = Buffer.alloc(0);
          cleanup();
          resolve(socket);
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    socket.on('data', onData);
    socket.once('error', onError);

    // 发起初次协商: VER=5, NMETHODS=1, METHOD=0 (NO_AUTH)
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
  });
}

// 解析代理 URL（http/socks5，host:port 简写兼容），非法返回 null
function parseProxyUrl(proxy) {
  if (!proxy) return null;
  if (typeof proxy === 'object' && proxy.host && proxy.port) {
    return { protocol: proxy.protocol || 'http', host: proxy.host, port: Number(proxy.port) };
  }
  if (typeof proxy === 'string') {
    let str = proxy.trim();
    if (!str.includes('://')) str = `http://${str}`;
    try {
      const u = new URL(str);
      return {
        protocol: u.protocol.replace(':', '').toLowerCase(),
        host: u.hostname,
        port: Number(u.port) || (u.protocol.startsWith('socks') ? 10808 : 10809),
      };
    } catch {
      return null;
    }
  }
  return null;
}

// 直连或通过本地 HTTP / SOCKS5 多协议代理建立 TLS
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

    const parsedProxy = parseProxyUrl(proxy);
    if (!parsedProxy?.host || !parsedProxy?.port) {
      fail(new Error('启用 viaProxy 时必须配置代理 host 和 port'));
      return;
    }
    // 节点直连（ss/trojan/vless）：协议隧道协商后在其上套 TLS；
    // 隧道建立是异步的，success 路径在协商完成后才 resolve。
    const node = typeof proxy === 'string' ? parseNodeUrl(proxy) : null;
    if (node && isDirectNodeType(node.type)) {
      connectNode(node, host, port, { signal, timeoutMs })
        .then((tunnelSocket) => {
          secureSocket = tls.connect({ socket: tunnelSocket, servername: host });
          secureSocket.once('secureConnect', () => succeed(secureSocket));
          secureSocket.once('error', fail);
        })
        .catch(fail);
      return;
    }
    rawSocket = net.connect(parsedProxy.port, parsedProxy.host);

    if (parsedProxy.protocol.startsWith('socks')) {
      // SOCKS5 原生握手
      rawSocket.once('connect', async () => {
        try {
          await handshakeSocks5(rawSocket, host, port);
          secureSocket = tls.connect({ socket: rawSocket, servername: host });
          secureSocket.once('secureConnect', () => succeed(secureSocket));
          secureSocket.once('error', fail);
        } catch (err) {
          fail(err);
        }
      });
      rawSocket.once('error', fail);
      return;
    }

    // HTTP CONNECT 原生握手
    rawSocket.once('connect', () => {
      const authority = connectAuthority(host, port);
      rawSocket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
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
      // 代理 200 响应可能与 TLS 首字节（ServerHello 起始）同包到达；
      // 头结束之后的残留字节必须原样交给 TLS 层，否则 TLS 流从中段开始解密
      // → ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC。
      const leftover = connectHead.subarray(end + 4);
      rawSocket.removeListener('error', fail);
      secureSocket = tls.connect({ socket: rawSocket, servername: host });
      secureSocket.once('secureConnect', () => succeed(secureSocket));
      secureSocket.once('error', fail);
      if (leftover.length > 0) {
        // tls.connect 接管前 socket 已 pause 吗？没有——removeListener 后新数据直达 TLS；
        // 残留字节需在 TLS 'data' 管道接好后注入，等 secureConnect 之前注入会当作 TLS 记录处理（正确）。
        secureSocket.unshift?.(leftover);
        // unshift 不可用时（理论不该发生）退化为直接写回 socket 事件循环
        if (!secureSocket.unshift) rawSocket.emit('data', leftover);
      }
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

export function connectAuthority(host, port) {
  // CONNECT authority 必须始终包含端口，IPv6 字面量必须加方括号。
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${normalizedHost}:${port}`;
}

function requestAuthority(host, port, protocol) {
  // HTTP Host 必须反映实际连接端口；IPv6 字面量还需要方括号避免与端口分隔符混淆。
  const normalizedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const defaultPort = protocol === 'http' ? 80 : 443;
  return Number(port) === defaultPort ? normalizedHost : `${normalizedHost}:${port}`;
}

function requestHead(method, host, port, protocol, path, headers, body, connection = 'keep-alive') {
  // 裸写请求时主动补齐长度，避免上游等待永远不会到来的 chunked 尾块。
  // body 统一转 Buffer 单次编码：请求头与正文分开 write，避免整包字符串拼接
  // 再编码产生的双份大拷贝（60MB 级请求 ~120MB 瞬时分配）。
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const normalizedHeaders = { ...headers };
  const hasContentLength = Object.keys(normalizedHeaders).some((key) => key.toLowerCase() === 'content-length');
  const hasContentType = Object.keys(normalizedHeaders).some((key) => key.toLowerCase() === 'content-type');
  if (!hasContentLength) normalizedHeaders['content-length'] = bodyBuffer.length;
  if (!hasContentType) normalizedHeaders['content-type'] = 'application/json';
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${requestAuthority(host, port, protocol)}`, `Connection: ${connection}`];
  for (const [key, value] of Object.entries(normalizedHeaders)) {
    if (Array.isArray(value)) value.forEach((item) => lines.push(`${key}: ${item}`));
    else if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  return { head: `${lines.join('\r\n')}\r\n\r\n`, body: bodyBuffer };
}

// 统一写出口：请求头与正文分开写（见 requestHead）。
function writeRequest(socket, method, host, port, protocol, path, headers, body, connection) {
  const parts = requestHead(method, host, port, protocol, path, headers, body, connection);
  socket.write(parts.head);
  if (parts.body.length) socket.write(parts.body);
}

// 解析 HTTP 响应头：状态行/头字段/正文边界（支持 chunked 与 content-length）
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

function parseChunkSize(sizeText) {
  if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error(`invalid chunk size: ${sizeText}`);
  const size = Number.parseInt(sizeText, 16);
  if (!Number.isSafeInteger(size)) throw new Error(`invalid chunk size: ${sizeText}`);
  if (size > MAX_CHUNK_BYTES) throw new Error(`chunk size exceeds limit: ${sizeText}`);
  return size;
}

// 增量解码 HTTP/1.1 chunked，避免再由 ServerResponse 套一层 chunked。
export class DechunkTransform extends Transform {
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.chunkRemaining = null;
    this.expectingChunkTerminator = false;
    this.readingTrailers = false;
    this.finished = false;
  }

  consume(count) {
    this.buffer = count >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(count);
  }

  _transform(chunk, _encoding, callback) {
    if (this.finished) {
      callback(new Error('unexpected data after chunked body'));
      return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (true) {
      if (this.readingTrailers) {
        const lineEnd = this.buffer.indexOf('\r\n');
        if (lineEnd === -1) {
          if (this.buffer.length > MAX_CHUNK_CONTROL_LINE_BYTES) {
            callback(new Error('chunk trailer line too large'));
            return;
          }
          break;
        }
        if (lineEnd > MAX_CHUNK_CONTROL_LINE_BYTES) {
          callback(new Error('chunk trailer line too large'));
          return;
        }
        if (lineEnd === 0) {
          this.consume(2);
          this.readingTrailers = false;
          this.finished = true;
          // 帧完整终止即结束流：keep-alive 连接不会靠 socket 关闭来收尾，
          // 连接池归还也依赖这个「正文干净完成」信号。
          this.push(null);
          if (this.buffer.length) {
            callback(new Error('unexpected data after chunked body'));
            return;
          }
          break;
        }
        const trailer = this.buffer.subarray(0, lineEnd).toString('latin1');
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*:/.test(trailer)) {
          callback(new Error('invalid chunk trailer'));
          return;
        }
        this.consume(lineEnd + 2);
        continue;
      }
      if (this.chunkRemaining === null && !this.expectingChunkTerminator) {
        const lineEnd = this.buffer.indexOf('\r\n');
        if (lineEnd === -1) {
          if (this.buffer.length > MAX_CHUNK_CONTROL_LINE_BYTES) {
            callback(new Error('chunk size line too large'));
            return;
          }
          break;
        }
        if (lineEnd > MAX_CHUNK_CONTROL_LINE_BYTES) {
          callback(new Error('chunk size line too large'));
          return;
        }
        const sizeText = this.buffer.subarray(0, lineEnd).toString('latin1').split(';')[0].trim();
        try {
          this.chunkRemaining = parseChunkSize(sizeText);
        } catch (error) {
          callback(error);
          return;
        }
        this.consume(lineEnd + 2);
        if (this.chunkRemaining === 0) {
          this.chunkRemaining = null;
          this.readingTrailers = true;
          continue;
        }
      }
      if (this.chunkRemaining > 0) {
        if (!this.buffer.length) break;
        const take = Math.min(this.chunkRemaining, this.buffer.length);
        this.push(this.buffer.subarray(0, take));
        this.consume(take);
        this.chunkRemaining -= take;
        if (this.chunkRemaining > 0) break;
        this.expectingChunkTerminator = true;
      }
      if (this.expectingChunkTerminator) {
        if (this.buffer.length < 2) break;
        if (this.buffer[0] !== 13 || this.buffer[1] !== 10) {
          callback(new Error('invalid chunk terminator'));
          return;
        }
        this.consume(2);
        this.expectingChunkTerminator = false;
        this.chunkRemaining = null;
      }
    }
    callback();
  }

  _flush(callback) {
    if (this.finished) {
      callback();
      return;
    }
    if (this.readingTrailers) {
      callback(new Error('truncated chunk trailer'));
      return;
    }
    if (this.chunkRemaining !== null) {
      if (this.chunkRemaining > 0) callback(new Error('truncated chunk data'));
      else callback(new Error('missing chunk terminator'));
      return;
    }
    if (this.expectingChunkTerminator) {
      callback(new Error('missing chunk terminator'));
      return;
    }
    callback(new Error(this.buffer.length ? 'truncated chunk size' : 'missing final zero chunk'));
  }
}

function contentLengthValue(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const length = Number(text);
  return Number.isSafeInteger(length) ? length : null;
}

class ContentLengthTransform extends Transform {
  constructor(value) {
    super();
    this.expected = contentLengthValue(value);
    this.received = 0;
  }

  _transform(chunk, _encoding, callback) {
    if (this.expected === null) {
      callback(new Error('invalid content-length'));
      return;
    }
    if (this.received + chunk.length > this.expected) {
      callback(new Error('content-length body exceeded'));
      return;
    }
    this.received += chunk.length;
    this.push(chunk);
    if (this.received === this.expected) {
      // 字节数读满即结束流（keep-alive 语义下不等待 socket 关闭）。
      this.push(null);
    }
    callback();
  }

  _flush(callback) {
    if (this.expected === null) callback(new Error('invalid content-length'));
    else if (this.received !== this.expected) callback(new Error('content-length body truncated'));
    else callback();
  }
}

// ---------- 上游连接池（keep-alive 复用，免每请求 TCP+TLS 握手） ----------
// 只收留「请求声明 keep-alive + 响应未要求关闭 + 帧完整干净消费」的连接；
// 任何错误/截断路径照旧销毁。上限：每键 4 条、全局 24 条、空闲 15 秒回收。
// 复用前校验 socket 健康（未销毁、可读可写、无残留字节），不健康即弃用重建。
const POOL_PER_KEY = 4;
const POOL_TOTAL = 24;
const POOL_IDLE_MS = 15_000;
const connectionPool = new Map();

function destroyQuietly(socket) {
  try { socket.destroy(); } catch { /* 尽力 */ }
}

function poolIdentity(options, host, port) {
  const protocol = options.protocol === 'http' ? 'http' : 'https';
  const proxyTag = options.viaProxy && options.proxy ? `${options.proxy.host}:${options.proxy.port}` : 'direct';
  return `${protocol}://${host}:${port}|${proxyTag}`;
}

function poolDrop(key, socket) {
  const list = connectionPool.get(key);
  if (!list) return;
  const at = list.indexOf(socket);
  if (at !== -1) list.splice(at, 1);
  if (!list.length) connectionPool.delete(key);
}

function poolPark(socket, key, eligible) {
  if (socket.__pooled) return;
  socket.__pooled = true;
  if (!eligible || socket.destroyed) {
    destroyQuietly(socket);
    return;
  }
  try { socket.setTimeout(0); } catch { /* 尽力 */ }
  try { socket.pause(); } catch { /* 尽力 */ }
  socket.removeAllListeners('data');
  socket.removeAllListeners('error');
  socket.removeAllListeners('end');
  socket.removeAllListeners('close');
  const idleTimer = setTimeout(() => {
    socket.__pooled = false;
    poolDrop(key, socket);
    destroyQuietly(socket);
  }, POOL_IDLE_MS);
  idleTimer.unref?.();
  socket.__poolIdleTimer = idleTimer;
  socket.once('error', () => {
    clearTimeout(idleTimer);
    poolDrop(key, socket);
    destroyQuietly(socket);
  });
  socket.once('close', () => {
    clearTimeout(idleTimer);
    poolDrop(key, socket);
  });
  const list = connectionPool.get(key) || [];
  connectionPool.set(key, list);
  list.push(socket);
  while (list.length > POOL_PER_KEY) destroyQuietly(list.shift());
  let total = 0;
  for (const sockets of connectionPool.values()) total += sockets.length;
  while (total > POOL_TOTAL && connectionPool.size) {
    const firstKey = connectionPool.keys().next().value;
    const oldest = connectionPool.get(firstKey)?.shift();
    if (!oldest) {
      connectionPool.delete(firstKey);
      continue;
    }
    clearTimeout(oldest.__poolIdleTimer);
    destroyQuietly(oldest);
    total -= 1;
  }
}

function poolTake(key) {
  const list = connectionPool.get(key);
  while (list && list.length) {
    const socket = list.shift();
    if (!socket) break;
    clearTimeout(socket.__poolIdleTimer);
    socket.__pooled = false;
    if (socket.destroyed || !socket.readable || !socket.writable || (socket.readableLength || 0) > 0) {
      destroyQuietly(socket);
      continue;
    }
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    try { socket.setTimeout(0); } catch { /* 尽力 */ }
    // 入池时已 pause；取出复用必须恢复流动，否则响应头永远等不到。
    try { socket.resume(); } catch { /* 尽力 */ }
    return socket;
  }
  if (list && !list.length) connectionPool.delete(key);
  return null;
}

/** 连接池状态（测试/诊断用）：当前池化键数与连接总数。 */
export function connectionPoolStats() {
  let sockets = 0;
  for (const list of connectionPool.values()) sockets += list.length;
  return { keys: connectionPool.size, sockets };
}

// 上游响应体流构造：按传输编码拆分块并执行空闲超时与取消信号
function bodyStreamFor(socket, headers, initialBody, idleMs, signal, host, onCleanEnd) {
  // 响应头解析完成后立即返回流，并把客户端取消继续传播到 socket。
  const output = new PassThrough();
  const chunked = /chunked/i.test(String(headers['transfer-encoding'] || ''));
  const decoder = chunked
    ? new DechunkTransform()
    : headers['content-length'] !== undefined
      ? new ContentLengthTransform(headers['content-length'])
      : new PassThrough();
  delete headers['transfer-encoding'];
  delete headers['content-length'];

  const onAbort = () => socket.destroy(abortError(host));
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.setTimeout(idleMs, () => socket.destroy(new Error(`stream idle timeout for ${host}`)));
  socket.once('close', () => signal?.removeEventListener('abort', onAbort));
  socket.once('error', (error) => decoder.destroy(error));
  decoder.once('error', (error) => {
    socket.destroy(error);
    output.destroy(error);
  });
  output.once('close', () => {
    // 调用方只读取错误摘要或客户端提前断开时，必须把取消反向传播到底层连接。
    if (!output.readableEnded && !socket.destroyed) {
      decoder.destroy();
      socket.destroy();
    }
  });
  if (onCleanEnd) {
    // 正文按帧完整消费：连接可安全回池（响应边界后无本请求残留字节）。
    output.once('end', () => {
      try { socket.unpipe(decoder); } catch { /* 尽力 */ }
      onCleanEnd();
    });
  }
  decoder.pipe(output);
  // 响应头和短正文可能同包到达；先把 output 交给调用方，再喂初始正文，确保错误可由消费者接住。
  queueMicrotask(() => {
    if (decoder.destroyed || output.destroyed) return;
    if (initialBody.length) decoder.write(initialBody);
    socket.pipe(decoder);
    socket.resume();
  });
  return output;
}

// 打开真正的流式 HTTPS 请求；Promise 只等待响应头，不等待完整响应体。
export async function openHttpsStream(options) {
  const {
    host,
    path,
    method = 'POST',
    viaProxy = false,
    proxy,
    headers = {},
    body = '',
    signal,
    connector = connectTls,
  } = options;
  const port = options.port || (options.protocol === 'http' ? 80 : 443);
  const timeouts = resolveTimeouts(options.timeouts);
  const selectedConnector = options.connector || (options.protocol === 'http' ? connectTcp : connector);
  // 连接池复用仅对默认连接器（真实 TCP/TLS socket）生效；自定义连接器（测试桩/
  // 特殊通道）语义不受池影响。命中即免一次 TCP+TLS 握手。
  const useDefaultConnector = !options.connector;
  const poolKey = poolIdentity(options, host, port);
  let socket = useDefaultConnector ? poolTake(poolKey) : null;
  if (!socket) {
    socket = await selectedConnector({ host, port, viaProxy, proxy, timeoutMs: timeouts.connectMs, signal });
  }
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
      // 暂停后再移除头部 data 监听，避免同一轮事件中的后续正文无人接收而丢失。
      socket.pause();
      settled = true;
      cleanupBeforeHead();
      const { status, headers: responseHeaders } = parseResponseHead(responseBuffer.subarray(0, end));
      const initialBody = responseBuffer.subarray(end + 4);
      // 上游显式要求关闭（connection: close）或自定义连接器时不入池。
      const poolEligible = useDefaultConnector
        && String(responseHeaders['connection'] || '').toLowerCase() !== 'close';
      const release = () => poolPark(socket, poolKey, poolEligible);
      const stream = bodyStreamFor(socket, responseHeaders, initialBody, timeouts.streamIdleMs, signal, host, release);
      resolve({ status, headers: responseHeaders, stream, socket, release });
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('data', onData);
    socket.once('error', fail);
    socket.once('end', onEndBeforeHead);
    writeRequest(socket, method, host, port, options.protocol || 'https', path, headers, body);
  });
}

function dechunkBuffer(buffer) {
  // 非流式请求已经收齐，必须验证零块、每块 CRLF 和 trailer 终止，不能返回部分成功正文。
  const chunks = [];
  let cursor = 0;
  while (true) {
    const lineEnd = buffer.indexOf('\r\n', cursor);
    if (lineEnd === -1) {
      throw new Error(cursor === buffer.length ? 'missing final zero chunk' : 'truncated chunk size');
    }
    const sizeText = buffer.subarray(cursor, lineEnd).toString('latin1').split(';')[0].trim();
    const size = parseChunkSize(sizeText);
    const start = lineEnd + 2;
    if (size === 0) {
      cursor = start;
      while (true) {
        const trailerEnd = buffer.indexOf('\r\n', cursor);
        if (trailerEnd === -1) throw new Error('truncated chunk trailer');
        if (trailerEnd === cursor) {
          cursor += 2;
          if (cursor !== buffer.length) throw new Error('unexpected data after chunked body');
          return Buffer.concat(chunks);
        }
        const trailer = buffer.subarray(cursor, trailerEnd).toString('latin1');
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\s*:/.test(trailer)) throw new Error('invalid chunk trailer');
        cursor = trailerEnd + 2;
      }
    }
    if (buffer.length < start + size) throw new Error('truncated chunk data');
    if (buffer.length < start + size + 2) throw new Error('missing chunk terminator');
    if (buffer[start + size] !== 13 || buffer[start + size + 1] !== 10) {
      throw new Error('invalid chunk terminator');
    }
    chunks.push(buffer.subarray(start, start + size));
    cursor = start + size + 2;
  }
}

// 控制类和视觉中继使用的一次性请求，保留整体等待超时。
export async function rawHttpsRequest(options) {
  const timeouts = resolveTimeouts(options.timeouts);
  const configuredLimit = Number(options.maxResponseBytes);
  const maxResponseBytes = Number.isFinite(configuredLimit)
    ? Math.max(0, Math.floor(configuredLimit))
    : DEFAULT_MAX_RESPONSE_BYTES;
  const requestPort = options.port || (options.protocol === 'http' ? 80 : 443);
  const socket = await (options.connector || (options.protocol === 'http' ? connectTcp : connectTls))({
    host: options.host,
    port: requestPort,
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
    socket.on('error', (error) => {
      // 个别代理出口（v2rayN 节点对部分域）在 TLS close_notify 阶段扰动残余
      // 字节，触发 bad record mac；此时响应头与 body 往往已完整到手。
      // 一次性请求按已收数据尽力收敛：完整则成功，不完整才失败。
      if (responseHead !== null) {
        try {
          finishResponse(responseHead, Buffer.concat(bodyChunks, responseBodyBytes));
          return;
        } catch { /* 解析失败落到原错误 */ }
      }
      finish(error);
    });
    function finishResponse(headBuf, bodyBuf) {
      const parsed = parseResponseHead(headBuf);
      let responseBody = bodyBuf;
      if (/chunked/i.test(String(parsed.headers['transfer-encoding'] || ''))) {
        responseBody = dechunkBuffer(responseBody);
      } else if (parsed.headers['content-length'] !== undefined) {
        const expected = contentLengthValue(parsed.headers['content-length']);
        if (expected === null) throw new Error('invalid content-length');
        if (responseBody.length < expected) throw new Error('content-length body truncated');
        if (responseBody.length > expected) throw new Error('content-length body exceeded');
      }
      finish(null, { status: parsed.status, headers: parsed.headers, bodyText: responseBody.toString('utf8') });
    }
    socket.once('end', () => {
      try {
        if (responseHead === null) {
          // 连接在响应头完整到达前关闭：必须报截断错误，不能返回 status:0 的伪成功
          // （调用方会把 0 当真实状态码透传，掩盖"上游未响应"的真相）。
          throw new Error(`upstream ${options.host} closed before complete response header`);
        }
        finishResponse(responseHead, Buffer.concat(bodyChunks, responseBodyBytes));
      } catch (error) {
        finish(error);
      }
    });
    // 一次性聚合请求按 close 收尾：完整语义依赖 socket end（暂不入连接池）。
    socket.write(requestHead(
      options.method || 'POST',
      options.host,
      requestPort,
      options.protocol || 'https',
      options.path,
      options.headers || {},
      options.body || '',
      'close',
    ).head);
    {
      const bodyBuffer = Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body ?? ''), 'utf8');
      if (bodyBuffer.length) socket.write(bodyBuffer);
    }
  });
}
