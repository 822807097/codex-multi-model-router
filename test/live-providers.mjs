import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// ---------- DeepSeek / 阿里云 Token Plan 真实链路冒烟测试 ----------
// 不进入 npm test，避免普通本地测试意外消耗额度；密钥只从父进程环境继承且从不打印。
const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

async function freePort() {
  const server = http.createServer();
  await listen(server);
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntilHealthy(port, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`隔离路由提前退出，code=${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch { /* 路由尚未开始监听 */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('隔离路由健康检查超时');
}

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY 未设置');
if (!process.env.aliyun_video_key) throw new Error('aliyun_video_key 未设置');

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-deepseek-'));
const routerPort = await freePort();
const configPath = path.join(tempDir, 'config.json');
const catalogPath = path.join(tempDir, 'models.json');
await fs.writeFile(catalogPath, JSON.stringify({
  models: [{ slug: 'deepseek-v4-flash' }, { slug: 'qwen3.8-max' }],
}));
await fs.writeFile(configPath, JSON.stringify({
  port: routerPort,
  modelContext: { enabled: false },
  modelCapabilities: [
    { match: '^deepseek-v4-flash$', contextWindow: 1_000_000, maxOutputTokens: 65_536 },
    { match: '^qwen3\\.8-max$', contextWindow: 1_000_000, maxOutputTokens: 65_536 },
  ],
  targets: [
    {
      name: 'deepseek-live',
      platform: 'deepseek',
      match: '^deepseek-v4-flash$',
      host: 'api.deepseek.com',
      prefix: '',
      envKey: 'DEEPSEEK_API_KEY',
      wireApi: 'chat',
      vision: true,
    },
    {
      name: 'bailian-live',
      platform: 'dashscope',
      match: '^qwen3\\.8-max$',
      host: 'token-plan.cn-beijing.maas.aliyuncs.com',
      prefix: '/compatible-mode/v1',
      envKey: 'aliyun_video_key',
      wireApi: 'chat',
      vision: true,
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
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childExit = once(child, 'exit');
let childOutput = '';
child.stdout.on('data', (chunk) => { childOutput += chunk; });
child.stderr.on('data', (chunk) => { childOutput += chunk; });

try {
  await waitUntilHealthy(routerPort, child);
  const smokeModel = async (model) => {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        max_output_tokens: 64,
        reasoning: { effort: 'none' },
        input: [{ role: 'user', content: [{ type: 'input_text', text: '只回复 OK' }] }],
      }),
    });
    const sse = await response.text();
    assert.equal(response.status, 200);
    assert.match(sse, /"type":"response\.completed"/);
    assert.match(sse, /"status":"completed"/);
    assert.match(sse, /data: \[DONE\]/);
  };
  await smokeModel('deepseek-v4-flash');
  await smokeModel('qwen3.8-max');
  console.log('DeepSeek Flash 与 Qwen3.8 Max 真实跨供应商链路通过');
} catch (error) {
  throw new Error(`${error.message}\n${childOutput}`);
} finally {
  try {
    await fetch(`http://127.0.0.1:${routerPort}/_admin/shutdown`, { method: 'POST' });
  } catch { /* 子路由可能在响应完成后立即退出 */ }
  if (child.exitCode === null) {
    await Promise.race([
      childExit,
      new Promise((_, reject) => setTimeout(() => reject(new Error('隔离路由未优雅退出')), 5_000)),
    ]);
  }
  await fs.rm(tempDir, { recursive: true, force: true });
}
