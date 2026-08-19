import test from 'node:test';
import assert from 'node:assert/strict';

import { generateCodeVerifier, generateCodeChallenge } from '../lib/auth/oauth-core.mjs';
import {
  GOOGLE_OAUTH,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  refreshGoogleTokens,
  fetchGoogleUserInfo,
  discoverGoogleProject,
  fetchGoogleAvailableModels,
  tierIdToPlanType,
} from '../lib/auth/google-sub-auth.mjs';
import {
  OPENAI_OAUTH,
  buildOpenAiAuthUrl,
  exchangeOpenAiCode,
  refreshOpenAiTokens,
  decodeOpenAiIdToken,
} from '../lib/auth/openai-sub-auth.mjs';
import {
  CLAUDE_OAUTH,
  buildClaudeAuthUrl,
  exchangeClaudeCode,
  refreshClaudeTokens,
  fetchClaudeModels,
} from '../lib/auth/claude-sub-auth.mjs';

// ---------- 测试用请求桩：捕获请求并返回预设响应 ----------
function stubRequest(responses) {
  const calls = [];
  const requestFn = async (opts) => {
    calls.push(opts);
    const body = typeof opts.body === 'string' ? opts.body : String(opts.body || '');
    const params = Object.fromEntries(new URLSearchParams(body));
    const responder = responses.shift();
    if (!responder) throw new Error('stub 无预设响应');
    if (responder instanceof Error) throw responder;
    return typeof responder === 'function' ? responder(opts, params) : responder;
  };
  return { requestFn, calls };
}

function jsonResponse(payload, status = 200) {
  return { status, bodyText: JSON.stringify(payload) };
}

// ---------- Google（Antigravity 官方客户端） ----------

test('google: 授权 URL 携带官方 client、PKCE、offline consent 与完整 scope', () => {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const url = buildGoogleAuthUrl({
    redirectUri: 'http://localhost:54321/oauth-callback',
    state: 'st-123',
    codeChallenge: challenge,
  });

  assert.equal(new URL(url).origin, 'https://accounts.google.com');
  const q = new URL(url).searchParams;
  assert.equal(q.get('client_id'), '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com');
  assert.equal(q.get('redirect_uri'), 'http://localhost:54321/oauth-callback');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('state'), 'st-123');
  assert.equal(q.get('code_challenge'), challenge);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('include_granted_scopes'), 'true');
  const scope = q.get('scope');
  assert.ok(scope.includes('cloud-platform'));
  assert.ok(scope.includes('userinfo.email'));
  assert.ok(!scope.includes('generative-language'), '不得携带受限的 generative-language scope');
});

test('google: 未配置 client_secret 时省略该字段（凭据只从环境变量读取）', async () => {
  const previous = process.env.ANTIGRAVITY_CLIENT_SECRET;
  delete process.env.ANTIGRAVITY_CLIENT_SECRET;
  try {
    const { requestFn, calls } = stubRequest([jsonResponse({
      access_token: 'ya29.at', refresh_token: '1//rt', expires_in: 3600,
    })]);
    const tokens = await exchangeGoogleCode({
      code: '4/0AXcode',
      codeVerifier: 'verifier-abc',
      redirectUri: 'http://localhost:54321/oauth-callback',
      requestFn,
    });
    assert.equal(tokens.accessToken, 'ya29.at');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].host, 'oauth2.googleapis.com');
    const sent = new URLSearchParams(calls[0].body);
    assert.equal(sent.get('grant_type'), 'authorization_code');
    assert.equal(sent.get('code'), '4/0AXcode');
    assert.equal(sent.get('code_verifier'), 'verifier-abc');
    assert.equal(sent.get('redirect_uri'), 'http://localhost:54321/oauth-callback');
    assert.equal(sent.get('client_secret'), null, '未配置环境变量时必须省略 client_secret');
    assert.equal(sent.get('client_id'), GOOGLE_OAUTH.clientId);
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
    else process.env.ANTIGRAVITY_CLIENT_SECRET = previous;
  }
});

test('google: 配置 ANTIGRAVITY_CLIENT_SECRET 时交换请求携带该值', async () => {
  const previous = process.env.ANTIGRAVITY_CLIENT_SECRET;
  process.env.ANTIGRAVITY_CLIENT_SECRET = 'env-provided-secret';
  try {
    const { requestFn, calls } = stubRequest([jsonResponse({
      access_token: 'ya29.at', refresh_token: '1//rt', expires_in: 3600,
    })]);
    await exchangeGoogleCode({
      code: '4/0AXcode',
      codeVerifier: 'verifier-abc',
      redirectUri: 'http://localhost:54321/oauth-callback',
      requestFn,
    });
    const sent = new URLSearchParams(calls[0].body);
    assert.equal(sent.get('client_secret'), 'env-provided-secret');
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_CLIENT_SECRET;
    else process.env.ANTIGRAVITY_CLIENT_SECRET = previous;
  }
});

test('google: 刷新响应缺 refresh_token 时保留旧值', async () => {
  const { requestFn } = stubRequest([jsonResponse({
    access_token: 'ya29.new', expires_in: 3600,
  })]);
  const tokens = await refreshGoogleTokens({ refreshToken: '1//old-rt', requestFn });
  assert.equal(tokens.accessToken, 'ya29.new');
  assert.equal(tokens.refreshToken, '1//old-rt', 'Google 刷新不回传 refresh_token，必须沿用旧值');
});

test('google: userinfo 拉取真实 email', async () => {
  const { requestFn, calls } = stubRequest([jsonResponse({ email: 'real.user@gmail.com' })]);
  const info = await fetchGoogleUserInfo({ accessToken: 'ya29.at', requestFn });
  assert.equal(info.email, 'real.user@gmail.com');
  assert.equal(calls[0].headers.Authorization, 'Bearer ya29.at');
});

test('google: LoadCodeAssist 发现 project 与套餐；tier 映射 Pro/Ultra/Free', async () => {
  assert.equal(tierIdToPlanType('g1-pro-tier'), 'Pro');
  assert.equal(tierIdToPlanType('g1-ultra-tier'), 'Ultra');
  assert.equal(tierIdToPlanType('free-tier'), 'Free');

  const { requestFn, calls } = stubRequest([jsonResponse({
    cloudaicompanionProject: 'proj-123',
    currentTier: { id: 'free-tier' },
    paidTier: { id: 'g1-pro-tier' },
  })]);
  const discovered = await discoverGoogleProject({ accessToken: 'ya29.at', requestFn });
  assert.equal(discovered.projectId, 'proj-123');
  assert.equal(discovered.planType, 'Pro');
  assert.equal(calls[0].host, 'cloudcode-pa.googleapis.com');
  assert.match(calls[0].path, /\/v1internal:loadCodeAssist$/);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.metadata.ideType, 'ANTIGRAVITY');
});

test('google: 无 project 时按默认 tier 走 onboardUser', async () => {
  const { requestFn, calls } = stubRequest([
    jsonResponse({
      allowedTiers: [{ id: 'free-tier', isDefault: true }],
    }),
    jsonResponse({
      done: true,
      response: { cloudaicompanionProject: 'onboarded-proj' },
    }),
  ]);
  const discovered = await discoverGoogleProject({ accessToken: 'ya29.at', requestFn });
  assert.equal(discovered.projectId, 'onboarded-proj');
  assert.match(calls[1].path, /\/v1internal:onboardUser$/);
  assert.equal(JSON.parse(calls[1].body).tierId, 'free-tier');
});

// ---------- OpenAI（Codex CLI 官方客户端） ----------

test('openai: 授权 URL 携带 Codex client、PKCE 与简化流程参数', () => {
  const challenge = generateCodeChallenge('a'.repeat(128));
  const url = buildOpenAiAuthUrl({
    redirectUri: 'http://localhost:1455/auth/callback',
    state: 'st-oai',
    codeChallenge: challenge,
  });
  assert.equal(new URL(url).origin, 'https://auth.openai.com');
  const q = new URL(url).searchParams;
  assert.equal(q.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(q.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(q.get('scope'), 'openid profile email offline_access');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('id_token_add_organizations'), 'true');
  assert.equal(q.get('codex_cli_simplified_flow'), 'true');
});

test('openai: code 交换无 client_secret（公共客户端 PKCE）', async () => {
  const { requestFn, calls } = stubRequest([jsonResponse({
    access_token: 'oai-at', id_token: buildIdToken({ email: 'u@openai.com' }),
    refresh_token: 'oai-rt', expires_in: 3600,
  })]);
  const tokens = await exchangeOpenAiCode({
    code: 'cd', codeVerifier: 'v'.repeat(128),
    redirectUri: 'http://localhost:1455/auth/callback',
    requestFn,
  });
  assert.equal(tokens.refreshToken, 'oai-rt');
  const sent = new URLSearchParams(calls[0].body);
  assert.equal(sent.get('client_id'), OPENAI_OAUTH.clientId);
  assert.equal(sent.get('code_verifier'), 'v'.repeat(128));
  assert.equal(sent.get('client_secret'), null, '公共客户端不得携带 client_secret');
});

test('openai: 刷新使用不带 offline_access 的 scope 并保留旧 refresh_token', async () => {
  const { requestFn, calls } = stubRequest([jsonResponse({ access_token: 'n', expires_in: 3600 })]);
  const tokens = await refreshOpenAiTokens({ refreshToken: 'keep-rt', requestFn });
  const sent = new URLSearchParams(calls[0].body);
  assert.equal(sent.get('grant_type'), 'refresh_token');
  assert.equal(sent.get('scope'), 'openid profile email');
  assert.equal(tokens.refreshToken, 'keep-rt');
});

test('openai: ID Token 解析 email / plan / 默认组织', () => {
  const claims = {
    email: 'plus.user@chatgpt.com',
    email_verified: true,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc-1',
      chatgpt_plan_type: 'plus',
      organizations: [
        { id: 'org-x', is_default: false },
        { id: 'org-main', is_default: true },
      ],
    },
  };
  const info = decodeOpenAiIdToken(buildIdToken(claims));
  assert.equal(info.email, 'plus.user@chatgpt.com');
  assert.equal(info.planType, 'plus');
  assert.equal(info.organizationId, 'org-main');
});

// ---------- Claude（Claude Code 官方客户端） ----------

test('claude: 授权 URL 携带官方 client、code=true 与 platform.claude.com redirect', () => {
  const challenge = generateCodeChallenge('c'.repeat(43));
  const url = buildClaudeAuthUrl({ state: 'st-claude', codeChallenge: challenge });
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://claude.com');
  assert.equal(parsed.pathname, '/cai/oauth/authorize');
  const q = parsed.searchParams;
  assert.equal(q.get('client_id'), '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  assert.equal(q.get('code'), 'true', 'code=true 触发浏览器展示一次性授权码');
  assert.equal(q.get('redirect_uri'), 'https://platform.claude.com/oauth/code/callback');
  assert.equal(q.get('code_challenge_method'), 'S256');
  const scope = q.get('scope');
  assert.ok(scope.includes('user:inference'));
  assert.ok(scope.includes('org:create_api_key'));
});

test('claude: code 交换解析 organization.uuid 与 account.email_address', async () => {
  const { requestFn, calls } = stubRequest([jsonResponse({
    access_token: 'sk-oauth-at',
    refresh_token: 'sk-oauth-rt',
    expires_in: 3600,
    organization: { uuid: 'org-uuid-9' },
    account: { uuid: 'acct-uuid-1', email_address: 'me@anthropic.team' },
  })]);
  const tokens = await exchangeClaudeCode({ code: 'cd', codeVerifier: 'cv', requestFn });
  assert.equal(tokens.refreshToken, 'sk-oauth-rt');
  assert.equal(tokens.organizationUuid, 'org-uuid-9');
  assert.equal(tokens.email, 'me@anthropic.team');
  const sent = new URLSearchParams(calls[0].body);
  assert.equal(calls[0].host, 'platform.claude.com');
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('code_verifier'), 'cv');
  assert.equal(sent.get('redirect_uri'), CLAUDE_OAUTH.redirectUri);
});

test('claude: 刷新保留旧 refresh_token', async () => {
  const { requestFn } = stubRequest([jsonResponse({ access_token: 'new-at', expires_in: 3600 })]);
  const tokens = await refreshClaudeTokens({ refreshToken: 'old-rt', requestFn });
  assert.equal(tokens.refreshToken, 'old-rt');
});

// ---------- 工具 ----------

function buildIdToken(claims) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.${b64({})}`;
}

// ---------- 真实模型发现（fetchAvailableModels / v1/models） ----------

test('google: fetchAvailableModels 请求形状与响应解析（project body + fallback）', async () => {
  const { requestFn, calls } = stubRequest([
    jsonResponse({ models: {
      'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', supportsThinking: true, supportsImages: true, maxTokens: 65536 },
      'gemini-2.5-flash': { displayName: 'Gemini 2.5 Flash' },
    } }),
  ]);
  const models = await fetchGoogleAvailableModels({
    accessToken: 'ya29.at',
    projectId: 'proj-1',
    requestFn,
  });
  assert.equal(models.length, 2);
  assert.equal(models[0].name, 'gemini-2.5-pro');
  assert.equal(models[0].displayName, 'Gemini 2.5 Pro');
  assert.equal(models[0].thinking, true);
  assert.equal(models[0].images, true);
  assert.equal(calls[0].host, 'cloudcode-pa.googleapis.com');
  assert.match(calls[0].path, /\/v1internal:fetchAvailableModels$/);
  assert.equal(JSON.parse(calls[0].body).project, 'proj-1');
});

test('google: 缺 project_id 时明确报错', async () => {
  await assert.rejects(
    () => fetchGoogleAvailableModels({ accessToken: 'x', projectId: '', requestFn: async () => ({ status: 200, bodyText: '{}' }) }),
    (err) => err.code === 'google_no_project',
  );
});

test('claude: /v1/models 请求头（OAuth beta + claude-cli UA）与响应解析', async () => {
  const { requestFn, calls } = stubRequest([jsonResponse({
    data: [
      { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
    ],
  })]);
  const models = await fetchClaudeModels({ accessToken: 'sk-oauth-at', requestFn });
  assert.equal(models.length, 2);
  assert.equal(models[0].name, 'claude-sonnet-4-5');
  assert.equal(models[0].displayName, 'Claude Sonnet 4.5');
  assert.equal(calls[0].host, 'api.anthropic.com');
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01');
  assert.match(calls[0].headers['anthropic-beta'], /claude-code-20250219/);
  assert.match(calls[0].headers['anthropic-beta'], /oauth-2025-04-20/);
  assert.match(calls[0].headers['user-agent'] || calls[0].headers['User-Agent'], /^claude-cli\//);
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-oauth-at');
});

test('openai: 内置 Codex 清单非空且形状统一', async () => {
  const { CODEX_KNOWN_MODELS: known } = await import('../lib/auth/openai-sub-auth.mjs');
  assert.ok(known.length >= 5);
  for (const m of known) {
    assert.equal(typeof m.name, 'string');
    assert.equal(typeof m.displayName, 'string');
  }
});

test('fetchOpenAiCodexModels 实时拉取清单并识别能力', async () => {
  const { fetchOpenAiCodexModels, CODEX_KNOWN_MODELS } = await import('../lib/auth/openai-sub-auth.mjs');
  const requestFn = async ({ path }) => {
    assert.ok(path.startsWith('/backend-api/codex/models'), '应请求 codex/models 端点');
    assert.ok(path.includes('client_version'), '应带 client_version 参数');
    return {
      status: 200,
      bodyText: JSON.stringify({ models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'high' }], input_modalities: ['text', 'image'] },
        { slug: 'plain', display_name: 'Plain', supported_reasoning_levels: [], input_modalities: ['text'] },
        { slug: 'legacy-name', display_name: '', supported_reasoning_levels: [], input_modalities: ['text'] },
      ] }),
    };
  };
  const models = await fetchOpenAiCodexModels({ accessToken: 'sk-test-token', proxy: 'http://127.0.0.1:10808', requestFn });
  assert.equal(models.length, 3);
  assert.equal(models[0].name, 'gpt-5.6-sol');
  assert.equal(models[0].thinking, true, '有 supported_reasoning_levels 应识别为思考模型');
  assert.equal(models[0].images, true, 'input_modalities 含 image 应识别为看图模型');
  assert.equal(models[1].thinking, false);
  assert.equal(models[1].images, false);
  // display_name 缺失时回退 slug
  assert.equal(models[2].displayName, 'legacy-name');
  // 内置清单必须包含实时拉取能看到的 gpt-5.3-codex-spark，避免拉取失败时清单缺失
  assert.ok(CODEX_KNOWN_MODELS.some((m) => m.name === 'gpt-5.3-codex-spark'), '内置清单应含 gpt-5.3-codex-spark');
});

test('fetchOpenAiCodexModels 非 200 抛错（调用方回退内置清单）', async () => {
  const { fetchOpenAiCodexModels } = await import('../lib/auth/openai-sub-auth.mjs');
  const requestFn = async () => ({ status: 403, bodyText: '{"detail":"forbidden"}' });
  await assert.rejects(
    fetchOpenAiCodexModels({ accessToken: 'sk-test-token', requestFn }),
    /Codex 模型清单拉取失败/,
  );
});
