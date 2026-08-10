import test from 'node:test';
import assert from 'node:assert/strict';

import { createOpenAiAuthManager } from '../lib/openai-auth.mjs';

function jwt(exp) {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `header.${payload}.signature`;
}

function memoryAuthFile(initial) {
  let current = structuredClone(initial);
  let temporary = null;
  let writes = 0;
  return {
    fileSystem: {
      statSync() { return { size: Buffer.byteLength(JSON.stringify(current)) }; },
      readFileSync() { return Buffer.from(JSON.stringify(current)); },
      writeFileSync(filePath, text) {
        assert.match(filePath, /\.tmp$/);
        temporary = JSON.parse(text);
        writes += 1;
      },
      renameSync(from, to) {
        assert.match(from, /\.tmp$/);
        assert.doesNotMatch(to, /\.tmp$/);
        current = temporary;
        temporary = null;
      },
    },
    get current() { return current; },
    get writes() { return writes; },
  };
}

function managerOptions(authFile, overrides = {}) {
  return {
    authPath: 'C:/isolated/auth.json',
    fileSystem: authFile.fileSystem,
    clientId: 'client-id',
    refreshSkewSeconds: 30,
    oauthConfig: {},
    timeouts: { requestMs: 1000 },
    proxy: { host: '127.0.0.1', port: 10808 },
    resolveViaProxy: () => false,
    request: async () => { throw new Error('不应刷新'); },
    now: () => 1_000_000,
    ...overrides,
  };
}

test('未临期登录态直接返回且不调用刷新接口', async () => {
  const authFile = memoryAuthFile({
    tokens: { access_token: jwt(2000), refresh_token: 'refresh', account_id: 'account' },
  });
  let requests = 0;
  const manager = createOpenAiAuthManager(managerOptions(authFile, {
    request: async () => { requests += 1; throw new Error('不应刷新'); },
  }));

  assert.deepEqual(await manager.get({ name: 'official' }), {
    token: jwt(2000),
    accountId: 'account',
  });
  assert.deepEqual(manager.identity(), { accountId: 'account' });
  assert.equal(requests, 0);
  assert.equal(authFile.writes, 0);
});

test('并发临期请求只刷新一次并原子写回登录态', async () => {
  const authFile = memoryAuthFile({
    tokens: { access_token: jwt(1), refresh_token: 'refresh-old', account_id: 'account' },
    keep: 'desktop-field',
  });
  let requests = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const manager = createOpenAiAuthManager(managerOptions(authFile, {
    request: async (options) => {
      requests += 1;
      assert.equal(options.host, 'auth.openai.com');
      assert.match(options.body, /refresh-old/);
      await pending;
      return {
        status: 200,
        bodyText: JSON.stringify({ access_token: jwt(3000), refresh_token: 'refresh-new' }),
      };
    },
  }));

  const first = manager.get({ name: 'official' });
  const second = manager.get({ name: 'official' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  release();

  const [firstAuth, secondAuth] = await Promise.all([first, second]);
  assert.deepEqual(firstAuth, secondAuth);
  assert.equal(firstAuth.token, jwt(3000));
  assert.equal(authFile.writes, 1);
  assert.equal(authFile.current.keep, 'desktop-field');
  assert.equal(authFile.current.tokens.refresh_token, 'refresh-new');
});
