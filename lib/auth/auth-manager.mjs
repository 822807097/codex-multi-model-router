// ChatGPT 订阅套餐 → 可用 Codex 模型推断（对齐 sub2api：按账号订阅等级过滤模型，
// 避免把 gpt-5.6-sol 这类高阶模型发到免费/低档账号上被上游 400 拒绝）。
// 依据实测（2026-08-18）：pro 账号可用 gpt-5.6-sol，免费/基础账号会被上游拒
// （"not supported when using Codex with a ChatGPT account"）。
// 精确优先级：账号 metadata.models 显式清单 > 套餐推断 > 全部放行。
const CODEX_MODEL_TIERS = Object.freeze({
  // 各套餐可用的 Codex 模型（高阶套餐为低阶超集）。
  // free 清单为 2026-08-18 实测：luna/terra/gpt-5.5/gpt-5.4-mini/auto-review 可用；
  // sol/gpt-5.4/gpt-5.3-codex-spark 被上游 400 拒绝（"not supported when using Codex with a ChatGPT account"）。
  free: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini', 'codex-auto-review'],
  plus: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'codex-auto-review'],
  pro: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'codex-auto-review'],
  team: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'codex-auto-review'],
  enterprise: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'codex-auto-review'],
});
const CODEX_TIER_ORDER = Object.freeze(['free', 'plus', 'pro', 'team', 'enterprise']);

function normalizePlanType(value) {
  const plan = String(value || '').trim().toLowerCase();
  if (!plan) return '';
  if (CODEX_MODEL_TIERS[plan]) return plan;
  // ChatGPT 套餐可能返回变体（如 "chatgpt_plus"、"pro-monthly"），归一化前缀
  for (const tier of CODEX_TIER_ORDER) {
    if (plan.includes(tier)) return tier;
  }
  return '';
}

/** 账号是否支持指定 Codex 模型：显式 models 清单优先，否则按套餐推断。 */
export function accountSupportsModel(account, model) {
  if (!account || !model) return true;
  const explicit = Array.isArray(account.metadata?.models) && account.metadata.models.length > 0;
  if (explicit) return account.metadata.models.includes(model);
  const tier = normalizePlanType(account.metadata?.planType || account.planType);
  if (!tier) return true; // 未知套餐不拦截，让上游决定
  const allowed = CODEX_MODEL_TIERS[tier];
  return allowed.includes(model);
}

export function createAuthManager(options = {}) {
  const {
    now = () => Date.now(),
    defaultCooldownMs = 60000,
    // 账号状态变更持久化回调（冷却/恢复时间等），重启后不复活已用尽账号
    onAccountPersist = null,
  } = options;
  // 官方周额度窗口（2026 起取消 5 小时配额）：滚动 7 天本地统计
  const WEEK_MS = 7 * 24 * 3600 * 1000;

  // key: accountId -> Account
  const accounts = new Map();
  // key: provider -> index for round-robin
  const rrPointers = new Map();
  // single-flight lock: key -> Promise
  const activeRefreshes = new Map();
  // provider -> refresherFn({ account, authManager })
  const refreshers = new Map();
  // 刷新成功回调（持久化新 token 到 vault/db，重启不丢）
  const refreshListeners = [];

  function addAccount(accountData) {
    if (!accountData || !accountData.id || !accountData.provider) {
      throw new Error('accountData 必须包含 id 与 provider');
    }
    const account = {
      id: accountData.id,
      provider: accountData.provider.toLowerCase(),
      alias: accountData.alias || accountData.id,
      email: accountData.email || '',
      status: accountData.status || 'active',
      cooldownUntil: accountData.cooldownUntil || 0,
      credentials: accountData.credentials || {},
      expiresAt: accountData.expiresAt || 0,
      proxy: {
        enabled: accountData.proxy?.enabled ?? true,
        url: accountData.proxy?.url || '',
      },
      quota: {
        used: accountData.quota?.used || 0,
        limit: accountData.quota?.limit || 100,
        // 官方 2026 起取消 5 小时额度，统一为周额度（滚动 7 天本地统计）
        period: 'weekly',
        resetsAt: accountData.quota?.resetsAt || (now() + WEEK_MS),
      },
      metadata: accountData.metadata || {},
    };
    accounts.set(account.id, account);
    return account;
  }

  function updateAccount(id, partial) {
    const acc = accounts.get(id);
    if (!acc) return null;
    if (partial.alias !== undefined) acc.alias = partial.alias;
    if (partial.email !== undefined) acc.email = partial.email;
    if (partial.status !== undefined) acc.status = partial.status;
    if (partial.credentials !== undefined) acc.credentials = { ...acc.credentials, ...partial.credentials };
    if (partial.expiresAt !== undefined) acc.expiresAt = partial.expiresAt;
    if (partial.proxy !== undefined) acc.proxy = { ...acc.proxy, ...partial.proxy };
    if (partial.quota !== undefined) acc.quota = { ...acc.quota, ...partial.quota };
    if (partial.metadata !== undefined) acc.metadata = { ...acc.metadata, ...partial.metadata };
    return sanitizeAccount(acc);
  }

  function recordQuotaUsage(id, count = 1) {
    const acc = accounts.get(id);
    if (!acc) return;
    const currentTime = now();
    if (currentTime > acc.quota.resetsAt) {
      acc.quota.used = 0;
      acc.quota.resetsAt = currentTime + WEEK_MS;
    }
    acc.quota.used += count;
  }

  function getAccount(id) {
    return accounts.get(id) || null;
  }

  // 按 metadata 字段精确匹配账号（如 chatgptAccountId → 路由请求计数用）
  function findByMetadataField(field, value) {
    if (!field || value === undefined || value === null) return null;
    for (const acc of accounts.values()) {
      if (acc.metadata?.[field] === value) return acc;
    }
    return null;
  }

  function removeAccount(id) {
    return accounts.delete(id);
  }

  function listAccounts(providerFilterOrOptions = null) {
    const asOptions = providerFilterOrOptions !== null && typeof providerFilterOrOptions === 'object';
    const sanitized = asOptions ? providerFilterOrOptions.sanitized !== false : true;
    const providerFilter = asOptions ? providerFilterOrOptions.provider : providerFilterOrOptions;
    const currentTime = now();
    const result = [];
    for (const acc of accounts.values()) {
      if (acc.status === 'cooldown' && currentTime >= acc.cooldownUntil) {
        acc.status = 'active';
        acc.cooldownUntil = 0;
      }
      if (currentTime > acc.quota.resetsAt) {
        acc.quota.used = 0;
        acc.quota.resetsAt = currentTime + WEEK_MS;
      }
      if (!providerFilter || acc.provider === providerFilter.toLowerCase()) {
        result.push(sanitized ? sanitizeAccount(acc) : acc);
      }
    }
    return result;
  }

  function markCooldown(id, durationOrOptions = defaultCooldownMs) {
    const acc = accounts.get(id);
    if (!acc) return false;
    const options = typeof durationOrOptions === 'number'
      ? { cooldownMs: durationOrOptions }
      : (durationOrOptions || {});
    acc.status = 'cooldown';
    // 支持绝对恢复时间（如上游 429 返回的周额度重试点）：until 优先于 cooldownMs
    const until = Number(options.until);
    acc.cooldownUntil = Number.isFinite(until) && until > 0
      ? until
      : (now() + (Number(options.cooldownMs) || defaultCooldownMs));
    // 同步 quota 恢复时间：管理页据此展示「周额度于 <时间> 恢复」
    if (options.setResetsAt) acc.quota.resetsAt = acc.cooldownUntil;
    if (options.reason) acc.metadata.lastCooldownReason = String(options.reason).slice(0, 200);
    persistAccountState(acc);
    return true;
  }

  function persistAccountState(acc) {
    if (typeof onAccountPersist !== 'function') return;
    try {
      onAccountPersist({
        id: acc.id,
        provider: acc.provider,
        email: acc.email,
        alias: acc.alias,
        status: acc.status,
        cooldownUntil: acc.cooldownUntil,
        quota: { ...acc.quota },
        metadata: { ...acc.metadata },
      });
    } catch { /* 持久化失败不影响主流程 */ }
  }

  function acquireAccount(providerOrOptions) {
    const p = (typeof providerOrOptions === 'string'
      ? providerOrOptions
      : providerOrOptions?.provider || ''
    ).toLowerCase();
    // 可选按模型过滤：只挑支持该模型的账号（sub2api 式套餐匹配）
    const model = (typeof providerOrOptions === 'object' && providerOrOptions?.model)
      ? String(providerOrOptions.model)
      : '';
    const activeList = [];
    const currentTime = now();

    for (const acc of accounts.values()) {
      if (acc.provider !== p) continue;
      if (model && !accountSupportsModel(acc, model)) continue;
      if (acc.status === 'cooldown') {
        if (currentTime >= acc.cooldownUntil) {
          acc.status = 'active';
          acc.cooldownUntil = 0;
          activeList.push(acc);
        }
      } else if (acc.status === 'active') {
        activeList.push(acc);
      }
    }

    if (activeList.length === 0) return null;

    const currentPtr = rrPointers.get(p) || 0;
    const selected = activeList[currentPtr % activeList.length];
    rrPointers.set(p, (currentPtr + 1) % activeList.length);
    return selected;
  }

  async function getValidCredentials(accountId) {
    const acc = accounts.get(accountId);
    if (!acc) throw new Error(`账号不存在: ${accountId}`);

    const currentTime = now();
    if (acc.expiresAt && acc.expiresAt > currentTime + 30000) {
      return acc.credentials;
    }

    const refresher = refreshers.get(acc.provider);
    if (!refresher) {
      return acc.credentials;
    }

    const refreshKey = `${acc.provider}:${acc.id}`;
    if (activeRefreshes.has(refreshKey)) {
      return activeRefreshes.get(refreshKey);
    }

    const refreshPromise = (async () => {
      try {
        const refreshed = await refresher({ account: acc });
        if (refreshed) {
          const newCreds = refreshed.credentials || refreshed;
          acc.credentials = { ...acc.credentials, ...newCreds };
          if (refreshed.expiresAt) acc.expiresAt = refreshed.expiresAt;
          acc.status = 'active';
          // 新 token 通知持久化监听器（vault/db），重启后凭据不丢；
          // 持久化失败只告警，不影响本次请求继续使用内存凭据。
          for (const listener of refreshListeners) {
            try {
              listener(acc.id, { ...acc.credentials }, acc.expiresAt);
            } catch { /* 持久化旁路 */ }
          }
        }
        return acc.credentials;
      } catch (err) {
        if (err.status === 429) {
          markCooldown(acc.id);
        }
        throw err;
      } finally {
        activeRefreshes.delete(refreshKey);
      }
    })();

    activeRefreshes.set(refreshKey, refreshPromise);
    return refreshPromise;
  }

  function registerRefresher(provider, refresherFn) {
    refreshers.set(provider.toLowerCase(), refresherFn);
  }

  // 注册刷新成功后的持久化监听器（vault/db 写入），多监听器按注册顺序执行。
  function onCredentialsRefreshed(listener) {
    if (typeof listener === 'function') refreshListeners.push(listener);
  }

  function sanitizeAccount(acc) {
    return {
      id: acc.id,
      provider: acc.provider,
      alias: acc.alias,
      email: acc.email,
      status: acc.status,
      cooldownUntil: acc.cooldownUntil,
      expiresAt: acc.expiresAt,
      proxy: { ...acc.proxy },
      quota: { ...acc.quota },
      metadata: { ...acc.metadata },
      hasCredentials: Object.keys(acc.credentials || {}).length > 0,
    };
  }

  return {
    addAccount,
    updateAccount,
    getAccount,
    removeAccount,
    listAccounts,
    markCooldown,
    recordQuotaUsage,
    acquireAccount,
    getValidCredentials,
    findByMetadataField,
    registerRefresher,
    onCredentialsRefreshed,
  };
}
