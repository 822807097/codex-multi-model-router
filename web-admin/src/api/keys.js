import request from './request.js';

export function listKeys(config = {}) {
  return request({
    url: '/keys',
    method: 'get',
    ...config,
  });
}

export function createKey(data) {
  return request({
    url: '/keys/create',
    method: 'post',
    data,
  });
}

export function revokeKey(id) {
  return request({
    url: '/keys/revoke',
    method: 'post',
    data: { id },
  });
}

export function syncCodex(apiKey) {
  return request({
    url: '/keys/sync-codex',
    method: 'post',
    data: { apiKey },
  });
}

export function unsyncCodex() {
  return request({
    url: '/keys/unsync-codex',
    method: 'post',
  });
}
