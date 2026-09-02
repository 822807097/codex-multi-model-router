// ---------- 官方通道增量续聊（official incremental continuation） ----------
// 背景（2026-09-02 实锤）：桌面端经路由的 /v1/responses 请求每轮全量重发
// （长任务实测 3.7MB / 317 条 input，previous_response_id 恒为 false——桌面端对
// 自定义 provider 不发链式标记），一轮即烧光官方订阅的 5 小时窗口。
//
// 方案：缓存「每个会话最近一次成功上游响应的 response.id + 规范化 input 串」。
// 新请求与缓存为纯追加（同 model/instructions/tools 指纹、input 是旧串的前缀
// 扩展、追加点落在 item 边界）时，把请求改写为
//   { previous_response_id, input: 增量项, store: true }
// 上游按增量续算，输入从 3.7MB 降到 KB 级。
// 任一前提不满足即回退全量；上游拒绝增量（状态过期等）由调用方清会话后全量重试。
import { createHash } from 'node:crypto';

const DEFAULT_ENTRY_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;
// 低于该字节的请求不值得增量（增量有协议开销，小请求全量更简单可靠）
const DEFAULT_MIN_INPUT_BYTES = 8 * 1024;

// 稳定序列化：逐项 stringify 以 \u0000 连接（项边界可逆；JSON 字符串值内
// 出现字面 \u0000 会被转义为 \\u0000 六字符，不会破坏边界切分）。
function serializeItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => JSON.stringify(item))
    .join('\u0000');
}

// 请求「属性指纹」：model/instructions/tools/tool_choice 等任一变化都必须全量
// （previous_response_id 引用的历史绑定这些参数；变了就不是纯追加续算）。
function propsFingerprint(body) {
  return createHash('sha256').update(JSON.stringify({
    model: body.model ?? null,
    instructions: body.instructions ?? null,
    tools: body.tools ?? null,
    tool_choice: body.tool_choice ?? null,
    parallel_tool_calls: body.parallel_tool_calls ?? null,
    reasoning: body.reasoning ?? null,
    text: body.text ?? null,
  })).digest('hex').slice(0, 32);
}

// 会话键：prompt_cache_key（桌面端按项目/工作区生成，天然区分会话）；缺失时用
// 首条 user 消息文本哈希（同一任务链的前缀必然包含它）。跨任务撞键无碍——
// 前缀不匹配只会回退全量，不会误增量。
// user 项的 content 兼容字符串与数组（[{type:'input_text',text}...]）两种形态
function firstUserText(body) {
  for (const item of (Array.isArray(body?.input) ? body.input : [])) {
    if (item?.role !== 'user') continue;
    if (typeof item.content === 'string' && item.content) return item.content;
    if (Array.isArray(item.content)) {
      const text = item.content
        .filter((part) => part?.type === 'input_text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      if (text) return text;
    }
  }
  return null;
}

function sessionKeyOf(body) {
  const cacheKey = typeof body.prompt_cache_key === 'string' && body.prompt_cache_key
    ? `pc:${body.prompt_cache_key}`
    : null;
  if (cacheKey) return cacheKey;
  const firstUser = firstUserText(body);
  if (firstUser) {
    return `u:${createHash('sha256').update(firstUser.slice(0, 2048)).digest('hex').slice(0, 24)}`;
  }
  return null;
}

export function createOfficialIncrementalStore(options = {}) {
  const enabled = options.enabled !== false;
  const minInputBytes = Number(options.minInputBytes) || 8 * 1024;
  const ttlMs = Number(options.ttlMs) || DEFAULT_ENTRY_TTL_MS;
  const maxEntries = Math.max(8, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
  // sessions: sessionKey -> { props, inputJoined, inputBytes, responseId, updatedAt }
  const sessions = new Map();
  let bytes = 0;

  function entryBytes(entry) {
    return entry.inputJoined.length + 128;
  }

  function evictExpired(now) {
    for (const [key, entry] of sessions) {
      if (now - entry.updatedAt > ttlMs) {
        sessions.delete(key);
        bytes -= entryBytes(entry);
      }
    }
    while (sessions.size > maxEntries) {
      const oldest = sessions.keys().next().value;
      bytes -= entryBytes(sessions.get(oldest));
      sessions.delete(oldest);
    }
  }

  function put(sessionKey, props, inputItems, responseId, now) {
    const inputJoined = serializeItems(inputItems);
    const entry = {
      props,
      inputJoined,
      inputBytes: inputJoined.length,
      responseId: responseId || null,
      updatedAt: now,
    };
    const prev = sessions.get(sessionKey);
    if (prev) bytes -= entryBytes(prev);
    sessions.set(sessionKey, entry);
    bytes += entryBytes(entry);
  }

  /** 请求到达时记录基线（尚未绑定上游 responseId） */
  function recordRequest(sessionKey, props, inputItems, now = Date.now()) {
    if (!enabled || !sessionKey) return;
    evictExpired(now);
    put(sessionKey, props, inputItems, null, now);
  }

  /** 上游响应成功后绑定 responseId（此后该会话才具备增量资格） */
  function attachResponse(sessionKey, responseId, now = Date.now()) {
    const entry = sessions.get(sessionKey);
    if (entry) entry.responseId = responseId || entry.responseId;
  }

  /**
   * 增量判定。返回 null = 不适合增量（调用方保持全量原样发送）；
   * 命中返回 { previousResponseId, input: 增量项 }。
   */
  function incrementalFor(body, now = Date.now()) {
    if (!enabled) return null;
    const inputItems = Array.isArray(body?.input) ? body.input : [];
    const inputJoined = serializeItems(inputItems);
    if (inputJoined.length < minInputBytes) return null; // 小请求全量更省事
    const sessionKey = sessionKeyOf(body);
    if (!sessionKey) return null;
    const entry = sessions.get(sessionKey);
    if (!entry?.responseId || now - entry.updatedAt > ttlMs) return null; // 无链式资格
    if (entry.props !== propsFingerprint(body)) return null; // 参数变化 → 全量
    if (entry.inputBytes > inputJoined.length) return null; // 请求比基线短（历史被裁剪）→ 全量
    if (inputJoined.slice(0, entry.inputBytes) !== entry.inputJoined) return null; // 非纯追加
    if (inputJoined.length === entry.inputBytes) return null; // 完全重复，走全量（重复重试场景）
    const deltaJoined = inputJoined.slice(entry.inputBytes);
    const parts = deltaJoined.split('\u0000').filter((s) => s.length > 0);
    if (parts.length === 0) return null;
    let delta;
    try {
      delta = parts.map((s) => JSON.parse(s));
    } catch {
      return null;
    }
    // 增量首项不能是缺加密内容的 reasoning（store:true 下无法回放会被上游 400）
    if (delta[0]?.type === 'reasoning' && !delta[0]?.encrypted_content) return null;
    return { previousResponseId: entry.responseId, input: delta, sessionKey };
  }

  /** 清除会话（增量被上游拒绝后调用：下次回退全量重建基线） */
  function clearSession(sessionKey) {
    const entry = sessions.get(sessionKey);
    if (entry) bytes -= entryBytes(entry);
    sessions.delete(sessionKey);
  }

  function _debugSnapshot() {
    return [...sessions.entries()].map(([key, e]) => ({
      key: key.slice(0, 40),
      inputBytes: e.inputBytes,
      responseId: e.responseId,
      updatedAt: e.updatedAt,
    }));
  }

  return {
    incrementalFor,
    recordRequest,
    attachResponse,
    clearSession,
    _debugSnapshot,
  };
}

export function officialSessionKeyOf(body) {
  return sessionKeyOf(body);
}

export function officialPropsFingerprint(body) {
  return propsFingerprint(body);
}

export function officialSerializeItems(items) {
  return serializeItems(items);
}
