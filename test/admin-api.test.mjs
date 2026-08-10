import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAdminHandler } from '../lib/admin-api.mjs';
import { GoalCheckpointStore } from '../lib/goal-checkpoint.mjs';

function request(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : {},
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

async function startAdmin(tempDir) {
  const configPath = path.join(tempDir, 'config.json');
  const config = validConfig(15730);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
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
    config,
    checkpointStore,
    persistence,
  };
}

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
        message: '检查点空快照写入失败',
        backupPath: path.join(tempDir, 'checkpoint.clear-backup.bak'),
      },
    });
    assert.equal(admin.checkpointStore.exportSnapshot().entries.length, 1);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
