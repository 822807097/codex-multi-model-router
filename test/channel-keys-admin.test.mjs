import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAdminHandler } from '../lib/admin-api.mjs';
import { createChannelKeyPool } from '../lib/channel-key-pool.mjs';
import { initDatabase } from '../lib/db.mjs';
import { GoalCheckpointStore } from '../lib/goal-checkpoint.mjs';

// 测试专用内存库（本文件独立进程，全局单例只在本文件生效）
const db = initDatabase(':memory:');

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
    targets: [
      {
        name: 'custom',
        match: '^custom$',
        host: 'api.example.test',
        prefix: '/v1',
        envKey: 'TEST_KEY',
        wireApi: 'chat',
      },
      {
        name: 'oauth-channel',
        match: '^gpt-',
        host: 'chatgpt.com',
        prefix: '/backend-api/codex',
        useOpenAiAuth: true,
        wireApi: 'responses',
      },
    ],
  };
}

async function startAdmin(tempDir, overrides = {}) {
  const configPath = path.join(tempDir, 'config.json');
  const catalogPath = path.join(tempDir, 'models.json');
  const codexHome = path.join(tempDir, 'codex-home');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_reasoning_effort = "high"',
    'model = "custom"',
    'model_provider = "router"',
    '',
    '[model_providers.router]',
    'name = "router"',
  ].join('\n'), 'utf8');
  const config = validConfig(15730);
  const catalog = {
    models: [
      { slug: 'custom', display_name: 'Custom', input_modalities: ['text'] },
      { slug: 'qwen3.8-max', display_name: 'Qwen3.8-Max', input_modalities: ['text'] },
    ],
  };
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2));
  const checkpointStore = new GoalCheckpointStore();
  const keyPool = createChannelKeyPool({
    db,
    envKeySource: { getKey: (name) => ({ TEST_KEY: 'sk-runtime-secret', SECOND_REF: 'sk-second-ref' }[name]) },
  });
  const handler = createAdminHandler({
    configPath,
    defaultCodexHome: codexHome,
    env: { TEST_KEY: 'sk-runtime-secret', SECOND_REF: 'sk-second-ref' },
    runtime: { port: 15730 },
    targets: config.targets,
    warnings: [],
    startedAt: Date.now() - 1000,
    checkpointStore,
    persistence: {
      status: () => ({ mode: 'disabled', loadedEntries: 0 }),
      flush: async () => false,
      clearRecoverably: async () => ({ removed: 0, backupPath: null }),
    },
    catalogPath,
    keyPool,
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
    codexHome,
  };
}

test('通道密钥池管理端点：创建/校验/列表/更新/吊销全流程', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-keypool-'));
  const admin = await startAdmin(tempDir);
  try {
    // 1. 创建明文 key
    const created = await request(admin.port, 'POST', '/_admin/api/channel-keys/create', {
      target: 'custom', kind: 'plaintext', label: '账号1', key: 'sk-test-key-111111111111', priority: 0,
      skipVerify: true,
    });
    assert.equal(created.status, 200);
    const keyId = JSON.parse(created.text).id;

    // 2. 创建 env_ref key
    const envRef = await request(admin.port, 'POST', '/_admin/api/channel-keys/create', {
      target: 'custom', kind: 'env_ref', label: '账号2', key: 'SECOND_REF', priority: 5,
      skipVerify: true,
    });
    assert.equal(envRef.status, 200);

    // 3. 无效 target / OAuth 通道拒绝
    const badTarget = await request(admin.port, 'POST', '/_admin/api/channel-keys/create', {
      target: 'not-exist', kind: 'plaintext', key: 'sk-xxx',
    });
    assert.equal(badTarget.status, 404);
    const oauthReject = await request(admin.port, 'POST', '/_admin/api/channel-keys/create', {
      target: 'oauth-channel', kind: 'plaintext', key: 'sk-xxx',
    });
    assert.equal(oauthReject.status, 400);
    assert.equal(JSON.parse(oauthReject.text).error.code, 'target_auth_unsupported');

    // 4. env_ref 变量不存在 → 拒绝
    const missingRef = await request(admin.port, 'POST', '/_admin/api/channel-keys/create', {
      target: 'custom', kind: 'env_ref', key: 'NOT_DEFINED_VAR',
    });
    assert.equal(missingRef.status, 400);
    assert.equal(JSON.parse(missingRef.text).error.code, 'env_ref_missing');

    // 5. 列表：脱敏 + 优先级 + 冷却状态
    const list = await request(admin.port, 'GET', '/_admin/api/channel-keys?target=custom');
    assert.equal(list.status, 200);
    const entries = JSON.parse(list.text).entries;
    assert.equal(entries.length, 2);
    const plain = entries.find((entry) => entry.id === keyId);
    assert.equal(plain.maskedKey, 'sk-tes****1111');
    assert.equal(plain.kind, 'plaintext');
    assert.equal(plain.priority, 0);
    assert.equal(plain.cooldown.active, false);
    assert.equal(entries.find((entry) => entry.kind === 'env_ref').refName, 'SECOND_REF');

    // 5b. 不传 target：按通道分组返回全量（计划 3.4）
    const all = await request(admin.port, 'GET', '/_admin/api/channel-keys');
    const allBody = JSON.parse(all.text);
    assert.equal(allBody.grouped, true);
    assert.ok(Array.isArray(allBody.groups), '应返回 groups 数组');
    const customGroup = allBody.groups.find((group) => group.target === 'custom');
    assert.equal(customGroup.count, 2);
    assert.equal(customGroup.entries.length, 2);

    // 6. 更新：改优先级 + label
    const updated = await request(admin.port, 'POST', '/_admin/api/channel-keys/update', {
      id: keyId, label: '主账号', priority: 3,
    });
    assert.equal(updated.status, 200);
    const listAfterUpdate = await request(admin.port, 'GET', '/_admin/api/channel-keys?target=custom');
    const after = JSON.parse(listAfterUpdate.text).entries.find((entry) => entry.id === keyId);
    assert.equal(after.label, '主账号');
    assert.equal(after.priority, 3);

    // 7. 更新不存在 id → 404
    const missing = await request(admin.port, 'POST', '/_admin/api/channel-keys/update', {
      id: 'ckey_not_exist', label: 'x',
    });
    assert.equal(missing.status, 404);

    // 8. 吊销
    const revoked = await request(admin.port, 'POST', '/_admin/api/channel-keys/revoke', { id: keyId });
    assert.equal(revoked.status, 200);
    const listAfterRevoke = await request(admin.port, 'GET', '/_admin/api/channel-keys?target=custom');
    assert.equal(JSON.parse(listAfterRevoke.text).entries.length, 1);

    // 8b. 切换形态必须同时提供新 key（防 key_value 语义错位）
    const envRefId = JSON.parse(envRef.text).id;
    const kindSwitchNoKey = await request(admin.port, 'POST', '/_admin/api/channel-keys/update', {
      id: envRefId, kind: 'plaintext',
    });
    assert.equal(kindSwitchNoKey.status, 400);
    assert.equal(JSON.parse(kindSwitchNoKey.text).error.code, 'kind_switch_requires_key');
    const kindSwitchWithKey = await request(admin.port, 'POST', '/_admin/api/channel-keys/update', {
      id: envRefId, kind: 'plaintext', key: 'sk-switched-111111111111',
    });
    assert.equal(kindSwitchWithKey.status, 200);
    const afterSwitch = await request(admin.port, 'GET', '/_admin/api/channel-keys?target=custom');
    const switchedEntry = JSON.parse(afterSwitch.text).entries.find((entry) => entry.id === envRefId);
    assert.equal(switchedEntry.kind, 'plaintext');
    assert.equal(switchedEntry.maskedKey, 'sk-swi****1111');

    // 8c. 默认直连验证（skipVerify 缺省时不可达上游 → 400 key_verify_failed 且不落库）
    const verifyFail = await request(admin.port, 'POST', '/_admin/api/channel-keys/create', {
      target: 'custom', kind: 'plaintext', key: 'sk-verify-fail-111111111111',
    });
    assert.equal(verifyFail.status, 400);
    assert.equal(JSON.parse(verifyFail.text).error.code, 'key_verify_failed');
    const afterVerifyFail = await request(admin.port, 'GET', '/_admin/api/channel-keys?target=custom');
    assert.equal(JSON.parse(afterVerifyFail.text).entries.length, 1, '验证失败不得落库');

    // 9. keyPool 未注入时端点整体 503（隔离验证）
    const tempDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-nopool-'));
    const adminNoPool = await startAdmin(tempDir2, { keyPool: null });
    try {
      const blocked = await request(adminNoPool.port, 'GET', '/_admin/api/channel-keys');
      assert.equal(blocked.status, 503);
    } finally {
      await new Promise((resolve) => adminNoPool.server.close(resolve));
      await fs.rm(tempDir2, { recursive: true, force: true });
    }
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('厂商预设库：GET 清单 + activate 新建通道/去重/模型写入/env_ref 校验', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-vendor-'));
  const admin = await startAdmin(tempDir);
  try {
    // 1. GET 清单：16 家、分组、字段完整
    const list = await request(admin.port, 'GET', '/_admin/api/vendor-presets');
    assert.equal(list.status, 200);
    const presets = JSON.parse(list.text).presets;
    assert.equal(presets.length, 16);
    const categories = new Set(presets.map((preset) => preset.category));
    assert.deepEqual([...categories].sort(), ['aggregator', 'cn_official', 'official']);
    const deepseek = presets.find((preset) => preset.id === 'deepseek');
    assert.equal(deepseek.host, 'api.deepseek.com');
    assert.equal(deepseek.prefix, '', '与既有 deepseek-chat 同 host+prefix 去重');
    assert.ok(deepseek.models.length > 0);
    assert.equal(deepseek.existingTarget, null, '测试 config 无同 host 通道');

    // 2. activate：新建通道 + 模型写入 + key 入池
    const activated = await request(admin.port, 'POST', '/_admin/api/vendor-presets/activate', {
      vendorId: 'deepseek',
      keys: [
        { kind: 'plaintext', key: 'sk-vendor-test-key-111111', label: '主账号', priority: 0 },
        { kind: 'env_ref', key: 'SECOND_REF', label: '备用', priority: 5 },
      ],
    });
    assert.equal(activated.status, 200, activated.text);
    const actBody = JSON.parse(activated.text);
    assert.equal(actBody.target, 'deepseek');
    assert.equal(actBody.keyCount, 2);
    assert.ok(actBody.addedModels > 0);

    // config 已含新通道
    const configRes = await request(admin.port, 'GET', '/_admin/api/config');
    const config = JSON.parse(configRes.text).config;
    const newTarget = config.targets.find((target) => target.name === 'deepseek');
    assert.ok(newTarget, '新通道已写入 config');
    assert.equal(newTarget.host, 'api.deepseek.com');
    assert.equal(newTarget.prefix, '', '与既有 deepseek-chat 通道同 host+prefix，去重命中');
    assert.equal(newTarget.match, '^deepseek-');
    assert.equal(newTarget.envKey, undefined, '密钥走池，不落 envKey');

    // catalog 已含预设默认模型
    const modelsRes = await request(admin.port, 'GET', '/_admin/api/models');
    const models = JSON.parse(modelsRes.text).models;
    assert.ok(models.some((model) => model.slug === 'deepseek-v4-flash'), '预设模型已写入 catalog');

    // key 池已入账（脱敏展示）
    const poolRes = await request(admin.port, 'GET', '/_admin/api/channel-keys?target=deepseek');
    const entries = JSON.parse(poolRes.text).entries;
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.maskedKey || entry.refName), '列表脱敏');

    // 3. 重复 activate：host/prefix 去重 → 复用通道，只追加 key
    const reActivate = await request(admin.port, 'POST', '/_admin/api/vendor-presets/activate', {
      vendorId: 'deepseek',
      keys: [{ kind: 'plaintext', key: 'sk-vendor-extra-key-222222', label: '账号3', priority: 0 }],
      addCatalog: false,
    });
    assert.equal(reActivate.status, 200);
    const reBody = JSON.parse(reActivate.text);
    assert.equal(reBody.target, 'deepseek', '复用既有通道名');
    assert.match(reBody.changes.join('；'), /复用既有通道/);
    assert.equal(reBody.addedModels, 0, 'addCatalog=false 不写模型');
    const poolRes2 = await request(admin.port, 'GET', '/_admin/api/channel-keys?target=deepseek');
    assert.equal(JSON.parse(poolRes2.text).entries.length, 3);

    // 4. env_ref 未设置 → 拒绝且不落任何改动（secretDeleteConfirmation 每次生成，比较 config 内容）
    const envBefore = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    const missingRef = await request(admin.port, 'POST', '/_admin/api/vendor-presets/activate', {
      vendorId: 'minimax',
      keys: [{ kind: 'env_ref', key: 'NOT_DEFINED_VAR' }],
    });
    assert.equal(missingRef.status, 400);
    assert.equal(JSON.parse(missingRef.text).error.code, 'env_ref_missing');
    const configAfter = JSON.parse((await request(admin.port, 'GET', '/_admin/api/config')).text);
    assert.deepEqual(configAfter.config, envBefore.config, '校验失败不得改动 config');
    assert.ok(!configAfter.config.targets.some((target) => target.name === 'minimax'), 'minimax 通道不得创建');

    // 5. 未知 vendor → 404
    const unknown = await request(admin.port, 'POST', '/_admin/api/vendor-presets/activate', {
      vendorId: 'no-such-vendor',
      keys: [{ kind: 'plaintext', key: 'sk-xxx' }],
    });
    assert.equal(unknown.status, 404);

    // 6. 空 keys → 400
    const empty = await request(admin.port, 'POST', '/_admin/api/vendor-presets/activate', {
      vendorId: 'deepseek',
      keys: [],
    });
    assert.equal(empty.status, 400);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Codex 默认模型：GET 读当前值与 catalog 清单，PUT 原子写回并备份', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-codexmodel-'));
  const admin = await startAdmin(tempDir);
  try {
    // 1. GET：当前值来自 config.toml 顶部 model 行 + catalog 模型清单
    const got = await request(admin.port, 'GET', '/_admin/api/codex-default-model');
    assert.equal(got.status, 200);
    const body = JSON.parse(got.text);
    assert.equal(body.current, 'custom');
    assert.ok(body.models.some((model) => model.slug === 'qwen3.8-max'));
    assert.ok(body.configPath.endsWith('config.toml'));

    // 2. PUT：原子替换顶部 model 行 + 生成备份
    const put = await request(admin.port, 'PUT', '/_admin/api/codex-default-model', {
      model: 'qwen3.8-max',
    });
    assert.equal(put.status, 200);
    const putBody = JSON.parse(put.text);
    assert.equal(putBody.changed, true);
    assert.ok(putBody.backup, '写入前已备份');
    const toml = await fs.readFile(path.join(admin.codexHome, 'config.toml'), 'utf8');
    assert.match(toml, /^model = "qwen3\.8-max"$/m);
    const backupExists = await fs.access(putBody.backup).then(() => true).catch(() => false);
    assert.equal(backupExists, true, '备份文件存在');

    // 3. 再次 GET 反映新值
    const got2 = await request(admin.port, 'GET', '/_admin/api/codex-default-model');
    assert.equal(JSON.parse(got2.text).current, 'qwen3.8-max');

    // 4. 相同值幂等：changed=false 不生成新备份
    const putSame = await request(admin.port, 'PUT', '/_admin/api/codex-default-model', {
      model: 'qwen3.8-max',
    });
    assert.equal(JSON.parse(putSame.text).changed, false);

    // 5. 非法模型名 → 400
    const bad = await request(admin.port, 'PUT', '/_admin/api/codex-default-model', { model: 'a\nb' });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('模型显示名平台前缀：add 加前缀、remove 移除、幂等', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-admin-prefix-'));
  const admin = await startAdmin(tempDir);
  try {
    // 初始 catalog：custom 模型（目标通道 custom，前缀应为 custom）
    // 1. add：display_name 加目标短名前缀
    const added = await request(admin.port, 'POST', '/_admin/api/models/prefix-platform', { mode: 'add' });
    assert.equal(added.status, 200);
    const addBody = JSON.parse(added.text);
    assert.ok(addBody.changed >= 1, '应至少变更一个模型');
    const modelsAfterAdd = await request(admin.port, 'GET', '/_admin/api/models');
    const afterAdd = JSON.parse(modelsAfterAdd.text).models;
    const custom = afterAdd.find((m) => m.slug === 'custom');
    assert.equal(custom.displayName, 'custom/Custom', 'display_name 应加目标短名前缀');

    // 2. 幂等：再次 add 不重复加
    const addedAgain = await request(admin.port, 'POST', '/_admin/api/models/prefix-platform', { mode: 'add' });
    assert.equal(JSON.parse(addedAgain.text).changed, 0, '已带前缀不得重复添加');

    // 3. remove：移除前缀
    const removed = await request(admin.port, 'POST', '/_admin/api/models/prefix-platform', { mode: 'remove' });
    assert.equal(removed.status, 200);
    const modelsAfterRemove = await request(admin.port, 'GET', '/_admin/api/models');
    const afterRemove = JSON.parse(modelsAfterRemove.text).models.find((m) => m.slug === 'custom');
    assert.equal(afterRemove.displayName, 'Custom', 'remove 应还原显示名');
  } finally {
    await new Promise((resolve) => admin.server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
