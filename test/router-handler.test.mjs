import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createRouterHandler } from '../lib/router-handler.mjs';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.headers = null;
    this.body = '';
  }

  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  }

  end(body = '') {
    this.body += body;
    this.emit('finish');
  }
}

test('可选管理处理器命中后优先返回且不再进入普通路由', async () => {
  const calls = [];
  const handler = createRouterHandler({
    targets: [{ name: 'ordinary-target' }],
    adminHandler: async (request, response) => {
      calls.push(request.url);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ page: 'admin' }));
      return true;
    },
  });
  const response = new FakeResponse();

  await handler({ method: 'GET', url: '/healthz' }, response);

  assert.deepEqual(calls, ['/healthz']);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { page: 'admin' });
});

test('可选管理处理器未命中时继续执行原有路由', async () => {
  let calls = 0;
  const handler = createRouterHandler({
    targets: [{ name: 'official' }],
    adminHandler: async () => {
      calls += 1;
      return false;
    },
  });
  const response = new FakeResponse();

  await handler({ method: 'GET', url: '/healthz' }, response);

  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    targets: ['official'],
  });
});

test('健康端点由独立 handler 返回脱敏目标列表', async () => {
  const handler = createRouterHandler({
    targets: [{ name: 'official' }, { name: 'third-party' }],
  });
  const response = new FakeResponse();

  await handler({ method: 'GET', url: '/healthz' }, response);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    targets: ['official', 'third-party'],
  });
});

test('管理关闭端点在响应完成后调用注入的优雅退出', async () => {
  let shutdowns = 0;
  const handler = createRouterHandler({
    targets: [],
    onShutdown: () => { shutdowns += 1; },
  });
  const response = new FakeResponse();

  await handler({ method: 'POST', url: '/_admin/shutdown' }, response);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.equal(shutdowns, 1);
});

test('未显式注入关闭能力时管理命名空间返回 404 且不进入模型转发', async () => {
  const handler = createRouterHandler({ targets: [] });
  const response = new FakeResponse();

  await handler({ method: 'POST', url: '/_admin/shutdown' }, response);

  assert.equal(response.status, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'not found' });
});
