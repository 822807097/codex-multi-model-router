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

export function fetchAccountModels(provider, id) {
  return request({
    url: '/accounts/fetch-models',
    method: 'post',
    data: { provider, id },
  });
}
