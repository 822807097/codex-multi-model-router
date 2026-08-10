import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeRefreshResult } from '../lib/auth-state.mjs';

test('桌面端已轮换 refresh token 时丢弃路由的过期刷新结果', () => {
  const original = { tokens: { access_token: 'old-access', refresh_token: 'old-refresh' } };
  const latest = { tokens: { access_token: 'desktop-access', refresh_token: 'desktop-refresh', account_id: 'account' } };
  const merged = mergeRefreshResult(original, latest, {
    access_token: 'router-access',
    refresh_token: 'router-refresh',
  });

  assert.equal(merged.shouldWrite, false);
  assert.equal(merged.auth.token, 'desktop-access');
  assert.equal(merged.data.tokens.refresh_token, 'desktop-refresh');
});

test('refresh token 未变化时把刷新结果合并到最新 auth 其他字段', () => {
  const original = { profile: { name: 'old' }, tokens: { refresh_token: 'same-refresh', account_id: 'account' } };
  const latest = { profile: { name: 'new' }, tokens: { refresh_token: 'same-refresh', account_id: 'account' } };
  const merged = mergeRefreshResult(original, latest, {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    id_token: 'new-id',
  });

  assert.equal(merged.shouldWrite, true);
  assert.equal(merged.data.profile.name, 'new');
  assert.equal(merged.data.tokens.access_token, 'new-access');
  assert.equal(merged.data.tokens.refresh_token, 'new-refresh');
  assert.equal(merged.auth.accountId, 'account');
});

test('刷新等待期间桌面端注销时不得用旧结果复活登录态', () => {
  const original = { tokens: { access_token: 'access-old', refresh_token: 'refresh-old', account_id: 'acct-old' } };
  const latest = { tokens: {}, logged_out: true };
  const refreshResult = { access_token: 'access-stale', refresh_token: 'refresh-stale' };

  const merged = mergeRefreshResult(original, latest, refreshResult);

  assert.equal(merged.shouldWrite, false);
  assert.equal(merged.data.logged_out, true);
  assert.equal(merged.auth.token, undefined);
});
