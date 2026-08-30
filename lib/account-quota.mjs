// ---------- ChatGPT 订阅账号真实额度（Codex 额度池响应头捕获） ----------
// Codex 后端没有独立的配额查询端点（实测 404）：额度以响应头随每次
// /backend-api/codex/responses 返回（与 Codex CLI 的 parse_default_rate_limit 同源）：
//   x-codex-primary-used-percent / -window-minutes / -reset-at   （5 小时滚动窗口）
//   x-codex-secondary-used-percent / -window-minutes / -reset-at （周窗口）
// reset-at 为 unix 秒。路由在官方通道响应处捕获并挂到账号 metadata，订阅页展示。

function windowFromHeaders(headers, prefix) {
  const usedRaw = headers[`${prefix}-used-percent`];
  const windowRaw = headers[`${prefix}-window-minutes`];
  const resetRaw = headers[`${prefix}-reset-at`];
  const usedPercent = Number(usedRaw);
  const resetsSec = Number(resetRaw);
  if (!Number.isFinite(usedPercent) && !Number.isFinite(resetsSec)) return null;
  return {
    windowMinutes: Number(windowRaw) || 0,
    usedPercent: Number.isFinite(usedPercent) ? Math.max(0, Math.min(100, usedPercent)) : null,
    resetsAt: Number.isFinite(resetsSec) && resetsSec > 0 ? resetsSec * 1000 : null,
  };
}

/** 从上游响应头解析 5h/周额度；无任何额度头返回 null。 */
export function parseCodexRateLimitHeaders(headers = {}) {
  const fiveHour = windowFromHeaders(headers, 'x-codex-primary');
  const weekly = windowFromHeaders(headers, 'x-codex-secondary');
  if (!fiveHour && !weekly) return null;
  return {
    fiveHour,
    weekly,
    planType: String(headers['x-codex-plan-type'] || ''),
    activeLimit: String(headers['x-codex-active-limit'] || ''),
    creditsBalance: String(headers['x-codex-credits-balance'] || ''),
  };
}
