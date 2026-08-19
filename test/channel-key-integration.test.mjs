import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.ROUTER_TEST_SHUTDOWN = '1';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await close(server);
  return port;
}

function request(port, method, requestPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: {
        ...extraHeaders,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.setTimeout(3_000, () => req.destroy(new Error(`请求超时: ${method} ${requestPath}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitUntilHealthy(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`隔离路由提前退出，code=${child.exitCode}`);
    try {
      const response = await request(port, 'GET', '/healthz');
      if (response.status === 200) return;
    } catch { /* 路由尚未开始监听 */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('隔离路由健康检查超时');
}

function waitForChildExit(child, childExit, childOutput, timeoutMs = 2_000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`隔离路由未优雅退出：${childOutput}`)), timeoutMs);
    childExit.then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// 密钥池集成：429 记 key 级冷却 → 下一请求自动换 key → 全池耗尽回退 envKey 并报恢复时间
test('通道密钥池：额度耗尽自动切换 + 冷却持久化 + 全池耗尽恢复时间', async () => {
  const seenKeys = [];
  const upstream = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    if (req.url === '/pooled/chat/completions') {
      if (auth.includes('sk-pool-key-1')) {
        seenKeys.push('key1');
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
        res.end('{"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached: POOL_SECRET_KEY1_BODY"}}');
        return;
      }
      if (auth.includes('sk-pool-key-2')) {
        seenKeys.push('key2');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return;
      }
      if (auth.includes('sk-pool-legacy')) {
        seenKeys.push('legacy');
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7200' });
        res.end('{"error":{"code":"insufficient_quota","message":"quota will reset at 08-21 11:36:00 UTC"}}');
        return;
      }
      seenKeys.push('unknown');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"unexpected key"}}');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-keypool-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  const dbPath = path.join(tempDir, 'router-test.db');
  const diagnosticLogPath = path.join(tempDir, 'router.log');
  await fs.writeFile(catalogPath, JSON.stringify({
    models: [{ slug: 'pool-model', display_name: '密钥池模型' }],
  }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    heartbeatMs: 20,
    modelContext: { enabled: false },
    supportsResponses: { slugs: ['pool-model'] },
    targets: [
      {
        name: 'pooled',
        match: '^pool-model$',
        host: '127.0.0.1',
        port: upstream.address().port,
        protocol: 'http',
        prefix: '/pooled',
        envKey: 'POOLED_LEGACY',
        wireApi: 'chat',
      },
    ],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      ROUTER_HEARTBEAT_MS: '20',
      CODEX_CATALOG_PATH: catalogPath,
      ROUTER_LOG: diagnosticLogPath,
      ROUTER_DB_PATH: dbPath,
      POOLED_LEGACY: 'sk-pool-legacy',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  const responsesBody = (model, content) => ({
    model,
    stream: true,
    input: [{ role: 'user', content: [{ type: 'input_text', text: content }] }],
  });

  try {
    await waitUntilHealthy(routerPort, child);

    // 1. 池内挂两把 key：key1（p0，上游 429）、key2（p5，上游 200）
    const create1 = await request(routerPort, 'POST', '/_admin/api/channel-keys/create', {
      target: 'pooled', kind: 'plaintext', label: '账号1', key: 'sk-pool-key-1', priority: 0,
      skipVerify: true,
    });
    assert.equal(create1.status, 200);
    const create2 = await request(routerPort, 'POST', '/_admin/api/channel-keys/create', {
      target: 'pooled', kind: 'plaintext', label: '账号2', key: 'sk-pool-key-2', priority: 5,
      skipVerify: true,
    });
    assert.equal(create2.status, 200);
    const key1Id = JSON.parse(create1.text).id;
    const key2Id = JSON.parse(create2.text).id;

    // 2. 请求 1：命中 key1 → 上游 429 → 客户端收到 429 + retry-after，key1 记冷却
    const first = await request(routerPort, 'POST', '/v1/responses', responsesBody('pool-model', '请求1'));
    assert.equal(first.status, 429);
    assert.equal(first.headers['retry-after'], '120');
    assert.deepEqual(seenKeys, ['key1']);

    // 3. 冷却已持久化：管理 API 可见 key1 冷却中 + 精确恢复时间（now + 120s 附近）
    const listAfterFirst = await request(routerPort, 'GET', '/_admin/api/channel-keys?target=pooled');
    assert.equal(listAfterFirst.status, 200);
    const entriesAfterFirst = JSON.parse(listAfterFirst.text).entries;
    const cooled = entriesAfterFirst.find((entry) => entry.id === key1Id);
    assert.equal(cooled.cooldown.active, true);
    assert.ok(Math.abs(cooled.cooldown.retryAt - (Date.now() + 120_000)) < 10_000, '恢复时间来自 retry-after 头');
    assert.equal(entriesAfterFirst.find((entry) => entry.id === key2Id).cooldown.active, false);
    // 脱敏展示（前 6 后 4）
    assert.equal(cooled.maskedKey, 'sk-poo****ey-1');

    // 4. 请求 2（单请求单 key，不重试）：key1 冷却 → 自动换 key2 → 200 成功
    const second = await request(routerPort, 'POST', '/v1/responses', responsesBody('pool-model', '请求2'));
    assert.equal(second.status, 200);
    assert.deepEqual(seenKeys, ['key1', 'key2']);

    // 5. 把 key2 也冷却（管理 API 模拟上游额度耗尽后的状态），全池耗尽 → envKey 兜底
    const cooldownManual = await request(routerPort, 'POST', '/_admin/api/channel-keys/update', {
      id: key2Id, priority: 5,
      skipVerify: true,
    });
    assert.equal(cooldownManual.status, 200);
    // 直接标记 key2 冷却：模拟 key2 下一次也 429 的场景（通过上游再打一次即可，但此处走管理面验证冷却字段）
    const listBefore = await request(routerPort, 'GET', '/_admin/api/channel-keys?target=pooled');
    // key1 冷却 120s 未到期；直接向上游请求将命中 key2 并拿到 200——先验证单请求单 key 不重试：
    // 请求 3 命中 key2 → 200；key1 仍冷却
    const third = await request(routerPort, 'POST', '/v1/responses', responsesBody('pool-model', '请求3'));
    assert.equal(third.status, 200);
    assert.deepEqual(seenKeys, ['key1', 'key2', 'key2'], 'key1 冷却中，请求 3 仍只尝试 key2 一把');

    // 6. 全池耗尽：将 key2 的 key 值改为指向 429 上游（sk-pool-key-1）再打一次
    const swapKey = await request(routerPort, 'POST', '/_admin/api/channel-keys/update', {
      id: key2Id, key: 'sk-pool-key-1', priority: 5,
      skipVerify: true,
    });
    assert.equal(swapKey.status, 200);
    // key1 冷却中（p0），请求 4 命中 key2（p5，新值 429）→ 客户端 429，key2 记冷却
    const fourth = await request(routerPort, 'POST', '/v1/responses', responsesBody('pool-model', '请求4'));
    assert.equal(fourth.status, 429);
    assert.equal(fourth.headers['retry-after'], '120');
    // 全池耗尽：响应体必须带「key 池最早恢复时间」（计划 3.3 / 需求 4）
    const fourthBody = JSON.parse(fourth.text);
    assert.ok(fourthBody.error.retry_at, '全池耗尽响应体应含 retry_at');
    assert.ok(fourthBody.error.retry_after_seconds > 0, '全池耗尽响应体应含 retry_after_seconds');
    // key1 冷却 120s 尚未到期（除非测试运行超过 2 分钟）：池内两把全冷却
    const listAfterAll = await request(routerPort, 'GET', '/_admin/api/channel-keys?target=pooled');
    const allEntries = JSON.parse(listAfterAll.text).entries;
    assert.ok(allEntries.filter((entry) => entry.cooldown.active).length >= 2, '两把 key 均应冷却');

    // 7. 全池冷却 → envKey 兜底（POOLED_LEGACY=sk-pool-legacy，上游 429 + 文本恢复时间）
    const legacyRequest = await request(routerPort, 'POST', '/v1/responses', responsesBody('pool-model', '请求5'));
    assert.equal(legacyRequest.status, 429);
    assert.equal(legacyRequest.headers['retry-after'], '7200');
    assert.match(JSON.parse(legacyRequest.text).error.message, /retry at|quota/i, '错误信息附恢复时间');
    // 第 4 个 'key1' 是 key2 被改写后的上游标签（值 sk-pool-key-1 上游固定回 429）
    assert.deepEqual(seenKeys, ['key1', 'key2', 'key2', 'key1', 'legacy']);

    // 8. 吊销后不再参与轮换
    const revoke = await request(routerPort, 'POST', '/_admin/api/channel-keys/revoke', { id: key1Id });
    assert.equal(revoke.status, 200);
    const listAfterRevoke = await request(routerPort, 'GET', '/_admin/api/channel-keys?target=pooled');
    assert.ok(!JSON.parse(listAfterRevoke.text).entries.some((entry) => entry.id === key1Id));
  } finally {
    try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 子进程可能已自行退出 */ }
    try { await waitForChildExit(child, childExit, childOutput); } catch { /* 排空超时也继续清理 */ }
    upstream.closeAllConnections?.();
    try { await close(upstream); } catch { /* 已关闭 */ }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// 对外 API：OpenAI 标准 Chat Completions 格式必须原样透传（messages 进、chat SSE 出），
// 不得被误当成 Responses 转换（丢弃 messages / 返回 response.created 事件）
test('chat completions：任意工具接入格式原样透传', async () => {
  const receivedBodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (req.url === '/cc/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
    });
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-cc-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  const dbPath = path.join(tempDir, 'router-test.db');
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'cc-model', display_name: 'Chat 模型' }] }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    heartbeatMs: 20,
    modelContext: { enabled: false },
    supportsResponses: { slugs: ['cc-model'] },
    targets: [{
      name: 'cc',
      match: '^cc-model$',
      host: '127.0.0.1',
      port: upstream.address().port,
      protocol: 'http',
      prefix: '/cc',
      envKey: 'CC_KEY',
      wireApi: 'chat',
    }],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      ROUTER_HEARTBEAT_MS: '20',
      CODEX_CATALOG_PATH: catalogPath,
      ROUTER_DB_PATH: dbPath,
      CC_KEY: 'sk-cc-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  try {
    await waitUntilHealthy(routerPort, child);
    const res = await request(routerPort, 'POST', '/v1/chat/completions', {
      model: 'cc-model',
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
      max_tokens: 50,
    });
    assert.equal(res.status, 200);
    // 响应必须是 OpenAI chat SSE（choices[].delta），绝不能是 responses 事件
    assert.ok(res.text.includes('"choices"'), '应透传 chat SSE choices 帧');
    assert.ok(!res.text.includes('response.created'), '不得返回 responses 格式事件');
    assert.ok(res.text.includes('[DONE]'));
    // 上游必须收到原样 messages（未被丢弃/转换）
    assert.equal(receivedBodies.length, 1);
    assert.deepEqual(receivedBodies[0].messages, [{ role: 'user', content: '你好' }]);
    assert.equal(receivedBodies[0].stream, true);
    assert.equal(receivedBodies[0].max_tokens, 50);
  } finally {
    try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 子进程可能已自行退出 */ }
    try { await waitForChildExit(child, childExit, childOutput); } catch { /* 排空超时也继续清理 */ }
    upstream.closeAllConnections?.();
    try { await close(upstream); } catch { /* 已关闭 */ }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// 并发回归：两个请求同时命中同一通道的不同 key，key 级冷却必须各自归属，不得串号。
// （lastKeyAttempt 曾为闭包共享变量，并发下会把 A 请求的 429 冷却记到 B 请求的 key 上）
test('chat completions：非流式 JSON 响应原样透传（content-type 不误判为错误）', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/cc2/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-json-1',
        object: 'chat.completion',
        model: 'cc-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'json ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-ccjson-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  const dbPath = path.join(tempDir, 'router-test.db');
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'cc-model', display_name: 'Chat 模型' }] }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    heartbeatMs: 20,
    modelContext: { enabled: false },
    supportsResponses: { slugs: ['cc-model'] },
    targets: [{
      name: 'cc2',
      match: '^cc-model$',
      host: '127.0.0.1',
      port: upstream.address().port,
      protocol: 'http',
      prefix: '/cc2',
      envKey: 'CC2_KEY',
      wireApi: 'chat',
    }],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      ROUTER_HEARTBEAT_MS: '20',
      CODEX_CATALOG_PATH: catalogPath,
      ROUTER_DB_PATH: dbPath,
      CC2_KEY: 'sk-cc2-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  try {
    await waitUntilHealthy(routerPort, child);
    const res = await request(routerPort, 'POST', '/v1/chat/completions', {
      model: 'cc-model',
      messages: [{ role: 'user', content: '你好' }],
      stream: false,
    });
    assert.equal(res.status, 200, `应透传 200，实际 ${res.status}`);
    // 响应必须是原始 JSON（含 choices），绝不能变成 SSE 或错误体
    assert.ok(res.text.includes('"choices"'), '应透传 JSON choices 字段');
    assert.ok(res.text.includes('json ok'), '应透传 JSON 正文');
    assert.ok(res.text.includes('chatcmpl-json-1'), '应透传 JSON id');
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.object, 'chat.completion');
  } finally {
    try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 子进程可能已自行退出 */ }
    try { await waitForChildExit(child, childExit, childOutput); } catch { /* 排空超时也继续清理 */ }
    upstream.closeAllConnections?.();
    try { await close(upstream); } catch { /* 已关闭 */ }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('并发请求：key 级冷却按请求实际使用的 key 各自落库', async () => {
  const seenAuth = [];
  const upstream = http.createServer((req, res) => {
    if (req.url === '/conc/chat/completions') {
      const auth = String(req.headers.authorization || '');
      if (auth.includes('sk-conc-key-1')) {
        seenAuth.push('conc-1');
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
        res.end('{"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached"}}');
        return;
      }
      seenAuth.push('conc-2');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not found"}}');
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-keypool-conc-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  const dbPath = path.join(tempDir, 'router-test.db');
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'conc-model', display_name: '并发模型' }] }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    heartbeatMs: 20,
    modelContext: { enabled: false },
    supportsResponses: { slugs: ['conc-model'] },
    targets: [{
      name: 'conc',
      match: '^conc-model$',
      host: '127.0.0.1',
      port: upstream.address().port,
      protocol: 'http',
      prefix: '/conc',
      envKey: 'CONC_LEGACY',
      wireApi: 'chat',
    }],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      ROUTER_HEARTBEAT_MS: '20',
      CODEX_CATALOG_PATH: catalogPath,
      ROUTER_DB_PATH: dbPath,
      CONC_LEGACY: 'sk-conc-legacy',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  const responsesBody = (content) => ({
    model: 'conc-model',
    stream: true,
    input: [{ role: 'user', content: [{ type: 'input_text', text: content }] }],
  });

  try {
    await waitUntilHealthy(routerPort, child);
    // 两把同优先级 key（p0 轮询交替）：conc-1 上游 429、conc-2 上游 200
    const c1 = await request(routerPort, 'POST', '/_admin/api/channel-keys/create', {
      target: 'conc', kind: 'plaintext', label: '账号1', key: 'sk-conc-key-1', priority: 0,
      skipVerify: true,
    });
    const c2 = await request(routerPort, 'POST', '/_admin/api/channel-keys/create', {
      target: 'conc', kind: 'plaintext', label: '账号2', key: 'sk-conc-key-2', priority: 0,
      skipVerify: true,
    });
    const id1 = JSON.parse(c1.text).id;
    const id2 = JSON.parse(c2.text).id;

    // 并发两个请求（到达顺序不确定，但各自必须用各自选中的 key 记账）
    const [rA, rB] = await Promise.all([
      request(routerPort, 'POST', '/v1/responses', responsesBody('并发A')),
      request(routerPort, 'POST', '/v1/responses', responsesBody('并发B')),
    ]);
    const statuses = [rA.status, rB.status].sort();
    assert.deepEqual(statuses, [200, 429], `应恰有一个 429 一个 200，实际 ${statuses}`);
    assert.equal(seenAuth.length, 2);
    // 上游实际收到的顺序（并发到达不定）
    const used429 = seenAuth.findIndex((item) => item === 'conc-1') !== -1 ? 'conc-1' : null;
    const used200 = seenAuth.findIndex((item) => item === 'conc-2') !== -1 ? 'conc-2' : null;
    assert.ok(used429, '429 key 应被使用');

    // 冷却必须落在「实际收到 429 的那把 key」上（串号 bug 会把冷却记到另一把）
    const list = await request(routerPort, 'GET', '/_admin/api/channel-keys?target=conc');
    const entries = JSON.parse(list.text).entries;
    const cooled = entries.filter((entry) => entry.cooldown.active);
    assert.equal(cooled.length, 1, `应恰好一把冷却，实际 ${cooled.length} 把`);
    const expectedCooledId = used429 === 'conc-1' ? id1 : id2;
    assert.equal(cooled[0].id, expectedCooledId, `冷却必须归属 429 请求实际使用的 key，期望 ${used429}`);
    assert.equal(entries.find((entry) => entry.id === (used429 === 'conc-1' ? id2 : id1)).cooldown.active, false, '另一把 key 不得被误冷却');

    // 清理后下一请求仍可用另一把 key（200 成功）
    const next = await request(routerPort, 'POST', '/v1/responses', responsesBody('并发后续'));
    assert.equal(next.status, 200, '未被误冷却的 key 应继续可用');
  } finally {
    try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 子进程可能已自行退出 */ }
    try { await waitForChildExit(child, childExit, childOutput); } catch { /* 排空超时也继续清理 */ }
    upstream.closeAllConnections?.();
    try { await close(upstream); } catch { /* 已关闭 */ }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
