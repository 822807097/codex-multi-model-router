import fs from 'node:fs';

import { mergeRefreshResult } from './auth-state.mjs';
import { resolveTimeouts } from './transport.mjs';

const MAX_AUTH_BYTES = 4 * 1024 * 1024;

function jwtExp(token) {
  try {
    let payload = token.split('.')[1];
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp || null;
  } catch {
    return null;
  }
}

export function createOpenAiAuthManager(options) {
  const fileSystem = options.fileSystem || fs;
  const log = options.log || (() => {});
  const now = options.now || Date.now;
  const oauthConfig = options.oauthConfig || {};
  let refreshInFlight = null;

  function readAuth() {
    const stat = fileSystem.statSync(options.authPath);
    if (stat.size > MAX_AUTH_BYTES) throw new Error('auth.json 超过大小上限');
    const bytes = fileSystem.readFileSync(options.authPath);
    if (bytes.length > MAX_AUTH_BYTES) throw new Error('auth.json 超过大小上限');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }

  async function refresh(target) {
    const original = readAuth();
    const tokens = original.tokens || {};
    log('openai: access_token 临期，执行 refresh');
    const refreshTimeoutMs = Number(oauthConfig.refresh_timeout_ms) || 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), refreshTimeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await options.request({
        host: 'auth.openai.com',
        path: '/oauth/token',
        viaProxy: options.resolveViaProxy(oauthConfig, target),
        proxy: options.proxy,
        headers: {},
        body: JSON.stringify({
          client_id: options.clientId,
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
        }),
        signal: controller.signal,
        timeouts: {
          ...resolveTimeouts(options.timeouts),
          requestMs: refreshTimeoutMs,
        },
        maxResponseBytes: 256 * 1024,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`token refresh timeout after ${refreshTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    let refreshed = null;
    try { refreshed = JSON.parse(response.bodyText); } catch { /* 下方按刷新失败处理 */ }
    if (response.status !== 200 || !refreshed?.access_token) {
      throw new Error(`token refresh 失败 HTTP ${response.status}`);
    }
    const latest = readAuth();
    const merged = mergeRefreshResult(original, latest, refreshed);
    if (!merged.shouldWrite) {
      if (!merged.auth.token) throw new Error('auth.json 已被并发更新但缺少 access_token');
      log('openai: 检测到桌面端已更新登录态，丢弃过期 refresh 结果');
      return merged.auth;
    }

    const tempPath = `${options.authPath}.tmp`;
    fileSystem.writeFileSync(tempPath, JSON.stringify(merged.data, null, 2));
    fileSystem.renameSync(tempPath, options.authPath);
    log('openai: refresh 成功并已写回 auth.json');
    return merged.auth;
  }

  async function get(target) {
    const data = readAuth();
    const tokens = data.tokens || {};
    if (!tokens.access_token) {
      throw new Error('auth.json 缺少 access_token，请先在 Codex 桌面端登录 ChatGPT');
    }
    const expiresAt = jwtExp(tokens.access_token);
    if (expiresAt && now() / 1000 < expiresAt - options.refreshSkewSeconds) {
      return { token: tokens.access_token, accountId: tokens.account_id };
    }
    if (!tokens.refresh_token) {
      throw new Error('access_token 已过期且无 refresh_token，请在桌面端重新登录');
    }
    if (!refreshInFlight) {
      refreshInFlight = refresh(target).finally(() => { refreshInFlight = null; });
    }
    return refreshInFlight;
  }

  function identity() {
    try {
      return { accountId: readAuth().tokens?.account_id || null };
    } catch {
      return { accountId: null };
    }
  }

  return { get, identity };
}
