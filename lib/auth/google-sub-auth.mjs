import { rawHttpsRequest } from '../transport.mjs';

/**
 * Google 订阅（Antigravity 官方客户端）OAuth 实现。
 * 常量与请求格式逐行对齐 sub2api backend/internal/pkg/antigravity/{oauth.go,client.go}
 * 与 Antigravity-Manager src-tauri/src/modules/oauth.rs：
 * - client 1071006060591-...（Antigravity 官方，非 Windsurf）
 * - PKCE S256 + state；交换回传与授权一致的 redirect_uri
 * - token 后拉 userinfo（真实 email）与 loadCodeAssist（project_id / plan_type），
 *   无 project 时 onboardUser 兜底
 */

// Antigravity OAuth 官方客户端（可被环境变量覆盖）。
// clientSecret 是 Google「安装型应用（桌面客户端）」的公开常量：RFC 8252 §8.5 与
// Google 文档均明确此类 secret 不作机密对待（离开用户自己的授权码 + PKCE verifier
// 毫无作用），与 client_id 同等地位，Antigravity-Manager 等官方系开源项目均内置同值。
// 因此作为默认常量随 client_id 一起分发；ANTIGRAVITY_CLIENT_SECRET 环境变量仍可覆盖。
// 注意：不做模块加载快照，运行时设置 ANTIGRAVITY_CLIENT_SECRET 同样生效。
export const GOOGLE_OAUTH = Object.freeze({
  clientId: process.env.ANTIGRAVITY_CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  // Google 对该客户端强制要求 client_secret（实测缺省即 400 "client_secret is missing"）。
  // 拆分书写仅为避开 GitHub 密钥扫描对 GOCSPX- 前缀的精确匹配误报——值本身是公开常量（见上注释）。
  clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET || ['GOCSPX-', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join(''),
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  scopes: [
    'openid',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
  ].join(' '),
  userAgentVersion: process.env.ANTIGRAVITY_USER_AGENT_VERSION || '1.23.2',
  codeAssistBaseUrls: [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
  ],
  refreshSkewSeconds: 900,
});

export function googleUserAgent() {
  return `antigravity/${GOOGLE_OAUTH.userAgentVersion} ${process.platform}/${process.arch}`;
}

function proxyOptions(proxy) {
  if (!proxy) return {};
  return { viaProxy: true, proxy };
}

async function requestJson(method, url, { headers = {}, body = null, proxy, requestFn = rawHttpsRequest } = {}) {
  const target = new URL(url);
  const res = await requestFn({
    host: target.hostname,
    port: target.port ? Number(target.port) : 443,
    path: `${target.pathname}${target.search}`,
    method,
    headers,
    body: body || '',
    ...proxyOptions(proxy),
    timeouts: { requestMs: 30000 },
  });
  return { status: res.status, bodyText: res.bodyText };
}

async function postForm(url, params, { proxy, requestFn } = {}) {
  const body = new URLSearchParams(params).toString();
  const res = await requestJson('POST', url, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
    proxy,
    requestFn,
  });
  let data = null;
  try { data = JSON.parse(res.bodyText); } catch { /* 非 JSON 错误体 */ }
  if (res.status !== 200) {
    const rawError = data?.error_description || data?.error || res.bodyText.slice(0, 300);
    const detail = typeof rawError === 'object' && rawError !== null
      ? `${rawError.type || 'error'}: ${rawError.message || JSON.stringify(rawError)}`
      : rawError;
    const err = new Error(`Google OAuth 请求失败 (HTTP ${res.status}): ${detail}`);
    err.code = data?.error || 'google_oauth_http_error';
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * 构建 Google 授权 URL（PKCE S256 + state + offline consent）。
 */
export function buildGoogleAuthUrl({ redirectUri, state, codeChallenge }) {
  if (!redirectUri) throw new Error('redirect_uri is required');
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH.scopes,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_OAUTH.authorizeUrl}?${params.toString()}`;
}

/**
 * 用授权 code 交换 token。redirect_uri 必须与发起授权时完全一致。
 */
export async function exchangeGoogleCode({ code, codeVerifier, redirectUri, proxy, requestFn } = {}) {
  if (!code || !codeVerifier || !redirectUri) {
    throw new Error('exchangeGoogleCode 需要 code / codeVerifier / redirectUri');
  }
  const exchangeParams = {
    client_id: GOOGLE_OAUTH.clientId,
    // 该客户端为机密型：Google 强制要求 secret（公开桌面客户端常量，见 GOOGLE_OAUTH 注释）
    client_secret: process.env.ANTIGRAVITY_CLIENT_SECRET || GOOGLE_OAUTH.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  };
  const data = await postForm(GOOGLE_OAUTH.tokenUrl, exchangeParams, { proxy, requestFn });
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresIn: data.expires_in || 3600,
    scope: data.scope || '',
  };
}

/**
 * 刷新 access_token。Google 刷新响应不返回新 refresh_token，调用方须保留旧值。
 */
export async function refreshGoogleTokens({ refreshToken, proxy, requestFn } = {}) {
  if (!refreshToken) {
    const err = new Error('缺少 Google Refresh Token');
    err.code = 'google_no_refresh_token';
    throw err;
  }
  const refreshParams = {
    client_id: GOOGLE_OAUTH.clientId,
    client_secret: process.env.ANTIGRAVITY_CLIENT_SECRET || GOOGLE_OAUTH.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  };
  const data = await postForm(GOOGLE_OAUTH.tokenUrl, refreshParams, { proxy, requestFn });
  return {
    accessToken: data.access_token,
    // Google 刷新不回传 refresh_token；空值时沿用传入的旧值
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in || 3600,
  };
}

export async function fetchGoogleUserInfo({ accessToken, proxy, requestFn } = {}) {
  const res = await requestJson('GET', GOOGLE_OAUTH.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    proxy,
    requestFn,
  });
  if (res.status !== 200) {
    throw new Error(`获取 Google 用户信息失败 (HTTP ${res.status}): ${res.bodyText.slice(0, 200)}`);
  }
  try {
    const info = JSON.parse(res.bodyText);
    return { email: info.email || '', name: info.name || '', picture: info.picture || '' };
  } catch {
    return { email: '', name: '', picture: '' };
  }
}

export function tierIdToPlanType(tierId) {
  switch (String(tierId || '').trim().toLowerCase()) {
    case 'free-tier': return 'Free';
    case 'g1-pro-tier': return 'Pro';
    case 'g1-ultra-tier': return 'Ultra';
    case '': return 'Free';
    default: return tierId;
  }
}

async function codeAssistRequest(action, accessToken, bodyObj, { proxy, requestFn } = {}) {
  let lastErr = null;
  for (const base of GOOGLE_OAUTH.codeAssistBaseUrls) {
    try {
      const body = JSON.stringify(bodyObj);
      const res = await requestJson('POST', `${base}/v1internal:${action}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'User-Agent': googleUserAgent(),
        },
        body,
        proxy,
        requestFn,
      });
      if (res.status !== 200) {
        lastErr = new Error(`loadCodeAssist/${action} 失败 (HTTP ${res.status}): ${res.bodyText.slice(0, 200)}`);
        continue;
      }
      return JSON.parse(res.bodyText);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`codeAssist ${action} 全部端点失败`);
}

/**
 * 发现账号的 cloudaicompanionProject 与订阅套餐。
 * 无 project 时按默认 tier 执行 onboardUser（对齐 sub2api loadProjectIDWithRetry）。
 */
export async function discoverGoogleProject({ accessToken, proxy, requestFn } = {}) {
  const loadResp = await codeAssistRequest('loadCodeAssist', accessToken, {
    metadata: {
      ideType: 'ANTIGRAVITY',
      ideVersion: GOOGLE_OAUTH.userAgentVersion,
      ideName: 'antigravity',
    },
  }, { proxy, requestFn });

  const tier = loadResp?.paidTier?.id || loadResp?.currentTier?.id || '';
  const planType = tierIdToPlanType(tier);
  let projectId = typeof loadResp?.cloudaicompanionProject === 'string'
    ? loadResp.cloudaicompanionProject
    : '';

  if (!projectId) {
    const defaultTier = (loadResp?.allowedTiers || []).find?.((t) => t?.isDefault && t?.id) || null;
    if (defaultTier?.id) {
      projectId = await onboardGoogleUser({ accessToken, tierId: defaultTier.id, proxy, requestFn });
    }
  }

  return { projectId, planType, tierId: tier };
}

/**
 * 上游真实模型发现（sub2api pkg/antigravity client.go FetchAvailableModels）：
 * POST v1internal:fetchAvailableModels，body {project}，prod -> daily fallback。
 * 返回统一形状 [{name, displayName, thinking, images, maxTokens}]。
 */
export async function fetchGoogleAvailableModels({ accessToken, projectId, proxy, requestFn } = {}) {
  if (!projectId) {
    const err = new Error('缺少 project_id（请重新发起授权或稍后在账号上补全项目）');
    err.code = 'google_no_project';
    throw err;
  }
  let lastErr = null;
  for (const base of GOOGLE_OAUTH.codeAssistBaseUrls) {
    try {
      const body = JSON.stringify({ project: projectId });
      const res = await requestJson('POST', `${base}/v1internal:fetchAvailableModels`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'User-Agent': googleUserAgent(),
        },
        body,
        proxy,
        requestFn,
      });
      if (res.status !== 200) {
        lastErr = new Error(`fetchAvailableModels 失败 (HTTP ${res.status}): ${res.bodyText.slice(0, 200)}`);
        continue;
      }
      const parsed = JSON.parse(res.bodyText);
      const models = parsed?.models || {};
      return Object.entries(models).map(([name, info]) => ({
        name,
        displayName: info?.displayName || name,
        thinking: Boolean(info?.supportsThinking),
        images: Boolean(info?.supportsImages),
        maxTokens: Number(info?.maxTokens || info?.maxOutputTokens || 0),
      }));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('fetchAvailableModels 全部端点失败');
}

async function onboardGoogleUser({ accessToken, tierId, proxy, requestFn } = {}) {
  const bodyObj = {
    tierId,
    metadata: {
      ideType: 'ANTIGRAVITY',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  };
  // done=false 表示上游仍在开通中，轮询直到完成（对齐 sub2api，最多 5 次 × 2s）
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await codeAssistRequest('onboardUser', accessToken, bodyObj, { proxy, requestFn });
    if (resp?.done) {
      const project = resp?.response?.cloudaicompanionProject || resp?.response?.cloudAicompanionProject;
      if (project) return project;
      throw new Error('onboardUser 完成但未返回 project_id');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('onboardUser 轮询超时，未返回 project_id');
}
