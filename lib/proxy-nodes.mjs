// ---------- 代理节点直连（零依赖多协议隧道） ----------
// 目标：路由直接连接机场/自建节点（shadowsocks / trojan / vless），
// 不再依赖本地代理软件（v2rayN 等）中转——节点协议可直连就不绕一道。
// 已支持：ss://（aes-256-gcm）、trojan://、vless://、socks5://、http://。
// 说明：Node 的 chacha20-poly1305 不产生标准组合模式 tag（与主流 ss 客户端不互通），
// 故 SS 仅支持 aes-256-gcm；vmess（AEAD 头复杂）、hysteria（依赖 QUIC）需本地代理软件。
// 安全约束：节点凭据只来自用户管理页输入（config.targets[].proxyUrl），
// 不写日志、不回显完整值；与 envKey 同级风险面（本机 config.json）。

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { Duplex } from 'node:stream';

// ---------- 节点分享链接解析（v2rayN / 机场导出格式） ----------

function base64UrlDecode(value) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = text.padEnd(Math.ceil(text.length / 4) * 4, '=');
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function parseUserInfoPart(part) {
  // ss://base64(method:password)@host:port 或 ss://method:password@host:port
  if (part.includes(':')) {
    const [method, ...rest] = part.split(':');
    return { method, password: rest.join(':') };
  }
  const decoded = base64UrlDecode(part);
  if (decoded.includes(':')) {
    const [method, ...rest] = decoded.split(':');
    return { method, password: rest.join(':') };
  }
  return { method: '', password: part };
}

/**
 * 解析节点分享链接：
 * - ss://base64(method:password)@host:port  /  ss://method:password@host:port
 * - trojan://password@host:port?security=tls&sni=example.com
 * - vless://uuid@host:port?security=tls&sni=example.com&type=tcp&encryption=none
 * - socks5://user:pass@host:port  /  http://user:pass@host:port（本地代理）
 * 非法返回 null。
 */
export function parseNodeUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let match = url.match(/^(ss|trojan|vless|socks5|http)s?:\/\/([^@/?#]+)@([^/?#:]+)(?::(\d{1,5}))?([^#]*)(?:#.*)?$/i);
  if (!match) {
    // 无用户信息的形式（socks5/http 常见）：scheme://host:port
    match = url.match(/^(socks5|http)s?:\/\/([^/?#:]+)(?::(\d{1,5}))?([^#]*)(?:#.*)?$/i);
    if (!match) return null;
    const [, scheme, host, port, query] = match;
    return {
      type: scheme.toLowerCase(),
      host,
      port: port ? Number(port) : (scheme.toLowerCase() === 'socks5' ? 10808 : 10809),
      password: '',
      method: '',
      uuid: '',
      sni: '',
      name: '',
    };
  }
  const [, scheme, userInfo, host, port, queryPart] = match;
  const query = new URLSearchParams(queryPart || '');
  const node = {
    type: scheme.toLowerCase(),
    host,
    port: port ? Number(port) : 443,
    password: '',
    method: '',
    uuid: '',
    sni: query.get('sni') || query.get('peer') || '',
    name: '',
  };
  if (node.type === 'ss') {
    const parsed = parseUserInfoPart(userInfo);
    node.method = (parsed.method || '').toLowerCase();
    node.password = parsed.password || '';
  } else {
    node.password = decodeURIComponent(userInfo);
    if (node.type === 'vless') node.uuid = decodeURIComponent(userInfo);
  }
  if (!node.host || !/^[a-z0-9.-]+$/i.test(node.host)) return null;
  if (!Number.isSafeInteger(node.port) || node.port < 1 || node.port > 65535) return null;
  if (node.type === 'ss' && node.method !== 'aes-256-gcm') return null;
  if (node.type === 'vless' && !/^[0-9a-f-]{36}$/i.test(node.uuid)) return null;
  return node;
}

// ---------- shadowsocks AEAD 流式隧道（RFC 8439 / ss-2017） ----------

function evpBytesToKey(password, keyLen) {
  // ss 规范主密钥派生：MD5 迭代拼接（与 OpenSSL EVP_BytesToKey 一致）
  const derived = [];
  let previous = Buffer.alloc(0);
  while (derived.length < keyLen) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from(password, 'utf8')])).digest();
    derived.push(previous);
  }
  return Buffer.concat(derived, keyLen);
}

const SS_SALT_LENGTHS = { 'aes-256-gcm': 16 };
const SS_IV_LENGTH = 12;
const SS_CHUNK_MAX = 0x3fff;
const SS_TAG_LENGTH = 16;

function ssSubkey(masterKey, salt) {
  // AEAD 流式子密钥：HKDF-SHA1（ss-2017 规范，salt 参与派生，与主流客户端互通）。
  // 注意 hkdfSync 返回 ArrayBuffer（Node 19+），必须转 Buffer 才能作 cipher key。
  return Buffer.from(crypto.hkdfSync('sha1', masterKey, salt, Buffer.from('ss-subkey'), masterKey.length));
}

/**
 * SS AEAD 双向隧道：写入侧按块加密发送（2B 长度 + 长度 tag + 数据 + 数据 tag），
 * 读取侧按块解密还原；目标地址头作为第一块数据发出。
 * 实现为 Duplex：外部直接读写（上层再套 TLS）。
 */
class ShadowsocksTunnel extends Duplex {
  constructor(node, targetHost, targetPort) {
    super();
    const keyLen = 32;
    const masterKey = evpBytesToKey(node.password, keyLen);
    const salt = crypto.randomBytes(SS_SALT_LENGTHS[node.method]);
    // 发送侧：本端随机 salt 派生发送子密钥；接收侧：对端 salt 到达后派生解密子密钥
    this.masterKey = masterKey;
    this.subkey = ssSubkey(masterKey, salt);
    this.salt = salt;
    this.sentSalt = false;
    this.receivedSalt = false;
    this.encryptNonce = Buffer.alloc(SS_IV_LENGTH);
    this.decryptNonce = Buffer.alloc(SS_IV_LENGTH);
    this.writeBuffer = Buffer.alloc(0);
    this.readBuffer = Buffer.alloc(0);
    this.readState = 'length'; // length | payload
    this.readLength = 0;
    // 目标地址头（第一块载荷）
    this.pendingHeader = Buffer.concat([
      Buffer.from([atypFor(targetHost)]),
      ...addrParts(targetHost),
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ]);
    this.headerSent = false;
    this.destroyedByUs = false;
  }

  _read() { /* 被动推送：解密后的数据经 push 输出 */ }

  _write(chunk, _encoding, callback) {
    this.writeBuffer = Buffer.concat([this.writeBuffer, chunk]);
    try {
      this.flushWrite();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  flushWrite() {
    const cipher = crypto.createCipheriv('aes-256-gcm', this.subkey, this.encryptNonce);
    // 发送 salt（仅一次）
    if (!this.sentSalt) {
      this.sentSalt = true;
      this.push(this.salt);
    }
    while (this.writeBuffer.length > 0 || !this.headerSent) {
      let payload;
      if (!this.headerSent) {
        const header = this.pendingHeader;
        const headRoom = SS_CHUNK_MAX - header.length;
        payload = Buffer.concat([header, this.writeBuffer.subarray(0, Math.max(0, headRoom))]);
        this.writeBuffer = this.writeBuffer.subarray(Math.max(0, headRoom));
        this.headerSent = true;
      } else {
        payload = this.writeBuffer.subarray(0, SS_CHUNK_MAX);
        this.writeBuffer = this.writeBuffer.subarray(payload.length);
      }
      if (payload.length === 0) break;
      const lengthBuf = Buffer.alloc(2);
      lengthBuf.writeUInt16BE(payload.length, 0);
      // 规范：长度块与数据块各自使用递增后的 nonce（每块独立）。
      // Node 的 GCM 是分离模式：final() 只返回密文，tag 需 getAuthTag() 取，按规范拼在密文后。
      const lengthCipher = crypto.createCipheriv('aes-256-gcm', this.subkey, this.encryptNonce);
      const encLength = Buffer.concat([
        lengthCipher.update(lengthBuf),
        lengthCipher.final(),
        lengthCipher.getAuthTag(),
      ]);
      this.incrementNonce(this.encryptNonce);
      const dataCipher = crypto.createCipheriv('aes-256-gcm', this.subkey, this.encryptNonce);
      const encData = Buffer.concat([
        dataCipher.update(payload),
        dataCipher.final(),
        dataCipher.getAuthTag(),
      ]);
      this.incrementNonce(this.encryptNonce);
      this.push(Buffer.concat([encLength, encData]));
      if (this.writeBuffer.length === 0 && this.headerSent) break;
    }
  }

  incrementNonce(nonce) {
    for (let i = nonce.length - 1; i >= 0; i -= 1) {
      nonce[i] = (nonce[i] + 1) & 0xff;
      if (nonce[i] !== 0) break;
    }
  }

  pushRead(data) {
    this.readBuffer = Buffer.concat([this.readBuffer, data]);
    // 先收 salt，并用它派生解密子密钥
    if (!this.receivedSalt) {
      const saltLen = SS_SALT_LENGTHS['aes-256-gcm'];
      if (this.readBuffer.length < saltLen) return;
      this.decryptSubkey = ssSubkey(this.masterKey, this.readBuffer.subarray(0, saltLen));
      this.readBuffer = this.readBuffer.subarray(saltLen);
      this.receivedSalt = true;
    }
    while (true) {
      if (this.readState === 'length') {
        if (this.readBuffer.length < 2 + SS_TAG_LENGTH) return;
        const lengthCipher = crypto.createDecipheriv('aes-256-gcm', this.decryptSubkey, this.decryptNonce);
        try {
          lengthCipher.setAuthTag(this.readBuffer.subarray(2, 2 + SS_TAG_LENGTH));
          const decrypted = Buffer.concat([
            lengthCipher.update(this.readBuffer.subarray(0, 2)),
            lengthCipher.final(),
          ]);
          this.readBuffer = this.readBuffer.subarray(2 + SS_TAG_LENGTH);
          this.readLength = decrypted.readUInt16BE(0);
          if (this.readLength > SS_CHUNK_MAX) {
            this.destroy(new Error('SS 分块长度非法'));
            return;
          }
        } catch {
          this.destroy(new Error('SS 长度块认证失败'));
          return;
        }
        this.incrementNonce(this.decryptNonce);
        this.readState = 'payload';
      }
      if (this.readState === 'payload') {
        if (this.readBuffer.length < this.readLength + SS_TAG_LENGTH) return;
        const dataCipher = crypto.createDecipheriv('aes-256-gcm', this.decryptSubkey, this.decryptNonce);
        try {
          dataCipher.setAuthTag(this.readBuffer.subarray(this.readLength, this.readLength + SS_TAG_LENGTH));
          const payload = Buffer.concat([
            dataCipher.update(this.readBuffer.subarray(0, this.readLength)),
            dataCipher.final(),
          ]);
          this.readBuffer = this.readBuffer.subarray(this.readLength + SS_TAG_LENGTH);
          if (!this.push(payload)) {
            // 背压：暂停接收（上层 socket 会在 drain 后恢复）
          }
        } catch {
          this.destroy(new Error('SS 数据块认证失败'));
          return;
        }
        this.incrementNonce(this.decryptNonce);
        this.readState = 'length';
      }
    }
  }

  _destroy(error, callback) {
    this.destroyedByUs = true;
    callback(error);
  }
}

function atypFor(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 0x01;
  return 0x03; // 域名
}

function addrParts(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').map((part) => Buffer.from([Number(part)]));
  }
  const bytes = Buffer.from(host, 'utf8');
  return [Buffer.from([bytes.length]), bytes];
}

// ---------- 节点隧道建立（返回已协商好的 socket，上层再套 TLS） ----------

function proxyError(message) {
  const error = new Error(message);
  error.code = 'node_proxy_failed';
  return error;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(proxyError(`${label} 超时`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * 直连节点并协商目标地址。返回：
 * - ss：已加密隧道（Duplex，尚未发目标头——由隧道内部在首个写入时发出）
 * - trojan/vless：已完成协议握手、目标地址已声明的 TLS socket
 */
export async function connectNode(node, targetHost, targetPort, options = {}) {
  const timeoutMs = options.timeoutMs || 15_000;
  const signal = options.signal;

  const rawConnect = () => new Promise((resolve, reject) => {
    const socket = net.connect(node.port, node.host);
    const onAbort = () => {
      socket.destroy();
      reject(proxyError('节点连接已取消'));
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    socket.once('connect', () => { cleanup(); resolve(socket); });
    socket.once('error', (error) => { cleanup(); reject(proxyError(`节点 ${node.host}:${node.port} 连接失败: ${error.message}`)); });
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  if (node.type === 'ss') {
    const raw = await withTimeout(rawConnect(), timeoutMs, 'SS 节点连接');
    const tunnel = new ShadowsocksTunnel(node, targetHost, targetPort);
    // 双向接线：raw <-> tunnel（tunnel 的读写侧各自加密/解密）
    raw.on('data', (chunk) => tunnel.pushRead(chunk));
    raw.on('error', (error) => tunnel.destroy(error));
    raw.on('close', () => tunnel.push(null));
    tunnel.on('data', (chunk) => raw.write(chunk));
    tunnel.on('error', (error) => raw.destroy(error));
    tunnel.on('close', () => raw.destroy());
    return tunnel;
  }

  // trojan / vless：TLS 到节点，然后写目标地址头
  const tlsSocket = await withTimeout(new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: node.host,
      port: node.port,
      servername: node.sni || node.host,
      rejectUnauthorized: false,
    });
    const onAbort = () => { socket.destroy(); reject(proxyError('节点 TLS 连接已取消')); };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    socket.once('secureConnect', () => { cleanup(); resolve(socket); });
    socket.once('error', (error) => { cleanup(); reject(proxyError(`节点 TLS 连接失败: ${error.message}`)); });
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
  }), timeoutMs, '节点 TLS 连接');

  const atyp = atypFor(targetHost);
  const addr = addrParts(targetHost);
  const portBuf = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
  let header;
  if (node.type === 'trojan') {
    header = Buffer.concat([
      Buffer.from(`${node.password}\r\n`, 'utf8'),
      Buffer.from([atyp]),
      ...addr,
      portBuf,
      Buffer.from('\r\n', 'utf8'),
    ]);
  } else {
    // vless：版本 + UUID(16B) + addon 长度 + 命令(1=TCP) + atyp + addr + port
    const uuid = Buffer.from(node.uuid.replace(/-/g, ''), 'hex');
    header = Buffer.concat([
      Buffer.from([0x00]),
      uuid,
      Buffer.from([0x00, 0x01]),
      Buffer.from([atyp]),
      ...addr,
      portBuf,
    ]);
  }
  await new Promise((resolve, reject) => {
    tlsSocket.write(header, (error) => (error ? reject(error) : resolve()));
  });
  return tlsSocket;
}

export function isDirectNodeType(type) {
  return type === 'ss' || type === 'trojan' || type === 'vless';
}
