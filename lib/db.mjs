import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

let dbInstance = null;

// 默认库路径锚定在模块所在目录（lib/../data），与 config.json 的解析方式一致，
// 避免从计划任务等 CWD 为 System32 的环境启动时把 data 建到系统目录。
// ROUTER_DB_PATH 环境变量可覆盖（测试隔离 / 运行实例独立库）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = () => process.env.ROUTER_DB_PATH || path.join(__dirname, '..', 'data', 'router.db');

// 初始化数据库（幂等单例）：WAL 模式 + 全部表结构与索引
// 注：SQL 全部参数绑定（prepared statement），禁止拼接
export function initDatabase(dbPath) {
  if (dbInstance) return dbInstance;

  const resolvedPath = dbPath || defaultDbPath();
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);

  // 开启 WAL 高并发读写模式与基础性能优化
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  // 1. 订阅账号池表
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      email TEXT,
      alias TEXT NOT NULL,
      proxy_enabled INTEGER DEFAULT 1,
      proxy_url TEXT DEFAULT 'http://127.0.0.1:10808',
      status TEXT DEFAULT 'active',
      quota_used INTEGER DEFAULT 0,
      quota_limit INTEGER DEFAULT 100,
      resets_at INTEGER DEFAULT 0,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_provider ON accounts(provider);
    CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
  `);

  // 1b. 路由 API Key 表（只存 SHA-256；明文 key 仅创建响应一次性返回）
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      client TEXT DEFAULT 'generic',
      description TEXT DEFAULT '',
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      key_suffix TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER DEFAULT 0,
      revoked INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  `);
  // 补齐历史字段
  try { db.exec('ALTER TABLE api_keys ADD COLUMN client TEXT DEFAULT \'generic\''); } catch {}
  try { db.exec('ALTER TABLE api_keys ADD COLUMN description TEXT DEFAULT \'\''); } catch {}
  try { db.exec('ALTER TABLE api_keys ADD COLUMN key_suffix TEXT DEFAULT \'\''); } catch {}

  // 1c. 通道密钥池表（同通道多账号 key：明文直输或环境变量引用；key 级冷却持久化，重启不丢）
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_keys (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'plaintext',
      label TEXT DEFAULT '',
      key_value TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      cooldown_until INTEGER DEFAULT 0,
      cooldown_note TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER DEFAULT 0,
      revoked INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channel_keys_target ON channel_keys(target);
  `);

  // 2. Token 用量日志明细表
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      date_day TEXT NOT NULL,
      hour_slot TEXT NOT NULL,
      model TEXT NOT NULL,
      target TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      is_error INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_token_logs_day ON token_logs(date_day);
    CREATE INDEX IF NOT EXISTS idx_token_logs_model ON token_logs(model);
    CREATE INDEX IF NOT EXISTS idx_token_logs_timestamp ON token_logs(timestamp);
  `);

  // 3. 模型分组表
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_groups (
      group_name TEXT PRIMARY KEY,
      display_title TEXT,
      sort_order INTEGER DEFAULT 0,
      description TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  // 插入默认分组
  const insertGroupStmt = db.prepare(`
    INSERT OR IGNORE INTO model_groups (group_name, display_title, sort_order, description, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  insertGroupStmt.run('默认分组', '默认分组 (Default)', 1, '官方与其他通用模型', now);
  insertGroupStmt.run('DeepSeek 直连', 'DeepSeek 直连 (深度思考/代码)', 2, '国内高速直连 DeepSeek 系列模型', now);
  insertGroupStmt.run('阿里云百炼 / Qwen', '阿里云百炼 (Qwen 通义千问)', 3, '百炼平台与视觉中继大模型', now);
  insertGroupStmt.run('OpenCode 免费', 'OpenCode (全系免费模型网关)', 4, 'OpenCode Zen 免费模型池', now);
  insertGroupStmt.run('SiliconFlow', 'SiliconFlow (硅基流动)', 5, '硅基流动开源模型 API', now);

  dbInstance = db;
  return dbInstance;
}

export function getDatabase() {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

// ---------- 安全预编译数据库操作 (严格参数绑定，零 SQL 拼接) ----------

export function dbSaveAccount(account) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO accounts (id, provider, email, alias, proxy_enabled, proxy_url, status, quota_used, quota_limit, resets_at, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider,
      email = excluded.email,
      alias = excluded.alias,
      proxy_enabled = excluded.proxy_enabled,
      proxy_url = excluded.proxy_url,
      status = excluded.status,
      quota_used = excluded.quota_used,
      quota_limit = excluded.quota_limit,
      resets_at = excluded.resets_at,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `);
  const now = Date.now();
  stmt.run(
    String(account.id),
    String(account.provider || 'claude'),
    account.email ? String(account.email) : null,
    String(account.alias || account.id),
    account.proxy_enabled ? 1 : 0,
    account.proxy_url ? String(account.proxy_url) : 'http://127.0.0.1:10808',
    String(account.status || 'active'),
    Number(account.quota_used || 0),
    Number(account.quota_limit || 100),
    Number(account.resets_at || 0),
    account.metadata ? JSON.stringify(account.metadata) : null,
    account.created_at ? Number(account.created_at) : now,
    now,
  );
}

export function dbListAccounts(provider = null) {
  const db = getDatabase();
  if (provider) {
    const stmt = db.prepare(`SELECT * FROM accounts WHERE provider = ? ORDER BY created_at DESC`);
    return stmt.all(String(provider)).map(sanitizeAccountRow);
  }
  const stmt = db.prepare(`SELECT * FROM accounts ORDER BY created_at DESC`);
  return stmt.all().map(sanitizeAccountRow);
}

export function dbDeleteAccount(id) {
  const db = getDatabase();
  const stmt = db.prepare(`DELETE FROM accounts WHERE id = ?`);
  stmt.run(String(id));
}

// ---------- 通道密钥池数据操作（全部参数绑定，零 SQL 拼接） ----------

export function dbCreateChannelKey(entry) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO channel_keys (
      id, target, kind, label, key_value, priority,
      cooldown_until, cooldown_note, created_at, last_used_at, revoked
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  stmt.run(
    String(entry.id),
    String(entry.target),
    entry.kind === 'env_ref' ? 'env_ref' : 'plaintext',
    entry.label ? String(entry.label) : '',
    String(entry.key_value),
    Number.isInteger(Number(entry.priority)) ? Math.max(0, Number(entry.priority)) : 0,
    Number(entry.cooldown_until) > 0 ? Number(entry.cooldown_until) : 0,
    entry.cooldown_note ? String(entry.cooldown_note) : '',
    Number(entry.created_at) > 0 ? Number(entry.created_at) : now,
    Number(entry.last_used_at) > 0 ? Number(entry.last_used_at) : 0,
    entry.revoked ? 1 : 0,
  );
}

export function dbListChannelKeys(target = null) {
  const db = getDatabase();
  if (target) {
    const stmt = db.prepare(
      'SELECT * FROM channel_keys WHERE target = ? AND revoked = 0 ORDER BY priority ASC, created_at ASC',
    );
    return stmt.all(String(target));
  }
  const stmt = db.prepare(
    'SELECT * FROM channel_keys WHERE revoked = 0 ORDER BY target ASC, priority ASC, created_at ASC',
  );
  return stmt.all();
}

export function dbGetChannelKey(id) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM channel_keys WHERE id = ?');
  return stmt.get(String(id)) || null;
}

// 白名单字段动态更新：只拼已校验的列名，值全部参数绑定。
const CHANNEL_KEY_PATCH_COLUMNS = new Map([
  ['label', 'label'],
  ['kind', 'kind'],
  ['key_value', 'key_value'],
  ['priority', 'priority'],
]);

export function dbUpdateChannelKey(id, patch = {}) {
  const db = getDatabase();
  const sets = [];
  const values = [];
  for (const [field, column] of CHANNEL_KEY_PATCH_COLUMNS) {
    if (patch[field] === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(field === 'priority' ? Math.max(0, Math.floor(Number(patch[field]) || 0)) : String(patch[field]));
  }
  if (sets.length === 0) return false;
  values.push(String(id));
  db.prepare(`UPDATE channel_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return true;
}

export function dbRevokeChannelKey(id) {
  const db = getDatabase();
  db.prepare('UPDATE channel_keys SET revoked = 1 WHERE id = ?').run(String(id));
}

export function dbMarkChannelKeyCooldown(id, cooldownUntil, cooldownNote = '') {
  const db = getDatabase();
  db.prepare(
    'UPDATE channel_keys SET cooldown_until = ?, cooldown_note = ? WHERE id = ?',
  ).run(Number(cooldownUntil) || 0, cooldownNote ? String(cooldownNote) : '', String(id));
}

export function dbClearChannelKeyCooldown(id) {
  const db = getDatabase();
  db.prepare(
    'UPDATE channel_keys SET cooldown_until = 0, cooldown_note = \'\' WHERE id = ?',
  ).run(String(id));
}

export function dbTouchChannelKey(id, lastUsedAt = Date.now()) {
  const db = getDatabase();
  db.prepare('UPDATE channel_keys SET last_used_at = ? WHERE id = ?').run(Number(lastUsedAt), String(id));
}

export function dbRecordTokenLog(log) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO token_logs (
      timestamp, date_day, hour_slot, model, target,
      input_tokens, output_tokens, reasoning_tokens, cached_tokens, total_tokens,
      duration_ms, is_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Number(log.timestamp) || Date.now();
  const dateDay = new Date(now).toISOString().slice(0, 10);
  const hourSlot = new Date(now).toISOString().slice(0, 13) + ':00';
  const inputTokens = Number(log.inputTokens || 0);
  const outputTokens = Number(log.outputTokens || 0);
  const reasoningTokens = Number(log.reasoningTokens || 0);
  const cachedTokens = Number(log.cachedTokens || 0);
  const totalTokens = Number(log.totalTokens || (inputTokens + outputTokens));

  stmt.run(
    now,
    dateDay,
    hourSlot,
    String(log.model || 'unknown'),
    log.target ? String(log.target) : null,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cachedTokens,
    totalTokens,
    Number(log.durationMs || 0),
    log.isError ? 1 : 0,
  );
}

// ---------- 截图同款 Dashboard 统计数据生成算法 ----------

export function dbGetDashboardStats(days = 30) {
  const db = getDatabase();
  const now = Date.now();
  const sinceTimestamp = now - Number(days) * 86400 * 1000;
  const sinceDay = new Date(sinceTimestamp).toISOString().slice(0, 10);

  // 1. 汇总指标卡片
  const summaryStmt = db.prepare(`
    SELECT
      COUNT(id) AS total_rounds,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COUNT(DISTINCT date_day) AS active_days
    FROM token_logs
    WHERE timestamp >= ?
  `);
  const summary = summaryStmt.get(sinceTimestamp) || {
    total_rounds: 0,
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    active_days: 0,
  };

  // 2. 最常用模型统计
  const topModelStmt = db.prepare(`
    SELECT model, SUM(total_tokens) AS model_tokens, COUNT(id) AS model_rounds
    FROM token_logs
    WHERE timestamp >= ?
    GROUP BY model
    ORDER BY model_tokens DESC
    LIMIT 1
  `);
  const topModelRow = topModelStmt.get(sinceTimestamp);
  const topModel = topModelRow ? {
    model: topModelRow.model,
    tokens: Number(topModelRow.model_tokens),
    rounds: Number(topModelRow.model_rounds),
    percent: summary.total_tokens > 0 ? Math.round((Number(topModelRow.model_tokens) / Number(summary.total_tokens)) * 100) : 0,
  } : { model: '无调用数据', tokens: 0, rounds: 0, percent: 0 };

  // 3. 计算连续活跃天数 (Consecutive Days)
  const activeDaysStmt = db.prepare(`
    SELECT DISTINCT date_day
    FROM token_logs
    WHERE timestamp >= ?
    ORDER BY date_day DESC
  `);
  const activeDayRows = activeDaysStmt.all(sinceTimestamp);
  let consecutiveDays = 0;
  if (activeDayRows.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (activeDayRows[0].date_day === today || activeDayRows[0].date_day === yesterday) {
      consecutiveDays = 1;
      // 纯 UTC 日期减法：date_day 是 UTC 字符串，不能用本地时区 setDate/getDate
      // （负时区下本地与 UTC 差一天，连续天数会算错）。
      let cursor = Date.parse(`${activeDayRows[0].date_day}T00:00:00Z`);
      for (let i = 1; i < activeDayRows.length; i++) {
        cursor -= 86400000;
        const expected = new Date(cursor).toISOString().slice(0, 10);
        if (activeDayRows[i].date_day === expected) {
          consecutiveDays++;
        } else {
          break;
        }
      }
    }
  }

  // 4. 活跃热力图数据 (近 12 周 / 84 天)
  const heatmapDays = 84;
  const heatmapSince = now - heatmapDays * 86400 * 1000;
  const heatmapStmt = db.prepare(`
    SELECT date_day, COUNT(id) AS rounds, SUM(total_tokens) AS tokens
    FROM token_logs
    WHERE timestamp >= ?
    GROUP BY date_day
  `);
  const heatmapDataMap = new Map();
  for (const row of heatmapStmt.all(heatmapSince)) {
    heatmapDataMap.set(row.date_day, {
      rounds: Number(row.rounds),
      tokens: Number(row.tokens),
    });
  }

  const heatmapGrid = [];
  for (let d = heatmapDays - 1; d >= 0; d--) {
    const dayObj = new Date(now - d * 86400 * 1000);
    const dayStr = dayObj.toISOString().slice(0, 10);
    const found = heatmapDataMap.get(dayStr) || { rounds: 0, tokens: 0 };
    let level = 0;
    if (found.rounds > 0) {
      if (found.tokens > 5_000_000) level = 4;
      else if (found.tokens > 1_000_000) level = 3;
      else if (found.tokens > 200_000) level = 2;
      else level = 1;
    }
    heatmapGrid.push({
      date: dayStr,
      displayDate: `${dayObj.getMonth() + 1}月${dayObj.getDate()}日`,
      tokens: found.tokens,
      rounds: found.rounds,
      level,
    });
  }

  // 5. 按天 Token 趋势堆叠柱状图数据 (最近 30 天)
  const stackedStmt = db.prepare(`
    SELECT date_day, model, SUM(total_tokens) as tokens
    FROM token_logs
    WHERE timestamp >= ?
    GROUP BY date_day, model
    ORDER BY date_day ASC
  `);
  const stackedRows = stackedStmt.all(sinceTimestamp);
  const dailyStackedMap = new Map();
  const allModelsSet = new Set();

  for (const row of stackedRows) {
    allModelsSet.add(row.model);
    if (!dailyStackedMap.has(row.date_day)) {
      dailyStackedMap.set(row.date_day, {});
    }
    dailyStackedMap.get(row.date_day)[row.model] = Number(row.tokens);
  }

  const stackedDays = [];
  const modelPalette = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#ec4899', '#14b8a6', '#f97316', '#6366f1'
  ];
  const modelColors = {};
  let colorIdx = 0;
  for (const m of allModelsSet) {
    modelColors[m] = modelPalette[colorIdx % modelPalette.length];
    colorIdx++;
  }

  for (let d = days - 1; d >= 0; d--) {
    const dayObj = new Date(now - d * 86400 * 1000);
    const dayStr = dayObj.toISOString().slice(0, 10);
    const displayLabel = `${dayObj.getMonth() + 1}月${dayObj.getDate()}日`;
    const modelUsage = dailyStackedMap.get(dayStr) || {};
    let dayTotal = 0;
    for (const m of Object.keys(modelUsage)) {
      dayTotal += modelUsage[m];
    }
    stackedDays.push({
      date: dayStr,
      label: displayLabel,
      total: dayTotal,
      models: modelUsage,
    });
  }

  // 6. 各模型 Breakdown 表格数据
  const breakdownStmt = db.prepare(`
    SELECT
      model,
      target,
      COUNT(id) AS rounds,
      SUM(total_tokens) AS total_tokens,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(reasoning_tokens) AS reasoning_tokens,
      SUM(cached_tokens) AS cached_tokens,
      ROUND(AVG(duration_ms)) AS avg_latency_ms
    FROM token_logs
    WHERE timestamp >= ?
    GROUP BY model
    ORDER BY total_tokens DESC
  `);
  const breakdownRows = breakdownStmt.all(sinceTimestamp).map(r => ({
    model: r.model,
    target: r.target || '默认',
    rounds: Number(r.rounds),
    totalTokens: Number(r.total_tokens),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    reasoningTokens: Number(r.reasoning_tokens),
    cachedTokens: Number(r.cached_tokens),
    avgLatencyMs: Number(r.avg_latency_ms || 0),
  }));

  return {
    metrics: {
      totalTokens: Number(summary.total_tokens),
      totalTokensFormatted: formatTokenAmount(Number(summary.total_tokens)),
      totalSessions: Math.ceil(Number(summary.total_rounds) / 3.2), // 估算独立会话数
      totalRounds: Number(summary.total_rounds),
      activeDays: Number(summary.active_days),
      consecutiveDays,
      topModel,
    },
    heatmap: heatmapGrid,
    stackedChart: {
      days: stackedDays,
      models: Array.from(allModelsSet),
      colors: modelColors,
    },
    breakdown: breakdownRows,
  };
}

function sanitizeAccountRow(row) {
  let metadata = {};
  try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* 容错 */ }
  return {
    id: row.id,
    provider: row.provider,
    email: row.email,
    alias: row.alias,
    proxyEnabled: Boolean(row.proxy_enabled),
    proxyUrl: row.proxy_url,
    status: row.status,
    quotaUsed: Number(row.quota_used || 0),
    quotaLimit: Number(row.quota_limit || 100),
    resetsAt: Number(row.resets_at || 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at || row.created_at),
    metadata,
  };
}

function formatTokenAmount(tokens) {
  if (tokens >= 100_000_000) return (tokens / 100_000_000).toFixed(1) + '亿';
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M';
  if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + 'k';
  return String(tokens);
}
