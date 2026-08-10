// ---------- ChatGPT 登录态并发合并 ----------

export function mergeRefreshResult(original, latest, refreshResult) {
  const originalRefresh = original?.tokens?.refresh_token;
  const latestRefresh = latest?.tokens?.refresh_token;

  // 网络等待期间桌面端已经轮换 token 时，以磁盘最新状态为准，禁止旧请求覆盖。
  if (latestRefresh !== originalRefresh) {
    return {
      shouldWrite: false,
      data: latest,
      auth: {
        token: latest.tokens?.access_token,
        accountId: latest.tokens?.account_id,
      },
    };
  }

  const data = structuredClone(latest || original || {});
  const tokens = { ...(data.tokens || {}) };
  tokens.access_token = refreshResult.access_token;
  if (refreshResult.refresh_token) tokens.refresh_token = refreshResult.refresh_token;
  if (refreshResult.id_token) tokens.id_token = refreshResult.id_token;
  data.tokens = tokens;
  data.last_refresh = new Date().toISOString();
  return {
    shouldWrite: true,
    data,
    auth: { token: tokens.access_token, accountId: tokens.account_id },
  };
}
