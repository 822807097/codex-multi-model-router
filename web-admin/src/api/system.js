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
    // 免费共享端点（如 NVIDIA Trial）响应可到数十秒，放宽到 2.5 分钟
    timeout: 160_000,
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

// ---------- Codex 桌面端接入管理（一键官方直连 / 一键接入路由 + 模型动态加载） ----------

export function getCodexDesktopState(config = {}) {
  return request({
    url: '/codex-desktop/state',
    method: 'get',
    ...config,
  });
}

export function restoreCodexDesktopOfficial(data) {
  return request({
    url: '/codex-desktop/restore-official',
    method: 'post',
    data,
  });
}

export function applyCodexDesktopRouter(data) {
  return request({
    url: '/codex-desktop/apply-router',
    method: 'post',
    data,
  });
}
