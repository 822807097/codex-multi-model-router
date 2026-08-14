import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAdminHandler } from '../lib/admin-api.mjs';
import { GoalCheckpointStore } from '../lib/goal-checkpoint.mjs';

function request(port, method, requestPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: {
        ...extraHeaders,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('管理 API 拒绝伪造 Host 与跨站请求并为 JSON 添加安全头', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-request-policy-'));
  const admin = await startAdmin(tempDir);
  try {
    const normal = await request(admin.port, 'GET', '/_admin/api/status');
    assert.equal(normal.status, 200);
    assert.match(normal.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(normal.headers['x-content-type-options'], 'nosniff');
    assert.equal(normal.headers['referrer-policy'], 'no-referrer');
    assert.equal(normal.headers['x-frame-options'], 'DENY');

    const sameOrigin = await request(admin.port, 'GET', '/_admin/api/status', undefined, {
      origin: `http://127.0.0.1:${admin.port}`,
      'sec-fetch-site': 'same-origin',
    });
    assert.equal(sameOrigin.status, 200);

    const forgedHost = await request(admin.port, 'GET', '/_admin/api/status', undefined, {
      host: 'evil-secret.example:15730',
    });
    assert.equal(forgedHost.status, 403);
    assert.equal(JSON.parse(forgedHost.text).error.code, 'admin_host_forbidden');
    assert.doesNotMatch(forgedHost.text, /evil-secret|127\.0\.0\.1|stack|admin-api\.mjs/i);

    const crossSiteGet = await request(admin.port, 'GET', '/_admin/api/status', undefined, {
      'sec-fetch-site': 'cross-site',
    });
    assert.equal(crossSiteGet.status, 403);
    assert.equal(JSON.parse(crossSiteGet.text).error.code, 'admin_cross_site_forbidden');

    for (const method of ['PUT', 'DELETE']) {
      const blocked = await request(admin.port, method, '/_admin/api/config', {}, {
        origin: 'http://evil-secret.example',
      });
      assert.equal(blocked.status, 403);
      assert.equal(JSON.parse(blocked.text).error.code, 'admin_cross_site_forbidden');
      assert.doesNotMatch(blocked.text, /evil-secret|stack|admin-api\.mjs/i);
    }

    const missingWebRoot = path.join(tempDir, 'private-missing-web-root');
    const missingAssetDir = path.join(tempDir, 'missing-asset-instance');
    await fs.mkdir(missingAssetDir);
    const missingAsset = await startAdmin(missingAssetDir, {
      webRoot: missingWebRoot,
    });
    try {
      const failedAsset = await request(missingAsset.port, 'GET', '/admin');
      assert.equal(failedAsset.status, 400);
      assert.equal(JSON.parse(failedAsset.text).error.code, 'admin_error');
      assert.doesNotMatch(failedAsset.text, /private-missing-web-root|ENOENT|stack|admin-api\.mjs/i);
    } finally {
      await new Promise((resolve) => missingAsset.server.close(resolve));
    }
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function rawRequest(port, method, requestPath, bytes) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(bytes);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function validConfig(port) {
  return {
    port,
    heartbeatMs: 15_000,
    maxRequestBytes: 1024,
    maxConcurrentRequests: 2,
    maxBufferedRequestBytes: 2048,
    modelContext: { enabled: false },
    customExtension: { keep: true },
    targets: [{
      name: 'custom',
      match: '^custom$',
      host: 'api.example.test',
      prefix: '/v1',
      envKey: 'TEST_KEY',
      authType: 'header',
      authHeader: 'x-provider-token',
      wireApi: 'chat',
      headers: {
        authorization: 'Bearer static-secret',
        'x-provider-token': 'custom-static-secret',
        'x-tenant': 'tenant-a',
      },
    }],
  };
}

async function startAdmin(tempDir, overrides = {}) {
  const configPath = path.join(tempDir, 'config.json');
  const catalogPath = path.join(tempDir, 'models.json');
  const config = validConfig(15730);
  const catalog = {
    models: [{
      slug: 'custom',
      display_name: 'Custom',
      input_modalities: ['text'],
    }],
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  const checkpointStore = new GoalCheckpointStore();
  checkpointStore.remember({ taskKey: 'task', checkpoint: 'checkpoint text' });
  const persistence = {
    status: () => ({ mode: 'disabled', loadedEntries: 0 }),
    flush: async () => false,
    clearCalls: 0,
    clearRecoverably: async () => {
      persistence.clearCalls += 1;
      return {
        removed: checkpointStore.clear(),
        backupPath: null,
        recoveryHint: '持久化已关闭，仅清空当前内存检查点',
      };
    },
  };
  const handler = createAdminHandler({
    configPath,
    defaultCodexHome: path.join(tempDir, 'codex-home'),
    env: { TEST_KEY: 'runtime-secret' },
    runtime: { port: 15730 },
    targets: config.targets,
    warnings: [],
    startedAt: Date.now() - 1000,
    checkpointStore,
    persistence,
    catalogPath,
    ...overrides,
  });
  const server = http.createServer(async (req, res) => {
    if (!await handler(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    configPath,
    catalogPath,
    config,
    catalog,
    checkpointStore,
    persistence,
  };
}

async function routingState(admin) {
  const response = await request(admin.port, 'GET', '/_admin/api/model-routing');
  assert.equal(response.status, 200);
  return { response, body: JSON.parse(response.text) };
}

test('联合模型路由 GET 返回双 revision、安全视图与环境变量是否已设置', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-state-'));
  const admin = await startAdmin(tempDir);
  try {
    const { response, body } = await routingState(admin);
    assert.match(body.configRevision, /^[a-f0-9]{64}$/);
    assert.match(body.catalogRevision, /^[a-f0-9]{64}$/);
    assert.equal(body.models[0].slug, 'custom');
    assert.equal(body.targets[0].name, 'custom');
    assert.match(body.targets[0].targetRef, /^target:[a-f0-9]{64}$/);
    assert.equal(body.targets[0].envSet, true);
    assert.deepEqual(body.bindings, [{ slug: 'custom', targetRefs: [body.targets[0].targetRef] }]);
    assert.deepEqual(body.references, { modelContext: [], supportsResponses: [] });
    assert.doesNotMatch(
      response.text,
      /configPath|catalogPath|runtime-secret|static-secret|custom-static-secret|authorization|headers|cookie|oauth/i,
    );
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由正文严格限制为 UTF-8 JSON 且不超过 2 MiB', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-body-'));
  const admin = await startAdmin(tempDir);
  try {
    const invalidUtf8 = await rawRequest(
      admin.port,
      'POST',
      '/_admin/api/model-routing/validate',
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
    );
    assert.equal(invalidUtf8.status, 400);
    assert.equal(JSON.parse(invalidUtf8.text).error.code, 'invalid_json');

    const oversized = await rawRequest(
      admin.port,
      'PUT',
      '/_admin/api/model-routing',
      Buffer.alloc(2 * 1024 * 1024 + 1, 0x20),
    );
    assert.equal(oversized.status, 413);
    assert.equal(JSON.parse(oversized.text).error.code, 'admin_body_too_large');

    const multibyteText = `{"padding":"${'你'.repeat(700_000)}"}`;
    assert.equal(multibyteText.length < 2 * 1024 * 1024, true);
    assert.equal(Buffer.byteLength(multibyteText) > 2 * 1024 * 1024, true);
    const multibyteOversized = await rawRequest(
      admin.port,
      'POST',
      '/_admin/api/model-routing/validate',
      Buffer.from(multibyteText),
    );
    assert.equal(multibyteOversized.status, 413);
    assert.equal(JSON.parse(multibyteOversized.text).error.code, 'admin_body_too_large');

    const trailingBytes = await rawRequest(
      admin.port,
      'POST',
      '/_admin/api/model-routing/validate',
      Buffer.from('{}non-empty-trailer'),
    );
    assert.equal(trailingBytes.status, 400);
    assert.equal(JSON.parse(trailingBytes.text).error.code, 'invalid_json');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('超限分块正文排空到 end 后稳定返回 413 并保持同一 keep-alive 连接', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-drain-'));
  const admin = await startAdmin(tempDir);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let upload;
  try {
    let uploadSocket;
    let responseSeen = false;
    const responsePromise = new Promise((resolve, reject) => {
      upload = http.request({
        host: '127.0.0.1',
        port: admin.port,
        method: 'POST',
        path: '/_admin/api/model-routing/validate',
        agent,
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        responseSeen = true;
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      upload.once('socket', (socket) => { uploadSocket = socket; });
      upload.once('error', reject);
    });
    const write = (bytes) => new Promise((resolve, reject) => {
      upload.write(bytes, (error) => (error ? reject(error) : resolve()));
    });

    await write(Buffer.alloc(2 * 1024 * 1024, 0x20));
    await write(Buffer.from('x'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const respondedBeforeEnd = responseSeen;
    upload.end(Buffer.from('tail'));
    const oversized = await responsePromise;

    let followSocket;
    const follow = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: admin.port,
        method: 'GET',
        path: '/_admin/api/model-routing',
        agent,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks) }));
      });
      req.once('socket', (socket) => { followSocket = socket; });
      req.once('error', reject);
      req.end();
    });

    assert.equal(respondedBeforeEnd, false);
    assert.equal(oversized.status, 413);
    assert.equal(JSON.parse(oversized.text).error.code, 'admin_body_too_large');
    assert.equal(follow.status, 200);
    assert.equal(followSocket, uploadSocket);
  } finally {
    if (upload && !upload.writableEnded) upload.destroy();
    agent.destroy();
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由 validate 区分无破坏操作与需要一次性确认的删除', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-validate-'));
  let now = 1_000;
  const admin = await startAdmin(tempDir, {
    now: () => now,
    randomUUID: () => 'confirmation-token',
  });
  try {
    const { body: state } = await routingState(admin);
    const base = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
    };
    const safe = await request(admin.port, 'POST', '/_admin/api/model-routing/validate', {
      ...base,
      operations: [{ kind: 'model.update', slug: 'custom', patch: { display_name: 'Renamed' } }],
    });
    assert.equal(safe.status, 200);
    const safeBody = JSON.parse(safe.text);
    assert.deepEqual(safeBody.errors, []);
    assert.match(safeBody.operationDigest, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(safeBody, 'confirmation'), false);

    const destructivePayload = {
      ...base,
      operations: [{ kind: 'model.delete', slug: 'custom' }],
    };
    const destructive = await request(
      admin.port,
      'POST',
      '/_admin/api/model-routing/validate',
      destructivePayload,
    );
    assert.equal(destructive.status, 200);
    const destructiveBody = JSON.parse(destructive.text);
    assert.equal(destructiveBody.confirmation.token, 'confirmation-token');
    assert.equal(destructiveBody.confirmation.expiresAt, 61_000);
    assert.deepEqual(destructiveBody.impact.models.deleted, ['custom']);

    now = 61_001;
    const expired = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...destructivePayload,
      confirmation: destructiveBody.confirmation.token,
    });
    assert.equal(expired.status, 409);
    assert.equal(JSON.parse(expired.text).error.code, 'confirmation_invalid');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('破坏性确认令牌绑定双 revision 和操作摘要，错误令牌不消耗、正确令牌仅可使用一次', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-token-'));
  let commits = 0;
  const admin = await startAdmin(tempDir, {
    randomUUID: () => 'one-time-token',
    transactionFactory: () => ({
      commit: async ({ configRevision, catalogRevision }) => {
        commits += 1;
        return {
          configRevision: 'a'.repeat(64),
          catalogRevision: 'b'.repeat(64),
          txid: `tx-${commits}`,
        };
      },
    }),
  });
  try {
    const { body: state } = await routingState(admin);
    const payload = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
      operations: [{ kind: 'model.delete', slug: 'custom' }],
    };
    const validated = JSON.parse((await request(
      admin.port, 'POST', '/_admin/api/model-routing/validate', payload,
    )).text);

    const wrongDigest = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      operations: [
        ...payload.operations,
        { kind: 'reference.removeSlug', slug: 'custom' },
      ],
      confirmation: validated.confirmation.token,
    });
    assert.equal(wrongDigest.status, 409);
    assert.equal(JSON.parse(wrongDigest.text).error.code, 'confirmation_invalid');
    assert.equal(commits, 0);

    const wrong = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      confirmation: 'wrong-token',
    });
    assert.equal(wrong.status, 409);
    assert.equal(commits, 0);

    const saved = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      confirmation: validated.confirmation.token,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.text), {
      configRevision: 'a'.repeat(64),
      catalogRevision: 'b'.repeat(64),
      txid: 'tx-1',
      warnings: [],
      restartRequired: true,
      clientRestartRequired: true,
    });
    assert.equal(commits, 1);

    const repeated = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      confirmation: validated.confirmation.token,
    });
    assert.equal(repeated.status, 409);
    assert.equal(JSON.parse(repeated.text).error.code, 'confirmation_invalid');
    assert.equal(commits, 1);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('模型路由确认缓存只保留最近 128 项并淘汰最旧 token', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-token-bound-'));
  let sequence = 0;
  let commits = 0;
  const admin = await startAdmin(tempDir, {
    randomUUID: () => `bounded-token-${++sequence}`,
    transactionFactory: () => ({
      commit: async () => {
        commits += 1;
        return {
          configRevision: 'a'.repeat(64),
          catalogRevision: 'b'.repeat(64),
          txid: 'bounded-tx',
        };
      },
    }),
  });
  try {
    const { body: state } = await routingState(admin);
    const payload = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
      operations: [{ kind: 'model.delete', slug: 'custom' }],
    };
    const tokens = [];
    for (let index = 0; index < 129; index += 1) {
      const validated = await request(
        admin.port, 'POST', '/_admin/api/model-routing/validate', payload,
      );
      assert.equal(validated.status, 200);
      tokens.push(JSON.parse(validated.text).confirmation.token);
    }

    const oldest = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      confirmation: tokens[0],
    });
    assert.equal(oldest.status, 409);
    assert.equal(JSON.parse(oldest.text).error.code, 'confirmation_invalid');
    assert.equal(commits, 0);

    const newest = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      confirmation: tokens.at(-1),
    });
    assert.equal(newest.status, 200);
    assert.equal(commits, 1);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('同一确认 token 的并发双 PUT 只有一个能在事务 await 前进入提交', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-token-race-'));
  let enterCommit;
  const entered = new Promise((resolve) => { enterCommit = resolve; });
  let releaseCommit;
  const release = new Promise((resolve) => { releaseCommit = resolve; });
  let commits = 0;
  const admin = await startAdmin(tempDir, {
    randomUUID: () => 'race-token',
    transactionFactory: () => ({
      commit: async () => {
        commits += 1;
        enterCommit();
        if (commits === 1) await release;
        return {
          configRevision: 'a'.repeat(64),
          catalogRevision: 'b'.repeat(64),
          txid: 'race-tx',
        };
      },
    }),
  });
  try {
    const { body: state } = await routingState(admin);
    const payload = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
      operations: [{ kind: 'model.delete', slug: 'custom' }],
    };
    const validated = JSON.parse((await request(
      admin.port, 'POST', '/_admin/api/model-routing/validate', payload,
    )).text);
    const savePayload = { ...payload, confirmation: validated.confirmation.token };

    const first = request(admin.port, 'PUT', '/_admin/api/model-routing', savePayload);
    await entered;
    const second = await request(admin.port, 'PUT', '/_admin/api/model-routing', savePayload);
    assert.equal(second.status, 409);
    assert.equal(JSON.parse(second.text).error.code, 'confirmation_invalid');
    assert.equal(commits, 1);
    releaseCommit();
    assert.equal((await first).status, 200);
    assert.equal(commits, 1);
  } finally {
    releaseCommit();
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('确认 token 分别绑定 configRevision、catalogRevision 和 operationDigest 且失败不消耗', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-token-binding-'));
  let commits = 0;
  const admin = await startAdmin(tempDir, {
    randomUUID: () => 'triple-binding-token',
    transactionFactory: () => ({
      commit: async () => {
        commits += 1;
        return {
          configRevision: 'a'.repeat(64),
          catalogRevision: 'b'.repeat(64),
          txid: 'binding-tx',
        };
      },
    }),
  });
  try {
    const { body: state } = await routingState(admin);
    const payload = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
      operations: [{ kind: 'model.delete', slug: 'custom' }],
    };
    const validated = JSON.parse((await request(
      admin.port, 'POST', '/_admin/api/model-routing/validate', payload,
    )).text);
    const confirmation = validated.confirmation.token;
    const originalConfigText = await fs.readFile(admin.configPath, 'utf8');
    await fs.writeFile(admin.configPath, `${JSON.stringify({
      ...admin.config,
      _revisionProbe: 'config',
    }, null, 2)}\n`);
    const configChanged = (await routingState(admin)).body;
    const wrongConfig = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      configRevision: configChanged.configRevision,
      confirmation,
    });
    assert.equal(wrongConfig.status, 409);
    assert.equal(JSON.parse(wrongConfig.text).error.code, 'confirmation_invalid');
    await fs.writeFile(admin.configPath, originalConfigText);

    const originalCatalogText = await fs.readFile(admin.catalogPath, 'utf8');
    await fs.writeFile(admin.catalogPath, `${JSON.stringify({
      ...admin.catalog,
      _revisionProbe: 'catalog',
    }, null, 2)}\n`);
    const catalogChanged = (await routingState(admin)).body;
    const wrongCatalog = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      catalogRevision: catalogChanged.catalogRevision,
      confirmation,
    });
    assert.equal(wrongCatalog.status, 409);
    assert.equal(JSON.parse(wrongCatalog.text).error.code, 'confirmation_invalid');
    await fs.writeFile(admin.catalogPath, originalCatalogText);

    const wrongDigest = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      operations: [...payload.operations, { kind: 'reference.removeSlug', slug: 'custom' }],
      confirmation,
    });
    assert.equal(wrongDigest.status, 409);
    assert.equal(JSON.parse(wrongDigest.text).error.code, 'confirmation_invalid');
    assert.equal(commits, 0);

    const saved = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...payload,
      confirmation,
    });
    assert.equal(saved.status, 200);
    assert.equal(commits, 1);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由将非法正文和 operation 映射为 400、语义预检错误映射为 422', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-errors-'));
  const admin = await startAdmin(tempDir);
  try {
    const { body: state } = await routingState(admin);
    const base = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
    };
    const unknownBody = await request(admin.port, 'POST', '/_admin/api/model-routing/validate', {
      ...base,
      operations: [],
      catalogPath: admin.catalogPath,
    });
    assert.equal(unknownBody.status, 400);
    assert.equal(JSON.parse(unknownBody.text).error.code, 'request_invalid');
    assert.doesNotMatch(unknownBody.text, /catalogPath|models\.json/);

    const unknownOperation = await request(
      admin.port,
      'POST',
      '/_admin/api/model-routing/validate',
      { ...base, operations: [{ kind: 'model.execute-Bearer-leaked' }] },
    );
    assert.equal(unknownOperation.status, 400);
    assert.equal(JSON.parse(unknownOperation.text).error.code, 'operation_kind_unknown');
    assert.doesNotMatch(unknownOperation.text, /Bearer-leaked/);

    const invalidPlan = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...base,
      operations: [{
        kind: 'model.create',
        model: { slug: 'missing-display-name', input_modalities: ['text'] },
      }, {
        kind: 'target.create',
        target: { name: 'route', match: '^missing-display-name$', host: 'example.test' },
      }],
    });
    assert.equal(invalidPlan.status, 422);
    const invalidPlanBody = JSON.parse(invalidPlan.text);
    assert.equal(
      invalidPlanBody.errors.some((issue) => issue.code === 'catalog_display_name_invalid'),
      true,
    );
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由 HTTP 拒绝非专属精确 target.create 且允许规范 exact', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-target-create-'));
  const admin = await startAdmin(tempDir);
  try {
    const { body: state } = await routingState(admin);
    const base = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
    };
    const targetBody = (name, match) => ({
      name,
      ...(match === undefined ? {} : { match }),
      host: 'new-target.example.test',
      envKey: 'TEST_KEY',
      wireApi: 'chat',
    });
    for (const [name, match] of [
      ['missing', undefined],
      ['wide', '^custom'],
      ['mismatch', '^other$'],
      ['non-canonical', '^(?:custom)$'],
    ]) {
      const rejected = await request(admin.port, 'POST', '/_admin/api/model-routing/validate', {
        ...base,
        operations: [{ kind: 'target.create', target: targetBody(name, match) }],
      });
      assert.equal(rejected.status, 400, name);
      assert.equal(JSON.parse(rejected.text).error.code, 'target_create_not_dedicated', name);
    }

    const accepted = await request(admin.port, 'POST', '/_admin/api/model-routing/validate', {
      ...base,
      operations: [{ kind: 'target.create', target: targetBody('exact', '^custom$') }],
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.text).errors, []);

    const beforeConfig = await fs.readFile(admin.configPath, 'utf8');
    const putRejected = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      ...base,
      operations: [{ kind: 'target.create', target: targetBody('put-wide', '^custom') }],
    });
    assert.equal(putRejected.status, 400);
    assert.equal(JSON.parse(putRejected.text).error.code, 'target_create_not_dedicated');
    assert.equal(await fs.readFile(admin.configPath, 'utf8'), beforeConfig);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由 HTTP 拒绝绕过 UI 删除非专属 target 并允许 UI 删除顺序', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-target-delete-'));
  const admin = await startAdmin(tempDir);
  const route = (name, match) => ({
    name,
    ...(match === undefined ? {} : { match }),
    host: 'delete-target.example.test',
    envKey: 'TEST_KEY',
    wireApi: 'chat',
  });
  const cases = [
    {
      name: 'single-owner-wide-with-backup',
      models: [admin.catalog.models[0]],
      targets: [route('wide', '^custom'), route('backup', '^custom$')],
    },
    {
      name: 'non-canonical-exact',
      models: [admin.catalog.models[0]],
      targets: [route('non-canonical', '^(?:custom)$')],
    },
    {
      name: 'array-match',
      models: [admin.catalog.models[0]],
      targets: [route('array', ['^custom$'])],
    },
    {
      name: 'missing-match',
      models: [admin.catalog.models[0]],
      targets: [route('missing', undefined)],
    },
    {
      name: 'no-owner',
      models: [admin.catalog.models[0]],
      targets: [route('orphan', '^missing$')],
    },
    {
      name: 'duplicate-owner',
      models: [admin.catalog.models[0], admin.catalog.models[0]],
      targets: [route('duplicate', '^custom$')],
    },
  ];

  try {
    for (const scenario of cases) {
      await fs.writeFile(admin.configPath, JSON.stringify({
        ...admin.config,
        targets: scenario.targets,
      }, null, 2));
      await fs.writeFile(admin.catalogPath, JSON.stringify({ models: scenario.models }, null, 2));
      const { body: state } = await routingState(admin);
      const payload = {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: [{ kind: 'target.delete', targetRef: state.targets[0].targetRef }],
      };
      const rejected = await request(
        admin.port,
        'POST',
        '/_admin/api/model-routing/validate',
        payload,
      );
      assert.equal(rejected.status, 400, scenario.name);
      assert.equal(JSON.parse(rejected.text).error.code, 'target_not_dedicated', scenario.name);

      if (scenario.name === 'single-owner-wide-with-backup') {
        const beforeConfig = await fs.readFile(admin.configPath, 'utf8');
        const putRejected = await request(
          admin.port,
          'PUT',
          '/_admin/api/model-routing',
          payload,
        );
        assert.equal(putRejected.status, 400);
        assert.equal(JSON.parse(putRejected.text).error.code, 'target_not_dedicated');
        assert.equal(await fs.readFile(admin.configPath, 'utf8'), beforeConfig);
      }
    }

    await fs.writeFile(admin.configPath, JSON.stringify({
      ...admin.config,
      modelContext: { slugs: ['custom'] },
      targets: [route('exact', '^custom$'), route('other', '^other$')],
    }, null, 2));
    await fs.writeFile(admin.catalogPath, JSON.stringify({
      models: [
        ...admin.catalog.models,
        { slug: 'other', display_name: 'Other', input_modalities: ['text'] },
      ],
    }, null, 2));
    const { body: state } = await routingState(admin);
    const base = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
    };
    const targetRef = state.targets[0].targetRef;
    const deletedFirst = await request(
      admin.port,
      'POST',
      '/_admin/api/model-routing/validate',
      {
        ...base,
        operations: [
          { kind: 'model.delete', slug: 'custom' },
          { kind: 'target.delete', targetRef },
        ],
      },
    );
    assert.equal(deletedFirst.status, 400);
    assert.equal(JSON.parse(deletedFirst.text).error.code, 'target_not_dedicated');

    const uiOrder = await request(
      admin.port,
      'POST',
      '/_admin/api/model-routing/validate',
      {
        ...base,
        operations: [
          { kind: 'reference.removeSlug', slug: 'custom' },
          { kind: 'target.delete', targetRef },
          { kind: 'model.delete', slug: 'custom' },
        ],
      },
    );
    assert.equal(uiOrder.status, 200);
    assert.deepEqual(JSON.parse(uiOrder.text).errors, []);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由 HTTP 校验新草稿连续改名不替换孤立引用或要求确认', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-new-draft-rename-'));
  const admin = await startAdmin(tempDir);
  try {
    await fs.writeFile(admin.configPath, JSON.stringify({
      ...admin.config,
      modelContext: { slugs: ['new.model'] },
    }, null, 2));
    const { body: state } = await routingState(admin);
    const validated = await request(
      admin.port,
      'POST',
      '/_admin/api/model-routing/validate',
      {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: [
          {
            kind: 'model.create',
            model: {
              slug: 'new-model-v3',
              display_name: 'New Model',
              input_modalities: ['text'],
            },
          },
          {
            kind: 'target.create',
            target: {
              name: 'new-model',
              match: '^new-model-v3$',
              host: 'new.example.test',
              envKey: 'TEST_KEY',
              wireApi: 'chat',
            },
          },
        ],
      },
    );
    assert.equal(validated.status, 200);
    const body = JSON.parse(validated.text);
    assert.deepEqual(body.errors, []);
    assert.deepEqual(body.impact.references.replaced, []);
    assert.equal(Object.hasOwn(body, 'confirmation'), false);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由在 config 或 catalog 任一 revision 变化时稳定返回冲突', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-conflict-'));
  const admin = await startAdmin(tempDir);
  try {
    const { body: state } = await routingState(admin);
    const payload = {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
      operations: [],
    };
    await fs.writeFile(admin.configPath, `${JSON.stringify({ ...admin.config, port: 15731 }, null, 2)}\n`);
    const configConflict = await request(
      admin.port, 'POST', '/_admin/api/model-routing/validate', payload,
    );
    assert.equal(configConflict.status, 409);
    assert.equal(JSON.parse(configConflict.text).error.code, 'revision_conflict');

    await fs.writeFile(admin.configPath, `${JSON.stringify(admin.config, null, 2)}\n`);
    const fresh = (await routingState(admin)).body;
    await fs.writeFile(admin.catalogPath, `${JSON.stringify({ models: [] }, null, 2)}\n`);
    const catalogConflict = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      configRevision: fresh.configRevision,
      catalogRevision: fresh.catalogRevision,
      operations: [],
    });
    assert.equal(catalogConflict.status, 409);
    assert.equal(JSON.parse(catalogConflict.text).error.code, 'revision_conflict');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由拒绝 operation 中的认证字段与嵌套秘密', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-secret-'));
  const admin = await startAdmin(tempDir);
  try {
    const { body: state } = await routingState(admin);
    const operations = [
      { kind: 'target.create', target: { name: 'bad', match: '^bad$', headers: { authorization: 'Bearer leaked' } } },
      { kind: 'target.create', target: { name: 'bad', match: '^bad$', auth: { token: 'leaked' } } },
      { kind: 'target.create', target: { name: 'bad', match: '^bad$', apiKey: 'leaked' } },
      { kind: 'target.create', target: { name: 'bad', match: '^bad$', vision: { nested: { cookie: 'leaked' } } } },
      {
        kind: 'model.update',
        slug: 'custom',
        patch: { experimental_supported_tools: [{ metadata: { oauth: { refresh: 'OAUTH-LEAK' } } }] },
      },
      {
        kind: 'model.update',
        slug: 'custom',
        patch: { experimental_supported_tools: [{ metadata: { api: { key: 'API-LEAK' } } }] },
      },
      {
        kind: 'model.update',
        slug: 'custom',
        patch: {
          experimental_supported_tools: [{
            nested: {
              authorization: 'AUTH-LEAK',
              cookie: 'COOKIE-LEAK',
              token: 'TOKEN-LEAK',
              privateKey: 'PRIVATE-KEY-LEAK',
            },
          }],
        },
      },
    ];
    for (const operation of operations) {
      const rejected = await request(admin.port, 'POST', '/_admin/api/model-routing/validate', {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: [operation],
      });
      assert.equal(rejected.status, 400);
      assert.equal(JSON.parse(rejected.text).error.code, 'operation_sensitive_field');
      assert.doesNotMatch(
        rejected.text,
        /Bearer leaked|"leaked"|OAUTH-LEAK|API-LEAK|AUTH-LEAK|COOKIE-LEAK|TOKEN-LEAK|PRIVATE-KEY-LEAK/,
      );
    }
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由 GET 和 operation 对 Key 家族 fail closed 且不误伤普通单词', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-key-family-'));
  const admin = await startAdmin(tempDir);
  const getSentinel = 'SENTINEL-HTTP-GET-KEY-FAMILY';
  const operationSentinel = 'SENTINEL-HTTP-OPERATION-KEY-FAMILY';
  const sensitiveNames = [
    'key', 'Key', 'keyId', 'key_id', 'key-id', 'key.value',
    'access_key', 'auth-key', 'api-key', 'private-key', 'client-key', 'session-key',
    'publicKey', 'public_key', 'master_key', 'provider-key', 'displayKey', 'signing_key',
    'encryption-key', 'consumerKey', 'publishable_key', 'sshKey',
    'api', 'oauth', 'auth', 'credentials', 'headers', 'cookies', 'secrets', 'bearer',
  ];
  const safeNames = ['keyboard', 'monkey', 'keynote', 'tokenizer'];
  try {
    const catalog = structuredClone(admin.catalog);
    catalog.models[0].metadata = Object.fromEntries([
      ...sensitiveNames.map((name) => [name, getSentinel]),
      ...safeNames.map((name) => [name, `safe-${name}`]),
    ]);
    await fs.writeFile(admin.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    const { response, body: state } = await routingState(admin);
    assert.doesNotMatch(response.text, /SENTINEL-HTTP-GET-KEY-FAMILY/);
    assert.deepEqual(state.models[0].metadata, Object.fromEntries(
      safeNames.map((name) => [name, `safe-${name}`]),
    ));

    for (const name of sensitiveNames) {
      const operation = {
        kind: 'model.update',
        slug: 'custom',
        patch: { experimental_supported_tools: [{ metadata: { [name]: operationSentinel } }] },
      };
      const rejected = await request(admin.port, 'POST', '/_admin/api/model-routing/validate', {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: [operation],
      });
      assert.equal(rejected.status, 400);
      assert.equal(JSON.parse(rejected.text).error.code, 'operation_sensitive_field');
      assert.doesNotMatch(rejected.text, /SENTINEL-HTTP-OPERATION-KEY-FAMILY/);
    }
    const putRejected = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
      operations: [{
        kind: 'model.update',
        slug: 'custom',
        patch: { experimental_supported_tools: [{ metadata: { key: operationSentinel } }] },
      }],
    });
    assert.equal(putRejected.status, 400);
    assert.equal(JSON.parse(putRejected.text).error.code, 'operation_sensitive_field');
    assert.doesNotMatch(putRejected.text, /SENTINEL-HTTP-OPERATION-KEY-FAMILY/);
    assert.doesNotMatch(
      await fs.readFile(admin.catalogPath, 'utf8'),
      /SENTINEL-HTTP-OPERATION-KEY-FAMILY/,
    );
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由 HTTP 按路径限制 target 认证字段且拒绝模型全树变体落盘', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-path-scope-'));
  const admin = await startAdmin(tempDir);
  const getSentinel = 'SENTINEL-HTTP-GET-PATH-SCOPE';
  const operationSentinel = 'SENTINEL-HTTP-OPERATION-PATH-SCOPE';
  const sensitiveNames = [
    'envKey', 'ENV_KEY', 'env-key', 'eNv.Key',
    'authHeader', 'AUTH_HEADER', 'auth-header', 'aUtH.Header',
    'forwardHeaders', 'FORWARD_HEADERS', 'forward-headers', 'fOrWaRd.Headers',
  ];
  const placements = (field, value) => [
    { [field]: value },
    { extension: { [field]: value } },
    { experimental_supported_tools: [{ metadata: { [field]: value } }] },
  ];
  try {
    const catalog = structuredClone(admin.catalog);
    catalog.models[0].extension = {};
    catalog.models[0].experimental_supported_tools = [];
    for (const name of sensitiveNames) {
      catalog.models[0][name] = getSentinel;
      catalog.models[0].extension[name] = getSentinel;
      catalog.models[0].experimental_supported_tools.push({
        metadata: { [name]: getSentinel },
      });
    }
    await fs.writeFile(admin.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    const { response, body: state } = await routingState(admin);
    assert.doesNotMatch(response.text, /SENTINEL-HTTP-GET-PATH-SCOPE/);

    for (const name of sensitiveNames) {
      for (const placement of placements(name, operationSentinel)) {
        const operation = { kind: 'model.update', slug: 'custom', patch: placement };
        const rejected = await request(admin.port, 'POST', '/_admin/api/model-routing/validate', {
          configRevision: state.configRevision,
          catalogRevision: state.catalogRevision,
          operations: [operation],
        });
        assert.equal(rejected.status, 400, name);
        assert.equal(JSON.parse(rejected.text).error.code, 'operation_sensitive_field', name);
        assert.doesNotMatch(rejected.text, /SENTINEL-HTTP-OPERATION-PATH-SCOPE/);
      }
    }

    const putRejected = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
      operations: [{
        kind: 'model.update',
        slug: 'custom',
        patch: { extension: { envKey: operationSentinel } },
      }],
    });
    assert.equal(putRejected.status, 400);
    assert.equal(JSON.parse(putRejected.text).error.code, 'operation_sensitive_field');
    assert.doesNotMatch(putRejected.text, /SENTINEL-HTTP-OPERATION-PATH-SCOPE/);
    assert.doesNotMatch(
      await fs.readFile(admin.catalogPath, 'utf8'),
      /SENTINEL-HTTP-OPERATION-PATH-SCOPE/,
    );
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由 GET 省略分层认证容器但保留非敏感未知模型字段', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-exposure-'));
  const admin = await startAdmin(tempDir);
  try {
    const catalog = structuredClone(admin.catalog);
    catalog.models[0].metadata = {
      oauth: { refresh: 'GET-OAUTH-LEAK' },
      api: { key: 'GET-API-LEAK' },
      nested: {
        authorization: 'GET-AUTH-LEAK',
        cookie: 'GET-COOKIE-LEAK',
        token: 'GET-TOKEN-LEAK',
        privateKey: 'GET-PRIVATE-KEY-LEAK',
      },
      safeUnknown: { enabled: true, value: 'safe-model-value' },
      safeApi: { api: { format: 'responses', value: 'safe-api-value' } },
    };
    await fs.writeFile(admin.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

    const { response, body } = await routingState(admin);
    assert.deepEqual(body.models[0].metadata, {
      nested: {},
      safeUnknown: { enabled: true, value: 'safe-model-value' },
      safeApi: {},
    });
    assert.doesNotMatch(
      response.text,
      /GET-OAUTH-LEAK|GET-API-LEAK|GET-AUTH-LEAK|GET-COOKIE-LEAK|GET-TOKEN-LEAK|GET-PRIVATE-KEY-LEAK/,
    );
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('联合模型路由 HTTP 对精确敏感容器的 primitive、数组和名称变体 fail closed', async () => {
  const cases = [
    ['oauth', 'HTTP-OAUTH-STRING-LEAK'],
    ['auth', 42],
    ['credentials', ['HTTP-CREDENTIALS-ARRAY-LEAK', 7]],
    ['headers', [['HTTP-HEADERS-NESTED-ARRAY-LEAK']]],
    ['cookies', 'HTTP-COOKIES-STRING-LEAK'],
    ['secrets', 73],
    ['api', ['HTTP-API-ARRAY-LEAK']],
    ['oAu-Th', [['HTTP-OAUTH-VARIANT-LEAK']]],
    ['cre_den-tials', 'HTTP-CREDENTIALS-VARIANT-LEAK'],
    ['oauth', { mode: 'pkce', value: 'HTTP-OAUTH-OBJECT-LEAK' }],
    ['api', { format: 'responses', value: 'HTTP-API-OBJECT-LEAK' }],
  ];
  const safeMetadata = {
    apiFormat: 'responses',
    authType: 'header',
    tokenizer: 'safe-tokenizer',
    tokenCount: 12,
    max_output_tokens: 1_024,
    value: 'safe-value',
    format: 'safe-format',
    mode: 'safe-mode',
    unknown: { value: 'safe-unknown-value' },
  };

  for (const [index, [field, value]] of cases.entries()) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `router-admin-container-${index}-`));
    const admin = await startAdmin(tempDir);
    try {
      const catalog = structuredClone(admin.catalog);
      catalog.models[0].metadata = { ...safeMetadata, [field]: value };
      await fs.writeFile(admin.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

      const { response, body: state } = await routingState(admin);
      assert.equal(Object.hasOwn(state.models[0].metadata, field), false, field);
      assert.deepEqual(state.models[0].metadata, safeMetadata);
      assert.doesNotMatch(response.text, /HTTP-(?:OAUTH|CREDENTIALS|HEADERS|COOKIES|API)/);

      const rejected = await request(admin.port, 'POST', '/_admin/api/model-routing/validate', {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: [{
          kind: 'model.update',
          slug: 'custom',
          patch: {
            experimental_supported_tools: [{ metadata: { ...safeMetadata, [field]: value } }],
          },
        }],
      });
      assert.equal(rejected.status, 400, field);
      assert.equal(JSON.parse(rejected.text).error.code, 'operation_sensitive_field');
      assert.doesNotMatch(rejected.text, /HTTP-(?:OAUTH|CREDENTIALS|HEADERS|COOKIES|API)/);
    } finally {
      await new Promise((resolve) => admin.server.close(resolve));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('联合模型路由事务错误保持稳定 code 且不泄漏路径或秘密', async () => {
  for (const [code, expectedStatus, publicCode, txid] of [
    ['transaction_rolled_back', 409, 'transaction_rolled_back', 'safe-txid'],
    ['transaction_in_doubt', 500, 'transaction_in_doubt', 'safe-txid'],
    ['transaction_in_doubt', 500, 'transaction_in_doubt', '..\\config.json\nTXID-LEAK'],
    ['private_secret_code', 500, 'transaction_failed', 'safe-txid'],
  ]) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `router-admin-routing-${code}-`));
    const admin = await startAdmin(tempDir, {
      transactionFactory: () => ({
        commit: async () => {
          const error = new Error(`secret at ${tempDir}`);
          error.code = code;
          error.txid = txid;
          throw error;
        },
      }),
    });
    try {
      const { body: state } = await routingState(admin);
      const failed = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: [{ kind: 'model.update', slug: 'custom', patch: { display_name: 'Safe' } }],
      });
      assert.equal(failed.status, expectedStatus);
      const body = JSON.parse(failed.text);
      assert.equal(body.error.code, publicCode);
      if (code === 'transaction_in_doubt' && txid === 'safe-txid') {
        assert.equal(body.error.txid, 'safe-txid');
      }
      if (txid !== 'safe-txid') assert.equal(Object.hasOwn(body.error, 'txid'), false);
      assert.doesNotMatch(
        failed.text,
        /secret at|private_secret_code|TXID-LEAK|router-admin-routing|config\.json|models\.json/,
      );
    } finally {
      await new Promise((resolve) => admin.server.close(resolve));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('事务 factory 同步抛错时净化恶意 code、message 和 txid', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-factory-throw-'));
  const admin = await startAdmin(tempDir, {
    transactionFactory: () => {
      const error = new Error(`FACTORY-MESSAGE-LEAK ${path.join(tempDir, 'config.json')}`);
      error.code = 'FACTORY-CODE-LEAK';
      error.txid = '..\\models.json\r\nFACTORY-TXID-LEAK';
      throw error;
    },
  });
  try {
    const { body: state } = await routingState(admin);
    const failed = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
      configRevision: state.configRevision,
      catalogRevision: state.catalogRevision,
      operations: [{ kind: 'model.update', slug: 'custom', patch: { display_name: 'Safe' } }],
    });
    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failed.text), {
      error: { code: 'transaction_failed', message: '模型路由事务未提交' },
    });
    assert.doesNotMatch(
      failed.text,
      /FACTORY-MESSAGE-LEAK|FACTORY-CODE-LEAK|FACTORY-TXID-LEAK|config\.json|models\.json/,
    );
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('事务成功返回值必须含合法双 revision 和事务层格式 txid', async () => {
  for (const committed of [
    {
      configRevision: 'BAD-CONFIG-REVISION-LEAK',
      catalogRevision: 'b'.repeat(64),
      txid: 'valid-txid',
    },
    {
      configRevision: 'a'.repeat(64),
      catalogRevision: 'BAD-CATALOG-REVISION-LEAK',
      txid: 'valid-txid',
    },
    {
      configRevision: 'a'.repeat(64),
      catalogRevision: 'b'.repeat(64),
      txid: '..\\models.json\r\nBAD-TXID-LEAK',
    },
  ]) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-routing-result-'));
    const admin = await startAdmin(tempDir, {
      transactionFactory: () => ({ commit: async () => committed }),
    });
    try {
      const { body: state } = await routingState(admin);
      const failed = await request(admin.port, 'PUT', '/_admin/api/model-routing', {
        configRevision: state.configRevision,
        catalogRevision: state.catalogRevision,
        operations: [{ kind: 'model.update', slug: 'custom', patch: { display_name: 'Safe' } }],
      });
      assert.equal(failed.status, 500);
      assert.deepEqual(JSON.parse(failed.text), {
        error: { code: 'transaction_failed', message: '模型路由事务未提交' },
      });
      assert.doesNotMatch(
        failed.text,
        /BAD-CONFIG-REVISION-LEAK|BAD-CATALOG-REVISION-LEAK|BAD-TXID-LEAK|models\.json/,
      );
    } finally {
      await new Promise((resolve) => admin.server.close(resolve));
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('管理 API 返回脱敏状态和带不可伪造占位的配置', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-api-'));
  const admin = await startAdmin(tempDir);
  try {
    const status = await request(admin.port, 'GET', '/_admin/api/status');
    assert.equal(status.status, 200);
    const statusBody = JSON.parse(status.text);
    assert.equal(statusBody.port, 15730);
    assert.equal(statusBody.targets[0].envSet, true);
    assert.equal(statusBody.targets[0].viaProxy, false);
    assert.doesNotMatch(status.text, /runtime-secret|static-secret/);

    const response = await request(admin.port, 'GET', '/_admin/api/config');
    assert.equal(response.status, 200);
    const body = JSON.parse(response.text);
    assert.match(body.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(body.config.targets[0].headers.authorization, {
      $preserveSecret: body.config.targets[0].headers.authorization.$preserveSecret,
    });
    assert.match(body.config.targets[0].headers.authorization.$preserveSecret, /^[a-f0-9-]+$/);
    assert.match(body.config.targets[0].headers['x-provider-token'].$preserveSecret, /^[a-f0-9-]+$/);
    assert.equal(body.config.targets[0].headers['x-tenant'], 'tenant-a');
    assert.doesNotMatch(response.text, /static-secret|custom-static-secret/);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('配置预检和保存保留未知字段及敏感值并拒绝旧 revision', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-save-'));
  const admin = await startAdmin(tempDir);
  try {
    const loaded = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    loaded.config.port = 16730;
    const validation = await request(admin.port, 'POST', '/_admin/api/config/validate', loaded);
    assert.equal(validation.status, 200);
    assert.deepEqual(JSON.parse(validation.text).errors, []);

    const saved = await request(admin.port, 'PUT', '/_admin/api/config', loaded);
    assert.equal(saved.status, 200);
    const savedBody = JSON.parse(saved.text);
    assert.equal(savedBody.restartRequired, true);
    const disk = JSON.parse(await fs.readFile(admin.configPath, 'utf8'));
    assert.equal(disk.port, 16730);
    assert.deepEqual(disk.customExtension, { keep: true });
    assert.equal(disk.targets[0].headers.authorization, 'Bearer static-secret');
    assert.equal(disk.targets[0].headers['x-provider-token'], 'custom-static-secret');

    const conflict = await request(admin.port, 'PUT', '/_admin/api/config', loaded);
    assert.equal(conflict.status, 409);
    assert.equal(JSON.parse(conflict.text).error.code, 'revision_conflict');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('配置保存提交前被外部改写时返回 revision_conflict 且不覆盖外部版本', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-save-race-'));
  let configPath;
  let changed = false;
  const concurrent = Buffer.from(`${JSON.stringify({
    ...validConfig(17730),
    customExtension: { external: true },
  }, null, 2)}\n`);
  const configFileSystem = {
    ...fsSync,
    copyFileSync(source, destination, flags) {
      fsSync.copyFileSync(source, destination, flags);
      if (source === configPath && !changed) {
        changed = true;
        fsSync.writeFileSync(configPath, concurrent);
      }
    },
  };
  const admin = await startAdmin(tempDir, { configFileSystem });
  configPath = admin.configPath;
  try {
    const loaded = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    loaded.config.port = 16730;

    const response = await request(admin.port, 'PUT', '/_admin/api/config', loaded);

    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(response.text), {
      error: {
        code: 'revision_conflict',
        message: '文件已被其他页面或进程修改',
      },
    });
    assert.deepEqual(await fs.readFile(admin.configPath), concurrent);
    assert.equal(fsSync.existsSync(`${admin.configPath}.bak`), false);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('配置备份失败返回安全 500 且保留原文件和恢复备份', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-save-failure-'));
  const priorBackup = Buffer.from('{"priorBackup":true}\n');
  let configPath;
  const configFileSystem = {
    ...fsSync,
    copyFileSync(source, destination, flags) {
      fsSync.copyFileSync(source, destination, flags);
      if (source === configPath) {
        const error = new Error(`private backup failure at ${destination}`);
        error.code = 'PRIVATE_BACKUP_FAILURE';
        throw error;
      }
    },
  };
  const admin = await startAdmin(tempDir, { configFileSystem });
  configPath = admin.configPath;
  await fs.writeFile(`${admin.configPath}.bak`, priorBackup);
  const original = await fs.readFile(admin.configPath);
  try {
    const loaded = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    loaded.config.port = 16730;

    const response = await request(admin.port, 'PUT', '/_admin/api/config', loaded);

    assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.text), {
      error: {
        code: 'config_write_failed',
        message: '配置保存失败，原文件已保留',
      },
    });
    assert.doesNotMatch(response.text, /private|config\.json|backup|PRIVATE_BACKUP_FAILURE/i);
    assert.deepEqual(await fs.readFile(admin.configPath), original);
    assert.deepEqual(await fs.readFile(`${admin.configPath}.bak`), priorBackup);
    assert.deepEqual(
      (await fs.readdir(tempDir)).filter((name) => name.includes('.tmp-')),
      [],
    );
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('携带正确确认值保存时真正删除敏感字段且不落盘占位对象', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-secret-delete-'));
  const admin = await startAdmin(tempDir);
  try {
    const loaded = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    loaded.secretDeletes = ['/targets/0/headers/authorization'];

    const saved = await request(admin.port, 'PUT', '/_admin/api/config', loaded);
    assert.equal(saved.status, 200);
    const diskText = await fs.readFile(admin.configPath, 'utf8');
    const disk = JSON.parse(diskText);
    assert.equal(Object.hasOwn(disk.targets[0].headers, 'authorization'), false);
    assert.equal(disk.targets[0].headers['x-tenant'], 'tenant-a');
    assert.doesNotMatch(diskText, /\$preserveSecret/);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('拒绝错 revision 复用和移动后残留的敏感字段占位', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-secret-placeholder-'));
  const admin = await startAdmin(tempDir);
  try {
    const stale = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    const changedConfig = validConfig(15731);
    await fs.writeFile(admin.configPath, JSON.stringify(changedConfig, null, 2));
    const current = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);

    current.config.targets[0].headers.authorization = stale.config.targets[0].headers.authorization;
    const wrongRevisionToken = await request(admin.port, 'PUT', '/_admin/api/config', current);
    assert.equal(wrongRevisionToken.status, 400);
    assert.equal(JSON.parse(wrongRevisionToken.text).error.code, 'secret_placeholder_invalid');

    const moved = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    moved.config.customExtension.leftover = moved.config.targets[0].headers.authorization;
    const residualPlaceholder = await request(admin.port, 'PUT', '/_admin/api/config', moved);
    assert.equal(residualPlaceholder.status, 400);
    assert.equal(JSON.parse(residualPlaceholder.text).error.code, 'secret_placeholder_invalid');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('管理请求不能新增当前配置不存在的明文敏感请求头', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-secret-add-'));
  const admin = await startAdmin(tempDir);
  try {
    const loaded = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    loaded.config.targets[0].headers['x-api-key'] = 'must-not-be-written';

    const rejected = await request(admin.port, 'PUT', '/_admin/api/config', loaded);
    assert.equal(rejected.status, 400);
    assert.equal(JSON.parse(rejected.text).error.code, 'secret_field_add_forbidden');

    const disk = JSON.parse(await fs.readFile(admin.configPath, 'utf8'));
    assert.equal(Object.hasOwn(disk.targets[0].headers, 'x-api-key'), false);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('敏感占位令牌采用有界缓存并淘汰最旧令牌', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-placeholder-bound-'));
  const admin = await startAdmin(tempDir);
  try {
    const oldest = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    for (let index = 0; index < 512; index += 1) {
      const response = await request(admin.port, 'GET', '/_admin/api/config');
      assert.equal(response.status, 200);
    }

    const rejected = await request(admin.port, 'PUT', '/_admin/api/config', oldest);
    assert.equal(rejected.status, 400);
    assert.equal(JSON.parse(rejected.text).error.code, 'secret_placeholder_invalid');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('敏感删除确认采用有界缓存并淘汰最旧 revision', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-confirmation-bound-'));
  const admin = await startAdmin(tempDir);
  try {
    const originalText = await fs.readFile(admin.configPath, 'utf8');
    const oldest = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    oldest.secretDeletes = ['/targets/0/headers/authorization'];

    for (let index = 0; index < 64; index += 1) {
      const config = validConfig(16000 + index);
      config._cacheRevision = index;
      await fs.writeFile(admin.configPath, JSON.stringify(config, null, 2));
      const response = await request(admin.port, 'GET', '/_admin/api/config');
      assert.equal(response.status, 200);
    }
    await fs.writeFile(admin.configPath, originalText);

    const rejected = await request(admin.port, 'PUT', '/_admin/api/config', oldest);
    assert.equal(rejected.status, 400);
    assert.equal(JSON.parse(rejected.text).error.code, 'secret_delete_confirmation_invalid');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('同一 revision 的多个敏感删除确认互不覆盖且各自只能消费一次', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-secret-delete-tabs-'));
  const admin = await startAdmin(tempDir);
  const originalText = await fs.readFile(admin.configPath, 'utf8');
  try {
    const first = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    const second = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    assert.notEqual(first.secretDeleteConfirmation, second.secretDeleteConfirmation);
    first.secretDeletes = ['/targets/0/headers/authorization'];
    second.secretDeletes = ['/targets/0/headers/authorization'];

    const wrong = await request(admin.port, 'PUT', '/_admin/api/config', {
      ...first,
      secretDeleteConfirmation: 'wrong-token',
    });
    assert.equal(wrong.status, 400);
    assert.equal(JSON.parse(wrong.text).error.code, 'secret_delete_confirmation_invalid');

    const firstSaved = await request(admin.port, 'PUT', '/_admin/api/config', first);
    assert.equal(firstSaved.status, 200);

    // 恢复完全相同的测试文件 revision，只为证明第二个标签的确认值没有被覆盖。
    await fs.writeFile(admin.configPath, originalText);
    const secondSaved = await request(admin.port, 'PUT', '/_admin/api/config', second);
    assert.equal(secondSaved.status, 200);

    await fs.writeFile(admin.configPath, originalText);
    const repeated = await request(admin.port, 'PUT', '/_admin/api/config', first);
    assert.equal(repeated.status, 400);
    assert.equal(JSON.parse(repeated.text).error.code, 'secret_delete_confirmation_invalid');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('检查点清空要求一次性确认值', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-checkpoints-'));
  const admin = await startAdmin(tempDir);
  try {
    const state = JSON.parse((await request(admin.port, 'GET', '/_admin/api/checkpoints')).text);
    assert.equal(state.count, 1);
    assert.match(state.confirmation, /^[a-f0-9-]+$/);

    const rejected = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: 'wrong',
    });
    assert.equal(rejected.status, 409);

    const cleared = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: state.confirmation,
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(JSON.parse(cleared.text), {
      ok: true,
      removed: 1,
      backupPath: null,
      recoveryHint: '持久化已关闭，仅清空当前内存检查点',
    });
    assert.equal(admin.persistence.clearCalls, 1);
    assert.equal(admin.checkpointStore.exportSnapshot().entries.length, 0);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('多个检查点清空确认互不覆盖，错误值不消耗正确值且每个值只用一次', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-checkpoint-tabs-'));
  const admin = await startAdmin(tempDir);
  try {
    const first = JSON.parse((await request(admin.port, 'GET', '/_admin/api/checkpoints')).text);
    const second = JSON.parse((await request(admin.port, 'GET', '/_admin/api/checkpoints')).text);
    assert.notEqual(first.confirmation, second.confirmation);

    const wrong = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: 'wrong-token',
    });
    assert.equal(wrong.status, 409);

    const firstCleared = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: first.confirmation,
    });
    assert.equal(firstCleared.status, 200);
    assert.equal(JSON.parse(firstCleared.text).removed, 1);

    const secondCleared = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: second.confirmation,
    });
    assert.equal(secondCleared.status, 200);
    assert.equal(JSON.parse(secondCleared.text).removed, 0);

    const repeated = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: first.confirmation,
    });
    assert.equal(repeated.status, 409);
    assert.equal(admin.persistence.clearCalls, 2);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('检查点确认缓存有界并淘汰最旧令牌', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-checkpoint-bound-'));
  const admin = await startAdmin(tempDir);
  try {
    const oldest = JSON.parse((await request(admin.port, 'GET', '/_admin/api/checkpoints')).text);
    let newest = oldest;
    for (let index = 0; index < 64; index += 1) {
      newest = JSON.parse((await request(admin.port, 'GET', '/_admin/api/checkpoints')).text);
    }

    const evicted = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: oldest.confirmation,
    });
    assert.equal(evicted.status, 409);

    const accepted = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: newest.confirmation,
    });
    assert.equal(accepted.status, 200);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('敏感删除与检查点确认都在 TTL 后失效', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-confirmation-ttl-'));
  let now = 1_000;
  const admin = await startAdmin(tempDir, { now: () => now });
  try {
    const config = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    config.secretDeletes = ['/targets/0/headers/authorization'];
    const checkpoints = JSON.parse((await request(admin.port, 'GET', '/_admin/api/checkpoints')).text);

    now = 61_001;
    const configExpired = await request(admin.port, 'PUT', '/_admin/api/config', config);
    assert.equal(configExpired.status, 400);
    assert.equal(JSON.parse(configExpired.text).error.code, 'secret_delete_confirmation_invalid');

    const checkpointExpired = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: checkpoints.confirmation,
    });
    assert.equal(checkpointExpired.status, 409);
    assert.equal(JSON.parse(checkpointExpired.text).error.code, 'confirmation_invalid');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('检查点持久化清空失败时管理 API 返回非 200 且不伪报成功', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-checkpoint-failure-'));
  const admin = await startAdmin(tempDir);
  try {
    admin.persistence.clearRecoverably = async () => {
      const error = new Error('检查点空快照写入失败');
      error.code = 'checkpoint_clear_failed';
      error.backupPath = path.join(tempDir, 'checkpoint.clear-backup.bak');
      throw error;
    };
    const state = JSON.parse((await request(admin.port, 'GET', '/_admin/api/checkpoints')).text);

    const failed = await request(admin.port, 'DELETE', '/_admin/api/checkpoints', {
      confirmation: state.confirmation,
    });

    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failed.text), {
      error: {
        code: 'checkpoint_clear_failed',
        message: '检查点清空失败，原状态已保留',
      },
    });
    assert.equal(admin.checkpointStore.exportSnapshot().entries.length, 1);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
