import request from './request.js';

export function getDashboardStats(days = 30, config = {}) {
  return request({
    url: '/dashboard',
    method: 'get',
    params: { days },
    ...config,
  });
}

export function resetTokenUsage() {
  return request({
    url: '/token-usage/reset',
    method: 'post',
  });
}
