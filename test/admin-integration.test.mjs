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

test('管理页构建产物只引用本地资源且不提供敏感凭据输入', async () => {
  const page = await fs.readFile(path.join(PROJECT_DIR, 'web', 'index.html'), 'utf8');

  assert.match(page, /<div id="app"><\/div>/u, 'Vite 构建产物必须保留 #app 挂载点');
  assert.doesNotMatch(page, /https?:\/\//iu, '管理页不应引用外部 CDN');
  const assetReferences = [...page.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref) => ref.endsWith('.css') || ref.endsWith('.js'));
  assert.ok(assetReferences.length > 0, '管理页必须引用构建后的 JS/CSS 资源');
  for (const ref of assetReferences) {
    assert.match(ref, /^(?:\/assets\/|\.\/assets\/)[^/]+$/u, `资源必须来自本地 assets 目录: ${ref}`);
    const fileName = ref.replace(/^.*\/assets\//, '');
    await fs.access(path.join(PROJECT_DIR, 'web', 'assets', fileName));
  }
  assert.doesNotMatch(
    page,
    /<input[^>]+(?:type=["']password|(?:name|id|placeholder|value)=["'][^"']*(?:api[ _-]?key|authorization|cookie|token)[^"']*)/iu,
    '模型管理页面不能提供或暗示敏感凭据输入',
  );
});

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
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function shutdownIsolatedRouter(port, child, childExit, childOutput) {
  if (!child || child.exitCode !== null) return;
  let lastRequestError;
  for (let attempt = 0; attempt < 3 && child.exitCode === null; attempt += 1) {
    try {
      const response = await request(port, 'POST', '/_admin/shutdown');
      if (response.status === 200) break;
      lastRequestError = new Error(`隔离关闭端点返回 ${response.status}`);
    } catch (error) {
      if (child.exitCode !== null || error?.code === 'ECONNREFUSED') break;
      lastRequestError = error;
    }
    await delay(20);
  }

  if (child.exitCode === null) {
    let exitTimer;
    try {
      await Promise.race([
        childExit,
        new Promise((_, reject) => {
          exitTimer = setTimeout(() => {
            const error = new Error(`隔离路由未通过自身端点退出：${childOutput()}`);
            if (lastRequestError) error.cause = lastRequestError;
            reject(error);
          }, 3_000);
        }),
      ]);
    } finally {
      clearTimeout(exitTimer);
    }
  }
  assert.notEqual(child.exitCode, null, '隔离路由必须通过自身关闭端点退出');
}

function throwCombined(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 0) return;
  if (primaryError && cleanupErrors.length === 0) throw primaryError;
  if (!primaryError && cleanupErrors.length === 1) throw cleanupErrors[0];
  const errors = primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors;
  const aggregate = new AggregateError(errors, '隔离管理 API 测试及清理发生多个错误');
  if (primaryError) aggregate.cause = primaryError;
  throw aggregate;
}

test('隔离路由提供本地管理页和脱敏管理 API', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-admin-'));
  let routerPort;
  let child;
  let childExit;
  let childOutput = '';
  let primaryError;
  try {
    routerPort = await freePort();
    const configPath = path.join(tempDir, 'config.json');
    const catalogPath = path.join(tempDir, 'models.json');
    const staticSecret = 'Bearer admin-integration-secret';
    await fs.writeFile(catalogPath, JSON.stringify({
      models: [{
        slug: 'admin-test-model',
        display_name: 'Admin Test Model',
        input_modalities: ['text'],
      }],
    }));
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

    child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
      cwd: PROJECT_DIR,
      env: {
        ...process.env,
        ROUTER_TEST_SHUTDOWN: '1',
        ROUTER_CONFIG_PATH: configPath,
        ROUTER_PORT: String(routerPort),
        CODEX_CATALOG_PATH: catalogPath,
        ADMIN_TEST_KEY: 'admin-test-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childExit = once(child, 'exit');
    child.stdout.on('data', (chunk) => { childOutput += chunk; });
    child.stderr.on('data', (chunk) => { childOutput += chunk; });

    await waitUntilHealthy(routerPort, child);

    const page = await request(routerPort, 'GET', '/admin');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.text, /Codex.*路由/u);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    const assetReferences = [...page.text.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((match) => new URL(match[1], `http://127.0.0.1:${routerPort}/admin`).pathname)
      .filter((assetPath) => assetPath.endsWith('.css') || assetPath.endsWith('.js'));
    assert.ok(assetReferences.length > 0, '管理页必须引用构建后的 JS/CSS 资源');
    for (const assetPath of assetReferences) {
      assert.match(assetPath, /^\/assets\/[^/]+$/u, `资源必须来自本地 assets 目录: ${assetPath}`);
    }
    for (const assetPath of assetReferences) {
      const assetResponse = await request(routerPort, 'GET', assetPath);
      assert.equal(assetResponse.status, 200);
      assert.match(assetResponse.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.equal(assetResponse.headers['x-content-type-options'], 'nosniff');
    }

    const status = await request(routerPort, 'GET', '/_admin/api/status');
    assert.equal(status.status, 200);
    assert.match(status.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(status.headers['x-content-type-options'], 'nosniff');
    const statusBody = JSON.parse(status.text);
    assert.equal(statusBody.port, routerPort);
    assert.equal(statusBody.targets[0].envSet, true);
    assert.doesNotMatch(status.text, /admin-test-key|admin-integration-secret/);

    const forgedHost = await request(routerPort, 'GET', '/admin', undefined, {
      host: 'evil-secret.example:15730',
    });
    assert.equal(forgedHost.status, 403);
    assert.equal(JSON.parse(forgedHost.text).error.code, 'admin_host_forbidden');
    assert.doesNotMatch(forgedHost.text, /evil-secret|stack|admin-api\.mjs/i);

    const crossSite = await request(routerPort, 'PUT', '/_admin/api/config', {}, {
      origin: 'http://evil-secret.example',
      'sec-fetch-site': 'cross-site',
    });
    assert.equal(crossSite.status, 403);
    assert.equal(JSON.parse(crossSite.text).error.code, 'admin_cross_site_forbidden');
    assert.doesNotMatch(crossSite.text, /evil-secret|stack|admin-api\.mjs/i);

    const config = await request(routerPort, 'GET', '/_admin/api/config');
    assert.equal(config.status, 200);
    const configBody = JSON.parse(config.text);
    assert.match(configBody.config.targets[0].headers.authorization.$preserveSecret, /^[a-f0-9-]+$/);
    assert.equal(configBody.config.targets[0].headers['x-tenant'], 'local');
    assert.doesNotMatch(config.text, /admin-integration-secret/);

    const initialRouting = JSON.parse((await request(
      routerPort, 'GET', '/_admin/api/model-routing',
    )).text);
    assert.deepEqual(initialRouting.errors, []);
    assert.doesNotMatch(JSON.stringify(initialRouting), /admin-test-key|admin-integration-secret/);

    const createPayload = {
      configRevision: initialRouting.configRevision,
      catalogRevision: initialRouting.catalogRevision,
      operations: [{
        kind: 'model.create',
        model: {
          slug: 'admin-added-model',
          display_name: 'Admin Added Model',
          input_modalities: ['text'],
        },
      }, {
        kind: 'target.create',
        target: {
          name: 'admin-added',
          match: '^admin-added-model$',
          host: '127.0.0.1',
          port: 9,
          protocol: 'http',
          prefix: '',
          envKey: 'ADMIN_TEST_KEY',
          wireApi: 'chat',
        },
      }],
    };
    const createValidation = await request(
      routerPort, 'POST', '/_admin/api/model-routing/validate', createPayload,
    );
    assert.equal(createValidation.status, 200);
    assert.deepEqual(JSON.parse(createValidation.text).errors, []);
    const created = await request(routerPort, 'PUT', '/_admin/api/model-routing', createPayload);
    assert.equal(created.status, 200);
    assert.equal(JSON.parse(created.text).clientRestartRequired, true);

    const afterCreate = JSON.parse((await request(
      routerPort, 'GET', '/_admin/api/model-routing',
    )).text);
    const addedTarget = afterCreate.targets.find((target) => target.name === 'admin-added');
    assert.ok(addedTarget?.targetRef);
    assert.equal(afterCreate.models.some((model) => model.slug === 'admin-added-model'), true);

    const editPayload = {
      configRevision: afterCreate.configRevision,
      catalogRevision: afterCreate.catalogRevision,
      operations: [{
        kind: 'model.update',
        slug: 'admin-added-model',
        patch: { display_name: 'Admin Edited Model' },
      }, {
        kind: 'target.update',
        targetRef: addedTarget.targetRef,
        patch: { prefix: '/edited' },
      }],
    };
    assert.equal((await request(
      routerPort, 'POST', '/_admin/api/model-routing/validate', editPayload,
    )).status, 200);
    assert.equal((await request(
      routerPort, 'PUT', '/_admin/api/model-routing', editPayload,
    )).status, 200);

    const afterEdit = JSON.parse((await request(
      routerPort, 'GET', '/_admin/api/model-routing',
    )).text);
    assert.equal(
      afterEdit.models.find((model) => model.slug === 'admin-added-model').display_name,
      'Admin Edited Model',
    );
    const editedTarget = afterEdit.targets.find((target) => target.name === 'admin-added');
    assert.equal(editedTarget.prefix, '/edited');

    const deletePayload = {
      configRevision: afterEdit.configRevision,
      catalogRevision: afterEdit.catalogRevision,
      operations: [{ kind: 'model.delete', slug: 'admin-added-model' }, {
        kind: 'target.delete',
        targetRef: editedTarget.targetRef,
      }],
    };
    const configBeforeRejectedDelete = await fs.readFile(configPath, 'utf8');
    const catalogBeforeRejectedDelete = await fs.readFile(catalogPath, 'utf8');
    const deleteValidation = await request(
      routerPort, 'POST', '/_admin/api/model-routing/validate', deletePayload,
    );
    assert.notEqual(deleteValidation.status, 200);
    const deleteValidationBody = JSON.parse(deleteValidation.text);
    assert.equal(deleteValidationBody.error.code, 'target_not_dedicated');
    assert.equal(Object.hasOwn(deleteValidationBody, 'confirmation'), false);
    const deleted = await request(
      routerPort, 'PUT', '/_admin/api/model-routing', deletePayload,
    );
    assert.notEqual(deleted.status, 200);
    assert.equal(JSON.parse(deleted.text).error.code, 'target_not_dedicated');
    assert.equal(await fs.readFile(configPath, 'utf8'), configBeforeRejectedDelete);
    assert.equal(await fs.readFile(catalogPath, 'utf8'), catalogBeforeRejectedDelete);

    const finalRouting = JSON.parse((await request(
      routerPort, 'GET', '/_admin/api/model-routing',
    )).text);
    assert.equal(finalRouting.models.some((model) => model.slug === 'admin-added-model'), true);
    assert.equal(finalRouting.targets.some((target) => target.name === 'admin-added'), true);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  try {
    await shutdownIsolatedRouter(routerPort, child, childExit, () => childOutput);
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      await assert.rejects(
        fs.access(tempDir),
        (error) => error?.code === 'ENOENT',
        '隔离测试临时目录必须删除',
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  throwCombined(primaryError, cleanupErrors);
});
