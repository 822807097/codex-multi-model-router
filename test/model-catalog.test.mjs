import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyModelContextToCatalog,
  buildModelList,
  readModelCatalogFile,
  updateModelCatalogFile,
} from '../lib/model-catalog.mjs';

test('模型上下文更新返回新目录且只修改命中的模型', () => {
  const source = {
    models: [
      { slug: 'third-party', context_window: 128_000, extra: { keep: true } },
      { slug: 'official', context_window: 200_000 },
    ],
  };
  const original = structuredClone(source);

  const result = applyModelContextToCatalog(source, {
    enabled: true,
    slugs: ['third-party'],
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 400_000,
  });

  assert.equal(result.changed, true);
  assert.deepEqual(source, original);
  assert.deepEqual(result.catalog.models[0], {
    slug: 'third-party',
    context_window: 1_000_000,
    max_context_window: 1_000_000,
    auto_compact_token_limit: 400_000,
    extra: { keep: true },
  });
  assert.deepEqual(result.catalog.models[1], source.models[1]);
});

test('关闭模型上下文时不修改目录但仍隔离返回对象', () => {
  const source = { models: [{ slug: 'model-a', context_window: 10 }] };
  const result = applyModelContextToCatalog(source, { enabled: false, contextWindow: 20 });

  assert.equal(result.changed, false);
  assert.deepEqual(result.catalog, source);
  assert.notEqual(result.catalog, source);
  assert.notEqual(result.catalog.models, source.models);
});

test('/models 列表只为声明的模型暴露 streaming 能力', () => {
  const data = buildModelList({
    models: [
      { slug: 'native', display_name: 'Native' },
      { slug: 'chat', display_name: 'Chat' },
    ],
  }, { slugs: ['native'] });

  assert.deepEqual(data, [
    {
      id: 'native',
      object: 'model',
      created: 0,
      owned_by: 'local-router',
      capabilities: { streaming: true },
    },
    {
      id: 'chat',
      object: 'model',
      created: 0,
      owned_by: 'local-router',
    },
  ]);
});

test('目录文件适配器限量读取并按写临时文件再替换的顺序更新', () => {
  const source = JSON.stringify({ models: [{ slug: 'model-a', context_window: 10 }] });
  const calls = [];
  const fileSystem = {
    statSync(filePath) {
      calls.push(['stat', filePath]);
      return { size: Buffer.byteLength(source) };
    },
    readFileSync(filePath) {
      calls.push(['read', filePath]);
      return Buffer.from(source);
    },
    writeFileSync(filePath, body) {
      calls.push(['write', filePath, body]);
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
    },
  };

  const result = updateModelCatalogFile('C:/isolated/models.json', {
    enabled: true,
    contextWindow: 20,
  }, { fileSystem });

  assert.equal(result.changed, true);
  assert.deepEqual(calls.map((item) => item[0]), ['stat', 'read', 'write', 'rename']);
  assert.equal(calls[2][1], 'C:/isolated/models.json.tmp');
  assert.equal(calls[3][1], 'C:/isolated/models.json.tmp');
  assert.equal(calls[3][2], 'C:/isolated/models.json');
  assert.equal(JSON.parse(calls[2][2]).models[0].context_window, 20);
});

test('目录文件超过读取上限时在读取和解析前拒绝', () => {
  let readCalled = false;
  const fileSystem = {
    statSync() { return { size: 101 }; },
    readFileSync() { readCalled = true; return Buffer.from('{}'); },
  };

  assert.throws(
    () => readModelCatalogFile('C:/isolated/models.json', { fileSystem, maxBytes: 100 }),
    /模型目录文件超过大小上限/,
  );
  assert.equal(readCalled, false);
});
