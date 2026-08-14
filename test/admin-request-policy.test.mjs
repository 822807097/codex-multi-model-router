import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adminSecurityHeaders,
  inspectAdminRequest,
  isAllowedAdminHost,
} from '../lib/admin-request-policy.mjs';

test('管理 Host 只接受当前端口的规范本机名称', () => {
  for (const host of ['127.0.0.1:15730', 'localhost:15730', 'LOCALHOST:15730', '[::1]:15730']) {
    assert.equal(isAllowedAdminHost(host, 15730), true, host);
  }
  for (const host of [
    undefined,
    '',
    '127.0.0.1',
    'localhost:15731',
    'evil.example:15730',
    'user@127.0.0.1:15730',
    'localhost.:15730',
    '127.0.0.1.evil.example:15730',
    '[::1]:15731',
  ]) {
    assert.equal(isAllowedAdminHost(host, 15730), false, String(host));
  }
});

test('管理请求允许同源浏览器与无 Origin CLI 并拒绝跨站信号', () => {
  const base = { host: '127.0.0.1:15730', localPort: 15730 };
  for (const request of [
    { ...base, method: 'GET' },
    { ...base, method: 'PUT' },
    { ...base, method: 'GET', origin: 'http://127.0.0.1:15730', secFetchSite: 'same-origin' },
    { ...base, method: 'DELETE', origin: 'http://127.0.0.1:15730', secFetchSite: 'same-origin' },
  ]) {
    assert.deepEqual(inspectAdminRequest(request), { allowed: true });
  }

  for (const request of [
    { ...base, method: 'GET', secFetchSite: 'cross-site' },
    { ...base, method: 'PUT', origin: 'http://evil.example' },
    { ...base, method: 'DELETE', origin: 'http://localhost:15730' },
    { ...base, method: 'GET', origin: 'null' },
  ]) {
    assert.deepEqual(inspectAdminRequest(request), {
      allowed: false,
      status: 403,
      code: 'admin_cross_site_forbidden',
    });
  }
});

test('管理安全头包含 CSP 防嵌入与 MIME/来源保护', () => {
  const headers = adminSecurityHeaders();
  assert.match(headers['content-security-policy'], /default-src 'self'/);
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['x-frame-options'], 'DENY');
});
