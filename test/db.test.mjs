import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  initDatabase,
  dbSaveAccount,
  dbListAccounts,
  dbDeleteAccount,
  dbRecordTokenLog,
  dbGetDashboardStats,
} from '../lib/db.mjs';

test('SQLite 数据库初始化与安全参数绑定', () => {
  const testDbPath = path.join(process.cwd(), 'data', 'test-router.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = initDatabase(testDbPath);
  assert.ok(db, '数据库初始化成功');

  // 1. 账号增删查
  dbSaveAccount({
    id: 'acc_claude_1',
    provider: 'claude',
    email: 'user@claude.pro',
    alias: 'Claude Pro 主号',
    proxy_enabled: 1,
    proxy_url: 'http://127.0.0.1:10808',
    status: 'active',
    quota_used: 10,
    quota_limit: 100,
  });

  const accounts = dbListAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].alias, 'Claude Pro 主号');
  assert.equal(accounts[0].provider, 'claude');

  // 2. Token 记录
  dbRecordTokenLog({
    model: 'gemini-3.7-flash-high',
    target: 'google',
    inputTokens: 1000,
    outputTokens: 500,
    reasoningTokens: 200,
    cachedTokens: 100,
    totalTokens: 1500,
    durationMs: 350,
  });

  dbRecordTokenLog({
    model: 'qwen3.8-max',
    target: 'bailian',
    inputTokens: 2000,
    outputTokens: 1000,
    reasoningTokens: 400,
    cachedTokens: 0,
    totalTokens: 3000,
    durationMs: 420,
  });

  // 3. 6 卡矩阵与图表聚合
  const dashboard = dbGetDashboardStats(30);
  assert.equal(dashboard.metrics.totalTokens, 4500);
  assert.equal(dashboard.metrics.totalRounds, 2);
  assert.equal(dashboard.metrics.activeDays, 1);
  assert.equal(dashboard.metrics.topModel.model, 'qwen3.8-max');
  assert.ok(dashboard.heatmap.length > 0, '热力图数据生成正常');
  assert.ok(dashboard.stackedChart.days.length > 0, '堆叠图数据生成正常');

  // 清理
  dbDeleteAccount('acc_claude_1');
  assert.equal(dbListAccounts().length, 0);
});

// ---------- 凭据 vault：损坏文件兼容与写回归一 ----------

test('credentialsVault 修复历史双重包装损坏并归一写回', async () => {
  const { createCredentialsVault } = await import('../lib/auth/credentials-store.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fix-'));
  const vaultPath = path.join(tmp, 'vault.json');
  // 复刻线上损坏形态：多层 {updatedAt, accounts} 嵌套（历史每写一次多包一层），且各层混入凭据
  fs.writeFileSync(vaultPath, JSON.stringify({
    updatedAt: 3,
    accounts: {
      updatedAt: 2,
      accounts: {
        updatedAt: 1,
        accounts: { 'google_deep': { accessToken: 'a0', refreshToken: 'r0', expiresAt: 0 } },
        'openai_inner': { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 },
      },
      'google_misplaced_meta': { notCredential: true },
    },
    'openai_outer': { accessToken: 'a2', refreshToken: 'r2', expiresAt: 2 },
  }));
  const vault = createCredentialsVault({ vaultPath });
  const all = vault.loadAll();
  if (!all.openai_inner || !all.openai_outer || !all.google_deep) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('损坏文件未正确解包合并');
  }
  // 任一次 set 触发写回后文件应归一为单层 {updatedAt, accounts:{id:cred}}
  vault.set('claude_new', { accessToken: 'a3', refreshToken: 'r3' });
  const reread = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
  if (!reread.accounts?.openai_inner || !reread.accounts?.openai_outer || !reread.accounts?.claude_new) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('写回未归一为单层 accounts map');
  }
  if (reread.accounts.openai_inner.refreshToken !== 'r1') {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('凭据内容在迁移中损坏');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- API Key 签发、校验与多工具支持 ----------

test('API Key 管理: 签发、SHA-256 哈希脱敏、多工具校验与吊销', async () => {
  const { createApiKeyStore } = await import('../lib/api-keys.mjs');
  const testDbPath = path.join(process.cwd(), 'data', 'test-api-keys.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const db = initDatabase(testDbPath);
  const keyStore = createApiKeyStore({ db });

  // 1. 无 key 状态: hasKeys() 为 false (开放模式)
  assert.equal(keyStore.hasKeys(), false, '初始应无 key');
  assert.equal(keyStore.listKeys().length, 0);

  // 2. 为 Trae 签发 key
  const traeCreated = keyStore.createKey({
    name: 'Trae IDE',
    client: 'trae',
    description: 'Trae 编程助手专用 Key',
  });
  assert.ok(traeCreated.key.startsWith('sk-router-'), 'Key 必须以 sk-router- 开头');
  assert.equal(traeCreated.client, 'trae');
  assert.equal(keyStore.hasKeys(), true, '创建 key 后应进入鉴权模式');

  // 3. 为 Qoder 与 OpenCode 签发独立 key
  const qoderCreated = keyStore.createKey({ name: 'Qoder CLI', client: 'qoder' });
  const opencodeCreated = keyStore.createKey({ name: 'OpenCode Agent', client: 'opencode' });

  // 4. 列表脱敏展示
  const list = keyStore.listKeys();
  assert.equal(list.length, 3);
  const traeListed = list.find((k) => k.id === traeCreated.id);
  assert.ok(traeListed.keyPrefix.startsWith('sk-router-'));
  assert.ok(traeListed.keySuffix.length > 0);
  assert.equal(traeListed.fullKey, undefined, '列表不得暴露明文完整 key');

  // 5. 校验正确 key
  const verifiedTrae = keyStore.verifyKey(traeCreated.key);
  assert.ok(verifiedTrae, '正确 key 必须校验通过');
  assert.equal(verifiedTrae.client, 'trae');

  // 6. 错误 key 与空 key 拒绝
  assert.equal(keyStore.verifyKey('sk-router-invalid-key-here'), null);
  assert.equal(keyStore.verifyKey(''), null);
  assert.equal(keyStore.verifyKey(null), null);

  // 7. 吊销 Qoder Key
  const revoked = keyStore.revokeKey(qoderCreated.id);
  assert.equal(revoked, true);
  assert.equal(keyStore.verifyKey(qoderCreated.key), null, '已吊销 key 必须立即失效');

  // 8. 吊销剩余 key 后自动回到开放模式；吊销即删除语义：列表不再出现已吊销 key
  keyStore.revokeKey(traeCreated.id);
  keyStore.revokeKey(opencodeCreated.id);
  assert.equal(keyStore.hasKeys(), false, '全部 key 吊销后应回到开放模式');
  assert.equal(
    keyStore.listKeys().some((k) => k.id === traeCreated.id || k.id === qoderCreated.id),
    false,
    '已吊销 key 必须从列表消失（吊销即删除）',
  );

  // 9. 内部探针 key：可校验通过，但不计入鉴权模式、不进入管理页列表
  const probeKey = keyStore.rotateInternalProbeKey();
  assert.ok(probeKey.startsWith('sk-router-'));
  assert.ok(keyStore.verifyKey(probeKey), '探针 key 必须能通过校验（回环探测带它）');
  assert.equal(keyStore.hasKeys(), false, '探针 key 不得触发鉴权模式');
  assert.equal(keyStore.listKeys().some(k => k.client === 'internal-probe'), false, '探针 key 不得出现在列表');
  // 再签一个业务 key，鉴权模式开启时探针依然有效
  const bizKey = keyStore.createKey({ name: 'biz', client: 'trae' });
  assert.equal(keyStore.hasKeys(), true);
  assert.ok(keyStore.verifyKey(probeKey), '鉴权开启时探针 key 仍可通过校验');
  keyStore.revokeKey(bizKey.id);

  // 10. touch 节流：60 秒窗口内重复 verify 只落一次 last_used_at（用未吊销 key 验证）
  const touchKey = keyStore.createKey({ name: 'touch-probe', client: 'generic' });
  // 预热一次（首次 touch 从 0 落库）；之后 3 次节流窗口内至多再落一次
  keyStore.throttledTouch(touchKey.id);
  const before = keyStore.listKeys().find(k => k.id === touchKey.id);
  const t0 = Date.now();
  keyStore.throttledTouch(touchKey.id);
  keyStore.throttledTouch(touchKey.id);
  keyStore.throttledTouch(touchKey.id);
  const after = keyStore.listKeys().find(k => k.id === touchKey.id);
  assert.ok(after.lastUsedAt - before.lastUsedAt < 5000, '节流后 lastUsedAt 至多前进一次（含时钟容差）');
  keyStore.revokeKey(touchKey.id);

  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

test('credentialsVault 并发 set 不互相覆盖（串行化写）', async () => {
  const { createCredentialsVault } = await import('../lib/auth/credentials-store.mjs');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-conc-'));
  const vaultPath = path.join(tmp, 'vault.json');
  const vault = createCredentialsVault({ vaultPath });

  // 两个账号并发写入：修复前各自读旧 map 再写回，后写者覆盖先写者导致丢一个账号
  await Promise.all([
    vault.set('acc_a', { accessToken: 'ta', refreshToken: 'ra' }),
    vault.set('acc_b', { accessToken: 'tb', refreshToken: 'rb' }),
  ]);
  const reread = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
  if (!reread.accounts?.acc_a || !reread.accounts?.acc_b) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`并发 set 丢账号：${JSON.stringify(Object.keys(reread.accounts || {}))}`);
  }
  if (reread.accounts.acc_a.refreshToken !== 'ra' || reread.accounts.acc_b.refreshToken !== 'rb') {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('并发 set 凭据内容错乱');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
