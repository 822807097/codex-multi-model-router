const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
});

function validPort(value) {
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export function isAllowedAdminHost(host, localPort) {
  const port = validPort(localPort);
  if (port === null || typeof host !== 'string') return false;
  const normalized = host.toLowerCase();
  return normalized === `127.0.0.1:${port}`
    || normalized === `localhost:${port}`
    || normalized === `[::1]:${port}`;
}

function sameOrigin(origin, host, localPort) {
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === ''
      && isAllowedAdminHost(parsed.host, localPort)
      && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function inspectAdminRequest({ host, origin, secFetchSite, localPort }) {
  if (!isAllowedAdminHost(host, localPort)) {
    return { allowed: false, status: 403, code: 'admin_host_forbidden' };
  }
  if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') {
    return { allowed: false, status: 403, code: 'admin_cross_site_forbidden' };
  }
  // 无 Origin 是本机 CLI/脚本的兼容路径；浏览器发出 Origin 时必须精确同源。
  if (origin === undefined) return { allowed: true };
  if (!sameOrigin(origin, host, localPort)) {
    return { allowed: false, status: 403, code: 'admin_cross_site_forbidden' };
  }
  return { allowed: true };
}

export function adminSecurityHeaders() {
  return { ...SECURITY_HEADERS };
}
