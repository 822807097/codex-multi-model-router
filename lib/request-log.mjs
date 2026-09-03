// ---------- 请求/响应查看器（sub2api 式）：内存环形日志 ----------
// 记录每个经路由代理的真实请求与上游回复原文，供管理面板查看与排障。
// 仅存内存（环形 + TTL），绝不持久化；Authorization 等凭据头不入库。

const DEFAULT_MAX_ENTRIES = 300;
const DEFAULT_BODY_LIMIT = 96 * 1024;
const DEFAULT_RESPONSE_LIMIT = 64 * 1024;
const DEFAULT_TTL_MS = 2 * 60 * 60_000;

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length > limit ? value.slice(0, limit) + `\n…[已截断，共 ${value.length} 字符]` : value;
}

export function createRequestLogStore(options = {}) {
  const maxEntries = Math.max(10, Number(options.maxEntries) || DEFAULT_MAX_ENTRIES);
  const bodyLimit = Math.max(1024, Number(options.bodyLimit) || DEFAULT_BODY_LIMIT);
  const responseLimit = Math.max(1024, Number(options.responseLimit) || DEFAULT_RESPONSE_LIMIT);
  const ttlMs = Math.max(60_000, Number(options.ttlMs) || DEFAULT_TTL_MS);
  const now = options.now || Date.now;

  const entries = new Map(); // id -> entry（插入序即时间序）
  let counter = 0;

  function evict() {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) {
      if (entry.startedAt < cutoff) entries.delete(id);
    }
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  return {
    /** 请求开始：记录元数据与请求体快照，返回日志 id。 */
    begin({ path, model = '', target = '', wireApi = '', body = null }) {
      counter += 1;
      const id = `req_${counter}`;
      entries.set(id, {
        id,
        startedAt: now(),
        path: String(path || ''),
        model: String(model || ''),
        target: String(target || ''),
        wireApi: String(wireApi || ''),
        requestBody: body === null || body === undefined ? '' : clip(typeof body === 'string' ? body : JSON.stringify(body, null, 2), bodyLimit),
        status: 'running',
        upstreamStatus: null,
        error: '',
        responseText: '',
        finishedAt: null,
        elapsedMs: null,
      });
      // 新条目入表后再淘汰（TTL 过期 + 超量），保证上限语义在 set 之后收敛。
      evict();
      return id;
    },

    /** 上游回复原文增量（透传旁路提供，内部截断）。 */
    appendResponse(id, chunk) {
      const entry = entries.get(id);
      if (!entry || entry.responseText.length >= responseLimit) return;
      entry.responseText = clip(entry.responseText + String(chunk ?? ''), responseLimit);
    },

    /** 请求终态（成功/失败/客户端断开均到达）。 */
    finish(id, { status = null, upstreamStatus = null, error = '', target = null } = {}) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.finishedAt = now();
      entry.elapsedMs = entry.finishedAt - entry.startedAt;
      entry.status = status || (upstreamStatus && upstreamStatus >= 400 ? 'error' : 'ok');
      if (upstreamStatus !== null && upstreamStatus !== undefined) entry.upstreamStatus = upstreamStatus;
      if (error) entry.error = clip(error, 2000);
      if (target) entry.target = String(target);
    },

    /** 元数据列表（新→旧），不含请求/响应正文。 */
    list({ limit = 50 } = {}) {
      evict();
      const size = Math.min(Math.max(1, Number(limit) || 50), maxEntries);
      const all = [...entries.values()].reverse();
      return all.slice(0, size).map((entry) => ({
        id: entry.id,
        startedAt: entry.startedAt,
        path: entry.path,
        model: entry.model,
        target: entry.target,
        wireApi: entry.wireApi,
        status: entry.status,
        upstreamStatus: entry.upstreamStatus,
        error: entry.error,
        elapsedMs: entry.elapsedMs,
        requestBodyBytes: entry.requestBody.length,
        responseChars: entry.responseText.length,
      }));
    },

    /** 单条全量详情。 */
    get(id) {
      evict();
      return entries.get(String(id)) || null;
    },

    get size() { return entries.size; },
  };
}
