import { rawHttpsRequest } from '../transport.mjs';

/**
 * Claude 订阅（Claude Code 官方客户端）OAuth 实现。
 * 常量与请求格式对齐 sub2api backend/internal/pkg/oauth/oauth.go：
 * - client 9d1c250a-e61b-44d9-88ed-5944d1962f5e
 * - authorize claude.com/cai/oauth/authorize（带 code=true → 浏览器展示一次性 code）
 * - token platform.claude.com/v1/oauth/token，响应自带 organization.uuid 与 account.email_address
 * - Anthropic redirect 白名单不含 localhost，因此采用「复制授权链接 + 粘贴 code」半自动模式
 *   （与 sub2api 的 Antigravity 授权交互一致）
 *
 * 已移除旧的 claude.ai 网页 sessionKey 路径：claude.ai 网页接口受 Cloudflare
 * 浏览器指纹校验保护，服务端直连必失败。
 */

export const CLAUDE_OAUTH = Object.freeze({
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scopes: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
});

function proxyOptions(proxy) {
  if (!proxy) return {};
  return { viaProxy: true, proxy };
}

async function postForm(url, params, { proxy, requestFn = rawHttpsRequest } = {}) {
  const body = new URLSearchParams(params).toString();
  const target = new URL(url);
  const res = await (requestFn || rawHttpsRequest)({
    host: target.hostname,
    port: 443,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
    ...proxyOptions(proxy),
    timeouts: { requestMs: 30000 },
  });
  let data = null;
  try { data = JSON.parse(res.bodyText); } catch { /* 非 JSON 错误体 */ }
  if (res.status !== 200) {
    const rawError = data?.error_description || data?.error || res.bodyText.slice(0, 300);
    const detail = typeof rawError === 'object' && rawError !== null
      ? `${rawError.type || 'error'}: ${rawError.message || JSON.stringify(rawError)}`
      : rawError;
    const err = new Error(`Claude OAuth 请求失败 (HTTP ${res.status}): ${detail}`);
    err.code = data?.error || 'claude_oauth_http_error';
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * 构建 Claude 授权 URL。code=true 让浏览器在授权后展示一次性 code 供复制。
 */
export function buildClaudeAuthUrl({ state, codeChallenge }) {
  if (!state || !codeChallenge) throw new Error('buildClaudeAuthUrl 需要 state / codeChallenge');
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_OAUTH.clientId,
    response_type: 'code',
    redirect_uri: CLAUDE_OAUTH.redirectUri,
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  // sub2api 以 '+' 编码 scope 空格，保持一致避免上游兼容性问题
  const query = params.toString().replace(/scope=[^&]+/, (m) => m.replace(/%20/g, '+'));
  return `${CLAUDE_OAUTH.authorizeUrl}?${query}`;
}

export async function exchangeClaudeCode({ code, codeVerifier, proxy, requestFn } = {}) {
  if (!code || !codeVerifier) throw new Error('exchangeClaudeCode 需要 code / codeVerifier');
  const data = await postForm(CLAUDE_OAUTH.tokenUrl, {
    grant_type: 'authorization_code',
    client_id: CLAUDE_OAUTH.clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: CLAUDE_OAUTH.redirectUri,
  }, { proxy, requestFn });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresIn: data.expires_in || 3600,
    tokenType: data.token_type || 'Bearer',
    organizationUuid: data?.organization?.uuid || '',
    accountUuid: data?.account?.uuid || '',
    email: data?.account?.email_address || '',
  };
}

export async function refreshClaudeTokens({ refreshToken, proxy, requestFn } = {}) {
  if (!refreshToken) {
    const err = new Error('缺少 Claude Refresh Token');
    err.code = 'claude_no_refresh_token';
    throw err;
  }
  const data = await postForm(CLAUDE_OAUTH.tokenUrl, {
    grant_type: 'refresh_token',
    client_id: CLAUDE_OAUTH.clientId,
    refresh_token: refreshToken,
  }, { proxy, requestFn });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 3600,
    organizationUuid: data?.organization?.uuid || '',
    accountUuid: data?.account?.uuid || '',
    email: data?.account?.email_address || '',
  };
}

// Claude Code 客户端伪装头与 OAuth beta（对齐 sub2api pkg/claude/constants.go）
export const CLAUDE_CLI_HEADERS = Object.freeze({
  'User-Agent': 'claude-cli/2.1.220 (external, cli)',
  'X-Stainless-Lang': 'js',
  'X-Stainless-Package-Version': '0.94.0',
  'X-Stainless-OS': 'Linux',
  'X-Stainless-Arch': 'arm64',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Runtime-Version': 'v24.3.0',
  'X-Stainless-Retry-Count': '0',
  'X-Stainless-Timeout': '600',
});
export const CLAUDE_OAUTH_BETA = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

/**
 * 上游真实模型发现：GET api.anthropic.com/v1/models（OAuth Bearer + claude-code beta）。
 * 返回统一形状 [{name, displayName}]。
 */
export async function fetchClaudeModels({ accessToken, proxy, requestFn } = {}) {
  if (!accessToken) {
    const err = new Error('缺少 Claude access_token');
    err.code = 'claude_no_access_token';
    throw err;
  }
  const target = new URL('https://api.anthropic.com/v1/models?limit=100');
  const res = await (requestFn || rawHttpsRequest)({
    host: target.hostname,
    port: 443,
    path: `${target.pathname}${target.search}`,
    method: 'GET',
    headers: {
      ...CLAUDE_CLI_HEADERS,
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': CLAUDE_OAUTH_BETA,
      Authorization: `Bearer ${accessToken}`,
    },
    ...proxyOptions(proxy),
    timeouts: { requestMs: 30000 },
  });
  if (res.status !== 200) {
    const err = new Error(`Claude 模型列表拉取失败 (HTTP ${res.status}): ${res.bodyText.slice(0, 200)}`);
    err.code = 'claude_models_failed';
    err.status = res.status;
    throw err;
  }
  const parsed = JSON.parse(res.bodyText);
  const data = Array.isArray(parsed?.data) ? parsed.data : [];
  return data.map((m) => ({ name: m.id, displayName: m.display_name || m.id }));
}
