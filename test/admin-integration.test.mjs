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

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('管理页加载自定义模型状态模块且不提供敏感凭据输入', async () => {
  const [page, app, styles] = await Promise.all([
    fs.readFile(path.join(PROJECT_DIR, 'web', 'index.html'), 'utf8'),
    fs.readFile(path.join(PROJECT_DIR, 'web', 'app.js'), 'utf8'),
    fs.readFile(path.join(PROJECT_DIR, 'web', 'styles.css'), 'utf8'),
  ]);

  assert.match(page, /自定义模型/u);
  assert.match(app, /from '\.\/model-routing-state\.mjs'/u);
  assert.match(app, /新增自定义模型/u);
  assert.match(app, /model-dialog-form[^>]+model-dialog-form/u, '模型弹窗必须使用独立表单布局');
  assert.match(app, /route-summary/u, '复用通道必须提供可读摘要，而非直接展开完整配置');
  assert.doesNotMatch(
    app,
    /model-target-summary-match/u,
    '普通模型通道摘要不得默认展示正则匹配规则',
  );
  assert.match(app, /route-editor-details/u, '编辑关联通道设置必须与复用摘要分层');
  assert.match(app, /fillModelTargetFields\(select\.value, model \? 'reuse' : 'dedicated'\)/u, '编辑模型必须按复用通道展示摘要');
  assert.match(app, /当前模型已关联已有通道/u, '编辑模型时必须显示准确的通道说明');
  assert.match(styles, /dialog\.model-dialog/u, '模型弹窗必须使用独立宽屏样式钩子');
  assert.match(styles, /\.dialog-section-heading \{ flex-direction: column;/u, '手机端模型分区标题必须纵向排列');
  assert.match(
    styles,
    /\.filter-search \{ flex: 0 0 auto; width: 100%; \}/u,
    '手机端搜索框不得把桌面 flex-basis 误用为纵向高度',
  );
  assert.match(app, /保存后需手动重启路由与 Codex/u);
  assert.match(app, /modelValidationCache/u, '保存前必须缓存一次预检的确认信息');
  assert.match(app, /await this\.resyncBaselines\(\)/u, '任一保存后必须重新载入两侧基线');
  assert.match(app, /renderModelImpact/u, '预检影响必须以安全 DOM 方式呈现');
  assert.match(app, /resyncRequired/u, '提交成功后必须冻结直到双基线重新载入');
  assert.match(app, /discard-model-drafts-reload/u, '模型冲突必须提供放弃草稿后重新载入入口');
  assert.match(app, /errorMessageForCode/u, '所有 API 错误必须由本地安全文案映射');
  assert.doesNotMatch(app, /body\?\.error\?\.message/u, '页面不得显示服务端 error.message');
  assert.match(app, /loadEpoch/u, '异步基线加载必须由 epoch 防止旧响应回写');
  assert.match(app, /activeResyncPromise/u, '重复重新载入必须复用同一批次');
  assert.match(app, /另一侧仍有未保存更改/u, '放弃草稿前必须保护另一侧草稿');
  assert.match(
    app,
    /else this\.openConfigGroups\.add\(group\);\s+this\.renderConfig\(\);/u,
    '高级设置分组切换后必须重绘，确保展开状态进入 DOM',
  );
  assert.match(
    app,
    /this\.openTargetEditor = this\.openTargetEditor === editor\.dataset\.targetIndex \? null : editor\.dataset\.targetIndex;\s+this\.renderConfig\(\);/u,
    '服务通道编辑切换后必须重绘，确保单条编辑器进入 DOM',
  );
  assert.match(
    app,
    /renderModelRouting\(\) \{\s+this\.renderOverview\(\);/u,
    '模型状态或草稿重绘时必须同步总览中的模型总数与不可用数量',
  );
  assert.match(
    app,
    /this\.querySelector\('#restart-notice'\)\.hidden = !saved\.restartRequired;\s+this\.renderOverview\(\);/u,
    '配置保存提示改变后必须同步总览中的待重启状态',
  );
  assert.match(
    app,
    /this\.querySelector\('#restart-notice'\)\.hidden = false;\s+this\.renderOverview\(\);\s+this\.showMessage\('自定义模型已保存/u,
    '模型保存后必须显示统一重启提示并同步总览状态',
  );
  assert.match(
    app,
    /const configResourceRisks = \(config\) =>/u,
    '管理页必须独立识别尚未重启生效的高资源配置',
  );
  assert.match(
    app,
    /const resourceRisks = configResourceRisks\(this\.configState\?\.config\);[\s\S]+const hasConfigWarning = warningCount > 0 \|\| resourceRisks\.length > 0;/u,
    '总览必须合并启动 warning 与当前配置中的高资源风险',
  );
  assert.match(
    app,
    /icon: hasConfigWarning \? '⚠' : '●'/u,
    '总览中的高资源风险必须同时使用图标和文字表达',
  );
  assert.match(
    app,
    /const resourceRisks = configResourceRisks\(config\);[\s\S]+`⚠ 高内存风险：\$\{resourceRisks\.join\('、'\)\}`/u,
    '本机服务摘要必须明确显示高内存风险，而不是只改变颜色',
  );
  assert.match(
    app,
    /label: '路由进程',[\s\S]+value: '在线'/u,
    '总览只能声明本机路由进程在线，不能暗示上游健康',
  );
  assert.match(
    app,
    /配置与凭据存在；未探测上游/u,
    '正常模型摘要必须明确说明未探测真实上游',
  );
  assert.doesNotMatch(
    app,
    /全部模型凭据与通道就绪/u,
    '配置存在不得表述为模型或上游已经就绪',
  );
  assert.match(
    app,
    /return statusTarget \? Boolean\(statusTarget\.envSet\) : null;/u,
    '运行时目标缺失时凭据状态必须是未知而不是默认 true',
  );
  assert.match(
    app,
    /凭据状态待确认/u,
    '高级设置必须用文字呈现未知凭据状态',
  );
  assert.doesNotMatch(page, /https?:\/\//iu, '管理页不应引用外部 CDN');
  assert.doesNotMatch(
    app,
    /<input[^>]+(?:type=["']password|(?:name|id|placeholder|value)=["'][^"']*(?:api[ _-]?key|authorization|cookie|token)[^"']*)/iu,
    '模型管理表单不能提供或暗示敏感凭据输入',
  );
});

test('浅色与深色弱化小字号文字保持至少 4.5:1 对比度', async () => {
  const styles = await fs.readFile(path.join(PROJECT_DIR, 'web', 'styles.css'), 'utf8');
  const faintValues = [...styles.matchAll(/--faint:\s*(#[0-9a-f]{6})/giu)].map((match) => match[1]);
  assert.equal(faintValues.length, 2, '浅色与深色主题都必须声明 --faint');
  assert.ok(contrastRatio(faintValues[0], '#f6f5f1') >= 4.5, '浅色主题弱化小字必须满足 WCAG AA');
  assert.ok(contrastRatio(faintValues[1], '#232a27') >= 4.5, '深色主题弱化小字必须满足 WCAG AA');
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
    assert.deepEqual(assetReferences, ['/admin/styles.css', '/admin/app.js']);
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
