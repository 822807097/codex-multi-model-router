// ---------- 通道密钥池 ----------
// 同一通道（host 相同）挂多把订阅 key = 多账号轮换（sub2api account pool 的 key 维度等价物）。
// - 每把 key 有用户可调优先级（数字小者先试；同优先级内轮询均摊）
// - key 级冷却持久化到 SQLite（cooldown_until），重启不丢
// - 单请求只取一把 key（acquireKey 返回 pool 命中或 envKey 兜底，二选一）
// 安全约束：所有 SQL 走 db.mjs 预编译参数绑定；key 明文只驻留 SQLite 与进程内存，
// 列表导出经 maskKey 脱敏（前 6 后 4），不写日志、不落盘。

import { randomBytes } from 'node:crypto';
import { resolveQuotaRetryAt } from './model-quota-cooldown.mjs';

const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const TOUCH_THROTTLE_MS = 60_000;
const KEY_ID_PREFIX = 'ckey_';
const MAX_LABEL_LENGTH = 120;

export function maskKey(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 10) return '****';
  return `${value.slice(0, 6)}****${value.slice(-4)}`;
}

function newEntryId() {
  return `${KEY_ID_PREFIX}${randomBytes(10).toString('hex')}`;
}

export function createChannelKeyPool(options) {
  const {
    db,
    envKeySource,
    now = Date.now,
    log = () => {},
  } = options;

  // 同优先级组内的轮询起点：`${target}\u0000${priority}` -> 下一起始下标
  const rrCursor = new Map();
  const lastTouched = new Map(); // entryId -> 上次 last_used_at 写入时间（节流）

  function resolveEntryValue(entry) {
    if (!entry) return undefined;
    if (entry.kind === 'env_ref') {
      return envKeySource.getKey(entry.key_value);
    }
    return entry.key_value;
  }

  /**
   * 取该通道本请求应使用的一把 key。
   * 优先级升序找第一个有可用 key 的优先级组（跳过冷却中/环境变量解析失败的条目），
   * 组内轮询；池空/全冷却/全解析失败时回退 target.envKey 现有链路。
   * 返回 { value, source: 'pool'|'env', entryId? } 或 null（连 envKey 也没有）。
   */
  function acquireKey(target) {
    const targetName = target && (typeof target === 'string' ? target : target.name);
    if (!targetName) return null;
    const currentTime = now();
    const rows = dbListChannelKeysFor(targetName);

    // 按优先级分组，只保留未被冷却的条目
    const groups = new Map();
    for (const row of rows) {
      if (row.revoked || Number(row.cooldown_until) > currentTime) continue;
      const priority = Number(row.priority) || 0;
      if (!groups.has(priority)) groups.set(priority, []);
      groups.get(priority).push(row);
    }

    const priorities = Array.from(groups.keys()).sort((a, b) => a - b);
    for (const priority of priorities) {
      const group = groups.get(priority);
      // 环境变量引用解析失败的条目不可用，但继续保留同组其他条目
      const usable = group.filter((entry) => resolveEntryValue(entry));
      if (usable.length === 0) continue;
      const cursorKey = `${targetName}\u0000${priority}`;
      const start = rrCursor.get(cursorKey) || 0;
      const picked = usable[start % usable.length];
      rrCursor.set(cursorKey, (start + 1) % usable.length);
      touchEntry(picked.id);
      // env_ref 记录的是变量名（非凭据），原样输出便于诊断；plaintext 只输出掩码
      const logValue = picked.kind === 'env_ref' ? picked.key_value : maskKey(picked.key_value);
      log(`key pool hit [${targetName}] ${picked.kind}:${logValue} (p${priority})`);
      return { value: resolveEntryValue(picked), source: 'pool', entryId: picked.id };
    }

    // 池空/全冷却 → envKey 兜底（原链路不变）
    const fallbackName = typeof target === 'string' ? null : target?.envKey;
    if (fallbackName) {
      const fallbackValue = envKeySource.getKey(fallbackName);
      if (fallbackValue) return { value: fallbackValue, source: 'env' };
    }
    return null;
  }

  function touchEntry(entryId) {
    const lastWrite = lastTouched.get(entryId);
    const currentTime = now();
    if (lastWrite && currentTime - lastWrite < TOUCH_THROTTLE_MS) return;
    lastTouched.set(entryId, currentTime);
    try {
      dbTouchChannelKeyFor(entryId, currentTime);
    } catch (error) {
      log(`key pool touch failed: ${error.message}`);
    }
  }

  /**
   * key 级冷却落库：上游 401/429 后调用。
   * retryAt 未显式传入时按配额解析器取精确恢复时间，解析不到默认 5 分钟。
   * note 未显式传入时从错误体提炼额度类型摘要（如 "5-hour usage limit reached"）。
   */
  function markKeyCooldown(entryId, { retryAt = null, note = '', headers = {}, bodyText = '' } = {}) {
    if (!entryId) return null;
    const resolvedRetryAt = retryAt
      || resolveQuotaRetryAt({ headers, bodyText, now });
    const until = resolvedRetryAt || now() + DEFAULT_COOLDOWN_MS;
    let effectiveNote = note;
    if (!effectiveNote && typeof bodyText === 'string' && bodyText) {
      try {
        const parsed = JSON.parse(bodyText.slice(0, 64 * 1024));
        const message = parsed?.error?.message || parsed?.message;
        if (typeof message === 'string' && message.trim()) {
          effectiveNote = message.trim().slice(0, 120);
        }
      } catch { /* 非 JSON 错误体不提炼 */ }
    }
    dbMarkChannelKeyCooldownFor(entryId, until, effectiveNote);
    log(`key pool cooldown [${entryId}] until ${new Date(until).toISOString()}${effectiveNote ? ` (${effectiveNote})` : ''}`);
    return until;
  }

  function clearKeyCooldown(entryId) {
    if (!entryId) return;
    dbClearChannelKeyCooldownFor(entryId);
    lastTouched.delete(entryId);
  }

  // ---------- 管理操作（全部经 db.mjs 参数绑定） ----------

  function listWithCooldown(targetName = null) {
    const currentTime = now();
    const rows = targetName ? dbListChannelKeysFor(targetName) : dbListAllChannelKeysFor();
    return rows.map((row) => {
      const cooled = Number(row.cooldown_until) > currentTime;
      const envResolved = row.kind === 'env_ref'
        ? Boolean(envKeySource.getKey(row.key_value))
        : null;
      return {
        id: row.id,
        target: row.target,
        kind: row.kind,
        label: row.label,
        maskedKey: maskKey(row.key_value),
        // env_ref 的 key_value 是变量名，直接展示变量名（非密钥）
        refName: row.kind === 'env_ref' ? row.key_value : null,
        priority: Number(row.priority) || 0,
        createdAt: Number(row.created_at),
        lastUsedAt: Number(row.last_used_at || 0),
        cooldown: cooled ? {
          active: true,
          retryAt: Number(row.cooldown_until),
          remainingMs: Number(row.cooldown_until) - currentTime,
          note: row.cooldown_note || '',
        } : { active: false, retryAt: 0, remainingMs: 0, note: '' },
        envResolved,
      };
    });
  }

  // 池内最早恢复时间（用于「全部账号耗尽」报错与通道卡片汇总）
  function earliestRetryAt(targetName) {
    const currentTime = now();
    const rows = dbListChannelKeysFor(targetName);
    let earliest = 0;
    for (const row of rows) {
      if (row.revoked) continue;
      const until = Number(row.cooldown_until);
      if (until > currentTime && (earliest === 0 || until < earliest)) earliest = until;
    }
    return earliest;
  }

  function createEntry({ target, kind, label, key, priority = 0 }) {
    const id = newEntryId();
    dbCreateChannelKeyFor({
      id,
      target: String(target),
      kind: kind === 'env_ref' ? 'env_ref' : 'plaintext',
      label: label ? String(label).slice(0, MAX_LABEL_LENGTH) : '',
      key_value: String(key),
      priority,
    });
    return id;
  }

  function updateEntry(id, patch = {}) {
    const changed = dbUpdateChannelKeyFor(id, patch);
    // 覆写 key 或切换形态后冷却状态不再可靠，一并清除
    if (changed && (patch.key_value !== undefined || patch.kind !== undefined)) {
      clearKeyCooldown(id);
    }
    return changed;
  }

  function revokeEntry(id) {
    dbRevokeChannelKeyFor(id);
    lastTouched.delete(id);
  }

  function getEntry(id) {
    const row = dbGetChannelKeyFor(id);
    if (!row) return null;
    return {
      id: row.id,
      target: row.target,
      kind: row.kind,
      label: row.label,
      key_value: row.key_value,
      priority: Number(row.priority) || 0,
      cooldownUntil: Number(row.cooldown_until || 0),
      revoked: Boolean(row.revoked),
    };
  }

  return {
    acquireKey,
    markKeyCooldown,
    clearKeyCooldown,
    listWithCooldown,
    earliestRetryAt,
    createEntry,
    updateEntry,
    revokeEntry,
    getEntry,
  };
}

// 与 db.mjs 的间接对接：延迟取 getDatabase()，避免模块加载期初始化数据库
import {
  dbCreateChannelKey,
  dbListChannelKeys,
  dbGetChannelKey,
  dbUpdateChannelKey,
  dbRevokeChannelKey,
  dbMarkChannelKeyCooldown,
  dbClearChannelKeyCooldown,
  dbTouchChannelKey,
} from './db.mjs';

const dbCreateChannelKeyFor = (entry) => dbCreateChannelKey(entry);
const dbListChannelKeysFor = (target) => dbListChannelKeys(target);
const dbListAllChannelKeysFor = () => dbListChannelKeys(null);
const dbGetChannelKeyFor = (id) => dbGetChannelKey(id);
const dbUpdateChannelKeyFor = (id, patch) => dbUpdateChannelKey(id, patch);
const dbRevokeChannelKeyFor = (id) => dbRevokeChannelKey(id);
const dbMarkChannelKeyCooldownFor = (id, until, note) => dbMarkChannelKeyCooldown(id, until, note);
const dbClearChannelKeyCooldownFor = (id) => dbClearChannelKeyCooldown(id);
const dbTouchChannelKeyFor = (id, ts) => dbTouchChannelKey(id, ts);
