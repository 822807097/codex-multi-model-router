// ---------- previous_response_id 的有界工具调用历史 ----------
// 仅缓存工具调用元数据，不缓存用户对话与模型正文，避免在路由内复制完整会话状态。
const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'tool_search_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);

function clone(value) {
  return structuredClone(value);
}

export class ResponseToolHistoryStore {
  constructor(options = {}) {
    this.maxEntries = Math.max(1, Number(options.maxEntries) || 512);
    this.ttlMs = Math.max(1, Number(options.ttlMs) || 24 * 60 * 60_000);
    this.now = options.now || Date.now;
    this.entries = new Map();
  }

  get size() {
    this.pruneExpired();
    return this.entries.size;
  }

  pruneExpired() {
    // 在读写入口惰性清理即可，本地单用户场景无需额外常驻定时器。
    const now = this.now();
    for (const [responseId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(responseId);
    }
  }

  get(responseId) {
    this.pruneExpired();
    const entry = this.entries.get(responseId);
    if (!entry) return null;
    // Map 删除再插入即可把命中项移动到 LRU 尾部。
    this.entries.delete(responseId);
    this.entries.set(responseId, entry);
    return entry;
  }

  recordResponse(response) {
    // 没有工具调用的普通文本响应无需入缓存。
    if (!response?.id || !Array.isArray(response.output)) return false;
    const calls = response.output.filter((item) => CALL_TYPES.has(item?.type) && item.call_id);
    if (!calls.length) return false;
    const entry = {
      responseId: response.id,
      calls: new Map(calls.map((item) => [item.call_id, clone(item)])),
      expiresAt: this.now() + this.ttlMs,
    };
    this.entries.delete(response.id);
    this.entries.set(response.id, entry);
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
    return true;
  }

  findUniqueCall(callId) {
    // previous ID 丢失时只允许全局唯一 call_id 兜底，歧义时宁可不恢复。
    this.pruneExpired();
    const matches = [];
    for (const entry of this.entries.values()) {
      const call = entry.calls.get(callId);
      if (call) matches.push(call);
      if (matches.length > 1) return null;
    }
    return matches.length === 1 ? clone(matches[0]) : null;
  }

  restoreRequest(body) {
    // Codex 增量轮次可能只带 output；在 output 前补回对应 call，维持 Chat 消息配对。
    const input = Array.isArray(body?.input) ? clone(body.input) : body?.input;
    if (!Array.isArray(input)) return { input, restoredCallIds: [], historyHit: false };
    const entry = body.previous_response_id ? this.get(body.previous_response_id) : null;
    const existingCalls = new Set(input
      .filter((item) => CALL_TYPES.has(item?.type) && item.call_id)
      .map((item) => item.call_id));
    const restoredCallIds = [];
    const restoredInput = [];

    for (const item of input) {
      if (OUTPUT_TYPES.has(item?.type) && item.call_id && !existingCalls.has(item.call_id)) {
        const call = entry?.calls.get(item.call_id) ? clone(entry.calls.get(item.call_id)) : this.findUniqueCall(item.call_id);
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
