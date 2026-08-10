import test from 'node:test';
import assert from 'node:assert/strict';

import * as requestPolicy from '../lib/request-policy.mjs';

const {
  forwardRequestHeaders,
  isChatGptBackend,
  hasStandaloneConversationInput,
  upstreamStateDomain,
} = requestPolicy;

test('只有显式 useOpenAiAuth 才启用 ChatGPT 官方身份', () => {
  assert.equal(isChatGptBackend({ name: 'openai', platform: 'openai' }), false);
  assert.equal(isChatGptBackend({ name: 'custom', useOpenAiAuth: true }), true);
});

test('第三方请求头默认只转发无身份信息的安全字段', () => {
  const headers = forwardRequestHeaders({
    accept: 'text/event-stream',
    'user-agent': 'Codex',
    cookie: 'secret=1',
    authorization: 'Bearer client-secret',
    'chatgpt-account-id': 'account-secret',
    'x-codex-session-id': 'session-secret',
    'x-explicit-safe': 'forward-me',
  }, { forwardHeaders: ['x-explicit-safe'] });

  assert.deepEqual(headers, {
    accept: 'text/event-stream',
    'user-agent': 'Codex',
    'x-explicit-safe': 'forward-me',
    'accept-encoding': 'identity',
  });
});

test('路由生成认证头按大小写替换静态旧值且不会留下旧账号 ID', () => {
  assert.equal(typeof requestPolicy.mergeGeneratedHeaders, 'function');
  const mergeGeneratedHeaders = requestPolicy.mergeGeneratedHeaders;

  assert.deepEqual(mergeGeneratedHeaders({
    Authorization: 'Bearer stale-a',
    authorization: 'Bearer stale-b',
    'ChatGPT-Account-ID': 'old-account',
    'X-Trace': 'keep-me',
  }, {
    authorization: 'Bearer current',
    'chatgpt-account-id': 'current-account',
  }, ['authorization', 'chatgpt-account-id']), {
    'x-trace': 'keep-me',
    authorization: 'Bearer current',
    'chatgpt-account-id': 'current-account',
  });

  assert.deepEqual(mergeGeneratedHeaders({
    'CHATGPT-ACCOUNT-ID': 'must-be-removed',
  }, {
    authorization: 'Bearer current',
  }, ['authorization', 'chatgpt-account-id']), {
    authorization: 'Bearer current',
  });

  assert.deepEqual(mergeGeneratedHeaders({
    'X-Custom-Key': 'stale',
    'x-custom-key': 'also-stale',
  }, {
    'X-Custom-Key': 'current',
  }), {
    'x-custom-key': 'current',
  });
});

test('跨协议请求只有携带可独立使用的历史输入时才允许去除私有 response id', () => {
  assert.equal(hasStandaloneConversationInput({ input: '仅最新消息' }), false);
  assert.equal(hasStandaloneConversationInput({
    input: [{ role: 'user', content: '仅最新消息' }],
  }), false);
  assert.equal(hasStandaloneConversationInput({
    input: [
      { role: 'user', content: '旧任务' },
      { role: 'assistant', content: '旧回复' },
      { role: 'user', content: '继续' },
    ],
  }), true);
  assert.equal(hasStandaloneConversationInput({
    input: [
      { type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  }), true);
  assert.equal(hasStandaloneConversationInput({
    input: [
      { role: 'assistant', content: '只有上一条回复' },
      { role: 'user', content: '继续' },
    ],
  }), false);
  assert.equal(hasStandaloneConversationInput({
    input: [
      { type: 'tool_search_call', call_id: 'search_1', query: '邮件' },
      { type: 'tool_search_output', call_id: 'search_1', output: '结果' },
    ],
  }), true);
});

test('供应商私有状态域默认按端点和认证隔离并允许显式共享', () => {
  const provider = { wireApi: 'responses' };
  const base = { host: 'api.example.com', prefix: '/v1', envKey: 'KEY_A' };
  assert.equal(upstreamStateDomain(base, provider), upstreamStateDomain({ ...base }, provider));
  assert.notEqual(upstreamStateDomain(base, provider), upstreamStateDomain({ ...base, envKey: 'KEY_B' }, provider));
  assert.equal(
    upstreamStateDomain({ ...base, stateDomain: 'shared' }, provider),
    upstreamStateDomain({ host: 'backup.example.com', stateDomain: 'shared' }, provider),
  );
  assert.notEqual(
    upstreamStateDomain(base, { ...provider, authType: 'bearer', authHeader: 'authorization' }),
    upstreamStateDomain(base, { ...provider, authType: 'header', authHeader: 'x-api-key' }),
  );
});

test('显式状态域只允许同一 wire API 共享', () => {
  const first = { host: 'api-a.example.com', stateDomain: 'shared' };
  const second = { host: 'api-b.example.com', stateDomain: 'shared' };

  assert.equal(
    upstreamStateDomain(first, { wireApi: 'responses' }),
    upstreamStateDomain(second, { wireApi: 'responses' }),
  );
  assert.notEqual(
    upstreamStateDomain(first, { wireApi: 'responses' }),
    upstreamStateDomain(second, { wireApi: 'chat' }),
  );
});

test('等价 prefix 和默认认证头归一到同一供应商状态域', () => {
  const base = { host: 'API.EXAMPLE.COM', prefix: '/v1', envKey: 'KEY' };
  const implicit = { wireApi: 'responses', authType: 'bearer' };
  const explicit = { wireApi: 'responses', authType: 'bearer', authHeader: 'Authorization' };

  assert.equal(
    upstreamStateDomain(base, implicit),
    upstreamStateDomain({ ...base, host: 'api.example.com', prefix: '/v1/' }, explicit),
  );
});

test('状态域按静态租户 header 内容分离并归一名称大小写与对象顺序', () => {
  const provider = { wireApi: 'responses', authType: 'bearer' };
  const base = { host: 'api.example.com', prefix: '/v1', envKey: 'KEY' };
  const first = upstreamStateDomain({
    ...base,
    headers: {
      'OpenAI-Organization': 'org-a',
      'X-Project': 'project-a',
    },
  }, provider);
  const equivalent = upstreamStateDomain({
    ...base,
    headers: {
      'x-project': 'project-a',
      'openai-organization': 'org-a',
    },
  }, provider);
  const otherTenant = upstreamStateDomain({
    ...base,
    headers: {
      'openai-organization': 'org-b',
      'x-project': 'project-a',
    },
  }, provider);

  assert.equal(first, equivalent);
  assert.notEqual(first, otherTenant);
});

test('路由覆盖的认证头不参与静态 header 状态摘要', () => {
  const base = { host: 'api.example.com', prefix: '/v1', envKey: 'KEY' };
  const customProvider = { wireApi: 'responses', authType: 'header', authHeader: 'X-Custom-Key' };
  assert.equal(
    upstreamStateDomain({ ...base, headers: { 'x-custom-key': 'stale-a' } }, customProvider),
    upstreamStateDomain({ ...base, headers: { 'X-CUSTOM-KEY': 'stale-b' } }, customProvider),
  );

  const officialProvider = { wireApi: 'responses', authType: 'bearer' };
  assert.equal(
    upstreamStateDomain({
      ...base,
      useOpenAiAuth: true,
      headers: { Authorization: 'old-a', 'ChatGPT-Account-ID': 'account-a' },
    }, officialProvider),
    upstreamStateDomain({
      ...base,
      useOpenAiAuth: true,
      headers: { authorization: 'old-b', 'chatgpt-account-id': 'account-b' },
    }, officialProvider),
  );
});

test('官方认证只忽略实际覆盖的 header 并保留自定义静态租户域', () => {
  const provider = {
    wireApi: 'responses',
    authType: 'header',
    authHeader: 'X-Tenant',
  };
  const base = {
    host: 'chatgpt.com',
    useOpenAiAuth: true,
  };

  assert.notEqual(
    upstreamStateDomain({ ...base, headers: { 'X-Tenant': 'tenant-a' } }, provider),
    upstreamStateDomain({ ...base, headers: { 'x-tenant': 'tenant-b' } }, provider),
  );
  assert.equal(
    upstreamStateDomain({ ...base, headers: { Authorization: 'stale-a' } }, provider),
    upstreamStateDomain({ ...base, headers: { authorization: 'stale-b' } }, provider),
  );
});

test('静态 header 长值只进入固定长度摘要且等价端口类型归一', () => {
  const marker = `tenant-secret-${'x'.repeat(100_000)}`;
  const provider = { wireApi: 'responses', authType: 'bearer' };
  const numericPort = upstreamStateDomain({
    host: 'api.example.com',
    port: 443,
    headers: { 'x-tenant': marker },
  }, provider);
  const stringPort = upstreamStateDomain({
    host: 'api.example.com',
    port: '443',
    headers: { 'X-Tenant': marker },
  }, provider);

  assert.equal(numericPort, stringPort);
  assert.equal(numericPort.includes(marker), false);
  assert.ok(numericPort.length < 512);
});
