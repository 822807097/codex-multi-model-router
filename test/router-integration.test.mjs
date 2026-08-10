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
// 隔离子进程显式开启测试专用关闭端点；正常运行实例不会暴露进程控制。
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
    const startedAt = Date.now();
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
      res.on('data', (chunk) => chunks.push({ at: Date.now() - startedAt, text: chunk.toString('utf8') }));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks, text: chunks.map((item) => item.text).join('') }));
      res.once('aborted', () => reject(new Error(`响应提前关闭: ${method} ${requestPath}`)));
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

async function cleanupIsolatedRouter({ routerPort, child, childExit, childOutput, upstream, tempDir }) {
  let cleanupError = null;
  try {
    try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 子进程可能已自行退出 */ }
    await waitForChildExit(child, childExit, childOutput);
  } catch (error) {
    cleanupError = error;
  } finally {
    // 即使优雅退出回归，也必须先关闭 mock 连接并删除临时配置，避免测试永久挂住或污染后续用例。
    upstream.closeAllConnections?.();
    try { await close(upstream); } catch (error) { cleanupError ||= error; }
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch (error) { cleanupError ||= error; }
  }
  // mock 连接关闭后，正在排空的隔离路由通常即可退出；再给它一次有界等待机会。
  if (child.exitCode === null) {
    try { await waitForChildExit(child, childExit, childOutput); } catch (error) { cleanupError = error; }
  }
  if (cleanupError) throw cleanupError;
}

test('非法配置在监听端口前聚合失败', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-invalid-config-'));
  const routerPort = await freePort();
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    heartbeatMs: 'bad',
    targets: [{ name: '', match: '(', host: '' }],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: { ...process.env, ROUTER_CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  try {
    const outcome = await Promise.race([
      childExit.then(([exitCode]) => ({ type: 'exit', exitCode })),
      waitUntilHealthy(routerPort, child).then(() => ({ type: 'listening' })),
    ]);
    assert.equal(outcome.type, 'exit', `非法配置不应开始监听：${childOutput}`);
    assert.notEqual(outcome.exitCode, 0);
    assert.match(childOutput, /heartbeat_invalid/);
    assert.match(childOutput, /target_name_invalid/);
    assert.match(childOutput, /target_match_invalid/);
    assert.doesNotMatch(childOutput, /SyntaxError|RouterConfigError/);
  } finally {
    if (child.exitCode === null) {
      try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 未监听时无需关闭 */ }
      await waitForChildExit(child, childExit, childOutput);
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('隔离路由完成心跳、failover、工具历史和 compact 拒绝', async () => {
  const captured = [];
  let primaryRequests = 0;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/primary/chat/completions') {
        primaryRequests += 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"temporary"}');
        return;
      }
      captured.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => {
        if (captured.length === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_custom","function":{"name":"apply_patch","arguments":"{\\"input\\":\\"patch\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n');
        }
        res.end('data: [DONE]\n\n');
      }, 80);
    });
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-test-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'test-model' }] }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    heartbeatMs: 20,
    modelContext: { enabled: false },
    modelCapabilities: [{ match: '^test-model$', contextWindow: 16_000, maxOutputTokens: 1_000 }],
    supportsResponses: { slugs: ['test-model'] },
    targets: [
      { name: 'primary', match: '^test-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/primary', envKey: 'TEST_ROUTER_KEY', wireApi: 'chat' },
      { name: 'backup', match: '^test-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/backup', envKey: 'TEST_ROUTER_KEY', wireApi: 'chat' },
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
      TEST_ROUTER_KEY: 'test-only-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  try {
    await waitUntilHealthy(routerPort, child);
    const models = await request(routerPort, 'GET', '/v1/models');
    assert.deepEqual(JSON.parse(models.text).data[0].capabilities, { streaming: true });

    const compact = await request(routerPort, 'POST', '/v1/responses/compact', { model: 'test-model', input: 'x' });
    assert.equal(compact.status, 400);

    const first = await request(routerPort, 'POST', '/v1/responses', {
      model: 'test-model',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '执行补丁' }] }],
      tools: [{ type: 'custom', name: 'apply patch' }],
    });
    assert.equal(first.status, 200);
    assert.match(first.text, /: keep-alive/);
    assert.ok(first.text.indexOf(': keep-alive') < first.text.indexOf('response.created'));
    const completedLine = first.text.split(/\r?\n/).find((line) => line.includes('"type":"response.completed"'));
    const completed = JSON.parse(completedLine.slice('data: '.length));
    assert.equal(completed.response.output[0].type, 'custom_tool_call');

    const second = await request(routerPort, 'POST', '/v1/responses', {
      model: 'test-model',
      stream: true,
      previous_response_id: completed.response.id,
      input: [{ type: 'custom_tool_call_output', call_id: 'call_custom', output: 'Done' }],
      tools: [{ type: 'custom', name: 'apply patch' }],
    });
    assert.match(second.text, /"delta":"ok"/);
    assert.equal(primaryRequests, 1);
    assert.equal(captured.length, 2);
    const toolCallMessage = captured[1].messages.find((message) => message.role === 'assistant' && message.tool_calls);
    assert.equal(toolCallMessage.tool_calls[0].id, 'call_custom');
    assert.equal(toolCallMessage.tool_calls[0].function.name, 'apply_patch');
    assert.ok(captured[1].messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_custom'));
  } finally {
    await cleanupIsolatedRouter({ routerPort, child, childExit, childOutput, upstream, tempDir });
  }
});

const CHECKPOINT_A = `目标\n完成跨模型任务\n\n硬性约束\n零依赖，不部署\n\n已完成\nA阶段完成\n\n进行中\n跨模型接力\n\n待完成\nB阶段\n\n关键决定\n使用任务检查点\n\n当前工作集\ncodex-router.mjs\n\n失败与原因\n无\n\n下一步\n切换模型B`;
const CHECKPOINT_B = `目标\n完成跨模型任务\n\n硬性约束\n零依赖，不部署\n\n已完成\nA阶段完成，B已接力\n\n进行中\n验证\n\n待完成\n完整回归\n\n关键决定\n供应商私有状态不迁移\n\n当前工作集\ncodex-router.mjs\n\n失败与原因\n无\n\n下一步\n运行测试`;
const CHECKPOINT_C = `目标\n完成跨模型任务\n\n硬性约束\n零依赖，不部署\n\n已完成\nC阶段摘要重试成功\n\n进行中\n验证\n\n待完成\n完整回归\n\n关键决定\n失败降级不污染精确缓存\n\n当前工作集\ncodex-router.mjs\n\n失败与原因\n首次摘要返回500\n\n下一步\n运行测试`;

test('裁剪时生成目标检查点并在同一任务跨模型接力', async () => {
  const captured = [];
  let cSummaryAttempts = 0;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      captured.push({ path: req.url, body });
      if (body.stream === false) {
        if (req.url.startsWith('/c/') && cSummaryAttempts++ === 0) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":"summary unavailable"}');
          return;
        }
        const checkpoint = req.url.startsWith('/a/')
          ? CHECKPOINT_A
          : req.url.startsWith('/c/') ? CHECKPOINT_C : CHECKPOINT_B;
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: checkpoint } }] }));
        }, 60);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      }, 20);
    });
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-checkpoint-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(catalogPath, JSON.stringify({
    models: [{ slug: 'checkpoint-a' }, { slug: 'checkpoint-b' }, { slug: 'checkpoint-c' }],
  }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    heartbeatMs: 20,
    modelContext: { enabled: false },
    goalCheckpoint: {
      enabled: true,
      maxEntries: 8,
      ttlMs: 60_000,
      sourceTokenBudget: 20_000,
      sourceWindowRatio: 0.5,
      maxOutputTokens: 512,
      requestMs: 2_000,
    },
    modelCapabilities: [
      { match: '^checkpoint-', contextWindow: 2_200, maxOutputTokens: 300, safetyRatio: 0.9, protocolReserveTokens: 100 },
    ],
    supportsResponses: { slugs: ['checkpoint-a', 'checkpoint-b', 'checkpoint-c'] },
    targets: [
      { name: 'provider-a', match: '^checkpoint-a$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/a', envKey: 'TEST_ROUTER_KEY', wireApi: 'chat' },
      { name: 'provider-b', match: '^checkpoint-b$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/b', envKey: 'TEST_ROUTER_KEY', wireApi: 'chat' },
      { name: 'provider-c', match: '^checkpoint-c$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/c', envKey: 'TEST_ROUTER_KEY', wireApi: 'chat' },
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
      TEST_ROUTER_KEY: 'test-only-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  const oldHistory = '旧历史'.repeat(1_100);
  const sessionHeaders = { 'x-codex-session-id': 'task-switch-1' };
  const inputFor = (latest) => [
    { role: 'developer', content: [{ type: 'input_text', text: '必须零依赖，禁止部署' }] },
    { role: 'user', content: [{ type: 'input_text', text: `/goal 完成跨模型任务\n${oldHistory}` }] },
    { role: 'assistant', content: [{ type: 'output_text', text: oldHistory }] },
    { role: 'user', content: [{ type: 'input_text', text: latest }] },
  ];

  try {
    await waitUntilHealthy(routerPort, child);
    const models = await request(routerPort, 'GET', '/v1/models');
    assert.deepEqual(JSON.parse(models.text).data.map((item) => item.id), ['checkpoint-a', 'checkpoint-b', 'checkpoint-c']);

    const first = await request(routerPort, 'POST', '/v1/responses', {
      model: 'checkpoint-a',
      stream: true,
      input: inputFor('模型A最新请求'),
    }, sessionHeaders);
    assert.equal(first.status, 200);
    assert.match(first.text, /: keep-alive/);
    assert.ok(first.text.indexOf(': keep-alive') < first.text.indexOf('response.created'));
    const completedLine = first.text.split(/\r?\n/).find((line) => line.includes('"type":"response.completed"'));
    const firstResponse = JSON.parse(completedLine.slice('data: '.length)).response;

    const second = await request(routerPort, 'POST', '/v1/responses', {
      model: 'checkpoint-b',
      stream: true,
      previous_response_id: firstResponse.id,
      prompt_cache_key: 'provider-a-private-cache',
      input: inputFor('模型B继续同一任务'),
    }, sessionHeaders);
    assert.equal(second.status, 200);
    const secondCompletedLine = second.text.split(/\r?\n/).find((line) => line.includes('"type":"response.completed"'));
    const secondResponse = JSON.parse(secondCompletedLine.slice('data: '.length)).response;

    const third = await request(routerPort, 'POST', '/v1/responses', {
      model: 'checkpoint-c',
      stream: true,
      previous_response_id: secondResponse.id,
      input: inputFor('模型C在摘要失败后继续任务'),
    }, sessionHeaders);
    assert.equal(third.status, 200);
    const thirdCompletedLine = third.text.split(/\r?\n/).find((line) => line.includes('"type":"response.completed"'));
    const thirdResponse = JSON.parse(thirdCompletedLine.slice('data: '.length)).response;

    const fourth = await request(routerPort, 'POST', '/v1/responses', {
      model: 'checkpoint-c',
      stream: true,
      previous_response_id: thirdResponse.id,
      input: inputFor('模型C在摘要失败后继续任务'),
    }, sessionHeaders);
    assert.equal(fourth.status, 200);

    const summaryA = captured.find((item) => item.path === '/a/chat/completions' && item.body.stream === false);
    const mainA = captured.find((item) => item.path === '/a/chat/completions' && item.body.stream === true);
    const summaryB = captured.find((item) => item.path === '/b/chat/completions' && item.body.stream === false);
    const mainB = captured.find((item) => item.path === '/b/chat/completions' && item.body.stream === true);
    const summariesC = captured.filter((item) => item.path === '/c/chat/completions' && item.body.stream === false);
    const mainsC = captured.filter((item) => item.path === '/c/chat/completions' && item.body.stream === true);
    assert.ok(summaryA);
    assert.ok(mainA);
    assert.ok(summaryB);
    assert.ok(mainB);
    assert.equal(summariesC.length, 2);
    assert.equal(mainsC.length, 2);
    assert.match(summaryA.body.messages.at(-1).content, /完成跨模型任务/);
    assert.match(summaryB.body.messages.at(-1).content, /A阶段完成/);
    assert.ok(mainA.body.messages.some((message) => message.role === 'assistant' && /Codex 持续目标执行检查点/.test(message.content)));
    assert.ok(mainB.body.messages.some((message) => message.role === 'assistant' && /A阶段完成，B已接力/.test(message.content)));
    assert.ok(mainB.body.messages.some((message) => message.role === 'user' && /模型B继续同一任务/.test(message.content)));
    assert.equal(mainB.body.previous_response_id, undefined);
    assert.equal(mainB.body.prompt_cache_key, undefined);
    assert.ok(mainsC[0].body.messages.some((message) => message.role === 'assistant' && /A阶段完成，B已接力/.test(message.content)));
    assert.ok(mainsC[0].body.messages.some((message) => message.role === 'user' && /模型C在摘要失败后继续任务/.test(message.content)));
    assert.ok(mainsC[1].body.messages.some((message) => message.role === 'assistant' && /C阶段摘要重试成功/.test(message.content)));
  } finally {
    await cleanupIsolatedRouter({ routerPort, child, childExit, childOutput, upstream, tempDir });
  }
});

test('自定义 openai 名称不启用 ChatGPT 登录态并拒绝未知或畸形请求', async () => {
  const captured = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_upstream","status":"completed","output":[]}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
    });
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-policy-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  const missingAuthPath = path.join(tempDir, 'missing-auth.json');
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'custom-openai-model' }] }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    modelContext: { enabled: false },
    targets: [{
      name: 'openai',
      platform: 'openai',
      match: '^custom-openai-model$',
      host: '127.0.0.1',
      port: upstream.address().port,
      protocol: 'http',
      envKey: 'TEST_ROUTER_KEY',
      wireApi: 'responses',
    }],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      CODEX_CATALOG_PATH: catalogPath,
      CODEX_AUTH_PATH: missingAuthPath,
      TEST_ROUTER_KEY: 'test-only-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  try {
    await waitUntilHealthy(routerPort, child);
    const routed = await request(routerPort, 'POST', '/v1/responses', {
      model: 'custom-openai-model',
      stream: true,
      max_output_tokens: 123,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '测试策略' }] }],
    }, {
      cookie: 'private-cookie=1',
      'chatgpt-account-id': 'private-account',
      'x-codex-session-id': 'private-session',
    });
    assert.equal(routed.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].headers.authorization, 'Bearer test-only-key');
    assert.equal(captured[0].headers.cookie, undefined);
    assert.equal(captured[0].headers['chatgpt-account-id'], undefined);
    assert.equal(captured[0].headers['x-codex-session-id'], undefined);
    assert.equal(captured[0].body.max_output_tokens, 123);
    assert.equal(captured[0].body.store, undefined);

    const unknown = await request(routerPort, 'POST', '/v1/responses', {
      model: 'custom-openai-model-typo',
      stream: true,
      input: '不能误投',
    });
    assert.equal(unknown.status, 400);
    assert.equal(JSON.parse(unknown.text).error.code, 'unknown_model');
    assert.equal(captured.length, 1);

    const malformed = await request(routerPort, 'POST', '/v1/responses', {
      model: 'custom-openai-model',
      stream: true,
      previous_response_id: 123,
      input: '畸形 previous id',
    });
    assert.equal(malformed.status, 400);
    assert.equal(JSON.parse(malformed.text).error.code, 'invalid_request');
    assert.equal(captured.length, 1);
  } finally {
    await cleanupIsolatedRouter({ routerPort, child, childExit, childOutput, upstream, tempDir });
  }
});

test('跨 wire API 或未知供应商状态域只在完整历史下移除私有 response id', async () => {
  const nativeBodies = [];
  const chatBodies = [];
  const mixedChatBodies = [];
  let mixedNativeRequests = 0;
  let sameARequests = 0;
  const sameABodies = [];
  const sameBBodies = [];
  const sharedStateBodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/chat/chat/completions') {
        chatBodies.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'data: {"choices":[{"delta":{"content":"阶段完成"},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'));
        return;
      }
      if (req.url === '/mixed-chat/chat/completions') {
        mixedChatBodies.push(body);
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"temporary"}');
        return;
      }
      if (req.url === '/same-a/responses') {
        sameABodies.push(body);
        sameARequests += 1;
        const latestText = body.input?.at(-1)?.content;
        if (latestText === '携带完整历史安全续接' || body.previous_response_id === 'resp_same') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":"temporary"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_same","status":"completed","output":[]}}',
          '',
        ].join('\n'));
        return;
      }
      if (req.url === '/shared-state/responses') {
        sharedStateBodies.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_shared","status":"completed","output":[]}}',
          '',
        ].join('\n'));
        return;
      }
      if (req.url === '/same-b/responses') {
        sameBBodies.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_same_b","status":"completed","output":[]}}',
          '',
        ].join('\n'));
        return;
      }
      if (req.url === '/collision-a/responses') {
        if (body.metadata?.conversation_id === 'collision-task-b') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end('{"error":"use collision backup"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_collision","status":"completed","output":[{"type":"function_call","call_id":"call_collision_a","name":"tool_a","arguments":"{}"}]}}',
          '',
        ].join('\n'));
        return;
      }
      if (req.url === '/collision-b/responses') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_collision","status":"completed","output":[{"type":"function_call","call_id":"call_collision_b","name":"tool_b","arguments":"{}"}]}}',
          '',
        ].join('\n'));
        return;
      }
      if (req.url === '/mixed-native/responses') mixedNativeRequests += 1;
      nativeBodies.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_native","status":"completed","output":[{"type":"function_call","call_id":"call_native","name":"native_tool","arguments":"{}"}]}}',
        '',
      ].join('\n'));
    });
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-cross-wire-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'chat-model' }, { slug: 'native-model' }, { slug: 'mixed-model' }, { slug: 'same-wire-model' }, { slug: 'shared-state-model' }, { slug: 'collision-model' }] }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    modelContext: { enabled: false },
    targets: [
      { name: 'chat', match: '^chat-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/chat', envKey: 'TEST_ROUTER_KEY', wireApi: 'chat' },
      { name: 'native', match: '^native-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/native', envKey: 'TEST_ROUTER_KEY', wireApi: 'responses' },
      { name: 'mixed-chat', match: '^mixed-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/mixed-chat', envKey: 'TEST_ROUTER_KEY', wireApi: 'chat' },
      { name: 'mixed-native', match: '^mixed-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/mixed-native', envKey: 'TEST_ROUTER_KEY', wireApi: 'responses' },
      { name: 'same-a', match: '^same-wire-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/same-a', envKey: 'TEST_ROUTER_KEY', wireApi: 'responses' },
      { name: 'same-b', match: '^same-wire-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/same-b', envKey: 'TEST_ROUTER_KEY', wireApi: 'responses' },
      { name: 'shared-a', match: '^shared-state-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/shared-state', envKey: 'TEST_ROUTER_KEY', wireApi: 'responses', stateDomain: 'shared-test' },
      { name: 'shared-b', match: '^shared-state-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/unused-shared-backup', envKey: 'TEST_ROUTER_KEY', wireApi: 'responses', stateDomain: 'shared-test' },
      { name: 'collision-a', match: '^collision-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/collision-a', envKey: 'TEST_ROUTER_KEY', wireApi: 'responses' },
      { name: 'collision-b', match: '^collision-model$', host: '127.0.0.1', port: upstream.address().port, protocol: 'http', prefix: '/collision-b', envKey: 'TEST_ROUTER_KEY', wireApi: 'responses' },
    ],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      CODEX_CATALOG_PATH: catalogPath,
      TEST_ROUTER_KEY: 'test-only-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  try {
    await waitUntilHealthy(routerPort, child);
    const first = await request(routerPort, 'POST', '/v1/responses', {
      model: 'chat-model',
      stream: true,
      input: [{ role: 'user', content: '完成第一阶段' }],
    });
    const completedLine = first.text.split(/\r?\n/).find((line) => line.includes('"type":"response.completed"'));
    const localResponseId = JSON.parse(completedLine.slice('data: '.length)).response.id;

    const completeHistory = await request(routerPort, 'POST', '/v1/responses', {
      model: 'native-model',
      stream: true,
      previous_response_id: localResponseId,
      prompt_cache_key: 'chat-private-cache',
      input: [
        { role: 'user', content: '完成第一阶段' },
        { role: 'assistant', content: '阶段完成' },
        { role: 'user', content: '继续第二阶段' },
      ],
    });
    assert.equal(completeHistory.status, 200);
    assert.equal(nativeBodies.length, 1);
    assert.equal(nativeBodies[0].previous_response_id, undefined);
    assert.equal(nativeBodies[0].prompt_cache_key, undefined);

    const chatRequestsBeforeInvalidSwitch = chatBodies.length;
    const invalidSwitchBack = await request(routerPort, 'POST', '/v1/responses', {
      model: 'chat-model',
      stream: true,
      previous_response_id: 'resp_native',
      input: [{ role: 'user', content: '只有最新普通增量' }],
    });
    assert.equal(invalidSwitchBack.status, 400);
    assert.equal(JSON.parse(invalidSwitchBack.text).error.code, 'cross_protocol_state_unavailable');
    assert.equal(chatBodies.length, chatRequestsBeforeInvalidSwitch);

    const switchBack = await request(routerPort, 'POST', '/v1/responses', {
      model: 'chat-model',
      stream: true,
      previous_response_id: 'resp_native',
      input: [{ type: 'function_call_output', call_id: 'call_native', output: 'native done' }],
      tools: [{ type: 'function', name: 'native_tool', parameters: { type: 'object', properties: {} } }],
    });
    assert.equal(switchBack.status, 200);
    const restoredNativeCall = chatBodies.at(-1).messages.find((message) => (
      message.role === 'assistant' && message.tool_calls?.[0]?.id === 'call_native'
    ));
    assert.ok(restoredNativeCall);
    assert.ok(chatBodies.at(-1).messages.some((message) => (
      message.role === 'tool' && message.tool_call_id === 'call_native'
    )));

    const incrementalOnly = await request(routerPort, 'POST', '/v1/responses', {
      model: 'native-model',
      stream: true,
      previous_response_id: localResponseId,
      input: [{ role: 'user', content: '只有最新增量' }],
    });
    assert.equal(incrementalOnly.status, 400);
    assert.equal(JSON.parse(incrementalOnly.text).error.code, 'cross_protocol_state_unavailable');
    assert.equal(nativeBodies.length, 1);

    const mixed = await request(routerPort, 'POST', '/v1/responses', {
      model: 'mixed-model',
      stream: true,
      input: [{ role: 'user', content: '不同协议不能自动 failover' }],
    });
    assert.equal(mixed.status, 200);
    assert.match(mixed.text, /"type":"error"/);
    assert.equal(mixedNativeRequests, 0);
    assert.equal(mixedChatBodies.length, 1);

    const mixedUnknownIncremental = await request(routerPort, 'POST', '/v1/responses', {
      model: 'mixed-model',
      stream: true,
      previous_response_id: 'resp_mixed_unknown',
      prompt_cache_key: 'mixed-private-cache',
      input: [{ role: 'user', content: '混合协议只有未知 ID 的最新增量' }],
    });
    assert.equal(mixedUnknownIncremental.status, 400);
    assert.match(mixedUnknownIncremental.headers['content-type'], /application\/json/);
    assert.equal(JSON.parse(mixedUnknownIncremental.text).error.code, 'cross_protocol_state_unavailable');
    assert.equal(mixedChatBodies.length, 1);
    assert.equal(mixedNativeRequests, 0);

    const mixedUnknownComplete = await request(routerPort, 'POST', '/v1/responses', {
      model: 'mixed-model',
      stream: true,
      previous_response_id: 'resp_mixed_unknown',
      prompt_cache_key: 'mixed-private-cache',
      input: [
        { role: 'user', content: '混合协议旧任务' },
        { role: 'assistant', content: '旧任务已完成一阶段' },
        { role: 'user', content: '携带完整历史继续' },
      ],
    });
    assert.equal(mixedUnknownComplete.status, 200);
    assert.match(mixedUnknownComplete.text, /"type":"error"/);
    assert.equal(mixedChatBodies.length, 2);
    assert.equal(mixedChatBodies.at(-1).previous_response_id, undefined);
    assert.equal(mixedChatBodies.at(-1).prompt_cache_key, undefined);
    assert.equal(mixedNativeRequests, 0);

    const unknownIncremental = await request(routerPort, 'POST', '/v1/responses', {
      model: 'same-wire-model',
      stream: true,
      previous_response_id: 'resp_unknown',
      prompt_cache_key: 'unknown-private-cache',
      input: [{ role: 'user', content: '只有未知 response id 的最新增量' }],
    });
    assert.equal(unknownIncremental.status, 400);
    assert.match(unknownIncremental.headers['content-type'], /application\/json/);
    assert.equal(JSON.parse(unknownIncremental.text).error.code, 'cross_protocol_state_unavailable');
    assert.equal(sameABodies.length, 0);
    assert.equal(sameBBodies.length, 0);

    const unknownComplete = await request(routerPort, 'POST', '/v1/responses', {
      model: 'same-wire-model',
      stream: true,
      previous_response_id: 'resp_unknown',
      prompt_cache_key: 'unknown-private-cache',
      input: [
        { role: 'user', content: '建立供应商 A 状态' },
        { role: 'assistant', content: '已建立' },
        { role: 'user', content: '携带完整历史安全续接' },
      ],
    });
    assert.equal(unknownComplete.status, 200);
    assert.equal(sameABodies.length, 1);
    assert.equal(sameABodies[0].previous_response_id, undefined);
    assert.equal(sameABodies[0].prompt_cache_key, undefined);
    assert.equal(sameBBodies.length, 1);
    assert.equal(sameBBodies[0].previous_response_id, undefined);
    assert.equal(sameBBodies[0].prompt_cache_key, undefined);

    const sharedStateIncremental = await request(routerPort, 'POST', '/v1/responses', {
      model: 'shared-state-model',
      stream: true,
      previous_response_id: 'resp_shared_unknown',
      prompt_cache_key: 'shared-private-cache',
      input: [{ role: 'user', content: '显式共享状态域仍可继续' }],
    });
    assert.equal(sharedStateIncremental.status, 200);
    assert.equal(sharedStateBodies.length, 1);
    assert.equal(sharedStateBodies[0].previous_response_id, 'resp_shared_unknown');
    assert.equal(sharedStateBodies[0].prompt_cache_key, 'shared-private-cache');

    const establishSameA = await request(routerPort, 'POST', '/v1/responses', {
      model: 'same-wire-model',
      stream: true,
      input: [{ role: 'user', content: '建立供应商 A 状态' }],
    });
    assert.equal(establishSameA.status, 200);
    assert.equal(sameABodies.length, 2);

    const unsafeSameWire = await request(routerPort, 'POST', '/v1/responses', {
      model: 'same-wire-model',
      stream: true,
      previous_response_id: 'resp_same',
      prompt_cache_key: 'same-a-private-cache',
      input: [{ role: 'user', content: '只有最新增量' }],
    });
    assert.equal(unsafeSameWire.status, 400);
    assert.equal(JSON.parse(unsafeSameWire.text).error.code, 'cross_protocol_state_unavailable');
    assert.equal(sameBBodies.length, 1);

    const safeSameWire = await request(routerPort, 'POST', '/v1/responses', {
      model: 'same-wire-model',
      stream: true,
      previous_response_id: 'resp_same',
      prompt_cache_key: 'same-a-private-cache',
      input: [
        { role: 'user', content: '建立供应商 A 状态' },
        { role: 'assistant', content: '已建立' },
        { role: 'user', content: '用完整历史切换' },
      ],
    });
    assert.equal(safeSameWire.status, 200);
    assert.equal(sameBBodies.length, 2);
    assert.equal(sameBBodies.at(-1).previous_response_id, undefined);
    assert.equal(sameBBodies.at(-1).prompt_cache_key, undefined);

    for (const conversationId of ['collision-task-a', 'collision-task-b']) {
      const established = await request(routerPort, 'POST', '/v1/responses', {
        model: 'collision-model',
        stream: true,
        metadata: { conversation_id: conversationId },
        input: [{ role: 'user', content: `建立 ${conversationId} 的工具状态` }],
      });
      assert.equal(established.status, 200);
      assert.match(established.text, /"id":"resp_collision"/);
    }

    const chatCountBeforeCollisionRestore = chatBodies.length;
    const restoreCollision = async (suffix) => request(routerPort, 'POST', '/v1/responses', {
      model: 'chat-model',
      stream: true,
      previous_response_id: 'resp_collision',
      metadata: { conversation_id: `collision-task-${suffix}` },
      input: [{ type: 'function_call_output', call_id: `call_collision_${suffix}`, output: `${suffix} done` }],
      tools: [{ type: 'function', name: `tool_${suffix}`, parameters: { type: 'object', properties: {} } }],
    });
    assert.equal((await restoreCollision('a')).status, 200);
    assert.equal((await restoreCollision('b')).status, 200);
    const restoredCollisionBodies = chatBodies.slice(chatCountBeforeCollisionRestore);
    assert.equal(restoredCollisionBodies[0].messages.find((message) => message.tool_calls)?.tool_calls[0].function.name, 'tool_a');
    assert.equal(restoredCollisionBodies[1].messages.find((message) => message.tool_calls)?.tool_calls[0].function.name, 'tool_b');

    const chatCountBeforeAmbiguous = chatBodies.length;
    const ambiguousCollision = await request(routerPort, 'POST', '/v1/responses', {
      model: 'chat-model',
      stream: true,
      previous_response_id: 'resp_collision',
      input: [{ type: 'function_call_output', call_id: 'call_collision_b', output: 'unknown task' }],
    });
    assert.equal(ambiguousCollision.status, 400);
    assert.equal(JSON.parse(ambiguousCollision.text).error.code, 'ambiguous_response_id');
    assert.equal(chatBodies.length, chatCountBeforeAmbiguous);
  } finally {
    await cleanupIsolatedRouter({ routerPort, child, childExit, childOutput, upstream, tempDir });
  }
});

test('并发请求名额保持到流式响应结束', async () => {
  let upstreamRequests = 0;
  let releaseFirstResponse;
  let notifyFirstRequest;
  const firstRequestArrived = new Promise((resolve) => { notifyFirstRequest = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      upstreamRequests += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      const complete = () => res.end([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
      if (upstreamRequests === 1) {
        releaseFirstResponse = complete;
        notifyFirstRequest();
      } else {
        complete();
      }
    });
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-concurrency-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'limited-model' }] }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    maxConcurrentRequests: 1,
    modelContext: { enabled: false },
    targets: [{
      name: 'limited-chat',
      match: '^limited-model$',
      host: '127.0.0.1',
      port: upstream.address().port,
      protocol: 'http',
      prefix: '',
      envKey: 'TEST_ROUTER_KEY',
      wireApi: 'chat',
    }],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      CODEX_CATALOG_PATH: catalogPath,
      TEST_ROUTER_KEY: 'test-only-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  try {
    await waitUntilHealthy(routerPort, child);
    const body = {
      model: 'limited-model',
      stream: true,
      input: [{ role: 'user', content: '保持运行' }],
    };
    const first = request(routerPort, 'POST', '/v1/responses', body);
    await firstRequestArrived;
    // 给路由完成上游管线装配的机会；此时首个 SSE 仍明确保持未结束。
    await new Promise((resolve) => setTimeout(resolve, 50));

    const busy = await request(routerPort, 'POST', '/v1/responses', body);
    assert.equal(busy.status, 503);
    assert.equal(JSON.parse(busy.text).error.code, 'router_busy');
    assert.equal(upstreamRequests, 1);

    releaseFirstResponse();
    assert.equal((await first).status, 200);
    assert.equal((await request(routerPort, 'POST', '/v1/responses', body)).status, 200);
    assert.equal(upstreamRequests, 2);
  } finally {
    releaseFirstResponse?.();
    await cleanupIsolatedRouter({ routerPort, child, childExit, childOutput, upstream, tempDir });
  }
});

test('同一任务的新请求无需裁剪时仍阻止旧摘要晚到覆盖进度', async () => {
  let releaseOldSummary;
  let oldSummaryReleased = false;
  let notifyOldSummary;
  const oldSummaryArrived = new Promise((resolve) => { notifyOldSummary = resolve; });
  const summaryBodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/native/responses') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_newer_native","status":"completed","output":[]}}',
          '',
        ].join('\n'));
        return;
      }
      if (body.stream === false) {
        summaryBodies.push(body);
        if (summaryBodies.length === 1) {
          releaseOldSummary = () => {
            if (oldSummaryReleased) return;
            oldSummaryReleased = true;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: CHECKPOINT_A } }] }));
          };
          notifyOldSummary();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: CHECKPOINT_B } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([
        'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'));
    });
  });
  await listen(upstream);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-checkpoint-race-'));
  const routerPort = await freePort();
  const catalogPath = path.join(tempDir, 'models.json');
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(catalogPath, JSON.stringify({
    models: [{ slug: 'checkpoint-race' }, { slug: 'checkpoint-race-native' }],
  }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    heartbeatMs: 20,
    modelContext: { enabled: false },
    goalCheckpoint: {
      enabled: true,
      maxEntries: 8,
      ttlMs: 60_000,
      sourceTokenBudget: 20_000,
      sourceWindowRatio: 0.5,
      maxOutputTokens: 512,
      requestMs: 2_000,
    },
    modelCapabilities: [
      { match: '^checkpoint-race$', contextWindow: 2_200, maxOutputTokens: 300, safetyRatio: 0.9, protocolReserveTokens: 100 },
    ],
    targets: [
      {
        name: 'checkpoint-provider',
        match: '^checkpoint-race$',
        host: '127.0.0.1',
        port: upstream.address().port,
        protocol: 'http',
        prefix: '',
        envKey: 'TEST_ROUTER_KEY',
        wireApi: 'chat',
      },
      {
        name: 'checkpoint-native-provider',
        match: '^checkpoint-race-native$',
        host: '127.0.0.1',
        port: upstream.address().port,
        protocol: 'http',
        prefix: '/native',
        envKey: 'TEST_ROUTER_KEY',
        wireApi: 'responses',
      },
    ],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      CODEX_CATALOG_PATH: catalogPath,
      TEST_ROUTER_KEY: 'test-only-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  const longInput = (history, latest) => [
    { role: 'developer', content: [{ type: 'input_text', text: '必须零依赖，禁止部署' }] },
    { role: 'user', content: [{ type: 'input_text', text: `/goal 完成跨模型任务\n${history}` }] },
    { role: 'assistant', content: [{ type: 'output_text', text: history }] },
    { role: 'user', content: [{ type: 'input_text', text: latest }] },
  ];
  const sessionHeaders = { 'x-codex-session-id': 'checkpoint-race-task' };

  try {
    await waitUntilHealthy(routerPort, child);
    const oldRequest = request(routerPort, 'POST', '/v1/responses', {
      model: 'checkpoint-race',
      stream: true,
      input: longInput('旧历史'.repeat(1_100), '旧请求等待摘要'),
    }, sessionHeaders);
    const oldRequestState = await Promise.race([
      oldSummaryArrived.then(() => ({ type: 'summary' })),
      oldRequest.then(
        (response) => ({ type: 'response', response }),
        (error) => ({ type: 'error', error }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ type: 'timeout' }), 1_000)),
    ]);
    assert.equal(
      oldRequestState.type,
      'summary',
      `旧请求未进入摘要阶段：${JSON.stringify(oldRequestState.response || oldRequestState.error?.message || oldRequestState)}；${childOutput}`,
    );

    const newer = await request(routerPort, 'POST', '/v1/responses', {
      model: 'checkpoint-race-native',
      stream: true,
      input: [{ role: 'user', content: '较新的短请求无需裁剪' }],
    }, sessionHeaders);
    assert.equal(newer.status, 200);

    releaseOldSummary();
    assert.equal((await oldRequest).status, 200);

    const followUp = await request(routerPort, 'POST', '/v1/responses', {
      model: 'checkpoint-race',
      stream: true,
      input: longInput('更新历史'.repeat(1_100), '验证缓存没有倒退'),
    }, sessionHeaders);
    assert.equal(followUp.status, 200);
    assert.equal(summaryBodies.length, 2);
    assert.doesNotMatch(JSON.stringify(summaryBodies[1]), /A阶段完成/);
  } finally {
    releaseOldSummary?.();
    await cleanupIsolatedRouter({ routerPort, child, childExit, childOutput, upstream, tempDir });
  }
});
