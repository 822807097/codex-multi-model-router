import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSupportsModel, createAuthManager } from '../lib/auth/auth-manager.mjs';

test('authManager: 添加、查询与脱敏导出账号', async () => {
  const manager = createAuthManager();

  const acc1 = manager.addAccount({
    id: 'claude-sub-1',
    provider: 'claude',
    alias: 'Claude Pro 主账号',
    credentials: { sessionKey: 'sk-ant-test-secret-key-1' },
    status: 'active',
  });

  assert.equal(acc1.id, 'claude-sub-1');
  assert.equal(acc1.provider, 'claude');
  assert.equal(acc1.credentials.sessionKey, 'sk-ant-test-secret-key-1');

  const acc = manager.getAccount('claude-sub-1');
  assert.equal(acc.id, 'claude-sub-1');

  // 脱敏导出测试，确保密钥不泄露
  const publicList = manager.listAccounts({ sanitized: true });
  assert.equal(publicList.length, 1);
  assert.equal(publicList[0].alias, 'Claude Pro 主账号');
  assert.equal(publicList[0].credentials, undefined);
  assert.equal(publicList[0].hasCredentials, true);
});

test('authManager: 轮询与多账号负载均衡 (Round Robin)', async () => {
  const manager = createAuthManager();

  manager.addAccount({ id: 'acc-1', provider: 'google', alias: 'G1' });
  manager.addAccount({ id: 'acc-2', provider: 'google', alias: 'G2' });
  manager.addAccount({ id: 'acc-3', provider: 'claude', alias: 'C1' });

  const picked1 = manager.acquireAccount({ provider: 'google' });
  const picked2 = manager.acquireAccount({ provider: 'google' });
  const picked3 = manager.acquireAccount({ provider: 'google' });

  assert.equal(picked1.id, 'acc-1');
  assert.equal(picked2.id, 'acc-2');
  assert.equal(picked3.id, 'acc-1'); // 轮询循环
});

test('authManager: 429 冷却与自动故障转移 (Failover)', async () => {
  const manager = createAuthManager();

  manager.addAccount({ id: 'acc-1', provider: 'openai', alias: 'OA1' });
  manager.addAccount({ id: 'acc-2', provider: 'openai', alias: 'OA2' });

  // 将 acc-1 标记为 429 冷却
  manager.markCooldown('acc-1', { cooldownMs: 10000, reason: '429 rate limit' });

  const picked = manager.acquireAccount({ provider: 'openai' });
  assert.equal(picked.id, 'acc-2'); // 自动跳过冷却中的 acc-1
});

test('authManager: 单飞 (Single-flight) 刷新锁防并发击穿', async () => {
  const manager = createAuthManager();
  let refreshCalls = 0;

  manager.addAccount({
    id: 'google-sub-1',
    provider: 'google',
    credentials: { refreshToken: 'rt-test-1', accessToken: 'expired-at', expiresAt: Date.now() - 1000 },
  });

  manager.registerRefresher('google', async (account) => {
    refreshCalls++;
    await new Promise((r) => setTimeout(r, 50));
    return {
      accessToken: 'new-valid-access-token',
      expiresAt: Date.now() + 3600000,
    };
  });

  // 并发发起 10 个获取有效凭据的请求
  const promises = Array.from({ length: 10 }).map(() =>
    manager.getValidCredentials('google-sub-1')
  );

  const results = await Promise.all(promises);

  // 10 个并发请求应全部拿到刷新后的 token
  for (const cred of results) {
    assert.equal(cred.accessToken, 'new-valid-access-token');
  }

  // 但真正的刷新函数只应该被执行 1 次（单飞防击穿）
  assert.equal(refreshCalls, 1);
});

test('authManager: 刷新成功后回调持久化监听器（vault 落盘新 token）', async () => {
  const manager = createAuthManager();
  const persisted = [];

  manager.addAccount({
    id: 'openai-sub-1',
    provider: 'openai',
    credentials: { refreshToken: 'rt-old', accessToken: 'expired', expiresAt: Date.now() - 1000 },
  });

  manager.registerRefresher('openai', async () => ({
    credentials: { refreshToken: 'rt-new', accessToken: 'fresh-token' },
    expiresAt: Date.now() + 3600000,
  }));

  // 注册持久化监听器
  manager.onCredentialsRefreshed((id, credentials, expiresAt) => {
    persisted.push({ id, credentials, expiresAt });
  });

  const creds = await manager.getValidCredentials('openai-sub-1');

  assert.equal(creds.accessToken, 'fresh-token');
  assert.equal(creds.refreshToken, 'rt-new');
  // 监听器必须收到刷新后的新凭据（含轮换的 refresh_token）
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, 'openai-sub-1');
  assert.equal(persisted[0].credentials.refreshToken, 'rt-new');
  assert.equal(persisted[0].credentials.accessToken, 'fresh-token');
  assert.ok(persisted[0].expiresAt > Date.now());
});

test('authManager: 按模型套餐过滤选号（sub2api 式）', () => {
  const manager = createAuthManager();
  manager.addAccount({ id: 'pro-1', provider: 'openai', metadata: { planType: 'pro' } });
  manager.addAccount({ id: 'free-1', provider: 'openai', metadata: { planType: 'free' } });

  // 套餐推断：pro 支持 sol，free 不支持
  assert.equal(accountSupportsModel({ metadata: { planType: 'pro' } }, 'gpt-5.6-sol'), true);
  assert.equal(accountSupportsModel({ metadata: { planType: 'pro' } }, 'gpt-5.6-luna'), true);
  assert.equal(accountSupportsModel({ metadata: { planType: 'free' } }, 'gpt-5.6-sol'), false);
  assert.equal(accountSupportsModel({ metadata: { planType: 'free' } }, 'gpt-5.6-luna'), true);

  // 按模型过滤选号：sol 只挑 pro，luna 轮换两者
  const solAccount = manager.acquireAccount({ provider: 'openai', model: 'gpt-5.6-sol' });
  assert.equal(solAccount.id, 'pro-1', 'sol 必须选中 pro 账号');
  const luna1 = manager.acquireAccount({ provider: 'openai', model: 'gpt-5.6-luna' });
  const luna2 = manager.acquireAccount({ provider: 'openai', model: 'gpt-5.6-luna' });
  assert.ok([luna1.id, luna2.id].includes('free-1'), 'luna 应能轮到 free 账号');

  // 显式 models 清单优先于套餐推断
  const explicit = manager.addAccount({ id: 'explicit-1', provider: 'openai', metadata: { planType: 'free', models: ['gpt-5.6-sol'] } });
  assert.equal(accountSupportsModel({ metadata: explicit.metadata }, 'gpt-5.6-sol'), true, '显式清单应覆盖套餐推断');

  // 未知套餐不拦截（交由上游决定）
  assert.equal(accountSupportsModel({ metadata: { planType: 'unknown-plan' } }, 'gpt-5.6-sol'), true);
  // 无套餐也不拦截
  assert.equal(accountSupportsModel({ metadata: {} }, 'gpt-5.6-sol'), true);
});
