import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SNAPSHOT_VERSION = 1;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function stableHeaders(headers) {
  return Object.entries(headers || {})
    .map(([name, value]) => [name.toLowerCase(), sha256(JSON.stringify(value))])
    .sort(([left], [right]) => left.localeCompare(right));
}

export function computeCheckpointNamespace(options = {}) {
  const targets = (options.targets || []).map((target) => ({
    name: target.name || '',
    wireApi: target.wireApi || target.apiFormat || '',
    protocol: target.protocol || 'https',
    host: target.host || '',
    port: target.port || null,
    prefix: target.prefix || '',
    stateDomain: target.stateDomain || '',
    envKey: target.envKey || '',
    credential: target.useOpenAiAuth === true
      ? sha256(`official\0${options.accountId || ''}`)
      : sha256(`api\0${target.envKey || ''}\0${options.getKey?.(target.envKey) || ''}`),
    headers: stableHeaders(target.headers),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return sha256(JSON.stringify({
    version: 1,
    stateGeneration: options.stateGeneration || '',
    targets,
  }));
}

function snapshotBody(namespace, revision, store, savedAt) {
  return {
    version: SNAPSHOT_VERSION,
    namespace,
    revision,
    savedAt,
    store,
  };
}

function encodeSnapshot(namespace, revision, store, savedAt) {
  const body = snapshotBody(namespace, revision, store, savedAt);
  return JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) }, null, 2);
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) throw new Error('检查点快照版本不受支持');
  if (typeof snapshot.namespace !== 'string' || !snapshot.namespace) throw new Error('检查点快照 namespace 无效');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error('检查点快照 revision 无效');
  if (!Number.isFinite(snapshot.savedAt)) throw new Error('检查点快照时间无效');
  if (!snapshot.store || typeof snapshot.store !== 'object') throw new Error('检查点快照内容无效');
  const body = snapshotBody(
    snapshot.namespace,
    snapshot.revision,
    snapshot.store,
    snapshot.savedAt,
  );
  if (snapshot.checksum !== sha256(JSON.stringify(body))) throw new Error('检查点快照校验失败');
  return snapshot;
}

export function createCheckpointPersistence(options) {
  const config = options.config || {};
  const originalStore = options.store;
  const log = options.log || (() => {});
  if (config.enabled !== true) {
    return {
      store: originalStore,
      flush: async () => false,
      clearRecoverably: async () => ({
        removed: originalStore.clear(),
        backupPath: null,
        recoveryHint: '持久化已关闭，仅清空当前内存检查点',
      }),
      close: async () => {},
      status: () => ({ mode: 'disabled', loadedEntries: 0 }),
    };
  }

  const snapshotPath = path.resolve(config.path);
  const backupPath = `${snapshotPath}.bak`;
  const lockPath = `${snapshotPath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const maxBytes = Math.max(1, Number(config.maxBytes) || DEFAULT_MAX_BYTES);
  const debounceMs = Math.max(10, Number(config.debounceMs) || 1_000);
  const lockHeartbeatMs = Math.max(100, Number(config.lockHeartbeatMs) || 5_000);
  const lockStaleMs = Math.max(
    lockHeartbeatMs * 3,
    Number(config.lockStaleMs) || 30_000,
  );
  const ownerId = crypto.randomUUID();
  let mode = 'writable';
  let namespaceMismatch = false;
  let loadedEntries = 0;
  let revision = 0;
  let dirty = false;
  let closed = false;
  let debounceTimer = null;
  let heartbeatTimer = null;
  let writeChain = Promise.resolve(false);
  let lastError = null;

  function report(error) {
    lastError = error?.message || String(error);
    log('checkpoint persistence:', lastError);
  }

  function readFile(filePath) {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) throw new Error('检查点快照超过大小上限');
    const bytes = fs.readFileSync(filePath);
    if (bytes.length > maxBytes) throw new Error('检查点快照超过大小上限');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return validateSnapshot(JSON.parse(text));
  }

  function loadExisting() {
    let snapshot = null;
    if (fs.existsSync(snapshotPath)) {
      try { snapshot = readFile(snapshotPath); } catch (error) {
        report(error);
        if (fs.existsSync(backupPath)) {
          try { snapshot = readFile(backupPath); } catch (backupError) { report(backupError); }
        }
      }
    }
    if (!snapshot) return;
    revision = snapshot.revision;
    if (snapshot.namespace !== options.namespace) {
      namespaceMismatch = true;
      mode = 'readonly';
      return;
    }
    loadedEntries = originalStore.importSnapshot(snapshot.store);
  }

  function currentDiskRevision() {
    if (!fs.existsSync(snapshotPath)) return 0;
    return readFile(snapshotPath).revision;
  }

  function ownsLock() {
    if (mode !== 'writable') return false;
    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      return owner.ownerId === ownerId;
    } catch {
      return false;
    }
  }

  function writeOwner() {
    fs.writeFileSync(ownerPath, JSON.stringify({
      ownerId,
      pid: process.pid,
      heartbeatAt: Date.now(),
    }), { mode: 0o600 });
  }

  function acquireLock() {
    if (mode === 'readonly') return false;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      writeOwner();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try {
      const stat = fs.statSync(ownerPath);
      if (Date.now() - stat.mtimeMs > lockStaleMs) {
        const stalePath = `${lockPath}.stale-${Date.now()}-${crypto.randomUUID()}`;
        fs.renameSync(lockPath, stalePath);
        fs.mkdirSync(lockPath, { mode: 0o700 });
        writeOwner();
        return true;
      }
    } catch { /* 无法可靠证明陈旧时保持只读 */ }
    mode = 'readonly';
    return false;
  }

  function startHeartbeat() {
    if (!ownsLock()) return;
    heartbeatTimer = setInterval(() => {
      if (!ownsLock()) {
        mode = 'readonly';
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        return;
      }
      try { writeOwner(); } catch (error) {
        report(error);
        mode = 'readonly';
      }
    }, lockHeartbeatMs);
    heartbeatTimer.unref?.();
  }

  function schedule() {
    if (closed || mode !== 'writable') return;
    dirty = true;
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush();
    }, debounceMs);
    debounceTimer.unref?.();
  }

  const store = new Proxy(originalStore, {
    get(target, property, receiver) {
      if (property === 'remember' || property === 'bindResponse' || property === 'clear') {
        return (...args) => {
          const responseCount = property === 'clear'
            ? target.exportSnapshot().responses.length
            : 0;
          const changed = target[property](...args);
          // 歧义 response 哨兵可能在没有检查点条目时独立存在，清空它也必须落盘。
          if (changed || responseCount > 0) schedule();
          return changed;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  async function writeSnapshot() {
    if (!dirty || closed || mode !== 'writable') return false;
    if (!ownsLock()) {
      mode = 'readonly';
      return false;
    }
    let diskRevision;
    try { diskRevision = currentDiskRevision(); } catch (error) {
      report(error);
      mode = 'readonly';
      return false;
    }
    if (diskRevision !== revision) {
      mode = 'readonly';
      report(new Error('检查点快照 revision 已变化，当前实例降级为只读'));
      return false;
    }

    const nextRevision = revision + 1;
    const text = encodeSnapshot(
      options.namespace,
      nextRevision,
      originalStore.exportSnapshot(),
      Date.now(),
    );
    if (Buffer.byteLength(text) > maxBytes) {
      report(new Error('检查点快照超过大小上限'));
      return false;
    }
    const tempPath = `${snapshotPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tempPath, text, { mode: 0o600 });
      // Windows 对只读句柄执行 fsync 会返回 EPERM，使用可写句柄保持跨平台一致。
      const descriptor = fs.openSync(tempPath, 'r+');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      if (fs.existsSync(snapshotPath)) fs.copyFileSync(snapshotPath, backupPath);
      if (!ownsLock()) {
        mode = 'readonly';
        throw new Error('检查点写入前已失去锁所有权');
      }
      fs.renameSync(tempPath, snapshotPath);
      revision = nextRevision;
      dirty = false;
      return true;
    } catch (error) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* 忽略临时文件清理失败 */ }
      report(error);
      return false;
    }
  }

  function flush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    writeChain = writeChain.then(writeSnapshot, writeSnapshot);
    return writeChain;
  }

  function clearError(message, backupFilePath = null) {
    const error = new Error(message);
    error.code = 'checkpoint_clear_failed';
    if (backupFilePath) error.backupPath = backupFilePath;
    return error;
  }

  function writeRecoveryBackup(snapshot) {
    const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
    const recoveryPath = `${snapshotPath}.clear-${timestamp}-${crypto.randomUUID()}.bak`;
    const text = encodeSnapshot(
      options.namespace,
      revision,
      snapshot,
      Date.now(),
    );
    if (Buffer.byteLength(text) > maxBytes) throw new Error('检查点恢复备份超过大小上限');
    const tempPath = `${recoveryPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(tempPath, text, { mode: 0o600 });
      const descriptor = fs.openSync(tempPath, 'r+');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(tempPath, recoveryPath);
      return recoveryPath;
    } catch (error) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* 忽略精确临时文件清理失败 */ }
      throw error;
    }
  }

  async function clearSnapshotRecoverably() {
    if (closed) throw clearError('检查点持久化已关闭');
    if (mode !== 'writable' || !ownsLock()) {
      mode = 'readonly';
      const error = new Error('当前实例未持有持久化写锁');
      error.code = 'persistence_readonly';
      throw error;
    }
    if (dirty) {
      await writeSnapshot();
      if (dirty) throw clearError(`清空前检查点写入失败：${lastError || '未知错误'}`);
    }

    const previousSnapshot = originalStore.exportSnapshot();
    let recoveryPath = null;
    try {
      // 恢复备份直接取当前内存快照，保证包含刚写入但尚未冷重启的数据。
      recoveryPath = writeRecoveryBackup(previousSnapshot);
      const removed = originalStore.clear();
      dirty = true;
      const flushed = await writeSnapshot();
      if (!flushed || dirty) {
        originalStore.importSnapshot(previousSnapshot);
        dirty = false;
        throw clearError(`检查点空快照写入失败：${lastError || '未知错误'}`, recoveryPath);
      }
      return {
        removed,
        backupPath: recoveryPath,
        recoveryHint: `如需恢复，请在路由停止后用备份文件替换检查点快照：${recoveryPath}`,
      };
    } catch (error) {
      if (error.code === 'checkpoint_clear_failed') throw error;
      throw clearError(`检查点清空失败：${error.message}`, recoveryPath);
    }
  }

  function clearRecoverably() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    writeChain = writeChain.then(clearSnapshotRecoverably, clearSnapshotRecoverably);
    return writeChain;
  }

  async function close() {
    if (closed) return;
    await flush();
    closed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (!ownsLock()) return;
    try { fs.unlinkSync(ownerPath); } catch { /* 锁目录可能已被接管 */ }
    try { fs.rmdirSync(lockPath); } catch { /* 非空或已接管时不得强删 */ }
  }

  try {
    loadExisting();
    if (acquireLock()) startHeartbeat();
  } catch (error) {
    report(error);
    mode = 'readonly';
  }

  return {
    store,
    flush,
    clearRecoverably,
    close,
    status: () => ({
      mode,
      path: snapshotPath,
      loadedEntries,
      revision,
      namespaceMismatch,
      lastError,
    }),
  };
}
