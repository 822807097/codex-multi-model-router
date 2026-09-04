import request from './request.js';

export function listAccounts(config = {}) {
  return request({
    url: '/accounts',
    method: 'get',
    ...config,
  });
}

export function addAccount(accountData) {
  return request({
    url: '/accounts/add',
    method: 'post',
    data: accountData,
  });
}

export function deleteAccount(id) {
  return request({
    url: '/accounts/delete',
    method: 'post',
    data: { id },
  });
}

/**
 * 发起一键 OAuth 授权。google/openai 后端会拉起默认浏览器并监听本地回调；
 * claude 返回授权链接由用户打开并复制 Code。
 */
export function startOAuth(provider) {
  return request({
    url: `/oauth/${provider}/start`,
    method: 'post',
  });
}

export function pollOAuthStatus(provider) {
  return request({
    url: `/oauth/${provider}/status`,
    method: 'get',
  });
}

export function exchangeOAuthCode(provider, code, state) {
  return request({
    url: `/oauth/${provider}/exchange`,
    method: 'post',
    data: { code, state },
  });
}

export function testAccountModel(provider, id, model) {
  return request({
    url: '/accounts/test-model',
    method: 'post',
    data: { provider, accountId: id, model },
    timeout: 60_000,
  });
}

/**
 * 谷歌订阅通道一键接入：拉取订阅模型清单 → 建平台专属通道 + 模型写入桌面目录。
 */
export function setupGoogleChannel() {
  return request({
    url: '/google-channel/setup',
    method: 'post',
    timeout: 90_000,
  });
}

/**
 * 设置订阅账号的额度消耗顺序（priority 数字越小越先消耗；null=自动按套餐）。
 */
export function setAccountPriority(id, priority) {
  return request({
    url: '/accounts/set-priority',
    method: 'post',
    data: { id, priority },
  });
}

/** 账号级独立代理：enabled=false 或 proxyUrl 空 = 清空（直连/跟随系统） */
export function setAccountProxy(id, enabled, proxyUrl) {
  return request({
    url: '/accounts/set-proxy',
    method: 'post',
    data: { id, enabled, proxyUrl },
  });
}

/**
 * 一键切换 Codex 桌面端登录的 ChatGPT 账号（替换 auth.json + 自动重启桌面端）。
 */
export function switchCodexAccount(id) {
  return request({
    url: '/codex-desktop/switch-account',
    method: 'post',
    data: { accountId: id },
    timeout: 60_000,
  });
}

/**
 * 当前 Codex 桌面端登录身份（解码 auth.json，仅展示用）。
 */
export function getCodexAuthIdentity() {
  return request({
    url: '/codex-desktop/auth-identity',
    method: 'get',
  });
}

/**
 * 订阅账号真实额度：ChatGPT=5h/周窗口 used% + 重置时间；谷歌=本地计数+说明。
 */
export function getAccountQuota(id) {
  return request({
    url: '/accounts/quota',
    method: 'get',
    params: { id },
    timeout: 45_000,
  });
}

export function fetchAccountModels(provider, id) {
  return request({
    url: '/accounts/fetch-models',
    method: 'post',
    data: { provider, id },
  });
}
