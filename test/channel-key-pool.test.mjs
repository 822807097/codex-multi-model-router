import test from 'node:test';
import assert from 'node:assert/strict';

import { initDatabase } from '../lib/db.mjs';
import { createChannelKeyPool, maskKey } from '../lib/channel-key-pool.mjs';

// 每个测试文件独立进程，initDatabase 的全局单例只在本文件内生效。
const db = initDatabase(':memory:');

function createPool(envStore, options = {}) {
  return createChannelKeyPool({
    db,
    envKeySource: { getKey: (name) => envStore[name] },
    now: options.now || Date.now,
  });
}

const TARGET = 'deepseek-chat';


test('掩码：前 6 后 4，短 key 全掩', () => {
  assert.equal(maskKey('sk-aaaa-111111111111'), 'sk-aaa****1111');
  assert.equal(maskKey('abc'), '****');
  assert.equal(maskKey(''), '');
});


test('优先级排序：数字小者先试，同优先级轮询', () => {
  const pool = createPool({});
  const a = pool.createEntry({ target: 'pool-t-2', kind: 'plaintext', label: 'A', key: 'sk-aaaa-000000000001', priority: 0 });
  const b = pool.createEntry({ target: 'pool-t-2', kind: 'plaintext', label: 'B', key: 'sk-bbbb-000000000002', priority: 0 });
  const c = pool.createEntry({ target: 'pool-t-2', kind: 'plaintext', label: 'C', key: 'sk-cccc-000000000003', priority: 5 });

  // p0 组两把轮询，p5 在 p0 组可用时永远轮不到
  const picked = [];
  for (let i = 0; i < 4; i += 1) {
    picked.push(pool.acquireKey({ name: 'pool-t-2', envKey: 'MISSING' }).entryId);
  }
  assert.deepEqual(picked, [a, b, a, b]);
});


test('env_ref：解析成功参与轮询，解析失败跳过该条目', () => {
  const envStore = { REAL_REF: 'sk-env-real-value' };
  const pool = createPool(envStore);
  const bad = pool.createEntry({ target: 'pool-t-3', kind: 'env_ref', label: '坏引用', key: 'MISSING_VAR', priority: 0 });
  const good = pool.createEntry({ target: 'pool-t-3', kind: 'env_ref', label: '好引用', key: 'REAL_REF', priority: 0 });

  const r1 = pool.acquireKey({ name: 'pool-t-3', envKey: 'MISSING' });
  assert.equal(r1.entryId, good, '解析失败的条目被跳过');
  assert.equal(r1.value, 'sk-env-real-value');

  pool.revokeEntry(good);
  pool.revokeEntry(bad);
  const r2 = pool.acquireKey({ name: 'pool-t-3', envKey: 'MISSING' });
  assert.equal(r2, null, '全部吊销后无 key 可用');
});


test('冷却：跳过冷却中的高优先级 key，落到低优先级', () => {
  const pool = createPool({});
  const a = pool.createEntry({ target: 'pool-t-4', kind: 'plaintext', label: 'A', key: 'sk-aaaa-000000000001', priority: 0 });
  const c = pool.createEntry({ target: 'pool-t-4', kind: 'plaintext', label: 'C', key: 'sk-cccc-000000000003', priority: 5 });
  pool.markKeyCooldown(a, { retryAt: Date.now() + 600_000 });

  const r = pool.acquireKey({ name: 'pool-t-4', envKey: 'MISSING' });
  assert.equal(r.entryId, c, 'p0 冷却中应落 p5');
});


test('全冷却 → envKey 兜底；无 envKey → null', () => {
  const pool = createPool({ LEGACY: 'sk-legacy-value' });
  const a = pool.createEntry({ target: 'pool-t-5', kind: 'plaintext', label: 'A', key: 'sk-aaaa-000000000001', priority: 0 });
  pool.markKeyCooldown(a, { retryAt: Date.now() + 600_000 });

  const r1 = pool.acquireKey({ name: 'pool-t-5', envKey: 'LEGACY' });
  assert.equal(r1.source, 'env');
  assert.equal(r1.value, 'sk-legacy-value');

  const r2 = pool.acquireKey({ name: 'pool-t-5', envKey: 'LEGACY' });
  assert.equal(r2.source, 'env', '池全冷却时持续走 envKey 兜底');
});


test('冷却持久化：markKeyCooldown 落库（含额度类型备注），重启不丢', () => {
  const pool = createPool({});
  const a = pool.createEntry({ target: 'pool-t-6', kind: 'plaintext', label: 'A', key: 'sk-aaaa-000000000001', priority: 0 });
  const until = Date.now() + 5 * 60_000;
  pool.markKeyCooldown(a, { retryAt: until, note: '周额度 08-21 11:36 UTC' });

  const row = db.prepare('SELECT cooldown_until, cooldown_note FROM channel_keys WHERE id = ?').get(a);
  assert.equal(row.cooldown_until, until);
  assert.equal(row.cooldown_note, '周额度 08-21 11:36 UTC');
});


test('冷却恢复时间解析：retry-after 头 → 错误体文本 → 默认 5 分钟', () => {
  const pool = createPool({});
  const a = pool.createEntry({ target: 'pool-t-7', kind: 'plaintext', label: 'A', key: 'sk-aaaa-000000000001', priority: 0 });

  // 1. retry-after 数字秒
  const now = Date.now();
  pool.markKeyCooldown(a, { headers: { 'retry-after': '120' } });
  let row = db.prepare('SELECT cooldown_until FROM channel_keys WHERE id = ?').get(a);
  assert.ok(Math.abs(row.cooldown_until - (now + 120_000)) < 5_000, `retry-after 秒解析: ${row.cooldown_until}`);

  // 2. 错误体文本（百炼式 "quota will reset at 08-21 11:36:00 UTC"）
  const bodyText = 'insufficient_quota: quota will reset at 08-21 11:36:00 UTC';
  pool.markKeyCooldown(a, { bodyText });
  row = db.prepare('SELECT cooldown_until, cooldown_note FROM channel_keys WHERE id = ?').get(a);
  // 解析时间应落在「补当年份的 08-21 11:36 UTC」附近
  const expected = Date.parse(`${new Date(now).getUTCFullYear()}-08-21 11:36:00 UTC`);
  assert.ok(Math.abs(row.cooldown_until - expected) < 5_000, `文本解析: ${row.cooldown_until}`);

  // 3. 无可解析来源 → 默认 5 分钟
  pool.markKeyCooldown(a, {});
  row = db.prepare('SELECT cooldown_until FROM channel_keys WHERE id = ?').get(a);
  assert.ok(Math.abs(row.cooldown_until - (now + 5 * 60_000)) < 5_000, `默认 5 分钟: ${row.cooldown_until}`);
});


test('updateEntry：覆写 key 或切换形态清冷却；仅改 label 不清', () => {
  const pool = createPool({});
  const a = pool.createEntry({ target: 'pool-t-8', kind: 'plaintext', label: 'A', key: 'sk-aaaa-000000000001', priority: 0 });
  const until = Date.now() + 600_000;
  pool.markKeyCooldown(a, { retryAt: until });

  pool.updateEntry(a, { label: '改名' });
  let row = db.prepare('SELECT label, cooldown_until FROM channel_keys WHERE id = ?').get(a);
  assert.equal(row.label, '改名');
  assert.equal(row.cooldown_until, until, '仅改 label 不清冷却');

  pool.updateEntry(a, { key_value: 'sk-new-value-000000000001' });
  row = db.prepare('SELECT key_value, cooldown_until FROM channel_keys WHERE id = ?').get(a);
  assert.equal(row.cooldown_until, 0, '覆写 key 清冷却');
  assert.equal(row.key_value, 'sk-new-value-000000000001');
});


test('revoke：软删除后不再参与选择，listWithCooldown 不含已吊销', () => {
  const pool = createPool({});
  const a = pool.createEntry({ target: 'pool-t-9', kind: 'plaintext', label: 'A', key: 'sk-aaaa-000000000001', priority: 0 });
  pool.revokeEntry(a);
  assert.equal(pool.acquireKey({ name: 'pool-t-9', envKey: 'MISSING' }), null);
  assert.equal(pool.listWithCooldown('pool-t-9').length, 0);
});


test('listWithCooldown：脱敏 + 冷却状态/恢复时间/剩余毫秒 + env 解析状态', () => {
  const envStore = { REAL_REF: 'sk-env-real-value' };
  const pool = createPool(envStore);
  const a = pool.createEntry({ target: 'pool-t-10', kind: 'plaintext', label: 'A', key: 'sk-aaaa-111111111111', priority: 0 });
  const b = pool.createEntry({ target: 'pool-t-10', kind: 'env_ref', label: 'B', key: 'REAL_REF', priority: 0 });
  const until = Date.now() + 300_000;
  pool.markKeyCooldown(a, { retryAt: until, note: '5 小时窗口' });

  const list = pool.listWithCooldown('pool-t-10');
  assert.equal(list.length, 2);
  const entryA = list.find((e) => e.id === a);
  assert.equal(entryA.maskedKey, 'sk-aaa****1111');
  assert.equal(entryA.cooldown.active, true);
  assert.equal(entryA.cooldown.retryAt, until);
  assert.ok(entryA.cooldown.remainingMs > 0 && entryA.cooldown.remainingMs <= 300_000);
  assert.equal(entryA.cooldown.note, '5 小时窗口');
  const entryB = list.find((e) => e.id === b);
  assert.equal(entryB.kind, 'env_ref');
  assert.equal(entryB.refName, 'REAL_REF');
  assert.equal(entryB.envResolved, true);
  assert.equal(entryB.cooldown.active, false);
});


test('earliestRetryAt：返回池内最早恢复时间，无冷却为 0', () => {
  const pool = createPool({});
  const OTHER = 'earliest-target';
  assert.equal(pool.earliestRetryAt(OTHER), 0);
  const a = pool.createEntry({ target: OTHER, kind: 'plaintext', label: 'A', key: 'sk-aaaa-000000000001', priority: 0 });
  const b = pool.createEntry({ target: OTHER, kind: 'plaintext', label: 'B', key: 'sk-bbbb-000000000002', priority: 0 });
  const t1 = Date.now() + 120_000;
  const t2 = Date.now() + 600_000;
  pool.markKeyCooldown(a, { retryAt: t1 });
  pool.markKeyCooldown(b, { retryAt: t2 });
  assert.equal(pool.earliestRetryAt(OTHER), t1, '取最早而非最后');
});
