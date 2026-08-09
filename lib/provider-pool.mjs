// ---------- 供应商候选池与安全 failover 判定 ----------
// 这里只负责候选顺序和粘性状态，不执行网络请求，避免把重试策略绑死在传输层。
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

function matches(target, model) {
  // 防御带 g/y 标志的正则：每次匹配前清掉 lastIndex，避免候选结果随调用次数漂移。
  if (!(target?.match instanceof RegExp)) return false;
  target.match.lastIndex = 0;
  return target.match.test(model);
}

export function isRetryableProviderFailure(failure) {
  // 客户端主动取消和上下文超限切换备用目标没有意义；鉴权/请求错误（400/401/403）也必须原样暴露。
  // 可切换备用目标的范围共三类：连接类错误码、网络/传输类错误消息（超时、响应头前断连、DNS/TLS 等），
  // 以及 HTTP 408、429、5xx。429 属于限流而非请求错误，允许切换备用目标。
  if (failure?.name === 'AbortError') return false;
  const status = Number(failure?.status);
  if (status) return status === 408 || status === 429 || status >= 500;
  if (RETRYABLE_ERROR_CODES.has(failure?.code)) return true;
  const message = String(failure?.message || failure || '');
  if (/context|maximum (?:input )?tokens?|token limit/i.test(message)) return false;
  return /\b(?:connect|socket|network|dns|tls)\b|timed? out|closed before response header|hang up/i.test(message);
}

export function requestAffinityKeys(body = {}, headers = {}) {
  // 从强关联到弱关联排列；previous_response_id 命中时优先保持上一轮供应商。
  const keys = [];
  if (body.previous_response_id) keys.push(`response:${body.previous_response_id}`);
  if (body.prompt_cache_key) keys.push(`prompt:${body.prompt_cache_key}`);
  const conversation = body.metadata?.conversation_id || body.metadata?.session_id;
  if (conversation) keys.push(`conversation:${conversation}`);
  const headerSession = headers['x-codex-session-id'];
  if (headerSession) keys.push(`header:${headerSession}`);
  if (body.model) keys.push(`model:${body.model}`);
  return [...new Set(keys)];
}

export class ProviderPool {
  constructor(targets, options = {}) {
    this.targets = Array.isArray(targets) ? targets : [];
    this.maxEntries = Math.max(1, Number(options.maxEntries) || 2_048);
    this.ttlMs = Math.max(1, Number(options.ttlMs) || 24 * 60 * 60_000);
    this.now = options.now || Date.now;
    this.affinity = new Map();
  }

  pruneExpired() {
    // 粘性只保存在内存中，并通过 TTL 与 LRU 双重限制内存占用。
    const now = this.now();
    for (const [key, entry] of this.affinity) {
      if (entry.expiresAt <= now) this.affinity.delete(key);
    }
  }

  getAffinity(key) {
    this.pruneExpired();
    const entry = this.affinity.get(key);
    if (!entry) return null;
    this.affinity.delete(key);
    this.affinity.set(key, entry);
    return entry.target;
  }

  hasAffinity(key) {
    return !!this.getAffinity(key);
  }

  candidates(model, affinityKeys = []) {
    // 未匹配任何规则时保留旧行为：回退到配置中的第一个目标。
    const matched = this.targets.filter((target) => matches(target, model));
    const candidates = matched.length ? matched : this.targets.slice(0, 1);
    let sticky = null;
    for (const key of affinityKeys) {
      sticky = this.getAffinity(key);
      if (sticky && candidates.includes(sticky)) break;
      sticky = null;
    }
    return sticky ? [sticky, ...candidates.filter((target) => target !== sticky)] : candidates;
  }

  remember(affinityKeys, target, aliases = []) {
    // aliases 用来把新生成的 response.id 也绑定到同一供应商，供下一轮恢复粘性。
    const expiresAt = this.now() + this.ttlMs;
    for (const key of [...affinityKeys, ...aliases].filter(Boolean)) {
      this.affinity.delete(key);
      this.affinity.set(key, { target, expiresAt });
    }
    while (this.affinity.size > this.maxEntries) {
      this.affinity.delete(this.affinity.keys().next().value);
    }
  }
}
