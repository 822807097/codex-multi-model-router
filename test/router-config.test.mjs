import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  RouterConfigError,
  formatConfigIssues,
  inspectRouterConfig,
  prepareRouterConfig,
} from '../lib/router-config.mjs';

const BASE_DIR = path.resolve('test-fixtures', 'router-config');

const context = {
  configPath: path.join(BASE_DIR, 'config.json'),
  baseDir: BASE_DIR,
  defaultCodexHome: path.join(BASE_DIR, 'codex-home'),
  env: {
    TEST_API_KEY: 'test-only-secret',
  },
};

function validConfig(overrides = {}) {
  return {
    port: 15730,
    proxy: {
      host: '127.0.0.1',
      port: 10808,
    },
    timeouts: {
      connectMs: 15_000,
      responseHeaderMs: 120_000,
      streamIdleMs: 600_000,
      requestMs: 600_000,
    },
    heartbeatMs: 15_000,
    maxRequestBytes: 1_024,
    maxConcurrentRequests: 2,
    maxBufferedRequestBytes: 2_048,
    modelContext: {
      enabled: false,
    },
    targets: [
      {
        name: 'test-chat',
        match: '^test-model$',
        host: 'api.example.test',
        prefix: '',
        envKey: 'TEST_API_KEY',
        wireApi: 'chat',
      },
    ],
    ...overrides,
  };
}

const rootIssue = {
  severity: 'error',
  code: 'config_root_invalid',
  path: '',
  message: '配置根节点必须是普通对象',
};

test('prepareRouterConfig 返回分离的配置副本、运行时信息与全部编译目标', () => {
  const firstTarget = {
    ...validConfig().targets[0],
    vendorOption: {
      nested: ['keep'],
    },
  };
  const source = validConfig({
    targets: [
      firstTarget,
      {
        ...firstTarget,
        name: 'unused-chat',
        match: '^unused-model$',
        vendorOption: {
          nested: ['keep-second'],
        },
      },
    ],
  });
  const before = structuredClone(source);

  assert.deepEqual(inspectRouterConfig(source, context), {
    errors: [],
    warnings: [],
  });

  const prepared = prepareRouterConfig(source, context);

  assert.deepEqual(Object.keys(prepared), [
    'config',
    'runtime',
    'targets',
    'warnings',
  ]);
  assert.deepEqual(prepared.config, source);
  assert.notStrictEqual(prepared.config, source);
  assert.notStrictEqual(prepared.config.targets, source.targets);
  assert.deepEqual(source, before);
  assert.equal(Object.hasOwn(prepared.config, 'runtime'), false);
  assert.equal(Object.hasOwn(prepared.config, 'warnings'), false);
  assert.equal(prepared.config.targets.length, 2);
  assert.equal(typeof prepared.config.targets[0].match, 'string');
  assert.equal(typeof prepared.config.targets[1].match, 'string');

  assert.deepEqual(prepared.runtime, {
    configPath: context.configPath,
    port: 15730,
    codexHome: context.defaultCodexHome,
    authPath: path.join(context.defaultCodexHome, 'auth.json'),
    catalogPath: path.join(context.defaultCodexHome, 'models.json'),
    proxy: {
      host: '127.0.0.1',
      port: 10808,
    },
    timeouts: {
      connectMs: 15_000,
      responseHeaderMs: 120_000,
      streamIdleMs: 600_000,
      requestMs: 600_000,
    },
    heartbeatMs: 15_000,
    maxRequestBytes: 1_024,
    requestBudget: {
      maxActive: 2,
      maxBytes: 2_048,
    },
    goalCheckpointPersistence: { enabled: false },
    oauth: {
      clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      refreshSkewSeconds: 30,
      refreshTimeoutMs: 30_000,
      viaProxy: null,
    },
    visionRelay: {
      host: 'token-plan.cn-beijing.maas.aliyuncs.com',
      prefix: '/compatible-mode/v1',
      model: 'qwen3.8-max',
      envKey: 'aliyun_video_key',
      viaProxy: false,
      concurrency: 3,
      maxImagesPerRequest: 8,
      cacheMaxEntries: 64,
      cacheMaxBytes: 1_048_576,
      maxTokens: 300,
    },
  });
  assert.equal(prepared.targets.length, 2);
  assert.equal(prepared.targets[0].matchSource, '^test-model$');
  assert.ok(prepared.targets[0].match instanceof RegExp);
  assert.equal(prepared.targets[0].match.test('test-model'), true);
  assert.equal(prepared.targets[1].matchSource, '^unused-model$');
  assert.ok(prepared.targets[1].match instanceof RegExp);
  assert.equal(prepared.targets[1].match.test('unused-model'), true);
  assert.deepEqual(
    prepared.targets[0].vendorOption,
    source.targets[0].vendorOption,
  );
  assert.notStrictEqual(
    prepared.targets[0].vendorOption,
    source.targets[0].vendorOption,
  );
  assert.equal(Object.hasOwn(prepared.targets[0], 'provider'), false);
  assert.equal(Object.hasOwn(prepared.targets[1], 'provider'), false);
  prepared.targets[0].vendorOption.nested.push('prepared-only');
  assert.deepEqual(prepared.targets[1].vendorOption.nested, ['keep-second']);
  assert.deepEqual(source.targets[0].vendorOption.nested, ['keep']);
  assert.deepEqual(source.targets[1].vendorOption.nested, ['keep-second']);
  assert.deepEqual(prepared.warnings, []);
});

test('runtime 按环境优先级规范化端口、代理与 CODEX_HOME，并解析配置相对路径', () => {
  const envCodexHome = path.join(BASE_DIR, 'env-home');
  const prepared = prepareRouterConfig(validConfig({
    paths: {
      auth: './credentials/auth.json',
      catalog: null,
    },
  }), {
    ...context,
    env: {
      ...context.env,
      ROUTER_PORT: '23456',
      V2RAY_HOST: 'proxy.from.env',
      V2RAY_PORT: '10901',
      CODEX_HOME: envCodexHome,
    },
  });

  assert.equal(prepared.runtime.port, 23456);
  assert.deepEqual(prepared.runtime.proxy, {
    host: 'proxy.from.env',
    port: 10901,
  });
  assert.equal(prepared.runtime.codexHome, envCodexHome);
  assert.equal(
    prepared.runtime.authPath,
    path.resolve(BASE_DIR, 'credentials', 'auth.json'),
  );
  assert.equal(prepared.runtime.catalogPath, path.join(envCodexHome, 'models.json'));
  assert.deepEqual(
    prepared.warnings.filter((issue) => issue.code === 'relative_path'),
    [{
      severity: 'warning',
      code: 'relative_path',
      path: '/paths/auth',
      message: '相对路径已按配置基准目录解析',
    }],
  );
});

test('CODEX_AUTH_PATH 与 CODEX_CATALOG_PATH 环境值优先并标记实际相对来源', () => {
  const prepared = prepareRouterConfig(validConfig({
    paths: {
      auth: 'config-auth.json',
      catalog: 'config-models.json',
    },
  }), {
    ...context,
    env: {
      ...context.env,
      CODEX_AUTH_PATH: 'env-auth.json',
      CODEX_CATALOG_PATH: './catalog/env-models.json',
    },
  });

  assert.equal(prepared.runtime.authPath, path.resolve(BASE_DIR, 'env-auth.json'));
  assert.equal(
    prepared.runtime.catalogPath,
    path.resolve(BASE_DIR, 'catalog', 'env-models.json'),
  );
  assert.deepEqual(
    prepared.warnings.filter((issue) => issue.code === 'relative_path')
      .map(({ path: issuePath }) => issuePath),
    ['$env/CODEX_AUTH_PATH', '$env/CODEX_CATALOG_PATH'],
  );
});

test('own 路径环境值非法时不回退且诊断不泄露原值', () => {
  const config = validConfig({
    paths: {
      auth: 'fallback-auth.json',
      catalog: 'fallback-models.json',
    },
  });
  const invalidValues = ['', null, 42, 'sensitive-path\r\nvalue'];

  for (const envName of ['CODEX_AUTH_PATH', 'CODEX_CATALOG_PATH']) {
    for (const value of invalidValues) {
      const result = inspectRouterConfig(config, {
        ...context,
        env: { ...context.env, [envName]: value },
      });
      const issue = result.errors.find((item) => item.path === `$env/${envName}`);
      assert.equal(issue?.code, 'path_invalid');
      assert.equal(issue?.message, '必须是非空且不含换行的字符串');
      assert.doesNotMatch(JSON.stringify(issue), /sensitive-path|fallback-/);
      assert.throws(
        () => prepareRouterConfig(config, {
          ...context,
          env: { ...context.env, [envName]: value },
        }),
        RouterConfigError,
      );
    }
  }

  for (const value of invalidValues) {
    const result = inspectRouterConfig(config, {
      ...context,
      env: { ...context.env, CODEX_HOME: value },
    });
    const issue = result.errors.find((item) => item.path === '$env/CODEX_HOME');
    assert.equal(issue?.code, 'path_invalid');
    assert.doesNotMatch(JSON.stringify(issue), /sensitive-path|codex-home/);
  }
});

test('runtime 全字段使用校验后的数值并合并默认值', () => {
  const relayTarget = { ...validConfig().targets[0], vision: false };
  const source = validConfig({
    port: '20001',
    proxy: { host: 'proxy.config.test', port: '10902' },
    timeouts: { connectMs: '1234.5' },
    heartbeatMs: '0.5',
    maxRequestBytes: '4096',
    maxConcurrentRequests: '3',
    maxBufferedRequestBytes: '8192',
    oauth: {
      client_id: 'custom-client',
      refresh_skew_seconds: '45.5',
      refresh_timeout_ms: '40000',
      viaProxy: null,
    },
    targets: [relayTarget],
    visionRelay: {
      host: 'relay.example.test',
      prefix: '/relay/v1',
      model: 'relay-model',
      envKey: 'RELAY_KEY',
      viaProxy: null,
      concurrency: '4',
      maxImagesPerRequest: '9',
      cacheMaxEntries: '65',
      cacheMaxBytes: '2097152',
      maxTokens: '301',
      prompt: '保留提示词',
      timeouts: { connectMs: '2222', privateTimeout: 'keep' },
      privateRelay: { flags: ['first', 'second'] },
    },
  });
  const prepared = prepareRouterConfig(source, {
    ...context,
    env: { ...context.env, RELAY_KEY: 'simulated-relay-secret' },
  });

  assert.deepEqual(prepared.runtime, {
    port: 20001,
    configPath: context.configPath,
    codexHome: context.defaultCodexHome,
    authPath: path.join(context.defaultCodexHome, 'auth.json'),
    catalogPath: path.join(context.defaultCodexHome, 'models.json'),
    proxy: { host: 'proxy.config.test', port: 10902 },
    timeouts: {
      connectMs: 1234.5,
      responseHeaderMs: 120_000,
      streamIdleMs: 600_000,
      requestMs: 600_000,
    },
    heartbeatMs: 10,
    maxRequestBytes: 4096,
    requestBudget: { maxActive: 3, maxBytes: 8192 },
    goalCheckpointPersistence: { enabled: false },
    oauth: {
      clientId: 'custom-client',
      refreshSkewSeconds: 45.5,
      refreshTimeoutMs: 40_000,
      viaProxy: null,
    },
    visionRelay: {
      host: 'relay.example.test',
      prefix: '/relay/v1',
      model: 'relay-model',
      envKey: 'RELAY_KEY',
      viaProxy: false,
      concurrency: 4,
      maxImagesPerRequest: 9,
      cacheMaxEntries: 65,
      cacheMaxBytes: 2_097_152,
      maxTokens: 301,
      prompt: '保留提示词',
      timeouts: { connectMs: 2222, privateTimeout: 'keep' },
      privateRelay: { flags: ['first', 'second'] },
    },
  });
  prepared.runtime.visionRelay.privateRelay.flags.push('runtime-only');
  assert.deepEqual(source.visionRelay.privateRelay.flags, ['first', 'second']);
});

test('不启用视觉中继校验时也只把安全字段送入 runtime', () => {
  const prepared = prepareRouterConfig(validConfig({
    visionRelay: {
      host: 42,
      viaProxy: 'true',
      concurrency: 'bad',
      prompt: [],
      timeouts: [],
      privateRelay: { keep: true },
    },
  }), context);

  assert.equal(prepared.runtime.visionRelay.host, 'token-plan.cn-beijing.maas.aliyuncs.com');
  assert.equal(prepared.runtime.visionRelay.viaProxy, false);
  assert.equal(prepared.runtime.visionRelay.concurrency, 3);
  assert.equal(Object.hasOwn(prepared.runtime.visionRelay, 'prompt'), false);
  assert.equal(Object.hasOwn(prepared.runtime.visionRelay, 'timeouts'), false);
  assert.deepEqual(prepared.runtime.visionRelay.privateRelay, { keep: true });
  assert.deepEqual(
    prepareRouterConfig(validConfig({ visionRelay: false }), context).runtime.visionRelay,
    {
      host: 'token-plan.cn-beijing.maas.aliyuncs.com',
      prefix: '/compatible-mode/v1',
      model: 'qwen3.8-max',
      envKey: 'aliyun_video_key',
      viaProxy: false,
      concurrency: 3,
      maxImagesPerRequest: 8,
      cacheMaxEntries: 64,
      cacheMaxBytes: 1_048_576,
      maxTokens: 300,
    },
  );
});

test('prepared config 与编译 targets 深克隆保留未知字段、注释和数组顺序', () => {
  const source = validConfig({
    _comment: '顶层注释',
    privateTop: { ordered: ['a', 'b', 'c'] },
    targets: [{
      ...validConfig().targets[0],
      _comment: 'target 注释',
      providerPrivate: { nested: { values: [3, 1, 2] } },
    }],
  });
  const before = structuredClone(source);
  const prepared = prepareRouterConfig(source, context);

  assert.deepEqual(prepared.config, source);
  assert.deepEqual(prepared.config.privateTop.ordered, ['a', 'b', 'c']);
  assert.deepEqual(prepared.targets[0].providerPrivate.nested.values, [3, 1, 2]);
  assert.equal(prepared.config._comment, '顶层注释');
  assert.equal(prepared.targets[0]._comment, 'target 注释');
  assert.notStrictEqual(
    prepared.targets[0].providerPrivate,
    prepared.config.targets[0].providerPrivate,
  );
  prepared.targets[0].providerPrivate.nested.values.push(4);
  assert.deepEqual(prepared.config.targets[0].providerPrivate.nested.values, [3, 1, 2]);
  assert.deepEqual(source, before);
});

test('prepareRouterConfig 优先使用环境中的 CODEX_HOME', () => {
  const codexHome = path.join(BASE_DIR, 'env-codex-home');
  const prepared = prepareRouterConfig(validConfig(), {
    ...context,
    env: {
      ...context.env,
      CODEX_HOME: codexHome,
    },
  });

  assert.equal(prepared.runtime.codexHome, codexHome);
});

test('prepareRouterConfig 将已校验端口规范化为 number', () => {
  const envPortPrepared = prepareRouterConfig(validConfig({ port: 15730 }), {
    ...context,
    env: {
      ...context.env,
      ROUTER_PORT: ' 23456 ',
    },
  });
  assert.equal(envPortPrepared.runtime.port, 23456);
  assert.equal(typeof envPortPrepared.runtime.port, 'number');

  const configPortPrepared = prepareRouterConfig(
    validConfig({ port: '23457' }),
    context,
  );
  assert.equal(configPortPrepared.runtime.port, 23457);
  assert.equal(typeof configPortPrepared.runtime.port, 'number');

  for (const missingPort of [null, undefined]) {
    const prepared = prepareRouterConfig(
      validConfig({ port: missingPort }),
      context,
    );
    assert.equal(prepared.runtime.port, 15730);
    assert.equal(typeof prepared.runtime.port, 'number');
  }
});

test('prepareRouterConfig 对非法环境端口抛出 RouterConfigError', () => {
  assert.throws(
    () =>
      prepareRouterConfig(validConfig({ port: 15730 }), {
        ...context,
        env: {
          ...context.env,
          ROUTER_PORT: 'bad',
        },
      }),
    (error) => {
      assert.ok(error instanceof RouterConfigError);
      assert.equal(error.issues[0].code, 'port_invalid');
      assert.equal(error.issues[0].path, '$env/ROUTER_PORT');
      return true;
    },
  );
});

test('prepareRouterConfig 忽略继承的 CODEX_HOME', () => {
  const inheritedEnv = Object.create({ CODEX_HOME: 'inherited-home' });
  inheritedEnv.TEST_API_KEY = context.env.TEST_API_KEY;

  const prepared = prepareRouterConfig(validConfig(), {
    ...context,
    env: inheritedEnv,
  });

  assert.equal(prepared.runtime.codexHome, context.defaultCodexHome);
});

test('RouterConfigError 保存固定信息且 formatConfigIssues 返回逐项文本', () => {
  const portIssue = {
    severity: 'error',
    code: 'port_invalid',
    path: '/port',
    message: '端口无效',
  };
  const issues = [portIssue];
  const error = new RouterConfigError(issues);

  assert.equal(error.name, 'RouterConfigError');
  assert.equal(error.message, '路由配置无效');
  assert.strictEqual(error.issues, issues);
  assert.deepEqual(formatConfigIssues(), []);
  assert.deepEqual(formatConfigIssues(issues), [
    '[error] port_invalid /port: 端口无效',
  ]);
  assert.deepEqual(formatConfigIssues([rootIssue]), [
    '[error] config_root_invalid <root>: 配置根节点必须是普通对象',
  ]);
});

test('inspectRouterConfig 对所有非普通根节点稳定返回精确错误', () => {
  for (const invalidConfig of [null, undefined, [], 42, 'invalid']) {
    assert.deepEqual(inspectRouterConfig(invalidConfig, context), {
      errors: [rootIssue],
      warnings: [],
    });
  }
});

test('prepareRouterConfig 对非法根节点抛出 RouterConfigError', () => {
  assert.throws(
    () => prepareRouterConfig(null, context),
    (error) => {
      assert.ok(error instanceof RouterConfigError);
      assert.equal(error.name, 'RouterConfigError');
      assert.equal(error.message, '路由配置无效');
      assert.deepEqual(error.issues, [rootIssue]);
      return true;
    },
  );
});

test('inspectRouterConfig 一次返回多个独立错误且顺序稳定', () => {
  const result = inspectRouterConfig(
    validConfig({
      port: 0,
      proxy: { host: '', port: 70_000 },
      heartbeatMs: 'bad',
    }),
    context,
  );

  assert.deepEqual(
    result.errors.map((issue) => issue.code),
    ['port_invalid', 'proxy_invalid', 'proxy_invalid', 'heartbeat_invalid'],
  );
  assert.deepEqual(
    result.errors.map((issue) => issue.path),
    ['/port', '/proxy/host', '/proxy/port', '/heartbeatMs'],
  );
});

test('inspectRouterConfig 不会让非法环境覆盖回退到配置值', () => {
  const result = inspectRouterConfig(validConfig({ port: 15730 }), {
    ...context,
    env: {
      TEST_API_KEY: context.env.TEST_API_KEY,
      ROUTER_PORT: 'not-a-port',
    },
  });

  assert.equal(result.errors[0].code, 'port_invalid');
  assert.equal(result.errors[0].path, '$env/ROUTER_PORT');
});

test('inspectRouterConfig 的问题对象与格式化文本不会泄露环境变量值', () => {
  const secret = 'sk-never-print-this';
  const result = inspectRouterConfig(validConfig(), {
    ...context,
    env: {
      TEST_API_KEY: secret,
      ROUTER_PORT: secret,
    },
  });

  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(
    formatConfigIssues(result.errors).join('\n'),
    new RegExp(secret),
  );
});

test('inspectRouterConfig 拒绝会被宽松数值转换误收的标量', () => {
  const invalidNumbers = [
    '',
    '   ',
    true,
    false,
    Infinity,
    Number.NaN,
    'Infinity',
    'NaN',
    '0x10',
    {},
  ];

  for (const invalidNumber of invalidNumbers) {
    const portResult = inspectRouterConfig(
      validConfig({ port: invalidNumber }),
      context,
    );
    assert.equal(portResult.errors[0].code, 'port_invalid');
    assert.equal(portResult.errors[0].path, '/port');

    const proxyPortResult = inspectRouterConfig(
      validConfig({
        proxy: { host: '127.0.0.1', port: invalidNumber },
      }),
      context,
    );
    assert.equal(proxyPortResult.errors[0].code, 'proxy_invalid');
    assert.equal(proxyPortResult.errors[0].path, '/proxy/port');

    const heartbeatResult = inspectRouterConfig(
      validConfig({ heartbeatMs: invalidNumber }),
      context,
    );
    assert.equal(heartbeatResult.errors[0].code, 'heartbeat_invalid');
    assert.equal(heartbeatResult.errors[0].path, '/heartbeatMs');
  }

  for (const invalidHost of ['', true, Infinity, 'line\rbreak', 'line\nbreak']) {
    const result = inspectRouterConfig(
      validConfig({ proxy: { host: invalidHost, port: 10808 } }),
      context,
    );
    assert.equal(result.errors[0].code, 'proxy_invalid');
    assert.equal(result.errors[0].path, '/proxy/host');
  }
});

test('inspectRouterConfig 对端口整数范围和正数心跳间隔执行边界校验', () => {
  for (const validPort of [1, 65_535, '1', '65535']) {
    assert.deepEqual(
      inspectRouterConfig(
        validConfig({
          port: validPort,
          proxy: { host: '127.0.0.1', port: validPort },
        }),
        context,
      ).errors,
      [],
    );
  }

  for (const invalidPort of [0, -1, 1.5, 65_536]) {
    const result = inspectRouterConfig(
      validConfig({
        port: invalidPort,
        proxy: { host: '127.0.0.1', port: invalidPort },
      }),
      context,
    );
    assert.deepEqual(
      result.errors.map((issue) => issue.path),
      ['/port', '/proxy/port'],
    );
  }

  for (const validHeartbeat of [0.5, '0.5']) {
    assert.deepEqual(
      inspectRouterConfig(
        validConfig({ heartbeatMs: validHeartbeat }),
        context,
      ).errors,
      [],
    );
  }
  for (const invalidHeartbeat of [0, -1, '0', '-1']) {
    const result = inspectRouterConfig(
      validConfig({ heartbeatMs: invalidHeartbeat }),
      context,
    );
    assert.equal(result.errors[0].code, 'heartbeat_invalid');
    assert.equal(result.errors[0].path, '/heartbeatMs');
  }
});

test('inspectRouterConfig 接受环境中的非空十进制字符串', () => {
  const result = inspectRouterConfig(validConfig(), {
    ...context,
    env: {
      TEST_API_KEY: context.env.TEST_API_KEY,
      ROUTER_PORT: ' 23456 ',
      V2RAY_HOST: 'proxy.example.test',
      V2RAY_PORT: ' 10809 ',
      ROUTER_HEARTBEAT_MS: ' 12.5 ',
    },
  });

  assert.deepEqual(result.errors, []);
});

test('inspectRouterConfig 保留配置字段 null 的既有缺省语义', () => {
  assert.deepEqual(
    inspectRouterConfig(
      validConfig({
        port: null,
        proxy: { host: null, port: null },
        heartbeatMs: null,
      }),
      context,
    ).errors,
    [],
  );
  assert.deepEqual(
    inspectRouterConfig(validConfig({ proxy: null }), context).errors,
    [],
  );
});

test('inspectRouterConfig 对存在但为空的环境覆盖报环境路径错误', () => {
  const cases = [
    ['ROUTER_PORT', null, 'port_invalid', '$env/ROUTER_PORT'],
    ['ROUTER_PORT', '', 'port_invalid', '$env/ROUTER_PORT'],
    ['V2RAY_HOST', null, 'proxy_invalid', '$env/V2RAY_HOST'],
    ['V2RAY_HOST', '', 'proxy_invalid', '$env/V2RAY_HOST'],
    ['V2RAY_PORT', null, 'proxy_invalid', '$env/V2RAY_PORT'],
    ['V2RAY_PORT', '', 'proxy_invalid', '$env/V2RAY_PORT'],
    [
      'ROUTER_HEARTBEAT_MS',
      null,
      'heartbeat_invalid',
      '$env/ROUTER_HEARTBEAT_MS',
    ],
    [
      'ROUTER_HEARTBEAT_MS',
      '',
      'heartbeat_invalid',
      '$env/ROUTER_HEARTBEAT_MS',
    ],
  ];

  for (const [envName, value, code, issuePath] of cases) {
    const result = inspectRouterConfig(validConfig(), {
      ...context,
      env: {
        TEST_API_KEY: context.env.TEST_API_KEY,
        [envName]: value,
      },
    });
    assert.equal(result.errors[0].code, code);
    assert.equal(result.errors[0].path, issuePath);
  }
});

test('inspectRouterConfig 对非法 proxy 容器只返回一个容器级错误', () => {
  for (const invalidProxy of [false, [], 'bad', 42]) {
    const result = inspectRouterConfig(
      validConfig({
        port: 0,
        proxy: invalidProxy,
        heartbeatMs: 'bad',
      }),
      context,
    );

    assert.deepEqual(
      result.errors.map((issue) => issue.code),
      ['port_invalid', 'proxy_invalid', 'heartbeat_invalid'],
    );
    assert.deepEqual(
      result.errors.map((issue) => issue.path),
      ['/port', '/proxy', '/heartbeatMs'],
    );
  }
});

test('inspectRouterConfig 对缺失或 null 的 proxy 容器沿用缺省值', () => {
  assert.deepEqual(
    inspectRouterConfig(validConfig({ proxy: null }), context).errors,
    [],
  );
  assert.deepEqual(
    inspectRouterConfig(validConfig({ proxy: undefined }), context).errors,
    [],
  );
});

test('inspectRouterConfig 在 context.env 缺省时使用配置值', () => {
  assert.deepEqual(inspectRouterConfig(validConfig()).errors, []);
});

test('inspectRouterConfig 忽略继承的环境键但拒绝 own undefined', () => {
  const inheritedEnv = Object.create({ ROUTER_PORT: 'bad' });
  assert.deepEqual(
    inspectRouterConfig(validConfig({ port: 15730 }), {
      ...context,
      env: inheritedEnv,
    }).errors,
    [],
  );

  const ownUndefinedResult = inspectRouterConfig(
    validConfig({ port: 15730 }),
    {
      ...context,
      env: { ROUTER_PORT: undefined },
    },
  );
  assert.equal(ownUndefinedResult.errors[0].code, 'port_invalid');
  assert.equal(ownUndefinedResult.errors[0].path, '$env/ROUTER_PORT');
});

for (const [code, issuePath, override] of [
  ['target_name_invalid', '/targets/0/name', { name: '' }],
  ['target_match_invalid', '/targets/0/match', { match: '(' }],
  ['target_host_invalid', '/targets/0/host', { host: 'bad\r\nhost' }],
  ['target_port_invalid', '/targets/0/port', { port: 70_000 }],
  ['target_protocol_invalid', '/targets/0/protocol', { protocol: 'ftp' }],
  ['target_wire_api_invalid', '/targets/0/wireApi', { wireApi: 'messages' }],
  ['target_path_invalid', '/targets/0/prefix', { prefix: 'v1' }],
  ['target_env_key_invalid', '/targets/0/envKey', { envKey: 'BAD KEY' }],
  ['target_headers_invalid', '/targets/0/headers', { headers: [] }],
  ['target_forward_headers_invalid', '/targets/0/forwardHeaders', { forwardHeaders: 'x-test' }],
  ['target_auth_conflict', '/targets/0/envKey', { useOpenAiAuth: true, envKey: 'TEST_API_KEY' }],
]) {
  test(`${code} 返回稳定 target path`, () => {
    const config = validConfig();
    Object.assign(config.targets[0], override);
    const result = inspectRouterConfig(config, context);
    assert.ok(result.errors.some((item) => item.code === code && item.path === issuePath));
  });
}

test('target match 拒绝超长、反向引用、嵌套量词和重复前缀歧义且保留常用生产规则', () => {
  const unsafePatterns = [
    'a'.repeat(1_025),
    '^(a+)+' + '$',
    '^(a|aa)+$',
    '^((a|aa))+$',
    '^(a)\\1$',
    '^(?<letter>a)\\k<letter>$',
  ];
  for (const match of unsafePatterns) {
    const result = inspectRouterConfig(validConfig({
      targets: [{ ...validConfig().targets[0], match }],
    }), context);
    assert.deepEqual(
      result.errors.filter((issue) => issue.path === '/targets/0/match').map((issue) => issue.code),
      ['target_match_unsafe'],
    );
  }

  const safePatterns = [
    '^(gpt-|codex-|o\\d|computer-use)',
    '^deepseek-v4-flash$',
    '^deepseek-(?!v4-flash$)',
    '^qwen',
    '^grok',
    '^glm',
    '^qwen3\\.8-max\\+\\(cn\\)\\[1\\]$',
  ];
  for (const match of safePatterns) {
    assert.equal(
      inspectRouterConfig(validConfig({
        targets: [{ ...validConfig().targets[0], match }],
      }), context).errors.some((issue) => issue.path === '/targets/0/match'),
      false,
      match,
    );
  }
});

test('target 非普通对象只返回容器级 name 错误且不级联', () => {
  for (const target of [null, [], 'bad', 42]) {
    const result = inspectRouterConfig(validConfig({ targets: [target] }), context);
    assert.deepEqual(result.errors, [{
      severity: 'error',
      code: 'target_name_invalid',
      path: '/targets/0',
      message: 'target 必须是普通对象',
    }]);
  }
});

test('target 字段缺省、空 prefix 和 wire API 别名保持合法', () => {
  const target = {
    name: 'alias-chat',
    match: '^alias$',
    host: 'api.example.test',
    prefix: '',
    envKey: 'TEST_API_KEY',
    apiFormat: 'openai_chat',
    protocol: null,
    port: null,
    chatPath: null,
    headers: null,
    forwardHeaders: null,
  };
  assert.deepEqual(inspectRouterConfig(validConfig({ targets: [target] }), context), {
    errors: [],
    warnings: [],
  });
});

test('target 严格校验 port、路径、wire 字段优先级与 useOpenAiAuth 类型', () => {
  for (const port of [' 443 ', '+443', '4e2', '0x1bb', 1.5, 0, 65_536]) {
    const config = validConfig();
    config.targets[0].port = port;
    assert.ok(inspectRouterConfig(config, context).errors.some(
      (item) => item.code === 'target_port_invalid' && item.path === '/targets/0/port',
    ));
  }

  for (const [field, value] of [
    ['prefix', null],
    ['prefix', '/bad\npath'],
    ['chatPath', ''],
    ['chatPath', 'chat/completions'],
    ['chatPath', '/bad\rpath'],
  ]) {
    const config = validConfig();
    config.targets[0][field] = value;
    assert.ok(inspectRouterConfig(config, context).errors.some(
      (item) => item.code === 'target_path_invalid' && item.path === `/targets/0/${field}`,
    ));
  }

  const emptyFormat = validConfig();
  emptyFormat.targets[0].apiFormat = '';
  emptyFormat.targets[0].wireApi = 'chat';
  assert.ok(inspectRouterConfig(emptyFormat, context).errors.some(
    (item) => item.code === 'target_wire_api_invalid' && item.path === '/targets/0/apiFormat',
  ));

  for (const invalidFormat of [false, 0]) {
    const config = validConfig();
    config.targets[0].apiFormat = invalidFormat;
    config.targets[0].wireApi = 'chat';
    assert.ok(inspectRouterConfig(config, context).errors.some(
      (item) => item.code === 'target_wire_api_invalid'
        && item.path === '/targets/0/apiFormat',
    ));
  }

  const invalidOfficialFlag = validConfig();
  invalidOfficialFlag.targets[0].useOpenAiAuth = 'true';
  assert.ok(inspectRouterConfig(invalidOfficialFlag, context).errors.some(
    (item) => item.code === 'target_auth_conflict' && item.path === '/targets/0/useOpenAiAuth',
  ));
});

test('headers 接受安全标量与数组，并拒绝名称、形状和 CRLF', () => {
  const valid = validConfig();
  valid.targets[0].headers = {
    'x-string': 'value',
    'x-number': 2,
    'x-boolean': false,
    'x-array': ['a', 2, true],
  };
  assert.deepEqual(inspectRouterConfig(valid, context).errors, []);

  for (const headers of [
    { 'bad name': 'value' },
    { 'x-safe': null },
    { 'x-safe': { nested: 'bad' } },
    { 'x-safe': ['ok', null] },
    { 'x-safe': 'secret-header-value\r\ninjected' },
    { 'secret-header-name\ninvalid': 'value' },
  ]) {
    const config = validConfig();
    config.targets[0].headers = headers;
    const result = inspectRouterConfig(config, context);
    assert.ok(result.errors.some(
      (item) => item.code === 'target_headers_invalid' && item.path === '/targets/0/headers',
    ));
    assert.doesNotMatch(JSON.stringify(result), /secret-header-(?:name|value)/);
    assert.doesNotMatch(formatConfigIssues(result.errors).join('\n'), /secret-header-(?:name|value)/);
  }
});

test('forwardHeaders 拒绝非法名称并对禁止透传项给出精确 warning path', () => {
  for (const forwardHeaders of [['x-safe', 'bad name'], ['x-safe', 42]]) {
    const config = validConfig();
    config.targets[0].forwardHeaders = forwardHeaders;
    assert.ok(inspectRouterConfig(config, context).errors.some(
      (item) => item.code === 'target_forward_headers_invalid'
        && item.path === '/targets/0/forwardHeaders/1',
    ));
  }

  const config = validConfig();
  config.targets[0].forwardHeaders = [
    'x-safe',
    'connection',
    'authorization',
    'accept-encoding',
  ];
  assert.deepEqual(
    inspectRouterConfig(config, context).warnings
      .filter((item) => item.code === 'forward_header_ignored')
      .map((item) => item.path),
    [
      '/targets/0/forwardHeaders/1',
      '/targets/0/forwardHeaders/2',
      '/targets/0/forwardHeaders/3',
    ],
  );
});

test('官方 target 无需 envKey，普通业务 header 不构成认证冲突', () => {
  const target = {
    name: 'official',
    match: '^official$',
    host: 'chatgpt.com',
    useOpenAiAuth: true,
    headers: { 'x-business-scope': 'private-value' },
  };
  assert.deepEqual(inspectRouterConfig(validConfig({ targets: [target] }), context), {
    errors: [],
    warnings: [],
  });
});

test('缺少环境 Key 的 warning 只显示变量名而不泄露环境值', () => {
  const secret = 'never-print-this-env-secret';
  const config = validConfig();
  config.targets[0].envKey = 'MISSING_KEY';
  config.targets[0].headers = { 'x-secret': secret };
  const result = inspectRouterConfig(config, { ...context, env: { PRESENT_KEY: secret } });
  const warning = result.warnings.find((item) => item.code === 'env_missing');
  assert.equal(warning.path, '/targets/0/envKey');
  assert.equal(warning.message, 'MISSING_KEY');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(formatConfigIssues(result.warnings).join('\n'), new RegExp(secret));
});

test('重复 name、实际 target、混合 wire API、HTTP proxy 与可疑状态域产生警告', () => {
  const first = validConfig().targets[0];
  const config = validConfig({
    targets: [
      { ...first, forwardHeaders: ['connection'] },
      { ...first, protocol: 'http', port: 80, viaProxy: true },
      { ...first, name: 'duplicate' },
      { ...first, name: 'native', wireApi: 'responses' },
      { ...first, name: 'state-a', match: '^state-a$', stateDomain: 'shared' },
      {
        ...first,
        name: 'state-b',
        match: '^state-b$',
        host: 'other.example.test',
        stateDomain: 'shared',
      },
    ],
  });
  const result = inspectRouterConfig(config, context);
  const codes = result.warnings.map((item) => item.code);
  for (const code of [
    'forward_header_ignored',
    'proxy_ignored_for_http',
    'target_name_duplicate',
    'target_duplicate',
    'target_wire_api_mixed',
    'state_domain_suspicious',
  ]) assert.ok(codes.includes(code), code);
  assert.doesNotMatch(JSON.stringify(result), /shared|TEST_API_KEY|test-only-secret/);
});

test('target warning 顺序对同一输入稳定且先本地后跨 target', () => {
  const first = {
    ...validConfig().targets[0],
    envKey: 'MISSING_KEY',
    host: '127.0.0.1',
    protocol: 'http',
    viaProxy: true,
    forwardHeaders: ['connection'],
  };
  const config = validConfig({ targets: [first, { ...first }] });
  const warningShape = (result) => result.warnings.map(({ code, path }) => [code, path]);
  const expected = [
    ['env_missing', '/targets/0/envKey'],
    ['proxy_ignored_for_http', '/targets/0/viaProxy'],
    ['forward_header_ignored', '/targets/0/forwardHeaders/0'],
    ['env_missing', '/targets/1/envKey'],
    ['proxy_ignored_for_http', '/targets/1/viaProxy'],
    ['forward_header_ignored', '/targets/1/forwardHeaders/0'],
    ['target_name_duplicate', '/targets/1/name'],
    ['target_duplicate', '/targets/1'],
  ];
  assert.deepEqual(warningShape(inspectRouterConfig(config, { ...context, env: {} })), expected);
  assert.deepEqual(warningShape(inspectRouterConfig(config, { ...context, env: {} })), expected);
});

test('存在任一 target 错误时 prepare 不编译部分目标', () => {
  const first = validConfig().targets[0];
  const config = validConfig({ targets: [first, { ...first, name: 'bad', match: '(' }] });
  assert.throws(
    () => prepareRouterConfig(config, context),
    (error) => error instanceof RouterConfigError
      && error.issues.some((item) => item.code === 'target_match_invalid'),
  );
});

test('prepareRouterConfig 缺省 context 时仍返回合法配置', () => {
  const prepared = prepareRouterConfig(validConfig());

  assert.equal(prepared.runtime.configPath, undefined);
  assert.equal(prepared.runtime.codexHome, undefined);
  assert.equal(prepared.runtime.port, 15730);
  assert.equal(prepared.warnings.some((item) => item.code === 'env_missing'), true);
});

test('context 字段不完整时相对路径安全回退且不抛原生 TypeError', () => {
  const config = validConfig({
    paths: {
      auth: 'relative-auth.json',
      catalog: 'nested/relative-models.json',
    },
  });
  const withoutBase = prepareRouterConfig(config, { env: context.env });
  assert.equal(withoutBase.runtime.authPath, undefined);
  assert.equal(withoutBase.runtime.catalogPath, undefined);
  assert.deepEqual(
    withoutBase.warnings.filter((issue) => issue.code === 'relative_path')
      .map(({ path: issuePath }) => issuePath),
    ['/paths/auth', '/paths/catalog'],
  );

  const configPathOnly = path.join(BASE_DIR, 'nested', 'router.json');
  const fromConfigDirectory = prepareRouterConfig(config, {
    configPath: configPathOnly,
    env: context.env,
  });
  assert.equal(
    fromConfigDirectory.runtime.authPath,
    path.resolve(path.dirname(configPathOnly), 'relative-auth.json'),
  );
  assert.equal(
    fromConfigDirectory.runtime.catalogPath,
    path.resolve(path.dirname(configPathOnly), 'nested', 'relative-models.json'),
  );
});

test('显式使用同一 stateDomain 的相同 target 仍报告 target_duplicate', () => {
  const target = {
    ...validConfig().targets[0],
    stateDomain: 'shared-domain',
  };
  const result = inspectRouterConfig(
    validConfig({ targets: [target, { ...target }] }),
    context,
  );

  assert.equal(
    result.warnings.some(
      (item) => item.code === 'target_duplicate' && item.path === '/targets/1',
    ),
    true,
  );
});

test('无效高优先级 wire 字段不参与依赖 provider wire 的跨 target warning', () => {
  const invalidWire = {
    ...validConfig().targets[0],
    apiFormat: false,
    wireApi: 'chat',
  };
  const nativeResponses = {
    ...validConfig().targets[0],
    name: 'native-responses',
    wireApi: 'responses',
  };
  const result = inspectRouterConfig(
    validConfig({ targets: [invalidWire, nativeResponses] }),
    context,
  );

  assert.equal(
    result.errors.some(
      (item) => item.code === 'target_wire_api_invalid'
        && item.path === '/targets/0/apiFormat',
    ),
    true,
  );
  assert.equal(
    result.warnings.some((item) => [
      'target_duplicate',
      'target_wire_api_mixed',
      'state_domain_suspicious',
    ].includes(item.code)),
    false,
  );
});

test('useOpenAiAuth 的 null 与 undefined 保持未启用语义', () => {
  for (const value of [null, undefined]) {
    const config = validConfig();
    config.targets[0].useOpenAiAuth = value;
    assert.deepEqual(inspectRouterConfig(config, context).errors, []);
  }
});

test('远程明文 HTTP 拒绝环境或官方凭据且仅允许规范回环主机', () => {
  const base = validConfig().targets[0];
  const inspectTarget = (target) => inspectRouterConfig(validConfig({ targets: [target] }), context);

  for (const target of [
    { ...base, protocol: 'http', host: 'api.example.test' },
    {
      ...base,
      protocol: 'http',
      host: 'api.example.test',
      envKey: undefined,
      useOpenAiAuth: true,
    },
  ]) {
    assert.deepEqual(
      inspectTarget(target).errors.filter((issue) => issue.code === 'target_insecure_auth_transport'),
      [{
        severity: 'error',
        code: 'target_insecure_auth_transport',
        path: '/targets/0/protocol',
        message: '带凭据的 HTTP target 仅允许规范回环主机',
      }],
    );
  }

  for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1']) {
    assert.equal(
      inspectTarget({ ...base, protocol: 'http', host }).errors.some(
        (issue) => issue.code === 'target_insecure_auth_transport',
      ),
      false,
      host,
    );
  }
  assert.equal(inspectTarget({
    ...base,
    protocol: 'http',
    host: 'localhost',
    envKey: undefined,
    useOpenAiAuth: true,
  }).errors.some((issue) => issue.code === 'target_insecure_auth_transport'), false);

  for (const host of [
    'user@127.0.0.1', 'localhost.', '127.0.0.1.', '[::1]', '127.1', '0x7f000001', '2130706433',
  ]) {
    assert.equal(
      inspectTarget({ ...base, protocol: 'http', host }).errors.some(
        (issue) => issue.code === 'target_insecure_auth_transport',
      ),
      true,
      host,
    );
  }

  assert.equal(inspectTarget({ ...base, protocol: 'https', host: 'api.example.test' }).errors.length, 0);
});

test('非法 name 类型不会让 provider 解析抛出异常', () => {
  for (const name of [42, null, {}, []]) {
    const config = validConfig();
    config.targets[0].name = name;
    const result = inspectRouterConfig(config, context);
    assert.equal(
      result.errors.some(
        (item) => item.code === 'target_name_invalid'
          && item.path === '/targets/0/name',
      ),
      true,
    );
  }
});

for (const [label, override, expectedCode] of [
  ['host', { host: 'bad\nhost' }, 'target_host_invalid'],
  ['protocol', { protocol: 'ftp' }, 'target_protocol_invalid'],
  ['port', { port: 70_000 }, 'target_port_invalid'],
  ['prefix', { prefix: 'v1' }, 'target_path_invalid'],
  ['headers', { headers: { 'bad name': 'value' } }, 'target_headers_invalid'],
  [
    'auth',
    { useOpenAiAuth: true, envKey: 'TEST_API_KEY' },
    'target_auth_conflict',
  ],
]) {
  test(`相同 ${label} 错误 target 不产生身份级联 warning`, () => {
    const target = {
      ...validConfig().targets[0],
      ...override,
      stateDomain: 'shared-invalid-domain',
    };
    const result = inspectRouterConfig(
      validConfig({ targets: [target, { ...target }] }),
      context,
    );

    assert.equal(result.errors.some((item) => item.code === expectedCode), true);
    assert.equal(
      result.warnings.some((item) => [
        'target_duplicate',
        'state_domain_suspicious',
      ].includes(item.code)),
      false,
    );
  });
}

test('Chat target 身份按有效 chatPath 区分', () => {
  const first = {
    ...validConfig().targets[0],
    wireApi: 'chat',
    chatPath: '/chat/a',
  };
  const second = {
    ...first,
    name: 'chat-b',
    chatPath: '/chat/b',
  };
  const withoutExplicitDomain = inspectRouterConfig(
    validConfig({ targets: [first, second] }),
    context,
  );
  assert.equal(
    withoutExplicitDomain.warnings.some((item) => item.code === 'target_duplicate'),
    false,
  );

  const withExplicitDomain = inspectRouterConfig(
    validConfig({
      targets: [
        { ...first, stateDomain: 'shared-chat-domain' },
        { ...second, stateDomain: 'shared-chat-domain' },
      ],
    }),
    context,
  );
  assert.equal(
    withExplicitDomain.warnings.some(
      (item) => item.code === 'state_domain_suspicious'
        && item.path === '/targets/1/stateDomain',
    ),
    true,
  );
});

function assertIssue(config, code, issuePath, inspectionContext = context) {
  const result = inspectRouterConfig(config, inspectionContext);
  assert.equal(
    result.errors.some((issue) => issue.code === code && issue.path === issuePath),
    true,
    `${code} ${issuePath}: ${JSON.stringify(result)}`,
  );
}

test('targets 缺失、null、非数组或空数组统一返回 targets_required', () => {
  for (const targets of [undefined, null, {}, '', []]) {
    const config = validConfig({ targets });
    const result = inspectRouterConfig(config, context);
    assert.deepEqual(result.errors, [{
      severity: 'error',
      code: 'targets_required',
      path: '/targets',
      message: '必须是非空数组',
    }]);
  }
});

test('Task4 标量和容器错误返回稳定 code 与精确 path', () => {
  const cases = [
    ['timeout_invalid', '/timeouts', { timeouts: [] }],
    ['timeout_invalid', '/timeouts/connectMs', { timeouts: { connectMs: 0 } }],
    ['request_limit_invalid', '/maxRequestBytes', { maxRequestBytes: 0 }],
    ['request_limit_invalid', '/maxConcurrentRequests', { maxConcurrentRequests: 1.5 }],
    ['request_limit_invalid', '/maxBufferedRequestBytes', { maxBufferedRequestBytes: true }],
    ['request_budget_conflict', '/maxBufferedRequestBytes', {
      maxRequestBytes: 2_049,
      maxBufferedRequestBytes: 2_048,
    }],
    ['provider_pool_invalid', '/providerPool', { providerPool: null }],
    ['provider_pool_invalid', '/providerPool/maxEntries', { providerPool: { maxEntries: 0 } }],
    ['provider_pool_invalid', '/providerPool/allowDefaultTarget', {
      providerPool: { allowDefaultTarget: 'false' },
    }],
    ['response_history_invalid', '/responseHistory', { responseHistory: null }],
    ['response_history_invalid', '/responseHistory/maxEntryBytes', {
      responseHistory: { maxEntryBytes: Number.NaN },
    }],
    ['response_history_conflict', '/responseHistory/maxEntryBytes', {
      responseHistory: { maxEntryBytes: 2_048, maxBytes: 1_024 },
    }],
    ['checkpoint_invalid', '/goalCheckpoint', { goalCheckpoint: null }],
    ['checkpoint_invalid', '/goalCheckpoint/sourceWindowRatio', {
      goalCheckpoint: { sourceWindowRatio: 0 },
    }],
    ['checkpoint_conflict', '/goalCheckpoint/maxResponseIndexes', {
      goalCheckpoint: { maxEntries: 4, maxResponseIndexes: 3 },
    }],
    ['model_capability_invalid', '/modelCapabilities', { modelCapabilities: {} }],
    ['model_capability_invalid', '/modelCapabilities/0/match', {
      modelCapabilities: [{ match: '(' }],
    }],
    ['model_context_invalid', '/modelContext', { modelContext: [] }],
    ['model_context_invalid', '/modelContext/autoCompactTokenLimit', {
      modelContext: { contextWindow: 1_000, autoCompactTokenLimit: 1_001 },
    }],
    ['model_capability_invalid', '/supportsResponses/slugs', {
      supportsResponses: { slugs: 'model-a' },
    }],
    ['oauth_invalid', '/oauth', { oauth: null }],
    ['oauth_invalid', '/oauth/client_id', { oauth: { client_id: '' } }],
    ['path_invalid', '/paths', { paths: [] }],
    ['path_invalid', '/paths/auth', { paths: { auth: 'bad\nauth.json' } }],
  ];

  for (const [code, issuePath, overrides] of cases) {
    assertIssue(validConfig(overrides), code, issuePath);
  }
});

test('timeouts 显式字段必须为有限正数，缺失或 null 容器使用默认值', () => {
  for (const timeouts of [undefined, null, {}]) {
    assert.deepEqual(inspectRouterConfig(validConfig({ timeouts }), context).errors, []);
  }

  for (const field of ['connectMs', 'responseHeaderMs', 'streamIdleMs', 'requestMs']) {
    for (const value of [null, '', '   ', '0x10', 0, -1, Infinity, Number.NaN, false, {}]) {
      assertIssue(
        validConfig({ timeouts: { [field]: value } }),
        'timeout_invalid',
        `/timeouts/${field}`,
      );
    }
    assert.deepEqual(
      inspectRouterConfig(validConfig({ timeouts: { [field]: 0.5 } }), context).errors,
      [],
    );
    assert.deepEqual(
      inspectRouterConfig(validConfig({ timeouts: { [field]: ' 0.5 ' } }), context).errors,
      [],
    );
  }
});

test('请求限制执行正整数边界、null 默认与有效值上的预算冲突检查', () => {
  for (const field of ['maxRequestBytes', 'maxConcurrentRequests', 'maxBufferedRequestBytes']) {
    for (const value of ['', '   ', '0x10', 0, -1, 1.5, Infinity, Number.NaN, false, {}]) {
      assertIssue(validConfig({ [field]: value }), 'request_limit_invalid', `/${field}`);
    }
    for (const value of [undefined, null]) {
      assert.deepEqual(inspectRouterConfig(validConfig({
        maxRequestBytes: 1_024,
        maxBufferedRequestBytes: 128 * 1024 * 1024,
        [field]: value,
      }), context).errors, []);
    }
  }

  const invalidLimit = inspectRouterConfig(validConfig({
    maxRequestBytes: 'bad',
    maxBufferedRequestBytes: 1,
  }), context);
  assert.deepEqual(
    invalidLimit.errors.map((issue) => issue.code),
    ['request_limit_invalid'],
  );

  assert.deepEqual(inspectRouterConfig(validConfig({
    maxRequestBytes: '1024',
    maxConcurrentRequests: '2',
    maxBufferedRequestBytes: '2048',
  }), context).errors, []);
  assertIssue(
    validConfig({ maxRequestBytes: '4096', maxBufferedRequestBytes: '2048' }),
    'request_budget_conflict',
    '/maxBufferedRequestBytes',
  );
});

test('请求限制对超过兼容阈值的内存预算给出稳定 warning 而不拒绝配置', () => {
  const highRequest = inspectRouterConfig(validConfig({
    maxRequestBytes: 256 * 1024 * 1024 + 1,
    maxBufferedRequestBytes: 512 * 1024 * 1024,
  }), context);
  assert.deepEqual(highRequest.errors, []);
  assert.deepEqual(highRequest.warnings, [{
    severity: 'warning',
    code: 'request_limit_high_risk',
    path: '/maxRequestBytes',
    message: '单请求上限超过 256 MiB，JSON 解析可能造成高内存占用',
  }]);

  const highBuffered = inspectRouterConfig(validConfig({
    maxRequestBytes: 256 * 1024 * 1024,
    maxBufferedRequestBytes: 512 * 1024 * 1024 + 1,
  }), context);
  assert.deepEqual(highBuffered.errors, []);
  assert.deepEqual(highBuffered.warnings, [{
    severity: 'warning',
    code: 'request_limit_high_risk',
    path: '/maxBufferedRequestBytes',
    message: '总缓冲预算超过 512 MiB，可能造成进程内存压力',
  }]);

  assert.deepEqual(inspectRouterConfig(validConfig({
    maxRequestBytes: 256 * 1024 * 1024,
    maxBufferedRequestBytes: 512 * 1024 * 1024,
  }), context).warnings, []);
  assert.deepEqual(inspectRouterConfig(validConfig({
    maxRequestBytes: null,
    maxBufferedRequestBytes: null,
  }), context).warnings, []);
});

test('providerPool 校验已知字段并忽略测试专用和其他未知字段', () => {
  for (const providerPool of [undefined, {}, {
    maxEntries: 1,
    ttlMs: 1,
    allowDefaultTarget: true,
    modelAffinity: false,
    now: '测试专用字段不参与校验',
    vendorOption: { keep: true },
  }, {
    maxEntries: '2048',
    ttlMs: '86400000',
    allowDefaultTarget: null,
    modelAffinity: null,
  }, {
    maxEntries: null,
    ttlMs: null,
  }]) {
    assert.deepEqual(inspectRouterConfig(validConfig({ providerPool }), context).errors, []);
  }

  for (const [field, value] of [
    ['maxEntries', 0],
    ['ttlMs', 1.5],
    ['allowDefaultTarget', 0],
    ['modelAffinity', 'false'],
  ]) {
    assertIssue(
      validConfig({ providerPool: { [field]: value } }),
      'provider_pool_invalid',
      `/providerPool/${field}`,
    );
  }
});

test('responseHistory 校验容量字段并仅在有效预算间报告冲突', () => {
  for (const responseHistory of [undefined, {}, {
    maxEntries: 1,
    maxEntryBytes: 1,
    maxBytes: 1,
    ttlMs: 1,
    now: false,
  }, {
    maxEntries: '512',
    maxEntryBytes: '1048576',
    maxBytes: '16777216',
    ttlMs: '86400000',
  }, {
    maxEntries: null,
    maxEntryBytes: null,
    maxBytes: null,
    ttlMs: null,
  }]) {
    assert.deepEqual(inspectRouterConfig(validConfig({ responseHistory }), context).errors, []);
  }

  for (const field of ['maxEntries', 'maxEntryBytes', 'maxBytes', 'ttlMs']) {
    assertIssue(
      validConfig({ responseHistory: { [field]: 0 } }),
      'response_history_invalid',
      `/responseHistory/${field}`,
    );
  }

  const invalidEntryBudget = inspectRouterConfig(validConfig({
    responseHistory: { maxEntryBytes: 'bad', maxBytes: 1 },
  }), context);
  assert.deepEqual(
    invalidEntryBudget.errors.map((issue) => issue.code),
    ['response_history_invalid'],
  );

  assertIssue(
    validConfig({ responseHistory: { maxEntryBytes: 16 * 1024 * 1024 + 1 } }),
    'response_history_conflict',
    '/responseHistory/maxEntryBytes',
  );
  assertIssue(
    validConfig({ responseHistory: { maxBytes: 1024 * 1024 - 1 } }),
    'response_history_conflict',
    '/responseHistory/maxEntryBytes',
  );
  assertIssue(
    validConfig({ responseHistory: { maxEntryBytes: '2048', maxBytes: '1024' } }),
    'response_history_conflict',
    '/responseHistory/maxEntryBytes',
  );
});

test('goalCheckpoint 的 disabled 模式忽略业务值，启用时校验边界与索引预算', () => {
  assert.deepEqual(inspectRouterConfig(validConfig({
    goalCheckpoint: {
      enabled: false,
      maxEntries: 0,
      maxResponseIdsPerTask: 'bad',
      maxResponseIndexes: null,
      ttlMs: Number.NaN,
      sourceTokenBudget: 1,
      sourceWindowRatio: 2,
      maxOutputTokens: 1,
      requestMs: 1,
    },
  }), context).errors, []);

  for (const [field, value] of [
    ['enabled', 'false'],
    ['maxEntries', 0],
    ['maxResponseIdsPerTask', 1.5],
    ['maxResponseIndexes', 0],
    ['ttlMs', '0x10'],
    ['sourceTokenBudget', 127],
    ['sourceWindowRatio', 1.01],
    ['maxOutputTokens', 255],
    ['requestMs', 999],
  ]) {
    assertIssue(
      validConfig({ goalCheckpoint: { [field]: value } }),
      'checkpoint_invalid',
      `/goalCheckpoint/${field}`,
    );
  }

  assert.deepEqual(inspectRouterConfig(validConfig({
    goalCheckpoint: {
      enabled: true,
      maxEntries: 1,
      maxResponseIdsPerTask: 1,
      maxResponseIndexes: 1,
      ttlMs: 1,
      sourceTokenBudget: 128,
      sourceWindowRatio: 1,
      maxOutputTokens: 256,
      requestMs: 1_000,
    },
  }), context).errors, []);

  assert.deepEqual(inspectRouterConfig(validConfig({
    goalCheckpoint: {
      enabled: null,
      maxEntries: '20000',
      maxResponseIdsPerTask: '2',
      maxResponseIndexes: null,
      ttlMs: null,
      sourceTokenBudget: null,
      sourceWindowRatio: null,
      maxOutputTokens: null,
      requestMs: null,
    },
  }), context).errors, []);
  assertIssue(
    validConfig({
      goalCheckpoint: {
        maxEntries: '20000',
        maxResponseIdsPerTask: '2',
        maxResponseIndexes: '19999',
      },
    }),
    'checkpoint_conflict',
    '/goalCheckpoint/maxResponseIndexes',
  );
});

test('modelCapabilities 按原顺序全量收集形状、范围与安全窗口错误', () => {
  assert.deepEqual(inspectRouterConfig(validConfig({ modelCapabilities: null }), context).errors, []);
  const result = inspectRouterConfig(validConfig({
    modelCapabilities: [
      null,
      { match: '' },
      { match: '^a$', contextWindow: null },
      { match: '^b$', maxOutputTokens: 1.5 },
      { match: '^c$', safetyRatio: 0 },
      { match: '^d$', protocolReserveTokens: -1 },
      { match: '^e$', imageTokens: true },
      {
        match: '^f$',
        contextWindow: 1_000,
        safetyRatio: 0.5,
        maxOutputTokens: 400,
        protocolReserveTokens: 100,
      },
    ],
  }), context);

  assert.deepEqual(
    result.errors.map(({ code, path: issuePath }) => [code, issuePath]),
    [
      ['model_capability_invalid', '/modelCapabilities/0'],
      ['model_capability_invalid', '/modelCapabilities/1/match'],
      ['model_capability_invalid', '/modelCapabilities/2/contextWindow'],
      ['model_capability_invalid', '/modelCapabilities/3/maxOutputTokens'],
      ['model_capability_invalid', '/modelCapabilities/4/safetyRatio'],
      ['model_capability_invalid', '/modelCapabilities/5/protocolReserveTokens'],
      ['model_capability_invalid', '/modelCapabilities/6/imageTokens'],
      ['model_capability_invalid', '/modelCapabilities/7/maxOutputTokens'],
    ],
  );
});

test('modelCapabilities 接受十进制数值字符串且 imageTokens 错误不抑制窗口冲突', () => {
  assert.deepEqual(inspectRouterConfig(validConfig({
    modelCapabilities: [{
      match: '^valid$',
      contextWindow: '1000',
      maxOutputTokens: '399',
      safetyRatio: '0.5',
      protocolReserveTokens: '100',
      imageTokens: '1',
    }],
  }), context).errors, []);

  const result = inspectRouterConfig(validConfig({
    modelCapabilities: [{
      match: '^conflict$',
      contextWindow: '1000',
      maxOutputTokens: '400',
      safetyRatio: '0.5',
      protocolReserveTokens: '100',
      imageTokens: '0x10',
    }],
  }), context);
  assert.deepEqual(
    result.errors.map(({ code, path: issuePath }) => [code, issuePath]),
    [
      ['model_capability_invalid', '/modelCapabilities/0/imageTokens'],
      ['model_capability_invalid', '/modelCapabilities/0/maxOutputTokens'],
    ],
  );
});

test('modelCapabilities 的 reserve/image null 兼容旧行为且其余预算 null 仍非法', () => {
  const compatibleNulls = inspectRouterConfig(validConfig({
    modelCapabilities: [{
      match: '^null-compatible$',
      contextWindow: 1_000,
      safetyRatio: 0.5,
      maxOutputTokens: 400,
      protocolReserveTokens: null,
      imageTokens: null,
    }],
  }), context);
  assert.deepEqual(compatibleNulls.errors, []);

  for (const protocolReserveTokens of [0, '0', null]) {
    assert.deepEqual(inspectRouterConfig(validConfig({
      modelCapabilities: [{
        match: '^zero-reserve$',
        contextWindow: 1_000,
        safetyRatio: 0.5,
        maxOutputTokens: 400,
        protocolReserveTokens,
        imageTokens: null,
      }],
    }), context).errors, []);
  }

  for (const imageTokens of [0, '0']) {
    assertIssue(
      validConfig({ modelCapabilities: [{ match: '^zero-image$', imageTokens }] }),
      'model_capability_invalid',
      '/modelCapabilities/0/imageTokens',
    );
  }

  for (const field of ['contextWindow', 'maxOutputTokens', 'safetyRatio']) {
    assertIssue(
      validConfig({ modelCapabilities: [{ match: '^null-invalid$', [field]: null }] }),
      'model_capability_invalid',
      `/modelCapabilities/0/${field}`,
    );
  }
});

test('modelContext disabled 时忽略业务值，启用时严格校验字段', () => {
  for (const modelContext of [
    undefined,
    null,
    { enabled: false, contextWindow: 0, slugs: 'bad' },
    {
      enabled: null,
      contextWindow: '1000',
      autoCompactTokenLimit: null,
      slugs: null,
    },
  ]) {
    assert.deepEqual(inspectRouterConfig(validConfig({ modelContext }), context).errors, []);
  }

  for (const [field, value] of [
    ['enabled', 1],
    ['contextWindow', null],
    ['contextWindow', 0],
    ['autoCompactTokenLimit', -1],
    ['slugs', ['ok', 1]],
  ]) {
    assertIssue(
      validConfig({ modelContext: { [field]: value } }),
      'model_context_invalid',
      `/modelContext/${field}`,
    );
  }

  assert.deepEqual(inspectRouterConfig(validConfig({
    modelContext: {
      enabled: true,
      contextWindow: 1,
      autoCompactTokenLimit: 0,
      slugs: [],
    },
  }), context).errors, []);
  assertIssue(
    validConfig({ modelContext: { contextWindow: '1000', autoCompactTokenLimit: '1001' } }),
    'model_context_invalid',
    '/modelContext/autoCompactTokenLimit',
  );
});

test('supportsResponses 缺失或 null 合法，显式 slugs 必须是字符串数组', () => {
  for (const supportsResponses of [
    undefined,
    null,
    {},
    { slugs: null },
    { slugs: [] },
    { slugs: ['a', ''] },
  ]) {
    assert.deepEqual(inspectRouterConfig(validConfig({ supportsResponses }), context).errors, []);
  }
  for (const supportsResponses of [[], '', { slugs: 'a' }, { slugs: [1] }]) {
    assertIssue(
      validConfig({ supportsResponses }),
      'model_capability_invalid',
      plainSupportsResponsesPath(supportsResponses),
    );
  }
});

function plainSupportsResponsesPath(value) {
  return Array.isArray(value) || typeof value !== 'object'
    ? '/supportsResponses'
    : '/supportsResponses/slugs';
}

test('oauth 校验官方请求会消费的已知字段并保留 viaProxy 的 null 继承语义', () => {
  for (const oauth of [undefined, {}, {
    client_id: 'client',
    refresh_skew_seconds: 0.5,
    refresh_timeout_ms: 1,
    viaProxy: null,
  }, { viaProxy: true }, {
    client_id: null,
    refresh_skew_seconds: null,
    refresh_timeout_ms: null,
    viaProxy: null,
  }, {
    refresh_skew_seconds: '30',
    refresh_timeout_ms: '30000',
  }]) {
    assert.deepEqual(inspectRouterConfig(validConfig({ oauth }), context).errors, []);
  }

  for (const [field, value] of [
    ['client_id', ''],
    ['refresh_skew_seconds', '0x10'],
    ['refresh_skew_seconds', 0],
    ['refresh_timeout_ms', Number.NaN],
    ['viaProxy', 0],
  ]) {
    assertIssue(
      validConfig({ oauth: { [field]: value } }),
      'oauth_invalid',
      `/oauth/${field}`,
    );
  }
});

test('paths 仅校验显式非 null auth/catalog 且错误文本不回显路径值', () => {
  for (const paths of [undefined, null, {}, { auth: null, catalog: undefined }, {
    auth: './auth.json',
    catalog: 'models.json',
  }]) {
    assert.deepEqual(inspectRouterConfig(validConfig({ paths }), context).errors, []);
  }

  const secret = 'secret-path-value';
  const result = inspectRouterConfig(validConfig({
    paths: { auth: '', catalog: `${secret}\r\nmodels.json` },
  }), context);
  assert.deepEqual(result.errors.map((issue) => issue.path), ['/paths/auth', '/paths/catalog']);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotMatch(formatConfigIssues(result.errors).join('\n'), new RegExp(secret));
});

test('visionRelay 仅在原始普通 target 显式 vision:false 时校验', () => {
  assert.deepEqual(inspectRouterConfig(validConfig({ visionRelay: false }), context).errors, []);
  const target = { ...validConfig().targets[0], vision: false };
  assertIssue(
    validConfig({ targets: [target], visionRelay: false }),
    'vision_relay_invalid',
    '/visionRelay',
  );
});

test('visionRelay 校验默认、字段边界、timeouts 与专用环境变量', () => {
  const target = { ...validConfig().targets[0], vision: false };
  for (const visionRelay of [undefined, null]) {
    const result = inspectRouterConfig(validConfig({ targets: [target], visionRelay }), {
      ...context,
      env: { ...context.env, aliyun_video_key: 'relay-secret' },
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.warnings.some(
      (issue) => issue.code === 'env_missing' && issue.path === '/visionRelay/envKey',
    ), false);
  }

  const cases = [
    ['host', 'bad\nhost'],
    ['host', null],
    ['prefix', 'v1'],
    ['prefix', null],
    ['model', ''],
    ['model', null],
    ['envKey', 'BAD KEY'],
    ['envKey', null],
    ['viaProxy', 'false'],
    ['concurrency', 0],
    ['concurrency', 9],
    ['maxImagesPerRequest', 0],
    ['cacheMaxEntries', 1.5],
    ['cacheMaxBytes', Number.NaN],
    ['maxTokens', '0x12c'],
    ['prompt', ''],
    ['timeouts', []],
    ['timeouts', { connectMs: 0 }],
  ];
  for (const [field, value] of cases) {
    assertIssue(
      validConfig({ targets: [target], visionRelay: { [field]: value } }),
      'vision_relay_invalid',
      field === 'timeouts' && value && !Array.isArray(value)
        ? '/visionRelay/timeouts/connectMs'
        : `/visionRelay/${field}`,
      { ...context, env: { ...context.env, aliyun_video_key: 'relay-secret' } },
    );
  }

  const missingEnv = inspectRouterConfig(validConfig({
    targets: [target],
    visionRelay: { envKey: 'RELAY_ONLY_KEY' },
  }), { ...context, env: context.env });
  assert.deepEqual(
    missingEnv.warnings.filter((issue) => issue.path === '/visionRelay/envKey'),
    [{
      severity: 'warning',
      code: 'env_missing',
      path: '/visionRelay/envKey',
      message: 'RELAY_ONLY_KEY',
    }],
  );

  const compatibleValues = inspectRouterConfig(validConfig({
    targets: [target],
    visionRelay: {
      viaProxy: null,
      concurrency: '3',
      maxImagesPerRequest: '8',
      cacheMaxEntries: '64',
      cacheMaxBytes: '1048576',
      maxTokens: '300',
      prompt: null,
      timeouts: { connectMs: '15000' },
    },
  }), { ...context, env: { ...context.env, aliyun_video_key: 'relay-secret' } });
  assert.deepEqual(compatibleValues.errors, []);

  const nullDefaults = inspectRouterConfig(validConfig({
    targets: [target],
    visionRelay: {
      viaProxy: null,
      concurrency: null,
      maxImagesPerRequest: null,
      cacheMaxEntries: null,
      cacheMaxBytes: null,
      maxTokens: null,
      prompt: null,
      timeouts: null,
    },
  }), { ...context, env: { ...context.env, aliyun_video_key: 'relay-secret' } });
  assert.deepEqual(nullDefaults.errors, []);
});

test('target 与 visionRelay 环境 Key 的 own 空值仍报告 env_missing', () => {
  const target = { ...validConfig().targets[0], vision: false };
  for (const value of ['', '   ', undefined, null, 42]) {
    const result = inspectRouterConfig(validConfig({
      targets: [target],
      visionRelay: { envKey: 'RELAY_KEY' },
    }), {
      ...context,
      env: {
        TEST_API_KEY: value,
        RELAY_KEY: value,
      },
    });
    assert.deepEqual(
      result.warnings
        .filter((issue) => issue.code === 'env_missing')
        .map(({ path: issuePath, message }) => [issuePath, message]),
      [
        ['/targets/0/envKey', 'TEST_API_KEY'],
        ['/visionRelay/envKey', 'RELAY_KEY'],
      ],
    );
  }
});

test('Task4 多个顶层错误按固定顺序一次聚合', () => {
  const target = { ...validConfig().targets[0], vision: false };
  const config = validConfig({
    port: 0,
    proxy: false,
    heartbeatMs: 0,
    targets: [target],
    timeouts: false,
    maxRequestBytes: 0,
    maxConcurrentRequests: 0,
    maxBufferedRequestBytes: 0,
    providerPool: null,
    responseHistory: null,
    goalCheckpoint: null,
    modelCapabilities: {},
    modelContext: [],
    supportsResponses: [],
    oauth: null,
    paths: [],
    visionRelay: false,
  });
  const expected = [
    ['port_invalid', '/port'],
    ['proxy_invalid', '/proxy'],
    ['heartbeat_invalid', '/heartbeatMs'],
    ['timeout_invalid', '/timeouts'],
    ['request_limit_invalid', '/maxRequestBytes'],
    ['request_limit_invalid', '/maxConcurrentRequests'],
    ['request_limit_invalid', '/maxBufferedRequestBytes'],
    ['provider_pool_invalid', '/providerPool'],
    ['response_history_invalid', '/responseHistory'],
    ['checkpoint_invalid', '/goalCheckpoint'],
    ['model_capability_invalid', '/modelCapabilities'],
    ['model_context_invalid', '/modelContext'],
    ['model_capability_invalid', '/supportsResponses'],
    ['oauth_invalid', '/oauth'],
    ['path_invalid', '/paths'],
    ['vision_relay_invalid', '/visionRelay'],
  ];
  const shape = () => inspectRouterConfig(config, context).errors
    .map(({ code, path: issuePath }) => [code, issuePath]);
  assert.deepEqual(shape(), expected);
  assert.deepEqual(shape(), expected);
});

test('Task4 新增错误仍让 prepareRouterConfig 整体抛出且不返回部分结果', () => {
  assert.throws(
    () => prepareRouterConfig(validConfig({ providerPool: null }), context),
    (error) => error instanceof RouterConfigError
      && error.issues.some((issue) => issue.code === 'provider_pool_invalid'),
  );
});

test('随仓 config.json 在显式模拟所需环境变量时可 prepare 出完整 runtime', () => {
  const config = JSON.parse(readFileSync(path.resolve('config.json'), 'utf8'));
  const configPath = path.resolve('config.json');
  const baseDir = path.dirname(configPath);
  const defaultCodexHome = path.join(baseDir, '.simulated-codex-home');
  const repositoryContext = {
    configPath,
    baseDir,
    defaultCodexHome,
    env: {
      DEEPSEEK_API_KEY: 'simulated-deepseek-key',
      aliyun_video_key: 'simulated-relay-key',
    },
  };
  assert.deepEqual(inspectRouterConfig(config, repositoryContext).errors, []);

  const prepared = prepareRouterConfig(config, repositoryContext);
  assert.equal(prepared.runtime.port, config.port);
  assert.equal(prepared.runtime.configPath, configPath);
  assert.equal(prepared.runtime.codexHome, defaultCodexHome);
  assert.equal(prepared.runtime.authPath, path.join(defaultCodexHome, 'auth.json'));
  assert.equal(prepared.runtime.catalogPath, path.join(defaultCodexHome, 'models.json'));
  assert.deepEqual(prepared.runtime.proxy, {
    host: config.proxy.host,
    port: config.proxy.port,
  });
  assert.deepEqual(prepared.runtime.timeouts, config.timeouts);
  assert.equal(prepared.runtime.heartbeatMs, config.heartbeatMs);
  assert.equal(prepared.runtime.maxRequestBytes, config.maxRequestBytes);
  assert.deepEqual(prepared.runtime.requestBudget, {
    maxActive: config.maxConcurrentRequests,
    maxBytes: config.maxBufferedRequestBytes,
  });
  assert.deepEqual(prepared.runtime.oauth, {
    clientId: config.oauth.client_id,
    refreshSkewSeconds: config.oauth.refresh_skew_seconds,
    refreshTimeoutMs: 30_000,
    viaProxy: null,
  });
  assert.deepEqual(prepared.runtime.visionRelay, config.visionRelay);
});

test('检查点持久化默认关闭，启用时解析相对路径并生成运行参数', () => {
  const disabled = prepareRouterConfig(validConfig(), context);
  assert.deepEqual(disabled.runtime.goalCheckpointPersistence, { enabled: false });

  const config = validConfig({
    goalCheckpoint: {
      enabled: true,
      persistence: {
        enabled: true,
        path: 'state/checkpoints.json',
        stateGeneration: 'generation-2',
        debounceMs: 250,
        maxBytes: 2_000_000,
        lockHeartbeatMs: 1_000,
        lockStaleMs: 5_000,
      },
    },
  });
  const prepared = prepareRouterConfig(config, context);
  assert.deepEqual(prepared.runtime.goalCheckpointPersistence, {
    enabled: true,
    path: path.join(BASE_DIR, 'state', 'checkpoints.json'),
    stateGeneration: 'generation-2',
    debounceMs: 250,
    maxBytes: 2_000_000,
    lockHeartbeatMs: 1_000,
    lockStaleMs: 5_000,
  });
  assert.ok(prepared.warnings.some((issue) => (
    issue.code === 'relative_path' && issue.path === '/goalCheckpoint/persistence/path'
  )));
});

test('检查点持久化启用时严格校验显式路径和锁定预算', () => {
  const config = validConfig({
    goalCheckpoint: {
      enabled: true,
      persistence: {
        enabled: true,
        path: '',
        debounceMs: 1,
        maxBytes: 0,
        lockHeartbeatMs: 50,
        lockStaleMs: 100,
      },
    },
  });
  const result = inspectRouterConfig(config, context);
  const paths = result.errors
    .filter((issue) => issue.code === 'checkpoint_invalid')
    .map((issue) => issue.path);
  assert.deepEqual(paths, [
    '/goalCheckpoint/persistence/path',
    '/goalCheckpoint/persistence/debounceMs',
    '/goalCheckpoint/persistence/maxBytes',
    '/goalCheckpoint/persistence/lockHeartbeatMs',
    '/goalCheckpoint/persistence/lockStaleMs',
  ]);
});
