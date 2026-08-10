import { createHash } from 'node:crypto';

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
const AFFINITY_KEY_DOMAINS = new Set([
  'response', 'prompt', 'conversation', 'header', 'model', 'response-scope',
]);

function matches(target, model) {
  // 防御带 g/y 标志的正则：每次匹配前清掉 lastIndex，避免候选结果随调用次数漂移。
  if (!(target?.match instanceof RegExp)) return false;
  target.match.lastIndex = 0;
  return target.match.test(model);
}

function preferredScopeKey(keys = []) {
  return keys.find((key) => key.startsWith('conversation:') || key.startsWith('header:'))
    || keys.find((key) => key.startsWith('prompt:'))
    || null;
}

function scopedResponseKey(responseKey, scopeKey) {
  return `response-scope:${JSON.stringify([responseKey, scopeKey])}`;
}

function internalAffinityKey(key) {
  const rawKey = String(key);
  const separator = rawKey.indexOf(':');
  const candidateDomain = separator > 0 ? rawKey.slice(0, separator) : '';
  const domain = AFFINITY_KEY_DOMAINS.has(candidateDomain) ? candidateDomain : 'raw';
  const value = domain === 'raw' ? rawKey : rawKey.slice(separator + 1);
  // Map 只保存固定长度摘要；固定类型域阻止相同值的不同亲和来源互相碰撞。
  const digest = createHash('sha256')
    .update('provider-affinity-v1\0')
    .update(domain)
    .update('\0')
    .update(value)
    .digest('hex');
  return `affinity:${digest}`;
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

export function requestAffinityKeys(body = {}, headers = {}, options = {}) {
  // 从强关联到弱关联排列；previous_response_id 命中时优先保持上一轮供应商。
  const keys = [];
  if (body.previous_response_id) keys.push(`response:${body.previous_response_id}`);
  if (body.prompt_cache_key) keys.push(`prompt:${body.prompt_cache_key}`);
  const conversation = body.metadata?.conversation_id || body.metadata?.session_id;
  if (conversation) keys.push(`conversation:${conversation}`);
  const headerSession = headers['x-codex-session-id'];
  if (headerSession) keys.push(`header:${headerSession}`);
  // 模型键会跨聊天共享，默认禁用；只为显式需要全局模型亲和的兼容场景开启。
  if (options.modelAffinity === true && body.model) keys.push(`model:${body.model}`);
  return [...new Set(keys)];
}

export class ProviderPool {
  constructor(targets, options = {}) {
    this.targets = Array.isArray(targets) ? targets : [];
    this.allowDefaultTarget = options.allowDefaultTarget === true;
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
    const internalKey = internalAffinityKey(key);
    const entry = this.affinity.get(internalKey);
    if (!entry) return null;
    this.affinity.delete(internalKey);
    this.affinity.set(internalKey, entry);
    return entry.target;
  }

  getResponseAffinity(responseKey, affinityKeys = []) {
    const scopeKey = preferredScopeKey(affinityKeys);
    if (scopeKey) {
      const scoped = this.getAffinity(scopedResponseKey(responseKey, scopeKey));
      if (scoped) {
        // scoped 状态仍活跃时同步刷新 base 标记，避免 LRU 先淘汰歧义证据却留下半套映射。
        this.getAffinity(responseKey);
        return scoped;
      }
      const internalResponseKey = internalAffinityKey(responseKey);
      const base = this.affinity.get(internalResponseKey);
      const requestedScopeIdentity = internalAffinityKey(scopeKey);
      if (base && !base.ambiguous && base.scopeIdentity
        && base.scopeIdentity !== requestedScopeIdentity) {
        // 首次跨任务引用也要立即变成可判定冲突，不能等错误响应写回后才建立歧义哨兵。
        this.affinity.delete(internalResponseKey);
        this.affinity.set(internalResponseKey, {
          target: null,
          ambiguous: true,
          expiresAt: base.expiresAt,
        });
        return null;
      }
    }
    return this.getAffinity(responseKey);
  }

  isAffinityAmbiguous(key) {
    this.pruneExpired();
    return this.affinity.get(internalAffinityKey(key))?.ambiguous === true;
  }

  hasAffinity(key) {
    return !!this.getAffinity(key);
  }

  candidates(model, affinityKeys = [], preferredTarget = null) {
    // 未知或空模型默认拒绝选路，避免把任务内容误发到首个供应商。
    const matched = model ? this.targets.filter((target) => matches(target, model)) : [];
    const candidates = matched.length
      ? matched
      : (this.allowDefaultTarget ? this.targets.slice(0, 1) : []);
    let sticky = candidates.includes(preferredTarget) ? preferredTarget : null;
    if (!sticky) {
      for (const key of affinityKeys) {
        sticky = this.getAffinity(key);
        if (sticky && candidates.includes(sticky)) break;
        sticky = null;
      }
    }
    return sticky ? [sticky, ...candidates.filter((target) => target !== sticky)] : candidates;
  }

  remember(affinityKeys, target, aliases = []) {
    // aliases 用来把新生成的 response.id 也绑定到同一供应商，供下一轮恢复粘性。
    this.pruneExpired();
    const expiresAt = this.now() + this.ttlMs;
    for (const key of affinityKeys.filter(Boolean)) {
      const internalKey = internalAffinityKey(key);
      this.affinity.delete(internalKey);
      this.affinity.set(internalKey, { target, expiresAt });
    }
    const scopeKey = preferredScopeKey(affinityKeys);
    const scopeIdentity = scopeKey ? internalAffinityKey(scopeKey) : null;
    for (const alias of aliases.filter(Boolean)) {
      const internalAlias = internalAffinityKey(alias);
      const existing = this.affinity.get(internalAlias);
      if (scopeKey) {
        const scopedKey = internalAffinityKey(scopedResponseKey(alias, scopeKey));
        this.affinity.delete(scopedKey);
        this.affinity.set(scopedKey, { target, expiresAt });
      }
      // base 放在 scoped 之后，使歧义标记成为该 response 组最后淘汰的安全哨兵。
      this.affinity.delete(internalAlias);
      const changedScope = existing && !existing.ambiguous
        && (existing.scopeIdentity ?? null) !== scopeIdentity;
      const unscopedDuplicate = existing && !existing.ambiguous && scopeIdentity === null;
      if (existing?.ambiguous
        || (existing?.target && existing.target !== target)
        || changedScope
        || unscopedDuplicate) {
        this.affinity.set(internalAlias, { target: null, ambiguous: true, expiresAt });
      } else {
        this.affinity.set(internalAlias, { target, scopeIdentity, expiresAt });
      }
    }
    while (this.affinity.size > this.maxEntries) {
      this.affinity.delete(this.affinity.keys().next().value);
    }
  }
}
