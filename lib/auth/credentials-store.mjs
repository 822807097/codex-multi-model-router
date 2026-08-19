import fs from 'node:fs';
import path from 'node:path';

/**
 * 零凭据泄露安全存储驱动
 * - 凭据优先从环境变量或系统安全存储读取
 * - 磁盘状态文件仅保留脱敏元数据，防止凭据落盘泄露
 */
export function createCredentialsStore(options = {}) {
  const persistPath = options.persistPath || null;

  function loadAccounts() {
    if (!persistPath || !fs.existsSync(persistPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
      return Array.isArray(data.accounts) ? data.accounts : [];
    } catch {
      return [];
    }
  }

  function saveAccounts(accounts) {
    if (!persistPath) return;
    try {
      const dir = path.dirname(persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // 仅存储脱敏数据和非密钥配置
      const sanitizedAccounts = accounts.map((acc) => ({
        id: acc.id,
        provider: acc.provider,
        alias: acc.alias,
        status: acc.status,
        metadata: acc.metadata,
        createdAt: acc.createdAt,
        updatedAt: acc.updatedAt,
      }));

      fs.writeFileSync(
        persistPath,
        JSON.stringify({ accounts: sanitizedAccounts, updatedAt: Date.now() }, null, 2),
        'utf8',
      );
    } catch {
      // 存储旁路不阻塞运行时
    }
  }

  return {
    loadAccounts,
    saveAccounts,
  };
}

/**
 * 订阅账号凭据保险库：授权得到的 OAuth refresh/access token 的唯一持久化位置。
 * - 元数据继续留在 SQLite accounts 表；本文件只存凭据本体
 * - 原子写（tmp + rename），避免进程崩溃写坏文件
 * - 与 config.json / router.db 同目录同级保护，不进版本库
 */
export function createCredentialsVault(options = {}) {
  const vaultPath = options.vaultPath;

  // 内存缓存：磁盘是持久化层，进程内以缓存为权威，避免每次 set 全量读盘。
  // 全部操作同步（fs 同步调用），JS 单线程天然串行，无并发覆盖风险。
  let cached = null;

  function loadAll() {
    if (cached !== null) return cached;
    if (!vaultPath || !fs.existsSync(vaultPath)) {
      cached = {};
      return cached;
    }
    try {
      const data = JSON.parse(fs.readFileSync(vaultPath, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        cached = {};
        return cached;
      }
      // loadAll 必须返回「accountId -> 凭据」纯 map；磁盘格式为 { updatedAt, accounts }。
      // 兼容历史双重包装损坏：accounts 里再嵌一层 { updatedAt, accounts } 时递归解开，
      // 并把误挂在外层的凭据条目（值含 accessToken/refreshToken 的对象）合并回来。
      const looksLikeCredential = (value) => value && typeof value === 'object'
        && !Array.isArray(value)
        && ('accessToken' in value || 'refreshToken' in value);
      // 历史缺陷曾把 loadAll 的外层包装整个写回，每写一次多嵌套一层
      // { updatedAt, accounts }；循环剥壳直到没有 accounts 包装，逐层收齐
      // 误挂的凭据条目（深层较新，覆盖浅层同 id 旧值）。
      const merged = {};
      let layer = data;
      for (let depth = 0; depth < 16 && layer && typeof layer === 'object' && !Array.isArray(layer); depth += 1) {
        for (const [id, value] of Object.entries(layer)) {
          if (id !== 'updatedAt' && id !== 'accounts' && looksLikeCredential(value)) {
            merged[id] = value;
          }
        }
        layer = layer.accounts && typeof layer.accounts === 'object' && !Array.isArray(layer.accounts)
          ? layer.accounts
          : null;
      }
      cached = merged;
      return cached;
    } catch {
      cached = {};
      return cached;
    }
  }

  function persistAll(map) {
    if (!vaultPath) return;
    try {
      const dir = path.dirname(vaultPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${vaultPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ updatedAt: Date.now(), accounts: map }, null, 2), 'utf8');
      fs.renameSync(tmpPath, vaultPath);
    } catch {
      // 存储旁路不阻塞运行时
    }
  }

  // 变更操作保持同步契约（调用方不 await）；缓存 map 就地修改后写盘。
  return {
    get(accountId) {
      return loadAll()[accountId] || null;
    },
    set(accountId, credentials) {
      const map = loadAll();
      map[accountId] = credentials || {};
      persistAll(map);
    },
    delete(accountId) {
      const map = loadAll();
      if (!(accountId in map)) return;
      delete map[accountId];
      persistAll(map);
    },
    loadAll,
  };
}
