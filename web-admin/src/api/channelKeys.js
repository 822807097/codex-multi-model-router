import request from './request.js';

// ---------- 通道密钥池（同通道多账号 key / 双形态 / 优先级 / 冷却持久化） ----------

export function listChannelKeys(target = '', config = {}) {
  return request({
    url: '/channel-keys',
    method: 'get',
    params: target ? { target } : {},
    ...config,
  });
}

export function createChannelKey(data) {
  return request({
    url: '/channel-keys/create',
    method: 'post',
    data,
    // 直连验证要等上游响应头，放宽超时
    timeout: 35_000,
  });
}

export function updateChannelKey(data) {
  return request({
    url: '/channel-keys/update',
    method: 'post',
    data,
  });
}

export function revokeChannelKey(id) {
  return request({
    url: '/channel-keys/revoke',
    method: 'post',
    data: { id },
  });
}

export function testChannelKey(id) {
  return request({
    url: '/channel-keys/test',
    method: 'post',
    data: { id },
    timeout: 35_000,
  });
}

// ---------- 厂商预设库（内置常用模型厂商，一键接入） ----------

export function getVendorPresets(config = {}) {
  return request({
    url: '/vendor-presets',
    method: 'get',
    ...config,
  });
}

export function activateVendorPreset(data) {
  return request({
    url: '/vendor-presets/activate',
    method: 'post',
    data,
    timeout: 30_000,
  });
}

// ---------- Codex 默认启动模型（config.toml 顶部 model = "..."） ----------

export function getCodexDefaultModel(config = {}) {
  return request({
    url: '/codex-default-model',
    method: 'get',
    ...config,
  });
}

export function setCodexDefaultModel(model) {
  return request({
    url: '/codex-default-model',
    method: 'put',
    data: { model },
  });
}
