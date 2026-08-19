import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  generateCodeVerifier,
  generateHexCodeVerifier,
  generateCodeChallenge,
  generateState,
  extractCodeFromInput,
  startLoopbackServer,
} from '../lib/auth/oauth-core.mjs';

test('oauth-core: PKCE S256 符合 RFC 7636 附录 B 测试向量', () => {
  // RFC 7636 Appendix B: verifier -> challenge
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = generateCodeChallenge(verifier);
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('oauth-core: code verifier 生成满足 RFC 长度与唯一性', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const v = generateCodeVerifier();
    assert.ok(v.length >= 43 && v.length <= 128, `verifier 长度 ${v.length} 不合规`);
    assert.match(v, /^[A-Za-z0-9\-_.]+$/);
    seen.add(v);
  }
  assert.equal(seen.size, 50);
});

test('oauth-core: OpenAI hex verifier 为 128 位 hex', () => {
  const v = generateHexCodeVerifier();
  assert.match(v, /^[0-9a-f]{128}$/);
});

test('oauth-core: state 具有足够熵且不重复', () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
});

test('oauth-core: extractCodeFromInput 支持纯 code / 回调 URL / 无 code 三种输入', () => {
  assert.equal(extractCodeFromInput('4/0AXXpurecode'), '4/0AXXpurecode');
  assert.equal(
    extractCodeFromInput('http://localhost:65112/oauth-callback?state=abc&code=4%2F0AXcode'),
    '4/0AXcode',
  );
  assert.equal(extractCodeFromInput('https://example.com/callback?error=access_denied'), '');
  assert.equal(extractCodeFromInput('  '), '');
});

test('oauth-core: loopback 双栈回调服务器接收正确 state 的 code 并返回成功页', async () => {
  const state = generateState();
  const server = await startLoopbackServer({ path: '/oauth-callback', state, timeoutMs: 5000 });

  assert.ok(server.redirectUri.startsWith('http://localhost:'), `redirectUri 应为 localhost 形式: ${server.redirectUri}`);
  assert.ok(server.port > 0);

  // 浏览器把 localhost 解析为 127.0.0.1 的场景
  const res = await fetch(`http://127.0.0.1:${server.port}/oauth-callback?code=CODE123&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Authorization Successful'));

  const result = await server.waitForCode();
  assert.equal(result.code, 'CODE123');
  assert.equal(result.state, state);
  server.close();
});

test('oauth-core: loopback 支持 IPv6 ::1 回调（localhost 双栈）', async (t) => {
  // 部分环境（防火墙/安全软件）拦截测试进程的 [::1] 出站直连（EACCES），
  // 与服务器双栈监听无关；先探测，不可达时跳过本用例。
  const net = await import('node:net');
  const ipv6Reachable = await new Promise((resolve) => {
    const probe = net.connect({ port: 0, host: '::1' });
    probe.once('error', () => resolve(false));
    // port 0 必然失败；这里只需确认不是 EACCES 类拦截
    probe.once('error', () => {});
    const real = net.connect({ host: '::1', port: server6ProbePort() });
    function server6ProbePort() { return 1; } // port 1 连接被拒（ECONNREFUSED）即代表路由可达
    real.once('error', (err) => resolve(err.code !== 'EACCES' && err.code !== 'EPERM'));
    real.once('connect', () => { real.destroy(); resolve(true); });
    probe.destroy();
  });
  if (!ipv6Reachable) {
    t.skip('环境拦截 IPv6 回环直连（EACCES/EPERM），跳过 [::1] 回调用例');
    return;
  }
  const state = generateState();
  const server = await startLoopbackServer({ path: '/oauth-callback', state, timeoutMs: 5000 });

  const res = await fetch(`http://[::1]:${server.port}/oauth-callback?code=V6CODE&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 200);
  const result = await server.waitForCode();
  assert.equal(result.code, 'V6CODE');
  server.close();
});

test('oauth-core: state 不匹配的回调被 CSRF 拒绝并返回失败页', async () => {
  const state = generateState();
  const server = await startLoopbackServer({ path: '/oauth-callback', state, timeoutMs: 5000 });
  // 先挂等待方（并兜底吞掉观察间隙的 rejection），再触发恶意回调
  const waitP = server.waitForCode();
  waitP.catch(() => {});

  const res = await fetch(`http://127.0.0.1:${server.port}/oauth-callback?code=BAD&state=evil`);
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.includes('Authorization Failed'));

  await assert.rejects(() => waitP, (err) => /state mismatch/i.test(err.message));
  server.close();
});

test('oauth-core: 非回调路径返回 404 不触发授权结果', async () => {
  const state = generateState();
  const server = await startLoopbackServer({ path: '/oauth-callback', state, timeoutMs: 5000 });

  const res = await fetch(`http://127.0.0.1:${server.port}/other-path`);
  assert.equal(res.status, 404);
  server.close();
});

test('oauth-core: 手动 submitCode 通道（Docker/远程粘贴兜底）', async () => {
  const state = generateState();
  const server = await startLoopbackServer({ path: '/oauth-callback', state, timeoutMs: 5000 });

  assert.equal(server.submitCode('MANUALCODE', 'wrong-state'), false, '错误 state 应被拒绝');
  assert.equal(server.submitCode('MANUALCODE', state), true);

  const result = await server.waitForCode();
  assert.equal(result.code, 'MANUALCODE');
  server.close();
});

test('oauth-core: 空闲超时自动关闭并拒绝等待方', async () => {
  const state = generateState();
  const server = await startLoopbackServer({ path: '/oauth-callback', state, timeoutMs: 150 });

  await assert.rejects(
    () => server.waitForCode(),
    (err) => err.code === 'oauth_callback_timeout',
  );
  server.close();
});

// 防止泄漏句柄：显式引用以便测试运行器在全部结束后自然退出
test('oauth-core: close 后端口不再接受连接', async () => {
  const server = await startLoopbackServer({ path: '/oauth-callback', state: 's', timeoutMs: 5000 });
  const port = server.port;
  server.close();
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(() => new Promise((_, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/oauth-callback`, (res) => {
      res.resume();
      reject(new Error('unexpected response after close'));
    });
    req.on('error', reject);
  }));
});

test('oauth-core: 固定端口绑定与占用拒绝（EADDRINUSE → oauth_loopback_bind_failed）', async () => {
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busyPort = blocker.address().port;

  await assert.rejects(
    () => startLoopbackServer({ path: '/auth/callback', state: 'sx', port: busyPort }),
    (err) => err.code === 'oauth_loopback_bind_failed',
  );

  await new Promise((r) => blocker.close(r));
  const srv = await startLoopbackServer({ path: '/auth/callback', state: 'sy', port: busyPort });
  assert.match(srv.redirectUri, new RegExp(`:${busyPort}/auth/callback$`));
  srv.close();
});
