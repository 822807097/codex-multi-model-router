import { createHash } from 'node:crypto';

// ---------- previous_response_id 的有界工具调用历史 ----------
// 仅缓存工具调用元数据，不缓存用户对话与模型正文，避免在路由内复制完整会话状态。
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_search_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

function clone(value) {
  return structuredClone(value);
}

function preferredScopeKey(keys = []) {
  return keys.find((key) => key.startsWith('conversation:') || key.startsWith('header:'))
    || keys.find((key) => key.startsWith('prompt:'))
    || null;
}

function internalHistoryKey(type, values) {
  // response id 与会话键都来自外部；Map 只保存带类型域的定长摘要，避免键本身绕过字节预算。
  const digest = createHash('sha256')
    .update('response-tool-history-v1\0')
    .update(type)
    .update('\0')
    .update(JSON.stringify(values))
    .digest('hex');
  return `history:${digest}`;
}

function responseKey(responseId) {
  return internalHistoryKey('response', [String(responseId)]);
}

function scopedResponseKey(responseId, scopeKey) {
  return internalHistoryKey('response-scope', [String(responseId), String(scopeKey)]);
}

function serializedEntryBytes(entry) {
  // Map 本身 JSON 序列化为空对象，计费时必须显式保留 call_id 键与完整调用值。
  const stored = entry.ambiguous
    ? { ambiguous: true, expiresAt: entry.expiresAt }
    : { calls: [...entry.calls.entries()], expiresAt: entry.expiresAt };
  if (entry.scopeKey) stored.scopeKey = entry.scopeKey;
  return Buffer.byteLength(JSON.stringify(stored), 'utf8');
}

export class ResponseToolHistoryStore {
  constructor(options = {}) {
    this.maxEntries = Math.max(1, Number(options.maxEntries) || 512);
    this.maxEntryBytes = Math.max(1, Number(options.maxEntryBytes) || DEFAULT_MAX_ENTRY_BYTES);
    this.maxBytes = Math.max(1, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
    this.ttlMs = Math.max(1, Number(options.ttlMs) || 24 * 60 * 60_000);
    this.now = options.now || Date.now;
    this.entries = new Map();
    this.entryReferences = new Map();
    this.entrySizes = new Map();
    this.bytes = 0;
  }

  get size() {
    this.pruneExpired();
    return this.entries.size;
  }

  pruneExpired() {
    // 在读写入口惰性清理即可，本地单用户场景无需额外常驻定时器。
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.deleteKey(key);
    }
  }

  deleteKey(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    const references = (this.entryReferences.get(entry) || 1) - 1;
    if (references > 0) {
      this.entryReferences.set(entry, references);
      return true;
    }
    this.entryReferences.delete(entry);
    const bytes = this.entrySizes.get(entry) || 0;
    this.entrySizes.delete(entry);
    this.bytes = Math.max(0, this.bytes - bytes);
    return true;
  }

  setKey(key, entry) {
    this.deleteKey(key);
    this.entries.set(key, entry);
    const references = this.entryReferences.get(entry) || 0;
    if (references === 0) {
      const bytes = serializedEntryBytes(entry);
      this.entrySizes.set(entry, bytes);
      this.bytes += bytes;
    }
    this.entryReferences.set(entry, references + 1);
  }

  evictOverBudget() {
    // LRU 顺序以 Map 键为准；共享 entry 只在最后一个键被淘汰时释放字节。
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.deleteKey(oldestKey);
    }
  }

  getByKey(key) {
    this.pruneExpired();
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Map 删除再插入即可把命中项移动到 LRU 尾部。
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.ambiguous ? null : entry;
  }

  get(responseId, scopeKeys = []) {
    const scopeKey = preferredScopeKey(scopeKeys);
    if (scopeKey) {
      const requestedScopedKey = scopedResponseKey(responseId, scopeKey);
      const scoped = this.getByKey(requestedScopedKey);
      if (scoped) {
        // scoped 仍活跃时同步刷新 base 歧义哨兵，使它晚于所有子记录被 LRU 淘汰。
        this.getByKey(responseKey(responseId));
        return scoped;
      }
      const base = this.getByKey(responseKey(responseId));
      // base 只为无作用域兼容或相同作用域的 scoped 项被 LRU 淘汰时兜底，禁止跨任务恢复。
      if (base?.scopeKey && base.scopeKey !== requestedScopedKey) return null;
      return base;
    }
    return this.getByKey(responseKey(responseId));
  }

  recordResponse(response, scopeKeys = []) {
    // 没有工具调用的普通文本响应无需入缓存。
    if (!response?.id || !Array.isArray(response.output)) return false;
    const calls = response.output.filter((item) => CALL_TYPES.has(item?.type) && item.call_id);
    if (!calls.length) return false;
    const scopeKey = preferredScopeKey(scopeKeys);
    const scopedKey = scopeKey ? scopedResponseKey(response.id, scopeKey) : null;
    const entry = {
      calls: new Map(calls.map((item) => [item.call_id, clone(item)])),
      scopeKey: scopedKey,
      expiresAt: this.now() + this.ttlMs,
    };
    const entryBytes = serializedEntryBytes(entry);
    if (entryBytes > this.maxEntryBytes || entryBytes > this.maxBytes) return false;
    const baseKey = responseKey(response.id);
    const existing = this.entries.get(baseKey);
    // scoped 先写、base 后写，确保歧义哨兵成为同一 response 组最后淘汰的记录。
    if (scopedKey) this.setKey(scopedKey, entry);
    this.deleteKey(baseKey);
    const changedScope = existing && !existing.ambiguous
      && (existing.scopeKey ?? null) !== scopedKey;
    const unscopedDuplicate = existing && !existing.ambiguous && scopedKey === null;
    if (existing?.ambiguous || changedScope || unscopedDuplicate) {
      this.setKey(baseKey, {
        ambiguous: true,
        expiresAt: entry.expiresAt,
      });
    } else {
      this.setKey(baseKey, entry);
    }
    this.evictOverBudget();
    return true;
  }

  restoreRequest(body, scopeKeys = []) {
    // Codex 增量轮次可能只带 output；在 output 前补回对应 call，维持 Chat 消息配对。
    // 调用方的 body.input 已是本请求私有数据（prepareAttemptBody 的拷贝），不再整体
    // 深克隆（60MB 级请求省一次全量克隆）；历史回补项仍逐个克隆（来自跨请求共享存储）。
    const input = Array.isArray(body?.input) ? body.input : body?.input;
    if (!Array.isArray(input)) return { input, restoredCallIds: [], historyHit: false };
    const entry = body.previous_response_id ? this.get(body.previous_response_id, scopeKeys) : null;
    const existingCalls = new Set(input
      .filter((item) => CALL_TYPES.has(item?.type) && item.call_id)
      .map((item) => item.call_id));
    const restoredCallIds = [];
    const restoredInput = [];

    for (const item of input) {
      if (OUTPUT_TYPES.has(item?.type) && item.call_id && !existingCalls.has(item.call_id)) {
        // previous_response_id 未命中时禁止全局搜索 call_id，避免把其他任务的工具参数注入当前请求。
        const call = entry?.calls.get(item.call_id) ? clone(entry.calls.get(item.call_id)) : null;
        if (call) {
          restoredInput.push(call);
          existingCalls.add(item.call_id);
          restoredCallIds.push(item.call_id);
        }
      }
      restoredInput.push(item);
    }
    return { input: restoredInput, restoredCallIds, historyHit: !!entry };
  }
}
