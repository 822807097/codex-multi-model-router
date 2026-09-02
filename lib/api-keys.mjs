import crypto from 'node:crypto';

/**
 * 路由 API Key 管理：多工具（Trae / Qoder / OpenCode / Codex）接入凭据。
 * - 完整 key 仅创建时返回一次；库中只存 SHA-256，杜绝明文落盘
 * - 存在任意未吊销 key 时 /v1/* 强制鉴权；全部吊销自动回到开放模式（防锁死）
 */

export const API_KEY_PREFIX = 'sk-router-';

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function generateApiKey() {
  const secret = crypto.randomBytes(32).toString('hex');
  return `${API_KEY_PREFIX}${secret}`;
}

// 内部回环探针（models/test 连通性探测）专用 client 标记：
// 可通过 verify 校验，但不计入鉴权模式判断、也不出现在管理页列表。
export const INTERNAL_PROBE_CLIENT = 'internal-probe';
// last_used_at 落库节流窗口：每个 key 60 秒内至多写一次，避免高频请求写放大。
const TOUCH_THROTTLE_MS = 60_000;

export function createApiKeyStore({ db, now = () => Date.now() } = {}) {
  if (!db) throw new Error('createApiKeyStore 需要 db 句柄');
  const touchTimestamps = new Map();

  function create(input) {
    const opts = typeof input === 'object' && input !== null ? input : { name: input };
    const name = String(opts.name || '未命名').slice(0, 120);
    const client = String(opts.client || 'generic').slice(0, 32);
    const description = String(opts.description || '').slice(0, 255);
    const key = generateApiKey();
    const id = `key_${crypto.randomBytes(8).toString('hex')}`;
    const createdAt = now();
    const keyPrefix = key.slice(0, API_KEY_PREFIX.length + 6);
    const keySuffix = key.slice(-4);

    db.prepare(
      'INSERT INTO api_keys (id, name, client, description, key_hash, key_prefix, key_suffix, created_at, last_used_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)',
    ).run(id, name, client, description, sha256Hex(key), keyPrefix, keySuffix, createdAt);

    // 完整 key 只随创建响应一次性返回
    return { id, name, client, description, key, createdAt, keyPrefix, keySuffix };
  }

  function list() {
    // 吊销即删除语义：列表只返回未吊销 key，吊销后立即从管理页消失（记录保留用于审计）
    return db.prepare(`SELECT id, name, client, description, key_prefix, key_suffix, created_at, last_used_at, revoked FROM api_keys WHERE client != ? AND revoked = 0 ORDER BY created_at DESC`).all(INTERNAL_PROBE_CLIENT)
      .map((row) => ({
        id: row.id,
        name: row.name,
        client: row.client || 'generic',
        description: row.description || '',
        keyPrefix: row.key_prefix,
        keySuffix: row.key_suffix || '',
        createdAt: Number(row.created_at),
        lastUsedAt: Number(row.last_used_at || 0),
        revoked: Number(row.revoked) === 1,
      }));
  }

  /** 幂等获取（不存在则创建）内部探针 key 的明文，供回环探测带上 Bearer。 */
  function ensureInternalProbeKey() {
    const row = db.prepare(
      `SELECT key_hash FROM api_keys WHERE client = ? AND revoked = 0 LIMIT 1`,
    ).get(INTERNAL_PROBE_CLIENT);
    if (row) return null; // 已存在但明文不可逆——探针 key 需要明文，只能重建轮换
    const created = create({ name: '内部连通性探测', client: INTERNAL_PROBE_CLIENT, description: 'models/test 回环探测专用' });
    return created.key;
  }

  /** 返回当前有效的内部探针明文 key；库中已有（明文不可恢复）时轮换重建并返回新明文。 */
  function rotateInternalProbeKey() {
    db.prepare(`UPDATE api_keys SET revoked = 1 WHERE client = ? AND revoked = 0`).run(INTERNAL_PROBE_CLIENT);
    return create({ name: '内部连通性探测', client: INTERNAL_PROBE_CLIENT, description: 'models/test 回环探测专用' }).key;
  }

  function verify(key) {
    if (!key || !key.startsWith(API_KEY_PREFIX)) return null;
    const rows = db.prepare('SELECT id, name, client, revoked FROM api_keys WHERE key_hash = ? LIMIT 1').all(sha256Hex(key));
    const row = rows[0];
    if (!row || Number(row.revoked) === 1) return null;
    throttledTouch(row.id);
    return { id: row.id, name: row.name, client: row.client || 'generic' };
  }

  function throttledTouch(id) {
    const last = touchTimestamps.get(id) || 0;
    const currentTime = now();
    if (currentTime - last < TOUCH_THROTTLE_MS) return;
    touchTimestamps.set(id, currentTime);
    touch(id);
  }

  function touch(id) {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  function revoke(id) {
    const result = db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ?').run(id);
    return Number(result?.changes || 0) > 0;
  }

  function hasActiveKey() {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM api_keys WHERE revoked = 0 AND client != ?`).get(INTERNAL_PROBE_CLIENT);
    return Number(row?.n || 0) > 0;
  }

  return {
    create,
    createKey: create,
    list,
    listKeys: list,
    verify,
    verifyKey: verify,
    touch,
    throttledTouch,
    revoke,
    revokeKey: revoke,
    hasActiveKey,
    hasKeys: hasActiveKey,
    ensureInternalProbeKey,
    rotateInternalProbeKey,
  };
}
