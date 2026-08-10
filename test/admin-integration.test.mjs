import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
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

function request(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.setTimeout(3_000, () => req.destroy(new Error(`请求超时：${method} ${requestPath}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitUntilHealthy(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`隔离路由提前退出，code=${child.exitCode}`);
    try {
      if ((await request(port, 'GET', '/healthz')).status === 200) return;
    } catch { /* 隔离进程尚未监听 */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('隔离路由健康检查超时');
}

test('隔离路由提供本地管理页和脱敏管理 API', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-admin-'));
  const routerPort = await freePort();
  const configPath = path.join(tempDir, 'config.json');
  const catalogPath = path.join(tempDir, 'models.json');
  const staticSecret = 'Bearer admin-integration-secret';
  await fs.writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'admin-test-model' }] }));
  await fs.writeFile(configPath, JSON.stringify({
    port: routerPort,
    modelContext: { enabled: false },
    targets: [{
      name: 'admin-test',
      match: '^admin-test-model$',
      host: '127.0.0.1',
      port: 9,
      protocol: 'http',
      prefix: '',
      envKey: 'ADMIN_TEST_KEY',
      wireApi: 'chat',
      headers: { authorization: staticSecret, 'x-tenant': 'local' },
    }],
  }));

  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      ROUTER_CONFIG_PATH: configPath,
      ROUTER_PORT: String(routerPort),
      CODEX_CATALOG_PATH: catalogPath,
      ADMIN_TEST_KEY: 'admin-test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk; });
  child.stderr.on('data', (chunk) => { childOutput += chunk; });

  try {
    await waitUntilHealthy(routerPort, child);

    const page = await request(routerPort, 'GET', '/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.text, /Codex.*路由/u);
    const assetReferences = [...page.text.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((match) => new URL(match[1], `http://127.0.0.1:${routerPort}/admin`).pathname)
      .filter((assetPath) => assetPath.endsWith('.css') || assetPath.endsWith('.js'));
    assert.deepEqual(assetReferences, ['/admin/styles.css', '/admin/app.js']);
    for (const assetPath of assetReferences) {
      assert.equal((await request(routerPort, 'GET', assetPath)).status, 200);
    }

    const status = await request(routerPort, 'GET', '/_admin/api/status');
    assert.equal(status.status, 200);
    const statusBody = JSON.parse(status.text);
    assert.equal(statusBody.port, routerPort);
    assert.equal(statusBody.targets[0].envSet, true);
    assert.doesNotMatch(status.text, /admin-test-key|admin-integration-secret/);

    const config = await request(routerPort, 'GET', '/_admin/api/config');
    assert.equal(config.status, 200);
    const configBody = JSON.parse(config.text);
    assert.match(configBody.config.targets[0].headers.authorization.$preserveSecret, /^[a-f0-9-]+$/);
    assert.equal(configBody.config.targets[0].headers['x-tenant'], 'local');
    assert.doesNotMatch(config.text, /admin-integration-secret/);
  } finally {
    if (child.exitCode === null) {
      try { await request(routerPort, 'POST', '/_admin/shutdown'); } catch { /* 子进程可能已自行退出 */ }
    }
    let exitTimer;
    try {
      await Promise.race([
        childExit,
        new Promise((_, reject) => {
          exitTimer = setTimeout(() => reject(new Error(`隔离路由未优雅退出：${childOutput}`)), 3_000);
        }),
      ]);
    } finally {
      clearTimeout(exitTimer);
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
