import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 72 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_STRING_LENGTH = 256;

const STRING_FIELDS = new Set([
  'event',
  'request_id',
  'model',
  'method',
  'path',
  'target',
  'wire_api',
  'upstream_request_id',
  'outcome',
  'error_code',
  'error_stage',
  'item_type',
  'id_prefix',
]);

const NUMBER_FIELDS = new Set([
  'elapsed_ms',
  'duration_ms',
  'first_byte_ms',
  'body_bytes',
  'input_items',
  'attempt',
  'failover_count',
  'upstream_status',
  'client_status',
  'restored_calls',
  'source_tokens',
  'chars',
  'groups',
  'tokens',
  'budget',
  'tool_count',
  'message_count',
]);

const BOOLEAN_FIELDS = new Set([
  'has_previous_response_id',
  'stream',
  'history_hit',
]);

// 只读取普通数据属性，避免诊断日志意外触发 getter 或代理对象中的用户代码。
function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function cleanString(value, limit = MAX_STRING_LENGTH) {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, limit);
}

function cleanPath(value) {
  if (typeof value !== 'string') return undefined;
  return cleanString(value.split('?', 1)[0]);
}

function cleanCounts(value) {
  if (!plainObject(value)) return undefined;
  const result = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    const safeKey = cleanString(key, 64);
    const count = dataValue(value, key);
    if (!safeKey || !Number.isSafeInteger(count) || count < 0) continue;
    result[safeKey] = count;
  }
  return result;
}

// 字段白名单是日志脱敏边界：未列出的请求、响应和异常字段一律不会序列化。
export function sanitizeDiagnosticEvent(event, timestampMs = Date.now()) {
  if (!plainObject(event)) return null;
  const safe = { ts: new Date(timestampMs).toISOString() };
  for (const field of STRING_FIELDS) {
    const value = field === 'path'
      ? cleanPath(dataValue(event, field))
      : cleanString(dataValue(event, field));
    if (value !== undefined && value !== '') safe[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    const value = dataValue(event, field);
    if (typeof value === 'number' && Number.isFinite(value)) safe[field] = value;
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = dataValue(event, field);
    if (typeof value === 'boolean') safe[field] = value;
  }
  const roleCounts = cleanCounts(dataValue(event, 'role_counts'));
  if (roleCounts) safe.role_counts = roleCounts;
  return typeof safe.event === 'string' ? safe : null;
}

function utcDate(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function archiveMatcher(filePath) {
  const parsed = path.parse(filePath);
  return new RegExp(
    `^${escapeRegex(parsed.name)}\\.\\d{4}-\\d{2}-\\d{2}(?:\\.\\d+)?${escapeRegex(parsed.ext)}$`,
  );
}

async function availableArchivePath(filePath, date) {
  const parsed = path.parse(filePath);
  const first = path.join(parsed.dir, `${parsed.name}.${date}${parsed.ext}`);
  if (!await fs.stat(first).then(() => true, () => false)) return first;
  for (let sequence = 1; sequence < 10_000; sequence += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}.${date}.${sequence}${parsed.ext}`);
    if (!await fs.stat(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error('诊断日志归档序号已耗尽');
}

export function createDiagnosticLog(options = {}) {
  const filePath = typeof options.filePath === 'string' && options.filePath.trim()
    ? path.resolve(options.filePath)
    : null;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const retentionMs = Number.isFinite(options.retentionMs) && options.retentionMs > 0
    ? options.retentionMs
    : DEFAULT_RETENTION_MS;
  const cleanupIntervalMs = Number.isFinite(options.cleanupIntervalMs) && options.cleanupIntervalMs >= 0
    ? options.cleanupIntervalMs
    : DEFAULT_CLEANUP_INTERVAL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let writeChain = Promise.resolve();
  let lastCleanupAt = Number.NEGATIVE_INFINITY;
  let activeFormatChecked = false;

  async function activeFileIsJsonLines(stat) {
    if (stat.size === 0) return true;
    const handle = await fs.open(filePath, 'r');
    try {
      const prefix = Buffer.alloc(Math.min(512, stat.size));
      const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
      return prefix.subarray(0, bytesRead).toString('utf8').trimStart().startsWith('{');
    } finally {
      await handle.close();
    }
  }

  async function rotateIfNeeded(timestampMs, pendingBytes) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return;
    const fileDate = utcDate(stat.mtimeMs);
    const currentDate = utcDate(timestampMs);
    let validActiveFormat = true;
    if (!activeFormatChecked) {
      validActiveFormat = await activeFileIsJsonLines(stat);
      activeFormatChecked = true;
    }
    // 非空活动文件在本次追加后越过上限时先轮转；单条记录不会被拆成两个文件。
    const remainsWithinLimit = stat.size === 0 || stat.size + pendingBytes <= maxBytes;
    if (fileDate === currentDate && remainsWithinLimit && validActiveFormat) return;
    const archivePath = await availableArchivePath(filePath, fileDate);
    await fs.rename(filePath, archivePath);
  }

  async function cleanupArchives(timestampMs) {
    if (timestampMs - lastCleanupAt < cleanupIntervalMs) return;
    lastCleanupAt = timestampMs;
    const directory = path.dirname(filePath);
    const matcher = archiveMatcher(filePath);
    const names = await fs.readdir(directory).catch(() => []);
    await Promise.all(names.filter((name) => matcher.test(name)).map(async (name) => {
      const archivePath = path.join(directory, name);
      const stat = await fs.stat(archivePath).catch(() => null);
      if (stat && stat.mtimeMs < timestampMs - retentionMs) {
        await fs.unlink(archivePath).catch(() => {});
      }
    }));
  }

  async function append(event, timestampMs) {
    const safe = sanitizeDiagnosticEvent(event, timestampMs);
    if (!safe) return;
    const line = `${JSON.stringify(safe)}\n`;
    await rotateIfNeeded(timestampMs, Buffer.byteLength(line));
    await cleanupArchives(timestampMs);
    await fs.appendFile(filePath, line, 'utf8');
  }

  return {
    write(event) {
      if (!filePath) return;
      const timestampMs = now();
      // Promise 链保证同一文件内事件顺序；任何磁盘错误都与路由请求隔离。
      writeChain = writeChain
        .then(() => append(event, timestampMs))
        .catch(() => {});
    },
    flush() {
      return writeChain;
    },
  };
}
