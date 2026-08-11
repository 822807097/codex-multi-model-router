import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  copyAndVerify,
  prepareJsonWrite,
  readRevisionedJson,
} from './json-file-store.mjs';

const JOURNAL_VERSION = 1;
const RETENTION_VERSION = 1;
const journalMutexes = new Map();

async function withJournalMutex(journalPath, operation) {
  const previous = journalMutexes.get(journalPath) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  journalMutexes.set(journalPath, tail);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (journalMutexes.get(journalPath) === tail) journalMutexes.delete(journalPath);
  }
}

function transactionError(code, txid) {
  const messages = {
    invalid_transaction_paths: '模型路由事务的两个目标必须是不同文件',
    revision_conflict: '模型路由配置已被外部修改',
    transaction_failed: '模型路由事务未提交',
    transaction_rolled_back: '模型路由事务失败并已安全回滚',
    transaction_in_doubt: '模型路由事务状态待恢复',
  };
  const error = new Error(messages[code] || '模型路由事务失败');
  error.code = code;
  if (txid !== undefined) error.txid = txid;
  return error;
}

function preserveEvidenceError(message) {
  const error = new Error(message);
  error.preserveEvidence = true;
  return error;
}

function sameActualFile(fileSystem, leftPath, rightPath) {
  if (leftPath === rightPath) return true;
  const identity = (filePath) => {
    const pathStat = fileSystem.lstatSync(filePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return null;
    const descriptor = fileSystem.openSync(filePath, (fileSystem.constants || fs.constants).O_RDONLY);
    try {
      const opened = fileSystem.fstatSync(descriptor, { bigint: true });
      if (opened.dev === undefined || opened.ino === undefined || opened.ino === 0 || opened.ino === 0n) {
        return null;
      }
      return { dev: String(opened.dev), ino: String(opened.ino) };
    } finally {
      fileSystem.closeSync(descriptor);
    }
  };
  const left = identity(leftPath);
  const right = identity(rightPath);
  // 无可靠文件标识时 fail-closed，避免 inode=0 的硬链接绕过双目标隔离。
  if (left === null || right === null) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function readForCommit(filePath, options) {
  try {
    return readStableSnapshot(filePath, options);
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('transaction_')) throw error;
    throw transactionError('transaction_failed');
  }
}

/** 返回与 config 同目录的固定事务日志路径。 */
export function transactionJournalPath(configPath) {
  return `${path.resolve(configPath)}.model-routing-transaction.json`;
}

function writeJournal(journalPath, journal, options) {
  const prepared = prepareJsonWrite(journalPath, journal, options);
  prepared.sync();
  prepared.replace();
}

function removeIfExists(fileSystem, filePath) {
  try {
    fileSystem.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function cleanupJournalArtifacts(fileSystem, journalPath, journal, includeBackups) {
  const paths = [journalPath];
  if (journal) {
    paths.push(journal.config.tempPath, journal.catalog.tempPath);
    if (includeBackups) paths.push(journal.config.backupPath, journal.catalog.backupPath);
  }
  for (const filePath of paths) {
    try { removeIfExists(fileSystem, filePath); } catch { /* 清理失败不掩盖事务结果 */ }
  }
}

function verifyCurrentIsolationEvidence(journal, options) {
  for (const entry of [journal.config, journal.catalog]) {
    for (const [evidencePath, expectedHash] of [
      [entry.quarantinePath, entry.oldHash],
      [entry.displacedPath, entry.newHash],
    ]) {
      if (!pathExists(options.fileSystem, evidencePath)) continue;
      const evidence = readStableSnapshot(evidencePath, options);
      if (evidence.revision !== expectedHash) {
        throw new Error('隔离证据在最终清理前发生变化');
      }
    }
  }
}

function backupPathFor(targetPath, txid, oldHash) {
  return `${targetPath}.model-routing.bak-${txid}-${oldHash}`;
}

function isolationPathFor(targetPath, kind, txid, expectedHash, token) {
  return `${targetPath}.model-routing.${kind}-${txid}-${expectedHash}-${token}`;
}

function stableFileIdentity(stat) {
  if (stat?.dev === undefined || stat?.ino === undefined || stat.ino === 0 || stat.ino === 0n) return null;
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameStableIdentity(left, right) {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function readStableSnapshot(filePath, options) {
  const before = stableFileIdentity(options.fileSystem.lstatSync(filePath, { bigint: true }));
  const current = readRevisionedJson(filePath, options);
  const after = stableFileIdentity(options.fileSystem.lstatSync(filePath, { bigint: true }));
  if (!sameStableIdentity(before, after)) throw new Error('事务文件身份不稳定');
  return { revision: current.revision, identity: after };
}

function pathExists(fileSystem, filePath) {
  try {
    fileSystem.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function syncPublishedPath(filePath, options) {
  const descriptor = options.fileSystem.openSync(filePath, 'r+');
  try {
    options.fileSystem.fsyncSync(descriptor);
  } finally {
    options.fileSystem.closeSync(descriptor);
  }
  // Windows 无法可靠打开目录句柄；文件 FlushFileBuffers 已完成。
  if (process.platform === 'win32') return;
  const directoryDescriptor = options.fileSystem.openSync(
    path.dirname(filePath),
    (options.fileSystem.constants || fs.constants).O_RDONLY,
  );
  try {
    options.fileSystem.fsyncSync(directoryDescriptor);
  } finally {
    options.fileSystem.closeSync(directoryDescriptor);
  }
}

function restoreCapturedTarget(capturePath, targetPath, captured, options) {
  options.fileSystem.linkSync(capturePath, targetPath);
  syncPublishedPath(targetPath, options);
  const target = readStableSnapshot(targetPath, options);
  const capture = readStableSnapshot(capturePath, options);
  if (
    target.revision !== captured.revision
    || capture.revision !== captured.revision
    || !sameStableIdentity(target.identity, capture.identity)
    || !sameStableIdentity(captured.identity, capture.identity)
  ) {
    throw new Error('隔离内容在恢复期间发生变化');
  }
  options.fileSystem.unlinkSync(capturePath);
}

function publishWithoutOverwrite({
  entry,
  sourcePath,
  expectedHash,
  expectedIdentity,
  desiredHash,
  capturePath,
  options,
}) {
  let targetBeforeCapture;
  if (!pathExists(options.fileSystem, capturePath)) {
    // rename 原子捕获调用时刻的目录项；高熵隔离名碰撞时绝不继续。
    targetBeforeCapture = readStableSnapshot(entry.path, options);
    if (
      expectedIdentity
      && !sameStableIdentity(expectedIdentity, targetBeforeCapture.identity)
    ) {
      throw preserveEvidenceError('发布前目标身份已变化');
    }
    options.fileSystem.renameSync(entry.path, capturePath);
  } else if (pathExists(options.fileSystem, entry.path)) {
    throw preserveEvidenceError('事务隔离路径冲突');
  }

  const captured = readStableSnapshot(capturePath, options);
  if (
    targetBeforeCapture
    && (
      !sameStableIdentity(targetBeforeCapture.identity, captured.identity)
      || (
        expectedIdentity
        && !sameStableIdentity(expectedIdentity, captured.identity)
      )
    )
  ) {
    restoreCapturedTarget(capturePath, entry.path, captured, options);
    throw preserveEvidenceError('原子捕获时目标身份已变化');
  }
  if (
    expectedIdentity
    && !sameStableIdentity(expectedIdentity, captured.identity)
  ) {
    if (targetBeforeCapture) {
      restoreCapturedTarget(capturePath, entry.path, captured, options);
    }
    throw preserveEvidenceError('隔离目标身份与预期不一致');
  }
  if (captured.revision !== expectedHash) {
    restoreCapturedTarget(capturePath, entry.path, captured, options);
    throw new Error('发布时目标已被外部修改');
  }
  const source = readStableSnapshot(sourcePath, options);
  if (source.revision !== desiredHash) throw new Error('发布源校验失败');

  // linkSync 只在 target 不存在时成功；EEXIST 时绝不覆盖外部重建的目录项。
  options.fileSystem.linkSync(sourcePath, entry.path);
  syncPublishedPath(entry.path, options);
  const published = readStableSnapshot(entry.path, options);
  const sourceAfter = readStableSnapshot(sourcePath, options);
  const capturedAfter = readStableSnapshot(capturePath, options);
  if (
    published.revision !== desiredHash
    || sourceAfter.revision !== desiredHash
    || capturedAfter.revision !== expectedHash
    || !sameStableIdentity(published.identity, sourceAfter.identity)
    || !sameStableIdentity(captured.identity, capturedAfter.identity)
  ) {
    throw new Error('无覆盖发布后校验失败');
  }
  // 当前事务保留捕获 inode 的目录链接；旧编辑器 fd 的延迟保存会落到该路径。
  // 后续事务仅在证据仍未变化时，才按严格记录的路径成组清理。
}

function restoreEntryFromBackup(entry, options, txid) {
  let current;
  try {
    current = readStableSnapshot(entry.path, options);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    current = null;
  }
  if (current?.revision === entry.oldHash) return false;
  if (current !== null && current.revision !== entry.newHash) {
    throw new Error('目标内容不属于当前事务');
  }

  if (current === null && pathExists(options.fileSystem, entry.quarantinePath)) {
    const captured = readStableSnapshot(entry.quarantinePath, options);
    if (captured.revision === entry.oldHash) {
      restoreCapturedTarget(entry.quarantinePath, entry.path, captured, options);
      return true;
    }
    if (captured.revision !== entry.newHash) throw new Error('隔离内容不属于当前事务');
  }
  let expectedIdentity = current?.identity;
  if (current === null && pathExists(options.fileSystem, entry.displacedPath)) {
    const displaced = readStableSnapshot(entry.displacedPath, options);
    if (displaced.revision !== entry.newHash) throw new Error('displaced 内容不属于当前事务');
    expectedIdentity = displaced.identity;
  }

  const backup = readRevisionedJson(entry.backupPath, options);
  if (backup.revision !== entry.oldHash) throw new Error('恢复备份校验失败');
  const restorePath = `${entry.path}.restore-${txid}-${options.randomUUID()}`;
  try {
    copyAndVerify(entry.backupPath, restorePath, entry.oldHash, options);
    publishWithoutOverwrite({
      entry,
      sourcePath: restorePath,
      expectedHash: entry.newHash,
      expectedIdentity,
      desiredHash: entry.oldHash,
      capturePath: entry.displacedPath,
      options,
    });
  } finally {
    try { removeIfExists(options.fileSystem, restorePath); } catch { /* 保留主错误 */ }
  }
  if (readStableSnapshot(entry.path, options).revision !== entry.oldHash) {
    throw new Error('恢复后校验失败');
  }
  return true;
}

function rollbackFromJournal(journal, options) {
  let restored = false;
  // 逆提交顺序恢复，避免 catalog 新而 config 旧的额外窗口。
  restored = restoreEntryFromBackup({
    ...journal.catalog,
    path: journal.catalogPath,
  }, options, journal.txid) || restored;
  restored = restoreEntryFromBackup({
    ...journal.config,
    path: journal.configPath,
  }, options, journal.txid) || restored;
  return restored;
}

function settleRecoveryEntry(entry, phase, options) {
  const targetExists = pathExists(options.fileSystem, entry.path);
  const quarantineExists = pathExists(options.fileSystem, entry.quarantinePath);
  const displacedExists = pathExists(options.fileSystem, entry.displacedPath);

  if (targetExists) {
    const target = readStableSnapshot(entry.path, options);
    if (![entry.oldHash, entry.newHash].includes(target.revision)) {
      throw new Error('恢复目标 hash 未知');
    }
    if (quarantineExists) {
      const quarantine = readStableSnapshot(entry.quarantinePath, options);
      if (quarantine.revision !== entry.oldHash) throw new Error('quarantine 证据已变化');
      if (target.revision === entry.oldHash && phase !== 'rolling-back') {
        throw new Error('提交阶段出现不安全隔离组合');
      }
    }
    if (displacedExists) {
      const displaced = readStableSnapshot(entry.displacedPath, options);
      if (phase !== 'rolling-back' || displaced.revision !== entry.newHash) {
        throw new Error('displaced 证据与阶段不一致');
      }
    }
    return target.revision;
  }

  if (phase === 'rolling-back') {
    if (quarantineExists) {
      const quarantine = readStableSnapshot(entry.quarantinePath, options);
      if (quarantine.revision !== entry.oldHash) throw new Error('回滚 quarantine 已变化');
      restoreCapturedTarget(entry.quarantinePath, entry.path, quarantine, options);
      return entry.oldHash;
    }
    if (displacedExists) {
      const displaced = readStableSnapshot(entry.displacedPath, options);
      if (displaced.revision !== entry.newHash) throw new Error('回滚 displaced 已变化');
      restoreEntryFromBackup(entry, options, entry.txid);
      return entry.oldHash;
    }
    throw new Error('回滚目标和隔离证据都缺失');
  }

  if (!quarantineExists || displacedExists) {
    throw new Error('提交恢复缺少安全发布证据');
  }
  const quarantine = readStableSnapshot(entry.quarantinePath, options);
  if (quarantine.revision !== entry.oldHash) throw new Error('提交 quarantine 已变化');
  if (!verifiedTemp(entry, options)) {
    restoreCapturedTarget(entry.quarantinePath, entry.path, quarantine, options);
    return entry.oldHash;
  }
  publishWithoutOverwrite({
    entry,
    sourcePath: entry.tempPath,
    expectedHash: entry.oldHash,
    desiredHash: entry.newHash,
    capturePath: entry.quarantinePath,
    options,
  });
  return entry.newHash;
}

function isHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function safeTransactionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectedTempPath(targetPath, tempPath, txid) {
  if (
    typeof tempPath !== 'string'
    || !path.isAbsolute(tempPath)
    || path.resolve(tempPath) !== tempPath
  ) return false;
  if (path.dirname(tempPath) !== path.dirname(targetPath)) return false;
  const pattern = new RegExp(
    `^${escapeRegExp(path.basename(targetPath))}\\.tmp-\\d+-${escapeRegExp(txid)}-[A-Za-z0-9-]+$`,
  );
  return pattern.test(path.basename(tempPath));
}

function expectedIsolationPath(targetPath, candidatePath, kind, txid, expectedHash) {
  if (
    typeof candidatePath !== 'string'
    || !path.isAbsolute(candidatePath)
    || path.resolve(candidatePath) !== candidatePath
    || path.dirname(candidatePath) !== path.dirname(targetPath)
  ) return false;
  const pattern = new RegExp(
    `^${escapeRegExp(path.basename(targetPath))}\\.model-routing\\.${kind}-${escapeRegExp(txid)}-${escapeRegExp(expectedHash)}-[A-Za-z0-9-]+$`,
  );
  return pattern.test(path.basename(candidatePath));
}

function validateJournal(value, configPath, expectedCatalogPath) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.version !== JOURNAL_VERSION
    || !safeTransactionId(value.txid)
    || !['prepared', 'config-replaced', 'catalog-replaced', 'rolling-back', 'committed']
      .includes(value.phase)
    || value.configPath !== configPath
    || typeof value.catalogPath !== 'string'
    || !path.isAbsolute(value.catalogPath)
    || path.resolve(value.catalogPath) !== value.catalogPath
    || value.catalogPath === configPath
    || (expectedCatalogPath !== undefined && value.catalogPath !== expectedCatalogPath)
  ) {
    return false;
  }
  const catalogPath = value.catalogPath;
  for (const [name, targetPath] of [['config', configPath], ['catalog', catalogPath]]) {
    const entry = value[name];
    if (
      entry === null
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !isHash(entry.oldHash)
      || !isHash(entry.newHash)
      || !expectedTempPath(targetPath, entry.tempPath, value.txid)
      || entry.backupPath !== backupPathFor(targetPath, value.txid, entry.oldHash)
      || !expectedIsolationPath(
        targetPath, entry.quarantinePath, 'quarantine', value.txid, entry.oldHash,
      )
      || !expectedIsolationPath(
        targetPath, entry.displacedPath, 'displaced', value.txid, entry.newHash,
      )
    ) {
      return false;
    }
  }
  return true;
}

function readPendingJournal(journalPath, options) {
  if (!options.fileSystem.existsSync(journalPath)) return null;
  try {
    return readRevisionedJson(journalPath, options).value;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw transactionError('transaction_in_doubt');
  }
}

function verifiedTemp(entry, options) {
  try {
    return readRevisionedJson(entry.tempPath, options).revision === entry.newHash;
  } catch {
    return false;
  }
}

function retentionIndexPath(configPath) {
  return `${configPath}.model-routing-retained-evidence.json`;
}

function validateRetentionRecord(record, configPath, catalogPath) {
  if (
    record === null
    || typeof record !== 'object'
    || Array.isArray(record)
    || !safeTransactionId(record.txid)
    || !['committed', 'rolled-back'].includes(record.outcome)
    || record.configPath !== configPath
    || record.catalogPath !== catalogPath
  ) return false;

  let retainedCount = 0;
  for (const [name, targetPath] of [['config', configPath], ['catalog', catalogPath]]) {
    const entry = record[name];
    if (
      entry === null
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !isHash(entry.oldHash)
      || !isHash(entry.newHash)
      || entry.backupPath !== backupPathFor(targetPath, record.txid, entry.oldHash)
      || !expectedIsolationPath(
        targetPath, entry.quarantinePath, 'quarantine', record.txid, entry.oldHash,
      )
      || !expectedIsolationPath(
        targetPath, entry.displacedPath, 'displaced', record.txid, entry.newHash,
      )
      || !Array.isArray(entry.retained)
      || entry.retained.some((kind) => !['quarantine', 'displaced'].includes(kind))
      || new Set(entry.retained).size !== entry.retained.length
    ) return false;
    retainedCount += entry.retained.length;
  }
  return retainedCount > 0;
}

function readRetentionIndex(indexPath, configPath, catalogPath, options) {
  if (!pathExists(options.fileSystem, indexPath)) return { version: RETENTION_VERSION, records: [] };
  const index = readRevisionedJson(indexPath, options).value;
  if (
    index === null
    || typeof index !== 'object'
    || Array.isArray(index)
    || index.version !== RETENTION_VERSION
    || !Array.isArray(index.records)
    || index.records.some((record) => !validateRetentionRecord(record, configPath, catalogPath))
    || new Set(index.records.map((record) => record.txid)).size !== index.records.length
  ) {
    throw new Error('保留证据索引非法');
  }
  return index;
}

function buildRetentionRecord(journal, outcome, options) {
  const record = {
    txid: journal.txid,
    outcome,
    configPath: journal.configPath,
    catalogPath: journal.catalogPath,
  };
  let retainedCount = 0;
  for (const name of ['config', 'catalog']) {
    const journalEntry = journal[name];
    const retained = [];
    for (const [kind, evidencePath, expectedHash] of [
      ['quarantine', journalEntry.quarantinePath, journalEntry.oldHash],
      ['displaced', journalEntry.displacedPath, journalEntry.newHash],
    ]) {
      if (!pathExists(options.fileSystem, evidencePath)) continue;
      if (readStableSnapshot(evidencePath, options).revision !== expectedHash) {
        throw new Error('当前事务隔离证据已变化');
      }
      retained.push(kind);
      retainedCount += 1;
    }
    if (readStableSnapshot(journalEntry.backupPath, options).revision !== journalEntry.oldHash) {
      throw new Error('当前事务备份证据已变化');
    }
    record[name] = {
      oldHash: journalEntry.oldHash,
      newHash: journalEntry.newHash,
      backupPath: journalEntry.backupPath,
      quarantinePath: journalEntry.quarantinePath,
      displacedPath: journalEntry.displacedPath,
      retained,
    };
  }
  return retainedCount === 0 ? null : record;
}

function retainedArtifactPaths(record) {
  const artifacts = [];
  for (const name of ['config', 'catalog']) {
    const entry = record[name];
    artifacts.push([entry.backupPath, entry.oldHash]);
    if (entry.retained.includes('quarantine')) {
      artifacts.push([entry.quarantinePath, entry.oldHash]);
    }
    if (entry.retained.includes('displaced')) {
      artifacts.push([entry.displacedPath, entry.newHash]);
    }
  }
  return artifacts;
}

function unchangedRetainedRecord(record, options) {
  // 威胁模型只保证：同一次管理事务开始前已打开的普通编辑器 fd，在该事务结束后、
  // 下一次管理保存开始前关闭并保存时可恢复。跨越下一次管理保存仍长期不关闭的 fd
  // 不在保证内，否则无法同时满足旧备份有界清理。
  try {
    const snapshots = retainedArtifactPaths(record).map(([filePath, expectedHash]) => {
      const snapshot = readStableSnapshot(filePath, options);
      if (snapshot.revision !== expectedHash) throw new Error('证据 hash 已变化');
      return snapshot;
    });
    return snapshots.every((snapshot, index) => snapshots.every(
      (other, otherIndex) => index === otherIndex
        || !sameStableIdentity(snapshot.identity, other.identity),
    ));
  } catch {
    return false;
  }
}

function retainCurrentAndPruneOlder(journal, outcome, options) {
  const current = buildRetentionRecord(journal, outcome, options);
  if (current === null) return false;
  const indexPath = retentionIndexPath(journal.configPath);
  const index = readRetentionIndex(
    indexPath, journal.configPath, journal.catalogPath, options,
  );
  const olderRecords = index.records.filter((record) => record.txid !== current.txid);

  const withCurrent = {
    version: RETENTION_VERSION,
    records: [...olderRecords, current],
  };
  // 先持久化精确路径，再尝试清理旧事务；崩溃最多造成保守残留，不会失去证据。
  writeJournal(indexPath, withCurrent, options);

  const retainedRecords = [];
  for (const record of olderRecords) {
    if (!unchangedRetainedRecord(record, options)) {
      retainedRecords.push(record);
      continue;
    }
    try {
      for (const [artifactPath] of retainedArtifactPaths(record)) {
        options.fileSystem.unlinkSync(artifactPath);
      }
    } catch {
      // 成组清理中断时保留记录，后续事务继续 fail-closed。
      retainedRecords.push(record);
    }
  }
  try {
    writeJournal(indexPath, {
      version: RETENTION_VERSION,
      records: [...retainedRecords, current],
    }, options);
  } catch {
    // 首次写入已包含全部记录；压缩索引失败只会造成保守残留。
  }
  return true;
}

function committedRecoveryResult(journal) {
  return {
    recovered: true,
    outcome: 'committed',
    configRevision: journal.config.newHash,
    catalogRevision: journal.catalog.newHash,
    txid: journal.txid,
    restartRequired: true,
  };
}

function rolledBackRecoveryResult(journal, outcome = 'rolled_back') {
  return {
    recovered: true,
    outcome,
    configRevision: journal.config.oldHash,
    catalogRevision: journal.catalog.oldHash,
    txid: journal.txid,
    restartRequired: false,
  };
}

function finishRecoveredCommit(journalPath, journal, options) {
  const configRevision = readRevisionedJson(journal.configPath, options).revision;
  const catalogRevision = readRevisionedJson(journal.catalogPath, options).revision;
  if (
    configRevision !== journal.config.newHash
    || catalogRevision !== journal.catalog.newHash
  ) {
    throw new Error('恢复提交校验失败');
  }
  verifyCurrentIsolationEvidence(journal, options);
  journal.phase = 'committed';
  writeJournal(journalPath, journal, options);
  retainCurrentAndPruneOlder(journal, 'committed', options);
  cleanupJournalArtifacts(options.fileSystem, journalPath, journal, false);
  return committedRecoveryResult(journal);
}

function recoverModelRoutingTransactionUnlocked(options) {
  const fileSystem = options.fileSystem || fs;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const commonOptions = { fileSystem, randomUUID, maxBytes: options.maxBytes };
  const configPath = path.resolve(options.configPath);
  const expectedCatalogPath = options.catalogPath === undefined
    ? undefined
    : path.resolve(options.catalogPath);
  const journalPath = transactionJournalPath(configPath);
  const journal = readPendingJournal(journalPath, commonOptions);
  if (journal === null) return { recovered: false };
  if (!validateJournal(journal, configPath, expectedCatalogPath)) {
    throw transactionError(
      'transaction_in_doubt',
      safeTransactionId(journal?.txid) ? journal.txid : undefined,
    );
  }
  const catalogPath = journal.catalogPath;
  const configEntry = { ...journal.config, path: configPath, txid: journal.txid };
  const catalogEntry = { ...journal.catalog, path: catalogPath, txid: journal.txid };
  const recoveryIdentities = {};
  try {
    if (
      pathExists(fileSystem, configPath)
      && pathExists(fileSystem, catalogPath)
    ) {
      if (sameActualFile(fileSystem, configPath, catalogPath)) {
        throw new Error('恢复双目标指向同一文件');
      }
      const configSnapshot = readStableSnapshot(configPath, commonOptions);
      const catalogSnapshot = readStableSnapshot(catalogPath, commonOptions);
      if (sameStableIdentity(configSnapshot.identity, catalogSnapshot.identity)) {
        throw new Error('恢复双目标身份相同');
      }
      recoveryIdentities.config = configSnapshot.identity;
      recoveryIdentities.catalog = catalogSnapshot.identity;
    }
  } catch {
    throw transactionError('transaction_in_doubt', journal.txid);
  }
  let configRevision;
  let catalogRevision;
  try {
    configRevision = settleRecoveryEntry(configEntry, journal.phase, commonOptions);
    catalogRevision = settleRecoveryEntry(catalogEntry, journal.phase, commonOptions);
    if (sameActualFile(fileSystem, configPath, catalogPath)) {
      throw new Error('事务双目标身份不安全');
    }
  } catch {
    throw transactionError('transaction_in_doubt', journal.txid);
  }

  const configOld = configRevision === journal.config.oldHash;
  const configNew = configRevision === journal.config.newHash;
  const catalogOld = catalogRevision === journal.catalog.oldHash;
  const catalogNew = catalogRevision === journal.catalog.newHash;
  if ((!configOld && !configNew) || (!catalogOld && !catalogNew)) {
    throw transactionError('transaction_in_doubt', journal.txid);
  }

  if (journal.phase === 'rolling-back') {
    try {
      rollbackFromJournal(journal, commonOptions);
      const finalConfig = readRevisionedJson(configPath, commonOptions).revision;
      const finalCatalog = readRevisionedJson(catalogPath, commonOptions).revision;
      if (finalConfig !== journal.config.oldHash || finalCatalog !== journal.catalog.oldHash) {
        throw new Error('恢复回滚校验失败');
      }
      verifyCurrentIsolationEvidence(journal, commonOptions);
      const retained = retainCurrentAndPruneOlder(
        journal, 'rolled-back', commonOptions,
      );
      cleanupJournalArtifacts(fileSystem, journalPath, journal, !retained);
      return rolledBackRecoveryResult(journal);
    } catch {
      throw transactionError('transaction_in_doubt', journal.txid);
    }
  }

  if (configNew && catalogNew) {
    try { return finishRecoveredCommit(journalPath, journal, commonOptions); } catch {
      throw transactionError('transaction_in_doubt', journal.txid);
    }
  }
  if (configOld && catalogOld) {
    try {
      verifyCurrentIsolationEvidence(journal, commonOptions);
    } catch {
      throw transactionError('transaction_in_doubt', journal.txid);
    }
    cleanupJournalArtifacts(fileSystem, journalPath, journal, true);
    return rolledBackRecoveryResult(journal, 'aborted');
  }

  const missingName = configOld ? 'config' : 'catalog';
  const missingEntry = journal[missingName];
  const missingPath = missingName === 'config' ? configPath : catalogPath;
  if (verifiedTemp(missingEntry, commonOptions)) {
    try {
      publishWithoutOverwrite({
        entry: { ...missingEntry, path: missingPath },
        sourcePath: missingEntry.tempPath,
        expectedHash: missingEntry.oldHash,
        expectedIdentity: recoveryIdentities[missingName],
        desiredHash: missingEntry.newHash,
        capturePath: missingEntry.quarantinePath,
        options: commonOptions,
      });
      journal.phase = 'catalog-replaced';
      writeJournal(journalPath, journal, commonOptions);
      return finishRecoveredCommit(journalPath, journal, commonOptions);
    } catch {
      // 完成提交失败后，继续尝试用已验证备份回滚。
    }
  }

  try {
    rollbackFromJournal(journal, commonOptions);
    const finalConfig = readRevisionedJson(configPath, commonOptions).revision;
    const finalCatalog = readRevisionedJson(catalogPath, commonOptions).revision;
    if (finalConfig !== journal.config.oldHash || finalCatalog !== journal.catalog.oldHash) {
      throw new Error('恢复回滚校验失败');
    }
    verifyCurrentIsolationEvidence(journal, commonOptions);
    const retained = retainCurrentAndPruneOlder(journal, 'rolled-back', commonOptions);
    cleanupJournalArtifacts(fileSystem, journalPath, journal, !retained);
    return rolledBackRecoveryResult(journal);
  } catch {
    throw transactionError('transaction_in_doubt', journal.txid);
  }
}

/** 恢复 config 同目录中遗留的模型路由事务日志。 */
export async function recoverModelRoutingTransaction(options) {
  const configPath = path.resolve(options.configPath);
  if (options.catalogPath !== undefined) {
    const fileSystem = options.fileSystem || fs;
    const catalogPath = path.resolve(options.catalogPath);
    try {
      if (sameActualFile(fileSystem, configPath, catalogPath)) {
        throw transactionError('invalid_transaction_paths');
      }
    } catch (error) {
      if (error?.code === 'invalid_transaction_paths') throw error;
      throw transactionError('transaction_failed');
    }
  }
  return withJournalMutex(
    transactionJournalPath(configPath),
    () => recoverModelRoutingTransactionUnlocked(options),
  );
}

/** 创建一次可恢复的 config + catalog 联合写入器。 */
export function createModelRoutingTransaction(options) {
  const fileSystem = options.fileSystem || fs;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const commonOptions = {
    fileSystem,
    randomUUID,
    maxBytes: options.maxBytes,
  };
  const configPath = path.resolve(options.configPath);
  const catalogPath = path.resolve(options.catalogPath);
  const journalPath = transactionJournalPath(configPath);
  try {
    if (sameActualFile(fileSystem, configPath, catalogPath)) {
      throw transactionError('invalid_transaction_paths');
    }
  } catch (error) {
    if (error?.code === 'invalid_transaction_paths') throw error;
    throw transactionError('transaction_failed');
  }

  return {
    async commit(request) {
      return withJournalMutex(journalPath, async () => {
        recoverModelRoutingTransactionUnlocked({
          ...options,
          configPath,
          catalogPath,
          fileSystem,
          randomUUID,
        });
        try {
          if (sameActualFile(fileSystem, configPath, catalogPath)) {
            throw transactionError('invalid_transaction_paths');
          }
        } catch (error) {
          if (error?.code === 'invalid_transaction_paths') throw error;
          throw transactionError('transaction_failed');
        }
      const txid = randomUUID();
      if (!safeTransactionId(txid)) throw transactionError('transaction_failed');
      const transactionOptions = {
        ...commonOptions,
        randomUUID: () => `${txid}-${randomUUID()}`,
      };
      const oldConfig = readForCommit(configPath, commonOptions);
      const oldCatalog = readForCommit(catalogPath, commonOptions);
      if (sameStableIdentity(oldConfig.identity, oldCatalog.identity)) {
        throw transactionError('invalid_transaction_paths');
      }
      if (
        oldConfig.revision !== request.configRevision
        || oldCatalog.revision !== request.catalogRevision
      ) {
        throw transactionError('revision_conflict');
      }

      let configWrite;
      let catalogWrite;
      let journal;
      let retainForRecovery = false;
      try {
        configWrite = prepareJsonWrite(configPath, request.config, transactionOptions);
        catalogWrite = prepareJsonWrite(catalogPath, request.catalog, transactionOptions);
        configWrite.sync();
        catalogWrite.sync();

        const configQuarantineToken = randomUUID();
        const configDisplacedToken = randomUUID();
        const catalogQuarantineToken = randomUUID();
        const catalogDisplacedToken = randomUUID();
        if (![configQuarantineToken, configDisplacedToken, catalogQuarantineToken, catalogDisplacedToken]
          .every(safeTransactionId)) {
          throw new Error('无法分配安全隔离路径');
        }

        journal = {
          version: JOURNAL_VERSION,
          txid,
          phase: 'prepared',
          configPath,
          catalogPath,
          config: {
            oldHash: oldConfig.revision,
            newHash: configWrite.revision,
            tempPath: configWrite.tempPath,
            backupPath: backupPathFor(configPath, txid, oldConfig.revision),
            quarantinePath: isolationPathFor(
              configPath, 'quarantine', txid, oldConfig.revision, configQuarantineToken,
            ),
            displacedPath: isolationPathFor(
              configPath, 'displaced', txid, configWrite.revision, configDisplacedToken,
            ),
          },
          catalog: {
            oldHash: oldCatalog.revision,
            newHash: catalogWrite.revision,
            tempPath: catalogWrite.tempPath,
            backupPath: backupPathFor(catalogPath, txid, oldCatalog.revision),
            quarantinePath: isolationPathFor(
              catalogPath, 'quarantine', txid, oldCatalog.revision, catalogQuarantineToken,
            ),
            displacedPath: isolationPathFor(
              catalogPath, 'displaced', txid, catalogWrite.revision, catalogDisplacedToken,
            ),
          },
        };
        writeJournal(journalPath, journal, transactionOptions);

        const checkedConfig = readStableSnapshot(configPath, commonOptions);
        const checkedCatalog = readStableSnapshot(catalogPath, commonOptions);
        if (
          checkedConfig.revision !== oldConfig.revision
          || checkedCatalog.revision !== oldCatalog.revision
          || !sameStableIdentity(checkedConfig.identity, oldConfig.identity)
          || !sameStableIdentity(checkedCatalog.identity, oldCatalog.identity)
          || sameStableIdentity(checkedConfig.identity, checkedCatalog.identity)
        ) {
          removeIfExists(fileSystem, journalPath);
          throw transactionError('revision_conflict');
        }

        copyAndVerify(configPath, journal.config.backupPath, oldConfig.revision, transactionOptions);
        copyAndVerify(catalogPath, journal.catalog.backupPath, oldCatalog.revision, transactionOptions);

        publishWithoutOverwrite({
          entry: { ...journal.config, path: configPath },
          sourcePath: configWrite.tempPath,
          expectedHash: oldConfig.revision,
          expectedIdentity: oldConfig.identity,
          desiredHash: configWrite.revision,
          capturePath: journal.config.quarantinePath,
          options: transactionOptions,
        });
        journal.phase = 'config-replaced';
        writeJournal(journalPath, journal, transactionOptions);
        publishWithoutOverwrite({
          entry: { ...journal.catalog, path: catalogPath },
          sourcePath: catalogWrite.tempPath,
          expectedHash: oldCatalog.revision,
          expectedIdentity: oldCatalog.identity,
          desiredHash: catalogWrite.revision,
          capturePath: journal.catalog.quarantinePath,
          options: transactionOptions,
        });
        journal.phase = 'catalog-replaced';
        writeJournal(journalPath, journal, transactionOptions);

        const newConfig = readRevisionedJson(configPath, commonOptions);
        const newCatalog = readRevisionedJson(catalogPath, commonOptions);
        if (
          newConfig.revision !== configWrite.revision
          || newCatalog.revision !== catalogWrite.revision
        ) {
          throw new Error('事务最终校验失败');
        }
        journal.phase = 'committed';
        writeJournal(journalPath, journal, transactionOptions);
        retainCurrentAndPruneOlder(journal, 'committed', transactionOptions);
        removeIfExists(fileSystem, journalPath);

        return {
          configRevision: newConfig.revision,
          catalogRevision: newCatalog.revision,
          txid,
          restartRequired: true,
        };
      } catch (error) {
        if (error?.code === 'revision_conflict') throw error;
        if (error?.preserveEvidence) {
          retainForRecovery = true;
          throw transactionError('transaction_in_doubt', txid);
        }

        let restored = false;
        let retained = false;
        if (journal) {
          try {
            journal.phase = 'rolling-back';
            writeJournal(journalPath, journal, transactionOptions);
            restored = rollbackFromJournal(journal, transactionOptions);
            verifyCurrentIsolationEvidence(journal, transactionOptions);
            retained = restored && retainCurrentAndPruneOlder(
              journal, 'rolled-back', transactionOptions,
            );
          } catch {
            retainForRecovery = true;
            throw transactionError('transaction_in_doubt', txid);
          }
        }

        cleanupJournalArtifacts(fileSystem, journalPath, journal, !retained);
        throw transactionError(restored ? 'transaction_rolled_back' : 'transaction_failed');
      } finally {
        if (!retainForRecovery) {
          configWrite?.cleanup();
          catalogWrite?.cleanup();
        }
      }
      });
    },
  };
}
