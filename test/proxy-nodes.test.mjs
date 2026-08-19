import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseNodeUrl, connectNode } from '../lib/proxy-nodes.mjs';

// ---------- URL 解析 ----------

test('ss:// 解析：base64 与明文两种格式', () => {
  const b64 = Buffer.from('aes-256-gcm:mypassword').toString('base64');
  const node = parseNodeUrl(`ss://${b64}@example.com:8388#我的节点`);
  assert.equal(node.type, 'ss');
  assert.equal(node.host, 'example.com');
  assert.equal(node.port, 8388);
  assert.equal(node.method, 'aes-256-gcm');
  assert.equal(node.password, 'mypassword');

  const plain = parseNodeUrl('ss://aes-256-gcm:secret@1.2.3.4:9000');
  assert.equal(plain.type, 'ss');
  assert.equal(plain.method, 'aes-256-gcm');
  assert.equal(plain.password, 'secret');
  assert.equal(plain.host, '1.2.3.4');
});

test('trojan:// 解析：密码 + SNI', () => {
  const node = parseNodeUrl('trojan://pass123@node.example.com:443?security=tls&sni=cdn.example.com#机场A');
  assert.equal(node.type, 'trojan');
  assert.equal(node.password, 'pass123');
  assert.equal(node.host, 'node.example.com');
  assert.equal(node.port, 443);
  assert.equal(node.sni, 'cdn.example.com');
});

test('vless:// 解析：UUID + SNI', () => {
  const node = parseNodeUrl('vless://3f9e8c1a-0000-4000-8000-1234567890ab@v.example.com:443?security=tls&sni=v.example.com&type=tcp&encryption=none#VL');
  assert.equal(node.type, 'vless');
  assert.equal(node.uuid, '3f9e8c1a-0000-4000-8000-1234567890ab');
  assert.equal(node.host, 'v.example.com');
  assert.equal(node.port, 443);
});

test('非法节点链接拒绝', () => {
  assert.equal(parseNodeUrl(''), null);
  assert.equal(parseNodeUrl('not-a-url'), null);
  assert.equal(parseNodeUrl('ss://aes-256-gcm:pass@'), null, '缺 host');
  assert.equal(parseNodeUrl('ss://chacha20-ietf-poly1305:pass@host:8388'), null, 'Node 不支持 chacha 组合 tag，应拒绝');
  assert.equal(parseNodeUrl('ss://badmethod:pass@host:8388'), null, '不支持的加密方法');
  assert.equal(parseNodeUrl('vless://not-a-uuid@host:443'), null, '非法 UUID');
  assert.equal(parseNodeUrl('trojan://pass@host:99999'), null, '端口越界');
});

test('socks5/http 无用户信息形式解析', () => {
  const s5 = parseNodeUrl('socks5://127.0.0.1:10808');
  assert.equal(s5.type, 'socks5');
  assert.equal(s5.port, 10808);
  const hp = parseNodeUrl('http://127.0.0.1:10809');
  assert.equal(hp.type, 'http');
});

// ---------- 隧道协议握手（本地 mock 节点） ----------

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

test('trojan 隧道：TLS 握手后发送密码校验头与目标地址', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-tunnel-'));
  const keyPath = path.join(tempDir, 'key.pem');
  const certPath = path.join(tempDir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1'],
  { stdio: 'ignore' });

  let receivedHead = null;
  const server = tls.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }, (socket) => {
    socket.once('data', (chunk) => {
      receivedHead = chunk;
      // 模拟节点：转发响应（这里直接回 200 文本）
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    });
  });
  await listen(server);

  const node = parseNodeUrl(`trojan://node-pass@127.0.0.1:${server.address().port}?sni=127.0.0.1`);
  const tunnel = await connectNode(node, 'api.example.com', 443, { timeoutMs: 5000 });
  const response = await new Promise((resolve, reject) => {
    let data = '';
    tunnel.on('data', (chunk) => { data += chunk.toString(); });
    tunnel.on('error', reject);
    setTimeout(() => resolve(data), 300);
  });
  tunnel.destroy();
  server.close();

  assert.ok(receivedHead, '节点应收到头部');
  const text = receivedHead.toString('utf8');
  assert.ok(text.startsWith('node-pass\r\n'), 'trojan 密码校验头');
  assert.ok(text.includes('api.example.com'), '目标域名');
  assert.ok(response.includes('200 OK'), '隧道数据可达');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('vless 隧道：TLS 握手后发送版本/UUID/命令头', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-tunnel-'));
  const keyPath = path.join(tempDir, 'key.pem');
  const certPath = path.join(tempDir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1'],
  { stdio: 'ignore' });

  let receivedHead = null;
  const server = tls.createServer({
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  }, (socket) => {
    socket.once('data', (chunk) => { receivedHead = chunk; });
  });
  await listen(server);

  const uuid = '3f9e8c1a-0000-4000-8000-1234567890ab';
  const node = parseNodeUrl(`vless://${uuid}@127.0.0.1:${server.address().port}?sni=127.0.0.1`);
  const tunnel = await connectNode(node, 'api.deepseek.com', 443, { timeoutMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  tunnel.destroy();
  server.close();

  assert.ok(receivedHead, '节点应收到 vless 头');
  assert.equal(receivedHead[0], 0x00, 'vless 版本 0');
  const uuidBytes = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  assert.deepEqual(receivedHead.subarray(1, 17), uuidBytes, 'UUID 16 字节');
  assert.equal(receivedHead[17], 0x00, 'addon 长度 0');
  assert.equal(receivedHead[18], 0x01, '命令 = TCP');
  assert.equal(receivedHead[19], 0x03, 'ATYP = 域名');
  const domainLen = receivedHead[20];
  assert.equal(receivedHead.subarray(21, 21 + domainLen).toString(), 'api.deepseek.com', '目标域名');
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('SS 隧道：加密流中携带目标地址头，mock 节点可解密验证', async () => {
  // mock ss 节点：收 salt + 解密首块，验证地址头与数据
  let verified = null;
  const server = net.createServer((socket) => {
    let salt = null;
    let nonce = Buffer.alloc(12);
    let state = 'salt';
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (state === 'salt') {
          if (buffer.length < 16) return;
          salt = buffer.subarray(0, 16);
          buffer = buffer.subarray(16);
          state = 'length';
        }
        if (state === 'length') {
          if (buffer.length < 2 + 16) return;
          const key = cryptoHkdf(salt);
          const decipher = cryptoCreateDecipher('aes-256-gcm', key, nonce);
          decipher.setAuthTag(buffer.subarray(2, 18));
          const lenBuf = Buffer.concat([decipher.update(buffer.subarray(0, 2)), decipher.final()]);
          buffer = buffer.subarray(18);
          nonce = incNonce(nonce);
          state = 'payload';
          verified = { len: lenBuf.readUInt16BE(0), payload: null };
        }
        if (state === 'payload' && verified) {
          const need = verified.len + 16;
          if (buffer.length < need) return;
          const key = cryptoHkdf(salt);
          const decipher = cryptoCreateDecipher('aes-256-gcm', key, nonce);
          decipher.setAuthTag(buffer.subarray(verified.len, need));
          verified.payload = Buffer.concat([decipher.update(buffer.subarray(0, verified.len)), decipher.final()]);
          state = 'done';
          socket.end();
        }
      } catch { /* mock 解析失败保持等待 */ }
    });
  });
  await listen(server);

  const node = parseNodeUrl(`ss://aes-256-gcm:mockpass@127.0.0.1:${server.address().port}`);
  const tunnel = await connectNode(node, 'api.example.com', 443, { timeoutMs: 5000 });
  tunnel.write('hello');
  await new Promise((resolve) => setTimeout(resolve, 300));
  tunnel.destroy();
  server.close();

  assert.ok(verified?.payload, 'mock 节点应解密出载荷');
  const text = verified.payload.toString('utf8');
  assert.ok(text.includes('api.example.com'), `地址头含目标域名: ${text}`);
  assert.ok(text.includes('hello'), '数据透传');
});

// 测试内辅助（与实现一致的最小派生/解密）
import crypto from 'node:crypto';
// mock 派生与实现一致：EVP_BytesToKey(md5 迭代) + HKDF-SHA1(salt)
function evpBytesToKey(password, keyLen) {
  const derived = [];
  let previous = Buffer.alloc(0);
  while (derived.length < keyLen) {
    previous = crypto.createHash('md5').update(Buffer.concat([previous, Buffer.from(password, 'utf8')])).digest();
    derived.push(previous);
  }
  return Buffer.concat(derived, keyLen);
}
function cryptoHkdf(salt) {
  const master = evpBytesToKey('mockpass', 32);
  return Buffer.from(crypto.hkdfSync('sha1', master, salt, Buffer.from('ss-subkey'), 32));
}
function cryptoCreateDecipher(algo, key, nonce) {
  return crypto.createDecipheriv(algo, key, nonce);
}
function incNonce(nonce) {
  const next = Buffer.from(nonce);
  for (let i = next.length - 1; i >= 0; i -= 1) {
    next[i] = (next[i] + 1) & 0xff;
    if (next[i] !== 0) break;
  }
  return next;
}
