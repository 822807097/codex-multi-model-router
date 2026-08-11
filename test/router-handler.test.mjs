import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    catalog: { models: [] },
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
    catalog: { models: [] },
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
    catalog: { models: [] },
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
    catalog: { models: [] },
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
  const handler = createRouterHandler({ targets: [], catalog: { models: [] } });
  const response = new FakeResponse();

  await handler({ method: 'POST', url: '/_admin/shutdown' }, response);

  assert.equal(response.status, 404);
  assert.deepEqual(JSON.parse(response.body), { error: 'not found' });
});

test('模型菜单使用创建时的深隔离 catalog 快照且两个路径完全一致', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-handler-catalog-'));
  const catalogPath = path.join(tempDir, 'models.json');
  const catalog = {
    models: [{ slug: 'startup-model', display_name: '启动模型' }],
  };
  await fs.writeFile(catalogPath, JSON.stringify(catalog));

  try {
    const handler = createRouterHandler({
      catalog,
      catalogPath,
      config: { supportsResponses: { slugs: ['startup-model'] } },
      targets: [],
    });

    catalog.models[0].slug = 'caller-mutated';
    catalog.models.push({ slug: 'caller-added', display_name: '调用方新增' });
    await fs.writeFile(catalogPath, JSON.stringify({
      models: [{ slug: 'disk-mutated', display_name: '磁盘变更' }],
    }));

    const plainResponse = new FakeResponse();
    const versionedResponse = new FakeResponse();
    await handler({ method: 'GET', url: '/models' }, plainResponse);
    await handler({ method: 'GET', url: '/v1/models' }, versionedResponse);

    assert.equal(plainResponse.status, 200);
    assert.equal(versionedResponse.status, 200);
    assert.deepEqual(JSON.parse(plainResponse.body), JSON.parse(versionedResponse.body));
    assert.deepEqual(JSON.parse(plainResponse.body).data, [{
      id: 'startup-model',
      object: 'model',
      created: 0,
      owned_by: 'local-router',
      capabilities: { streaming: true },
    }]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('缺失或非法 catalog 在 handler 创建阶段固定失败', async (t) => {
  for (const entry of [
    { name: '缺失', options: { targets: [] } },
    { name: '非法', options: { targets: [], catalog: { models: 'not-an-array' } } },
  ]) {
    await t.test(entry.name, async () => {
      assert.throws(
        () => createRouterHandler(entry.options),
        (error) => error?.code === 'catalog_snapshot_invalid'
          && error.message === '模型目录启动快照不可用',
      );
    });
  }
});

test('catalog 快照在读取任何值前拒绝访问器、Proxy 和循环引用', async (t) => {
  const hostileCases = [];

  {
    let reads = 0;
    const catalog = {};
    Object.defineProperty(catalog, 'models', {
      enumerable: true,
      get() { reads += 1; return []; },
    });
    hostileCases.push({ name: '根字段 getter', catalog, trapCount: () => reads });
  }
  {
    let reads = 0;
    const models = [];
    Object.defineProperty(models, '0', {
      enumerable: true,
      configurable: true,
      get() { reads += 1; return { slug: 'hidden', display_name: '隐藏' }; },
    });
    models.length = 1;
    hostileCases.push({ name: 'models 数组 getter', catalog: { models }, trapCount: () => reads });
  }
  {
    let reads = 0;
    const model = { display_name: '隐藏' };
    Object.defineProperty(model, 'slug', {
      enumerable: true,
      get() { reads += 1; return 'hidden'; },
    });
    hostileCases.push({ name: '模型条目 getter', catalog: { models: [model] }, trapCount: () => reads });
  }
  {
    let reads = 0;
    const metadata = {};
    Object.defineProperty(metadata, 'secret-marker', {
      enumerable: true,
      get() { reads += 1; return 'ACCESSOR_SECRET_MUST_NOT_LEAK'; },
    });
    hostileCases.push({
      name: '嵌套未知字段 getter',
      catalog: { models: [{ slug: 'safe', display_name: '安全', metadata }] },
      trapCount: () => reads,
    });
  }
  {
    let writes = 0;
    const metadata = {};
    Object.defineProperty(metadata, 'setter-only', {
      enumerable: true,
      set(_value) { writes += 1; },
    });
    hostileCases.push({
      name: '嵌套未知字段 setter',
      catalog: { models: [{ slug: 'safe', display_name: '安全', metadata }] },
      trapCount: () => writes,
    });
  }

  const proxyAt = (name, build) => {
    let traps = 0;
    const proxy = new Proxy(build.target, {
      ownKeys(target) { traps += 1; return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) { traps += 1; return Reflect.get(target, key, receiver); },
    });
    hostileCases.push({ name, catalog: build.wrap(proxy), trapCount: () => traps });
  };
  proxyAt('根 Proxy', {
    target: { models: [{ slug: 'safe', display_name: '安全' }] },
    wrap: (proxy) => proxy,
  });
  proxyAt('models 数组 Proxy', {
    target: [{ slug: 'safe', display_name: '安全' }],
    wrap: (proxy) => ({ models: proxy }),
  });
  proxyAt('模型条目 Proxy', {
    target: { slug: 'safe', display_name: '安全' },
    wrap: (proxy) => ({ models: [proxy] }),
  });
  proxyAt('嵌套未知字段 Proxy', {
    target: { marker: 'PROXY_SECRET_MUST_NOT_LEAK' },
    wrap: (proxy) => ({ models: [{ slug: 'safe', display_name: '安全', metadata: proxy }] }),
  });

  const rootCycle = { models: [{ slug: 'safe', display_name: '安全' }] };
  rootCycle.self = rootCycle;
  hostileCases.push({ name: '根循环', catalog: rootCycle, trapCount: () => 0 });
  const modelsCycle = [];
  modelsCycle.push(modelsCycle);
  hostileCases.push({ name: '数组循环', catalog: { models: modelsCycle }, trapCount: () => 0 });
  const nestedCycle = {};
  nestedCycle.self = nestedCycle;
  hostileCases.push({
    name: '嵌套循环',
    catalog: { models: [{ slug: 'safe', display_name: '安全', metadata: nestedCycle }] },
    trapCount: () => 0,
  });
  hostileCases.push({
    name: '非有限 JSON number',
    catalog: {
      models: [{ slug: 'safe', display_name: '安全', metadata: { score: Infinity } }],
    },
    trapCount: () => 0,
  });
  const symbolKeyMetadata = {};
  symbolKeyMetadata[Symbol('hidden')] = 'SYMBOL_SECRET_MUST_NOT_LEAK';
  hostileCases.push({
    name: 'Symbol 键',
    catalog: {
      models: [{ slug: 'safe', display_name: '安全', metadata: symbolKeyMetadata }],
    },
    trapCount: () => 0,
  });
  const arrayWithHole = new Array(1);
  hostileCases.push({
    name: '数组 hole',
    catalog: {
      models: [{ slug: 'safe', display_name: '安全', metadata: { values: arrayWithHole } }],
    },
    trapCount: () => 0,
  });
  const arrayWithExtraKey = [null];
  arrayWithExtraKey.extra = 'ARRAY_EXTRA_SECRET_MUST_NOT_LEAK';
  hostileCases.push({
    name: '数组额外命名键',
    catalog: {
      models: [{ slug: 'safe', display_name: '安全', metadata: { values: arrayWithExtraKey } }],
    },
    trapCount: () => 0,
  });
  const arrayWithSymbol = [null];
  arrayWithSymbol[Symbol('hidden')] = 'ARRAY_SYMBOL_SECRET_MUST_NOT_LEAK';
  hostileCases.push({
    name: '数组 Symbol 键',
    catalog: {
      models: [{ slug: 'safe', display_name: '安全', metadata: { values: arrayWithSymbol } }],
    },
    trapCount: () => 0,
  });
  hostileCases.push({
    name: '非普通对象',
    catalog: {
      models: [{ slug: 'safe', display_name: '安全', metadata: new Date(0) }],
    },
    trapCount: () => 0,
  });
  const nullPrototypeMetadata = Object.create(null);
  nullPrototypeMetadata.marker = 'NULL_PROTOTYPE_SECRET_MUST_NOT_LEAK';
  hostileCases.push({
    name: 'null prototype 对象',
    catalog: {
      models: [{ slug: 'safe', display_name: '安全', metadata: nullPrototypeMetadata }],
    },
    trapCount: () => 0,
  });
  let deepMetadata = { end: true };
  for (let depth = 0; depth < 80; depth += 1) deepMetadata = { child: deepMetadata };
  hostileCases.push({
    name: '深度预算',
    catalog: {
      models: [{ slug: 'safe', display_name: '安全', metadata: deepMetadata }],
    },
    trapCount: () => 0,
  });
  hostileCases.push({
    name: '节点预算',
    catalog: {
      models: [{
        slug: 'safe',
        display_name: '安全',
        metadata: { values: new Array(100_001).fill(null) },
      }],
    },
    trapCount: () => 0,
  });

  for (const entry of hostileCases) {
    await t.test(entry.name, async () => {
      assert.throws(
        () => createRouterHandler({ targets: [], catalog: entry.catalog }),
        (error) => error?.code === 'catalog_snapshot_invalid'
          && error.message === '模型目录启动快照不可用',
      );
      assert.equal(entry.trapCount(), 0, '创建 handler 时不得执行访问器或 Proxy trap');
      const publicError = JSON.stringify({ error: '模型目录启动快照不可用' });
      assert.doesNotMatch(
        publicError,
        /ACCESSOR_SECRET_MUST_NOT_LEAK|PROXY_SECRET_MUST_NOT_LEAK|SYMBOL_SECRET_MUST_NOT_LEAK|ARRAY_EXTRA_SECRET_MUST_NOT_LEAK|ARRAY_SYMBOL_SECRET_MUST_NOT_LEAK|NULL_PROTOTYPE_SECRET_MUST_NOT_LEAK|secret-marker|metadata/,
      );
    });
  }
});

test('超长数组在节点预算拒绝前只读取 length 描述符', () => {
  let getterReads = 0;
  const values = new Array(100_001);
  Object.defineProperty(values, '0', {
    enumerable: true,
    configurable: true,
    get() { getterReads += 1; return 'ARRAY_SECRET_MUST_NOT_LEAK'; },
  });
  const catalog = {
    models: [{ slug: 'safe', display_name: '安全', metadata: { values } }],
  };
  const originalBulkDescriptors = Object.getOwnPropertyDescriptors;
  const originalDescriptor = Object.getOwnPropertyDescriptor;
  let bulkDescriptorCalls = 0;
  const descriptorKeys = [];
  Object.getOwnPropertyDescriptors = function getOwnPropertyDescriptors(value) {
    if (value === values) bulkDescriptorCalls += 1;
    return originalBulkDescriptors(value);
  };
  Object.getOwnPropertyDescriptor = function getOwnPropertyDescriptor(value, key) {
    if (value === values) descriptorKeys.push(key);
    return originalDescriptor(value, key);
  };

  try {
    assert.throws(
      () => createRouterHandler({ targets: [], catalog }),
      (error) => error?.code === 'catalog_snapshot_invalid'
        && error.message === '模型目录启动快照不可用',
    );
  } finally {
    Object.getOwnPropertyDescriptors = originalBulkDescriptors;
    Object.getOwnPropertyDescriptor = originalDescriptor;
  }

  assert.equal(bulkDescriptorCalls, 0);
  assert.deepEqual(descriptorKeys, ['length']);
  assert.equal(getterReads, 0);
});

test('普通 JSON catalog 的嵌套字段同样与调用方后续 mutation 隔离', async () => {
  const catalog = {
    models: [{
      slug: 'nested-model',
      display_name: '嵌套模型',
      metadata: { labels: ['startup'], limits: { tokens: 1024 } },
    }],
  };
  const handler = createRouterHandler({
    targets: [],
    catalog,
    buildModelList: (snapshot) => [{
      id: snapshot.models[0].slug,
      metadata: snapshot.models[0].metadata,
    }],
  });
  catalog.models[0].metadata.labels[0] = 'mutated';
  catalog.models[0].metadata.limits.tokens = 1;

  const response = new FakeResponse();
  await handler({ method: 'GET', url: '/v1/models' }, response);

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body).data, [{
    id: 'nested-model',
    metadata: { labels: ['startup'], limits: { tokens: 1024 } },
  }]);
});
