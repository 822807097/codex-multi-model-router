import request from './request.js';

export function restartRouterService() {
  return request({
    url: '/service/restart',
    method: 'post',
  });
}

export function getSystemConfig(config = {}) {
  return request({
    url: '/config',
    method: 'get',
    ...config,
  });
}

export function getRouterStatus(config = {}) {
  return request({
    url: '/status',
    method: 'get',
    ...config,
  });
}

export function saveSystemConfig(data) {
  return request({
    url: '/config',
    method: 'put',
    data,
    timeout: 30_000,
  });
}

export function testVisionRelay(data) {
  return request({
    url: '/vision-relay/test',
    method: 'post',
    data,
    timeout: 45_000,
  });
}

// ---------- Cursor 订阅网关（内置面板管理：状态/账号池/增删 crsr_ key） ----------

export function getCursorGatewayStatus(config = {}) {
  return request({
    url: '/cursor-gateway/status',
    method: 'get',
    ...config,
  });
}

export function listCursorGatewayAccounts(config = {}) {
  return request({
    url: '/cursor-gateway/accounts',
    method: 'get',
    ...config,
  });
}

export function addCursorGatewayAccount(data) {
  return request({
    url: '/cursor-gateway/accounts/add',
    method: 'post',
    data,
    // 新增账号要真实验证 crsr_ key + 拉取模型清单，放宽超时
    timeout: 40_000,
  });
}

export function removeCursorGatewayAccount(id) {
  return request({
    url: '/cursor-gateway/accounts/remove',
    method: 'post',
    data: { id },
  });
}
