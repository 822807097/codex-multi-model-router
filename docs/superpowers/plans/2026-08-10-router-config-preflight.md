# 路由配置预检实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ('- [ ]') syntax for tracking.

**Goal:** 在路由绑定端口前聚合预检 config.json，并把环境覆盖、运行参数和 target 正则编译集中到零依赖模块。

**Architecture:** 新增纯配置模块 'lib/router-config.mjs'，入口只负责读取 JSON、传入环境和消费 prepared 结果。预检区分 errors/warnings，保留未知字段和合法配置语义；任何 error 都在创建 HTTP 服务前终止隔离进程。

**Tech Stack:** Node.js 18+ ESM、node:path、node:test、node:assert、现有 provider adapter；无 npm 依赖。

**Repository rule:** 用户明确禁止 commit/push；本计划用测试与 diff 检查作为阶段检查点，不执行 git add、git commit 或 git push。

---

### Task 1: 建立配置模块的 TDD 骨架

**Files:**
- Create: 'test/router-config.test.mjs'
- Create: 'lib/router-config.mjs'
- Reference: 'docs/superpowers/specs/2026-08-10-router-config-preflight-design.md'

- [x] **Step 1: 写入最小合法配置和失败导入测试**

先创建测试文件，内容包含：

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  RouterConfigError,
  formatConfigIssues,
  inspectRouterConfig,
  prepareRouterConfig,
} from '../lib/router-config.mjs';

const BASE_DIR = path.resolve('test-fixtures', 'router-config');
const BASE_CONTEXT = Object.freeze({
  configPath: path.join(BASE_DIR, 'config.json'),
  baseDir: BASE_DIR,
  defaultCodexHome: path.join(BASE_DIR, 'codex-home'),
  env: {
    TEST_API_KEY: 'test-only-secret',
  },
});

function validConfig(overrides = {}) {
  return {
    port: 15730,
    proxy: { host: '127.0.0.1', port: 10808 },
    timeouts: {
      connectMs: 15_000,
      responseHeaderMs: 120_000,
      streamIdleMs: 600_000,
      requestMs: 600_000,
    },
    heartbeatMs: 15_000,
    maxRequestBytes: 1024,
    maxConcurrentRequests: 2,
    maxBufferedRequestBytes: 2048,
    modelContext: { enabled: false },
    targets: [{
      name: 'test-chat',
      match: '^test-model$',
      host: 'api.example.test',
      prefix: '',
      envKey: 'TEST_API_KEY',
      wireApi: 'chat',
    }],
    ...overrides,
  };
}

test('合法最小配置生成稳定运行参数并编译 target 正则', () => {
  const prepared = prepareRouterConfig(validConfig(), BASE_CONTEXT);
  assert.equal(prepared.runtime.port, 15730);
  assert.equal(prepared.runtime.configPath, BASE_CONTEXT.configPath);
  assert.equal(prepared.targets.length, 1);
  assert.equal(prepared.targets[0].matchSource, '^test-model$');
  assert.equal(prepared.targets[0].match.test('test-model'), true);
  assert.deepEqual(prepared.warnings, []);
});

test('错误类和格式化器保持稳定结构', () => {
  const issue = { severity: 'error', code: 'port_invalid', path: '/port', message: '端口无效' };
  const error = new RouterConfigError([issue]);
  assert.deepEqual(error.issues, [issue]);
  assert.deepEqual(formatConfigIssues([issue]), ['[error] port_invalid /port: 端口无效']);
});
~~~

- [x] **Step 2: 运行测试，确认 RED**

Run:

~~~powershell
node --test test/router-config.test.mjs
~~~

Expected: FAIL，原因是 'lib/router-config.mjs' 不存在或缺少导出。

- [x] **Step 3: 写入最小模块骨架**

创建模块并先支持最小合法配置：

~~~js
import path from 'node:path';

export class RouterConfigError extends Error {
  constructor(issues) {
    super('路由配置预检失败');
    this.name = 'RouterConfigError';
    this.issues = issues;
  }
}

export function formatConfigIssues(issues = []) {
  return issues.map((issue) => (
    '[' + issue.severity + '] ' + issue.code + ' ' + (issue.path || '<root>') + ': ' + issue.message
  ));
}

export function inspectRouterConfig(rawConfig, context = {}) {
  const errors = [];
  const warnings = [];
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    errors.push({
      severity: 'error',
      code: 'config_root_invalid',
      path: '',
      message: '根配置必须是 JSON 对象',
    });
  }
  return { errors, warnings };
}

export function prepareRouterConfig(rawConfig, context = {}) {
  const inspected = inspectRouterConfig(rawConfig, context);
  if (inspected.errors.length) throw new RouterConfigError(inspected.errors);
  const config = structuredClone(rawConfig);
  const target = config.targets[0];
  return {
    config,
    runtime: {
      configPath: context.configPath,
      port: Number(config.port ?? 15730),
      codexHome: context.env?.CODEX_HOME || context.defaultCodexHome,
    },
    targets: [{
      ...target,
      matchSource: target.match,
      match: new RegExp(target.match),
    }],
    warnings: inspected.warnings,
  };
}
~~~

- [x] **Step 4: 运行测试，确认 GREEN**

Run:

~~~powershell
node --test test/router-config.test.mjs
~~~

Expected: 2 tests PASS。

- [x] **Step 5: 检查差异，不提交**

Run:

~~~powershell
git diff --check -- lib/router-config.mjs test/router-config.test.mjs
~~~

Expected: exit 0，无输出。

### Task 2: 实现稳定问题收集和标量解析

**Files:**
- Modify: 'lib/router-config.mjs'
- Modify: 'test/router-config.test.mjs'

- [x] **Step 1: 写入多错误聚合、环境优先级和脱敏失败测试**

追加：

~~~js
test('一次返回多个独立错误且顺序稳定', () => {
  const result = inspectRouterConfig(validConfig({
    port: 0,
    proxy: { host: '', port: 70_000 },
    heartbeatMs: 'bad',
  }), BASE_CONTEXT);
  assert.deepEqual(result.errors.map((item) => item.code), [
    'port_invalid',
    'proxy_invalid',
    'proxy_invalid',
    'heartbeat_invalid',
  ]);
  assert.deepEqual(result.errors.map((item) => item.path), [
    '/port',
    '/proxy/host',
    '/proxy/port',
    '/heartbeatMs',
  ]);
});

test('非法环境覆盖不能回退配置值', () => {
  const context = {
    ...BASE_CONTEXT,
    env: { ...BASE_CONTEXT.env, ROUTER_PORT: 'not-a-port' },
  };
  const result = inspectRouterConfig(validConfig({ port: 15730 }), context);
  assert.equal(result.errors[0].code, 'port_invalid');
  assert.equal(result.errors[0].path, '$env/ROUTER_PORT');
});

test('问题对象和格式化文本不包含环境变量值', () => {
  const secret = 'sk-never-print-this';
  const context = { ...BASE_CONTEXT, env: { TEST_API_KEY: secret, ROUTER_PORT: secret } };
  const result = inspectRouterConfig(validConfig(), context);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(formatConfigIssues(result.errors).join('\\n'), new RegExp(secret));
});
~~~

- [x] **Step 2: 运行新增测试，确认 RED**

Run:

~~~powershell
node --test test/router-config.test.mjs
~~~

Expected: FAIL，缺少标量校验和聚合错误。

- [x] **Step 3: 实现问题收集器和解析器**

在模块中加入以下内部原语，并让 'inspectRouterConfig' 按固定顺序调用：

~~~js
function addIssue(target, severity, code, issuePath, message) {
  target.push({ severity, code, path: issuePath, message });
}

function selectedValue(env, envName, configured, fallback) {
  if (envName && Object.hasOwn(env || {}, envName)) {
    return { value: env[envName], path: '$env/' + envName };
  }
  if (configured !== undefined) {
    return { value: configured, path: null };
  }
  return { value: fallback, path: null };
}

function finiteNumber(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, options = {}) {
  const number = finiteNumber(value);
  if (number === null || !Number.isInteger(number)) return null;
  if (number < (options.min ?? 1) || number > (options.max ?? Number.MAX_SAFE_INTEGER)) return null;
  return number;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
~~~

按 '/port'、'/proxy/host'、'/proxy/port'、'/heartbeatMs' 顺序收集。'selectedValue' 只决定环境覆盖优先级，不得统一吞掉 'null'；调用字段各自决定 'null' 是缺省、关闭还是非法。错误消息只描述规则，例如“必须是 1..65535 的整数”，不得拼入非法原值。

- [x] **Step 4: 运行测试，确认 GREEN**

Run:

~~~powershell
node --test test/router-config.test.mjs
~~~

Expected: all tests PASS。

### Task 3: 完成 target 校验、正则编译和警告

**Files:**
- Modify: 'lib/router-config.mjs'
- Modify: 'test/router-config.test.mjs'
- Reference: 'lib/provider-adapters.mjs'
- Reference: 'lib/request-policy.mjs'

- [x] **Step 1: 写入 target 表驱动失败测试**

追加表驱动：

~~~js
for (const sample of [
  ['target_name_invalid', '/targets/0/name', { name: '' }],
  ['target_match_invalid', '/targets/0/match', { match: '(' }],
  ['target_host_invalid', '/targets/0/host', { host: 'bad\\r\\nhost' }],
  ['target_port_invalid', '/targets/0/port', { port: 70_000 }],
  ['target_protocol_invalid', '/targets/0/protocol', { protocol: 'ftp' }],
  ['target_wire_api_invalid', '/targets/0/wireApi', { wireApi: 'messages' }],
  ['target_path_invalid', '/targets/0/prefix', { prefix: 'v1' }],
  ['target_env_key_invalid', '/targets/0/envKey', { envKey: 'BAD KEY' }],
  ['target_headers_invalid', '/targets/0/headers', { headers: [] }],
  ['target_forward_headers_invalid', '/targets/0/forwardHeaders', { forwardHeaders: 'x-test' }],
  ['target_auth_conflict', '/targets/0/envKey', { useOpenAiAuth: true, envKey: 'TEST_API_KEY' }],
]) {
  test(sample[0] + ' 返回稳定 target path', () => {
    const config = validConfig();
    Object.assign(config.targets[0], sample[2]);
    const result = inspectRouterConfig(config, BASE_CONTEXT);
    assert.ok(result.errors.some((item) => item.code === sample[0] && item.path === sample[1]));
  });
}

test('空 prefix 和 wireApi 历史别名保持合法', () => {
  const config = validConfig();
  config.targets[0].prefix = '';
  delete config.targets[0].wireApi;
  config.targets[0].apiFormat = 'openai_chat';
  assert.deepEqual(inspectRouterConfig(config, BASE_CONTEXT).errors, []);
});

test('重复目标和相同 match 混用 wireApi 只产生警告', () => {
  const first = validConfig().targets[0];
  const config = validConfig({
    targets: [
      first,
      { ...first },
      { ...first, name: 'native', wireApi: 'responses' },
    ],
  });
  const codes = inspectRouterConfig(config, BASE_CONTEXT).warnings.map((item) => item.code);
  assert.ok(codes.includes('target_duplicate'));
  assert.ok(codes.includes('target_wire_api_mixed'));
});

test('target 警告覆盖缺 Key、重名、HTTP 代理和被忽略转发头', () => {
  const first = { ...validConfig().targets[0], envKey: 'MISSING_KEY' };
  const config = validConfig({
    targets: [
      first,
      {
        ...first,
        match: '^second-model$',
        protocol: 'http',
        viaProxy: true,
        forwardHeaders: ['connection'],
      },
    ],
  });
  const codes = inspectRouterConfig(config, { ...BASE_CONTEXT, env: {} })
    .warnings.map((item) => item.code);
  assert.ok(codes.includes('env_missing'));
  assert.ok(codes.includes('target_name_duplicate'));
  assert.ok(codes.includes('proxy_ignored_for_http'));
  assert.ok(codes.includes('forward_header_ignored'));
});

test('显式状态域跨端点或认证身份复用时告警', () => {
  const first = validConfig().targets[0];
  const config = validConfig({
    targets: [
      { ...first, stateDomain: 'shared' },
      { ...first, name: 'other', host: 'other.example.test', stateDomain: 'shared' },
    ],
  });
  assert.ok(inspectRouterConfig(config, BASE_CONTEXT).warnings
    .some((item) => item.code === 'state_domain_suspicious'));
});
~~~

- [x] **Step 2: 运行测试，确认 RED**

Run: 'node --test test/router-config.test.mjs'
Expected: target cases FAIL。

- [x] **Step 3: 实现单 target 校验**

实现 'inspectTarget(target, index, env, errors, warnings)'：

~~~js
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

function validEndpointPath(value) {
  return value === '' || (
    typeof value === 'string'
    && value.startsWith('/')
    && !/[\r\n]/.test(value)
  );
}
~~~

具体规则：

1. target 必须是普通对象。
2. name/match/host 必须为非空字符串，且 host/match 诊断不回显原值。
3. match 在 try/catch 内编译；失败只记录 'target_match_invalid'。
4. protocol 缺失等价 'https'；只允许 'http'/'https'。
5. port 缺失按协议默认；显式值必须为 1..65535 整数。
6. prefix 允许空字符串；非空必须以 '/' 开头。provider.chatPath 同规则但不能为空。
7. 使用 'resolveProvider' 接受现有 wire API aliases，最终只允许 chat/responses。
8. 'useOpenAiAuth:true' 时 envKey 不必存在；其他 target 的 envKey 必须匹配 ENV_NAME。官方登录态与 envKey/authType/authHeader/auth 等替代凭据配置同时出现时返回 'target_auth_conflict'，普通静态业务 header 不算冲突。
9. headers 必须为普通对象；名称匹配 HEADER_NAME，名称和值不得含 CR/LF。
10. forwardHeaders 必须是字符串数组；禁止头产生 warning，不是 error。
11. 非官方 target 缺少对应环境变量只产生 'env_missing' warning，message 只写变量名，不写变量值。
12. 按原始数组顺序生成 'target_name_duplicate'、'target_duplicate'、'target_wire_api_mixed'、'proxy_ignored_for_http' 和 'state_domain_suspicious'；显式 stateDomain 相同但无显式 stateDomain 时的端点/认证身份不同才视为可疑。

- [x] **Step 4: 在 prepare 阶段编译全部 target**

仅在零 errors 时执行：

~~~js
const targets = config.targets.map((target) => ({
  ...target,
  matchSource: target.match,
  match: new RegExp(target.match),
}));
~~~

不把 'provider' 冗余写进 target；调用方继续通过现有 'resolveProvider(target)' 获取能力，避免两份 provider 状态漂移。

- [x] **Step 5: 运行测试和相关 provider 测试**

Run:

~~~powershell
node --test test/router-config.test.mjs test/provider-adapters.test.mjs test/request-policy.test.mjs
~~~

Expected: all PASS。

### Task 4: 验证顶层资源配置和跨字段关系

**Files:**
- Modify: 'lib/router-config.mjs'
- Modify: 'test/router-config.test.mjs'
- Reference: 'config.json'
- Reference: 'lib/transport.mjs'
- Reference: 'lib/context-budget.mjs'

- [x] **Step 1: 写入顶层配置表驱动测试**

增加 path setter 和用例表：

~~~js
function setAt(root, segments, value) {
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor[segment] ??= {};
    cursor = cursor[segment];
  }
  cursor[segments.at(-1)] = value;
}

for (const sample of [
  ['config_root_invalid', [], null],
  ['targets_required', ['targets'], []],
  ['timeout_invalid', ['timeouts', 'connectMs'], 0],
  ['request_limit_invalid', ['maxRequestBytes'], -1],
  ['response_history_invalid', ['responseHistory', 'ttlMs'], 0],
  ['checkpoint_invalid', ['goalCheckpoint', 'sourceWindowRatio'], 2],
  ['vision_relay_invalid', ['visionRelay', 'concurrency'], 9],
  ['model_capability_invalid', ['modelCapabilities'], [{ match: '(', contextWindow: 1000 }]],
  ['model_context_invalid', ['modelContext'], { enabled: true, contextWindow: 1000, autoCompactTokenLimit: 2000 }],
  ['oauth_invalid', ['oauth', 'viaProxy'], 'yes'],
  ['path_invalid', ['paths', 'auth'], 123],
]) {
  test(sample[0] + ' 覆盖 ' + sample[1].join('.'), () => {
    const config = sample[1].length ? validConfig() : sample[2];
    if (sample[1].length) setAt(config, sample[1], sample[2]);
    assert.ok(inspectRouterConfig(config, BASE_CONTEXT).errors.some((item) => item.code === sample[0]));
  });
}

test('跨字段预算矛盾分别报告', () => {
  const config = validConfig({
    maxRequestBytes: 4096,
    maxBufferedRequestBytes: 2048,
    responseHistory: { maxEntryBytes: 2048, maxBytes: 1024 },
  });
  const codes = inspectRouterConfig(config, BASE_CONTEXT).errors.map((item) => item.code);
  assert.ok(codes.includes('request_budget_conflict'));
  assert.ok(codes.includes('response_history_conflict'));
});
~~~

- [x] **Step 2: 运行测试，确认 RED**

Run: 'node --test test/router-config.test.mjs'
Expected: 顶层范围测试 FAIL。

- [x] **Step 3: 实现数据驱动数值校验**

在模块内定义现有字段规则，不引入通用 schema DSL：

~~~js
const POSITIVE_FIELDS = [
  ['/timeouts/connectMs', ['timeouts', 'connectMs'], 'timeout_invalid'],
  ['/timeouts/responseHeaderMs', ['timeouts', 'responseHeaderMs'], 'timeout_invalid'],
  ['/timeouts/streamIdleMs', ['timeouts', 'streamIdleMs'], 'timeout_invalid'],
  ['/timeouts/requestMs', ['timeouts', 'requestMs'], 'timeout_invalid'],
  ['/maxRequestBytes', ['maxRequestBytes'], 'request_limit_invalid'],
  ['/maxConcurrentRequests', ['maxConcurrentRequests'], 'request_limit_invalid'],
  ['/maxBufferedRequestBytes', ['maxBufferedRequestBytes'], 'request_limit_invalid'],
];
~~~

针对 providerPool、responseHistory、goalCheckpoint、visionRelay、modelCapabilities、modelContext、supportsResponses、oauth、paths 写各自小函数，避免把条件验证塞进一张不可读的大 schema。为 providerPool 的显式非法范围使用稳定码 'provider_pool_invalid'；这是规格“首版至少覆盖”目录之外的补充码。

兼容要求：

- heartbeat 正数继续由运行值钳制到至少 10ms；零、负数、空字符串和非数值报错。
- vision concurrency 的现有 1..8 范围外值报错，不静默钳制。
- goal checkpoint 的 maxOutputTokens、requestMs 和 sourceTokenBudget 低于现有安全下限时报错。
- disabled 容器只验证结构，不验证不会被读取的业务值。
- modelCapabilities 按数组原顺序验证正则和预算。
- 'targets' 缺失、非数组或空数组都返回 'targets_required'；根不是普通对象时只返回根错误，不能继续解引用。
- 'supportsResponses.slugs' 若存在必须是字符串数组，避免 '/models' 运行期调用 '.includes' 崩溃。
- 每个规格列出的稳定 error code 至少保留一个直接断言；warning 也逐一断言 code、path 和顺序。

- [x] **Step 4: 运行单元测试并检查随仓配置**

Run:

~~~powershell
node --test test/router-config.test.mjs
node -e "import('./lib/router-config.mjs').then(async m=>{const fs=await import('node:fs');const path=await import('node:path');const raw=JSON.parse(fs.readFileSync('config.json','utf8'));const r=m.inspectRouterConfig(raw,{configPath:path.resolve('config.json'),baseDir:process.cwd(),defaultCodexHome:'A:/isolated/codex',env:{DEEPSEEK_API_KEY:'x',aliyun_video_key:'x'}});if(r.errors.length)throw new Error(JSON.stringify(r.errors));console.log('config preflight ok')})"
~~~

Expected: tests PASS；输出 'config preflight ok'。

### Task 5: 生成完整 runtime 并证明未知字段不丢失

**Files:**
- Modify: 'lib/router-config.mjs'
- Modify: 'test/router-config.test.mjs'

- [x] **Step 1: 写入环境覆盖、路径和保留字段测试**

~~~js
test('环境覆盖和路径解析保持当前优先级', () => {
  const config = validConfig({
    port: 1000,
    paths: { auth: 'relative-auth.json', catalog: null },
    proxy: { host: 'config-proxy', port: 1001 },
  });
  const context = {
    ...BASE_CONTEXT,
    env: {
      ...BASE_CONTEXT.env,
      ROUTER_PORT: '2000',
      V2RAY_HOST: 'env-proxy',
      V2RAY_PORT: '2001',
    CODEX_HOME: path.join(BASE_DIR, 'env-codex'),
    },
  };
  const prepared = prepareRouterConfig(config, context);
  assert.equal(prepared.runtime.port, 2000);
  assert.deepEqual(prepared.runtime.proxy, { host: 'env-proxy', port: 2001 });
  assert.equal(prepared.runtime.codexHome, path.join(BASE_DIR, 'env-codex'));
  assert.equal(prepared.runtime.authPath, path.join(BASE_DIR, 'relative-auth.json'));
  assert.equal(prepared.runtime.catalogPath, path.join(BASE_DIR, 'env-codex', 'models.json'));
});

test('未知字段、注释、数组顺序和原配置对象保持不变', () => {
  const config = validConfig({
    _comment: '保留',
    vendorExtension: { mode: 'custom' },
  });
  config.targets[0].vendorOption = ['a', 'b'];
  const original = structuredClone(config);
  const prepared = prepareRouterConfig(config, BASE_CONTEXT);
  assert.deepEqual(config, original);
  assert.equal(prepared.config._comment, '保留');
  assert.deepEqual(prepared.config.vendorExtension, { mode: 'custom' });
  assert.deepEqual(prepared.config.targets[0].vendorOption, ['a', 'b']);
});
~~~

- [x] **Step 2: 运行测试，确认 RED**

Run: 'node --test test/router-config.test.mjs'
Expected: runtime 路径和完整字段保留测试 FAIL。

- [x] **Step 3: 完成 runtime 生成**

实现以下路径选择：

~~~js
const codexHome = context.env?.CODEX_HOME || context.defaultCodexHome;
const authConfigured = context.env?.CODEX_AUTH_PATH ?? config.paths?.auth;
const catalogConfigured = context.env?.CODEX_CATALOG_PATH ?? config.paths?.catalog;
const authPath = authConfigured
  ? path.resolve(context.baseDir, String(authConfigured))
  : path.join(codexHome, 'auth.json');
const catalogPath = catalogConfigured
  ? path.resolve(context.baseDir, String(catalogConfigured))
  : path.join(codexHome, 'models.json');
~~~

runtime 同时生成 proxy、timeouts、heartbeatMs、request limits、OAuth 和 visionRelay。不得冻结或重排 'config'，因为后续 model catalog 和 UI 仍需要原字段结构。

明确断言 'runtime' 至少含规格约定的 'configPath/codexHome/authPath/catalogPath/proxy/heartbeatMs/maxRequestBytes/requestBudget/oauth/visionRelay'；其中 'requestBudget' 使用 '{ maxActive, maxBytes }'，'oauth' 使用 '{ clientId, refreshSkewSeconds }'。合法正数心跳在 runtime 中继续钳制到至少 10ms。

- [x] **Step 4: 运行测试，确认 GREEN**

Run: 'node --test test/router-config.test.mjs'
Expected: all PASS。

### Task 6: 最小接入 codex-router.mjs

**Files:**
- Modify: 'codex-router.mjs:34-134'
- Modify: 'test/router-integration.test.mjs'
- Test: 'test/router-config.test.mjs'

- [x] **Step 1: 写入非法配置启动前失败的集成测试**

在集成测试增加仅等待子进程退出的 helper 和测试：

~~~js
test('非法配置在监听端口前聚合失败', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-router-invalid-config-'));
  const configPath = path.join(tempDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    port: 0,
    heartbeatMs: 'bad',
    targets: [{ name: '', match: '(', host: '' }],
  }));
  const child = spawn(process.execPath, [path.join(PROJECT_DIR, 'codex-router.mjs')], {
    cwd: PROJECT_DIR,
    env: { ...process.env, ROUTER_CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [exitCode] = await once(child, 'exit');
  try {
    assert.notEqual(exitCode, 0);
    assert.match(output, /port_invalid/);
    assert.match(output, /heartbeat_invalid/);
    assert.match(output, /target_name_invalid/);
    assert.match(output, /target_match_invalid/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
~~~

该测试不能调用 start/stop/restart 脚本，也不能用 Stop-Process。非法子进程必须自行退出。

- [x] **Step 2: 运行定向测试，确认 RED**

Run:

~~~powershell
node --test --test-name-pattern "非法配置在监听端口前聚合失败" test/router-integration.test.mjs
~~~

Expected: FAIL，当前入口会跳过非法正则或以非聚合方式失败。

- [x] **Step 3: 替换入口配置区**

新增 import：

~~~js
import {
  RouterConfigError,
  formatConfigIssues,
  prepareRouterConfig,
} from './lib/router-config.mjs';
~~~

用以下启动准备替换现有直接 JSON.parse 和 TARGETS flatMap：

~~~js
const CONFIG_PATH = path.resolve(process.env.ROUTER_CONFIG_PATH || path.join(__dirname, 'config.json'));
let rawConfig;
try {
  const stat = fs.statSync(CONFIG_PATH);
  if (stat.size > 4 * 1024 * 1024) throw new Error('config too large');
  const bytes = fs.readFileSync(CONFIG_PATH);
  rawConfig = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
} catch (error) {
  const issue = {
    severity: 'error',
    code: 'config_json_invalid',
    path: '',
    message: '无法读取或解析路由配置 JSON',
  };
  process.stderr.write(formatConfigIssues([issue]).map((line) => '[config] ' + line).join('\n') + '\n');
  process.exit(1);
}

let preparedConfig;
try {
  preparedConfig = prepareRouterConfig(rawConfig, {
    configPath: CONFIG_PATH,
    baseDir: path.dirname(CONFIG_PATH),
    defaultCodexHome: path.join(os.homedir(), '.codex'),
    env: process.env,
  });
} catch (error) {
  if (!(error instanceof RouterConfigError)) throw error;
  process.stderr.write(formatConfigIssues(error.issues).map((line) => '[config] ' + line).join('\n') + '\n');
  process.exit(1);
}

for (const line of formatConfigIssues(preparedConfig.warnings)) {
  console.warn('[config] ' + line);
}

const cfg = preparedConfig.config;
const {
  port: PORT,
  codexHome: CODEX_HOME,
  authPath: AUTH_PATH,
  catalogPath: CATALOG_PATH,
  proxy: V2RAY_PROXY,
  heartbeatMs: HEARTBEAT_MS,
  maxRequestBytes: MAX_REQUEST_BYTES,
  requestBudget: REQUEST_BUDGET,
  oauth: ROUTER_OAUTH,
  visionRelay: VISION_RELAY,
} = preparedConfig.runtime;
const TARGETS = preparedConfig.targets;
~~~

继续用现有 cfg 构造 ProviderPool、历史和检查点；RequestBudget 改为消费 'REQUEST_BUDGET'，OAuth client id/skew 和视觉中继改为消费 runtime。先不要把这些实例化迁入配置模块。配置错误只输出稳定诊断后由当前非法隔离进程自行退出，不再 'throw' 造成第二份未捕获异常栈，也不打印底层 JSON.parse/UTF-8 错误原文。

- [x] **Step 4: 运行配置和集成测试**

Run:

~~~powershell
node --test test/router-config.test.mjs test/router-integration.test.mjs
~~~

Expected: all PASS；隔离子进程只通过 '/_admin/shutdown' 优雅关闭。

- [x] **Step 5: 检查入口绝对路径语法**

Run:

~~~powershell
node --check A:\codex-multi-model-router\codex-router.mjs
node --check A:\codex-multi-model-router\lib\router-config.mjs
~~~

Expected: exit 0，无输出。

### Task 7: 同步文档并完成阶段一验证

**Files:**
- Modify: 'README.md:329-457'
- Modify: 'config.json'
- Modify: 'codex-router.mjs:24-33'
- Verify: all source and tests

- [x] **Step 1: 更新 README 配置预检说明**

在配置参考开头增加：

~~~markdown
### 启动配置预检

路由会在监听端口前一次性检查所有可静态判定的配置问题：

- error：端口、正则、wire API、路径、认证形状或资源预算无效，路由不会启动。
- warning：某个供应商 Key 尚未设置、目标重复或配置可能无效；其他模型仍可使用。

旧版本会忽略非法 target 正则，并把部分显式非法数值回退为默认值；新版本会明确列出字段路径并停止启动。诊断只显示环境变量名称，不显示 Key 或 Token。
~~~

- [x] **Step 2: 同步 config.json 中文注释**

只补充已有相关 '_comment'，说明非法 match 和显式非法资源值会在启动前失败；不得更改合法示例数值、模型、Key 名称或代理策略。

- [x] **Step 3: 更新入口顶部注释**

加入一行：

~~~js
//   启动时先执行聚合配置预检；错误在绑定端口前退出，警告不影响其他模型通道。
~~~

- [x] **Step 4: 运行完整离线测试**

Run:

~~~powershell
$tests = rg --files test -g "*.test.mjs"
node --test $tests
~~~

Expected: 原 165 项与新增测试全部 PASS，fail 0。

- [x] **Step 5: 检查全部 MJS 语法**

Run:

~~~powershell
$files = rg --files -g "*.mjs"
foreach ($file in $files) {
  node --check $file
  if ($LASTEXITCODE -ne 0) { throw "syntax check failed: $file" }
}
node --check A:\codex-multi-model-router\codex-router.mjs
~~~

Expected: 全部 exit 0。

- [x] **Step 6: 验证 JSON、零依赖和差异**

Run:

~~~powershell
node -e "JSON.parse(require('fs').readFileSync('config.json','utf8'));JSON.parse(require('fs').readFileSync('models.template.json','utf8'));console.log('json ok')"
$imports = rg -n "from ['\"]|import\\(['\"]|require\\(['\"]" --glob "*.mjs"
$external = $imports | Where-Object { $_ -notmatch "['\"](?:node:|\\.\\.?/|/)" }
if ($external) { $external; throw '发现外部模块导入' }
git diff --check
~~~

Expected:

- 输出 'json ok'。
- 外部包扫描没有新增匹配。
- 'git diff --check' exit 0。

- [x] **Step 7: 审计安全边界**

确认：

1. 没有访问或写入 'A:\CodexData\router'。
2. 没有运行任何 start/stop/restart 脚本。
3. 没有调用真实供应商。
4. 没有停止或杀死任何 Node 进程。
5. 没有 commit、push 或部署。
6. 只修改阶段一计划列出的文件，其他已有工作树改动保持不变。

- [x] **Step 8: 更新阶段进度，不结束总目标**

阶段一全绿后，把阶段一标为完成并开始阶段二独立设计门禁；不得因为配置预检完成就把五阶段持续目标标记 complete。

## Self-Review 记录

- 规格覆盖：补齐根/targets、target 认证冲突、全部 warning、supportsResponses、runtime 必填结构和配置限量 UTF-8 读取。
- 接口一致性：'RouterConfigError' 始终只接收 issues；入口不再传未定义 options，也不再把 provider 冗余写入编译 target。
- 平台一致性：测试路径改为 'node:path' 生成，配置路径进入模块前绝对化。
- 命令一致性：修正非法配置测试的环境覆盖、PowerShell 全量测试参数和不受 'rg' 前瞻限制的零依赖扫描。
- 占位符扫描：未发现延后实现或省略细节的占位语句；每个实现步骤均绑定具体规则、测试和命令。
