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
    try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 子进程可能已自行退出 */ }
    if (child.exitCode === null) {
      await Promise.race([
        childExit,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`隔离路由未优雅退出：${childOutput}`)), 2_000)),
      ]);
    }
    upstream.closeAllConnections?.();
    await close(upstream);
    await fs.rm(tempDir, { recursive: true, force: true });
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
    try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 子进程可能已自行退出 */ }
    if (child.exitCode === null) {
      await Promise.race([
        childExit,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`隔离路由未优雅退出：${childOutput}`)), 2_000)),
      ]);
    }
    upstream.closeAllConnections?.();
    await close(upstream);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
