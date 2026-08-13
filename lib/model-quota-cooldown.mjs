const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 256;
const MAX_KEY_CHARS = 512;

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
    return Number.isFinite(seconds) && seconds > 0 ? now + Math.ceil(seconds * 1_000) : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function parsedQuotaError(bodyText) {
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

function isExplicitLongQuota(status, bodyText) {
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

function retryAtFromBody(bodyText, now) {
  const error = parsedQuotaError(bodyText).error;
  if (!error) return null;
  for (const field of ['retry_after_seconds', 'retryAfterSeconds']) {
    const seconds = Number(error[field]);
    if (Number.isFinite(seconds) && seconds > 0) return now + Math.ceil(seconds * 1_000);
  }
  for (const field of ['reset_at', 'retry_at', 'resetAt', 'retryAt']) {
    const value = error[field];
    const parsed = typeof value === 'number'
      ? (value < 10_000_000_000 ? value * 1_000 : value)
      : Date.parse(String(value || ''));
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  return null;
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
