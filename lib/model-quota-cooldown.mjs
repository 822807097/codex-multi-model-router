const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;
const MAX_KEY_CHARS = 512;
// 冷却上限 8 天：覆盖官方周额度（最长 ~7 天）同时钳制异常大的 Retry-After /
// reset_at 值（曾有无上限钳制时一个头就能把密钥冷一年且落库存活重启）。
export const MAX_QUOTA_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000;

/** 钳制额度恢复时间戳：非有限值或已过期（无意义，改走默认冷却）返回 null，
 *  超过 now+上限 的按上限收口。 */
export function clampQuotaResetAt(timestamp, now = Date.now()) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return null;
  const base = Number.isFinite(now) ? now : Date.now();
  if (value <= base) return null;
  return Math.min(value, base + MAX_QUOTA_COOLDOWN_MS);
}

function normalizedKeyPart(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= MAX_KEY_CHARS ? text : null;
}

function quotaKey(target, model) {
  const safeTarget = normalizedKeyPart(target);
  const safeModel = normalizedKeyPart(model);
  return safeTarget && safeModel ? JSON.stringify([safeTarget, safeModel]) : null;
}

function headerValue(headers, wantedName) {
  for (const [name, value] of Object.entries(headers || {})) {
    if (name.toLowerCase() !== wantedName) continue;
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  }
  return '';
}

function retryAtFromHeaders(headers, now) {
  const value = headerValue(headers, 'retry-after');
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? clampQuotaResetAt(now + Math.ceil(seconds * 1_000), now) : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? clampQuotaResetAt(parsed, now) : null;
}

// 供 router-handler 透传层复用（导出，避免两处报文解析逻辑漂移）
export function parsedQuotaError(bodyText) {
  const snippet = bodyText.slice(0, 64 * 1024);
  try {
    const parsed = JSON.parse(snippet);
    const error = parsed?.error ?? parsed;
    if (!error || (typeof error !== 'object' && typeof error !== 'string')) return { text: '', error: null };
    if (typeof error === 'string') return { text: error, error: null };
    const text = ['code', 'type', 'name', 'message', 'detail', 'error_code', 'error_type']
      .map((field) => error[field])
      .filter((value) => typeof value === 'string')
      .join('\n');
    return { text, error };
  } catch {
    return { text: snippet, error: null };
  }
}

export function isExplicitLongQuota(status, bodyText) {
  if (Number(status) !== 429 || typeof bodyText !== 'string') return false;
  const normalized = parsedQuotaError(bodyText).text.toLowerCase();
  if (/\brate[_ -]?limit[_ -]?exceeded\b/.test(normalized)
    && !/\b(?:insufficient[_ -]?quota|billing[_ -]?(?:hard[_ -]?)?limit|plan[_ -]?quota)\b/.test(normalized)) {
    return false;
  }
  return /\bgousagelimiterror\b/.test(normalized)
    || /\b\d+[ -]hour usage limit reached\b/.test(normalized)
    || /\binsufficient[_ -]?quota\b/.test(normalized)
    || /\busage[_ -]?limit[_ -]?reached\b/.test(normalized)
    || /\bbilling[_ -]?(?:hard[_ -]?)?limit[_ -]?(?:reached|exceeded|exhausted)\b/.test(normalized)
    || /\bplan[_ -]?quota[_ -]?(?:reached|exceeded|exhausted)\b/.test(normalized)
    || /\b(?:monthly|daily|weekly|plan|account)\b[^\n]{0,80}\b(?:quota|allowance|spend limit)\b[^\n]{0,80}\b(?:reached|exceeded|exhausted)\b/.test(normalized);
}

// 百炼等上游把重置时间写在 message 文本里（"quota will reset at 08-21 11:36:00 UTC"），
// 结构化字段缺失时按文本兜底解析。
export function retryAtFromMessageText(bodyText, now) {
  const text = typeof bodyText === 'string' ? bodyText.slice(0, 64 * 1024) : '';
  const match = text.match(/\b(?:reset|resets|resume|renew)\w*\s+(?:at|on)\s+([^."'\n]{4,40}?(?:UTC|GMT|[+-]\d{2}:?\d{2}))/i);
  if (!match) return null;
  const raw = match[1].trim();
  const candidates = [
    raw,
    // "08-21 11:36:00 UTC"：补年份后 Date.parse 才能给出有效值
    `${new Date(now).getUTCFullYear()}-${raw}`,
  ];
  for (const candidate of candidates) {
    const parsed = Date.parse(candidate);
    if (!Number.isFinite(parsed)) continue;
    if (parsed > now) return clampQuotaResetAt(parsed, now);
    // "08-21 ... UTC" 补本年后落在过去 → 上游省略年份且实际是跨年重置时，
    // +366 天的近似值必然落在近未来（额度重置点不会远于两个月）。
    // 仅此窗口才按跨年解释；过期报文/解析噪声一律放弃，防止把陈旧重置时间
    // 升级成数天冷却。
    const nextYear = parsed + 366 * 86400 * 1000;
    if (nextYear > now && nextYear - now <= 62 * 86400 * 1000) {
      return clampQuotaResetAt(nextYear, now);
    }
  }
  return null;
}

function retryAtFromBody(bodyText, now) {
  const error = parsedQuotaError(bodyText).error;
  if (error) {
    for (const field of ['retry_after_seconds', 'retryAfterSeconds']) {
      const seconds = Number(error[field]);
      if (Number.isFinite(seconds) && seconds > 0) return clampQuotaResetAt(now + Math.ceil(seconds * 1_000), now);
    }
    for (const field of ['reset_at', 'retry_at', 'resetAt', 'retryAt']) {
      const value = error[field];
      const parsed = typeof value === 'number'
        ? (value < 10_000_000_000 ? value * 1_000 : value)
        : Date.parse(String(value || ''));
      if (Number.isFinite(parsed) && parsed > now) return clampQuotaResetAt(parsed, now);
    }
  }
  return retryAtFromMessageText(bodyText, now);
}

// 统一的额度恢复时间解析：头 → 结构化字段 → 错误体文本 → null。
// 供通道密钥池（key 级冷却）与模型级冷却共用，避免两处解析漂移。
export function resolveQuotaRetryAt({ headers = {}, bodyText = '', now = Date.now() } = {}) {
  const currentTime = now();
  return retryAtFromHeaders(headers, currentTime)
    || retryAtFromBody(bodyText, currentTime)
    || null;
}

function publicEntry(entry, now) {
  return {
    code: 'model_quota_cooldown',
    retryAt: entry.retryAt,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.retryAt - now) / 1_000)),
  };
}

export function createModelQuotaCooldownStore(options = {}) {
  const now = options.now || Date.now;
  const maxEntries = Math.max(1, Math.floor(Number(options.maxEntries) || DEFAULT_MAX_ENTRIES));
  const defaultCooldownMs = Math.max(1_000,
    Math.floor(Number(options.defaultCooldownMs) || DEFAULT_COOLDOWN_MS));
  const entries = new Map();

  function removeExpired(currentTime) {
    for (const [key, entry] of entries) {
      if (entry.retryAt <= currentTime) entries.delete(key);
    }
  }

  function get(target, model) {
    const key = quotaKey(target, model);
    if (!key) return null;
    const currentTime = now();
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.retryAt <= currentTime) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return publicEntry(entry, currentTime);
  }

  function observe({ target, model, status, headers = {}, bodyText = '' } = {}) {
    const key = quotaKey(target, model);
    if (!key || !isExplicitLongQuota(status, bodyText)) return null;
    const currentTime = now();
    removeExpired(currentTime);
    const retryAt = retryAtFromHeaders(headers, currentTime)
      || retryAtFromBody(bodyText, currentTime)
      || currentTime + defaultCooldownMs;
    const entry = { retryAt };
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return publicEntry(entry, currentTime);
  }

  return {
    get,
    observe,
    get size() { return entries.size; },
  };
}
