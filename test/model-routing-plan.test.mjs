import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyModelRoutingOperations,
  escapeModelSlug,
  exposeModelRoutingState,
  inspectModelCatalog,
  inspectModelRoutingPlan,
  targetReference,
} from '../lib/model-routing-plan.mjs';

function model(slug, overrides = {}) {
  return {
    slug,
    display_name: slug.toUpperCase(),
    input_modalities: ['text'],
    ...overrides,
  };
}

function target(name, match, overrides = {}) {
  return {
    name,
    match,
    host: 'api.example.test',
    envKey: 'TEST_KEY',
    wireApi: 'chat',
    ...overrides,
  };
}

test('目录校验接受未知原字段并保持稳定空诊断', () => {
  const catalog = {
    customRoot: { keep: true },
    models: [model('model-a', {
      customModelField: { keep: true },
      priority: 10,
      context_window: 128_000,
      effective_context_window_percent: 95,
    })],
  };

  assert.deepEqual(inspectModelCatalog(catalog), { errors: [], warnings: [] });
});

test('官方模型目录的 null 数值字段视为未设置，不判定为非法', () => {
  // Codex 官方 models.json 对未启用的压缩阈值显式写 null；null = 无值，必须通过预检。
  const catalog = {
    models: [model('gpt-5.6-sol', {
      auto_compact_token_limit: null,
      context_window: 272_000,
      max_context_window: null,
      priority: null,
    })],
  };

  assert.deepEqual(inspectModelCatalog(catalog), { errors: [], warnings: [] });
});

test('目录校验按路径报告根、条目、字符串、重复 slug、模态和数值边界', () => {
  assert.deepEqual(inspectModelCatalog([]).errors.map((item) => item.code), [
    'catalog_root_invalid',
  ]);

  const long = 'x'.repeat(257);
  const result = inspectModelCatalog({
    models: [
      null,
      model('same'),
      model('same', { display_name: 'bad\nname' }),
      model('bad\u0000slug', { display_name: 'safe-name' }),
      model(long, { display_name: 'safe-name' }),
      model('bad-modalities', { input_modalities: ['image', 'audio'] }),
      model('no-text', { input_modalities: ['image'] }),
      model('bad-number', {
        priority: 1.5,
        context_window: Infinity,
        max_context_window: 0,
        effective_context_window_percent: 101,
        auto_compact_token_limit: -1,
        truncation_policy: { mode: 'tokens', limit: 0 },
      }),
    ],
  });

  assert.deepEqual(result.errors.map((item) => [item.code, item.path]), [
    ['catalog_model_invalid', '/models/0'],
    ['catalog_slug_duplicate', '/models/2/slug'],
    ['catalog_display_name_invalid', '/models/2/display_name'],
    ['catalog_slug_invalid', '/models/3/slug'],
    ['catalog_slug_invalid', '/models/4/slug'],
    ['catalog_modalities_invalid', '/models/5/input_modalities'],
    ['catalog_modalities_invalid', '/models/6/input_modalities'],
    ['catalog_number_invalid', '/models/7/priority'],
    ['catalog_number_invalid', '/models/7/context_window'],
    ['catalog_number_invalid', '/models/7/max_context_window'],
    ['catalog_number_invalid', '/models/7/effective_context_window_percent'],
    ['catalog_number_invalid', '/models/7/auto_compact_token_limit'],
    ['catalog_number_invalid', '/models/7/truncation_policy/limit'],
  ]);
});

test('目录校验拒绝缺失 models、非数组 models 和非空字符串边界', () => {
  for (const catalog of [{}, { models: {} }]) {
    assert.equal(inspectModelCatalog(catalog).errors[0].code, 'catalog_models_invalid');
  }
  const result = inspectModelCatalog({ models: [{ slug: '', display_name: ' ' }] });
  assert.deepEqual(result.errors.map((item) => item.path), [
    '/models/0/slug',
    '/models/0/display_name',
  ]);
});

test('模型 slug 转义生成只命中自身的完整正则', () => {
  const slug = 'qwen3.8-max+(cn)[1]';
  const escaped = escapeModelSlug(slug);
  const regex = new RegExp(`^${escaped}$`);

  assert.equal(regex.test(slug), true);
  assert.equal(regex.test('qwen3x8-max+(cn)[1]'), false);
  assert.equal(regex.test(`${slug}-other`), false);
  assert.throws(() => escapeModelSlug(''), /slug/);
});

test('targetRef 绑定 revision、数组位置和目标身份且不泄漏身份正文', () => {
  const source = target('private-provider', '^model-a$', {
    headers: { authorization: 'Bearer secret-value' },
  });
  const first = targetReference('revision-a', 0, source);

  assert.match(first, /^target:[a-f0-9]{64}$/);
  assert.equal(first.includes('private-provider'), false);
  assert.equal(first.includes('secret-value'), false);
  assert.equal(targetReference('revision-a', 0, structuredClone(source)), first);
  assert.notEqual(targetReference('revision-b', 0, source), first);
  assert.notEqual(targetReference('revision-a', 1, source), first);
  assert.notEqual(targetReference('revision-a', 0, { ...source, host: 'other.example' }), first);
});

test('暴露状态使用安全目标白名单、布尔 envSet 并生成多目标宽正则绑定', () => {
  const config = {
    modelContext: { slugs: ['model-a'] },
    supportsResponses: { slugs: ['model-b'] },
    targets: [
      target('wide', '^model-', {
        headers: { authorization: 'Bearer hidden' },
        auth: { token: 'hidden-auth' },
      }),
      target('exact', '^model-a$', { envKey: 'MISSING_KEY', viaProxy: true }),
    ],
  };
  const state = exposeModelRoutingState(
    { models: [model('model-a'), model('model-b')] },
    config,
    'revision-a',
    { TEST_KEY: 'runtime-secret' },
  );

  assert.deepEqual(state.models.map((item) => item.slug), ['model-a', 'model-b']);
  assert.deepEqual(state.bindings.map((item) => [item.slug, item.targetRefs.length]), [
    ['model-a', 2],
    ['model-b', 1],
  ]);
  assert.equal(state.targets[0].envSet, true);
  assert.equal(state.targets[1].envSet, false);
  assert.equal(typeof state.targets[0].envSet, 'boolean');
  const serialized = JSON.stringify(state.targets);
  assert.doesNotMatch(serialized, /hidden|runtime-secret|headers|"auth"/);
  assert.deepEqual(state.references.modelContext, ['model-a']);
  assert.deepEqual(state.references.supportsResponses, ['model-b']);
});

test('暴露状态过滤模型与目标中的嵌套敏感键并省略非法管理字段形状', () => {
  const circularEnvKey = { apiKey: 'target-env-api-key' };
  circularEnvKey.self = circularEnvKey;
  const catalog = {
    models: [model('model-a', {
      auto_compact_token_limit: 120_000,
      truncation_policy: {
        mode: 'tokens',
        limit: 1_000,
        secret: 'catalog-truncation-secret',
      },
      supported_reasoning_levels: [{
        effort: 'high',
        description: 'safe-description',
        token: 'catalog-level-token',
      }],
      credentials: {
        authorization: 'Bearer catalog-private-authorization',
        cookie: 'catalog-private-cookie',
      },
      safeExtension: {
        nested: ['first', {
          enabled: true,
          accessToken: 'catalog-access-token',
        }],
        value: 'safe-business-value',
        tokenizer: 'safe-tokenizer-name',
        tokenCount: 42,
        max_output_tokens: 8_192,
        privateKey: 'catalog-private-key',
        clientToken: 'catalog-client-token',
        sessionToken: 'catalog-session-token',
        apiToken: 'catalog-api-token',
        oauthToken: 'catalog-oauth-token',
        refresh_token: 'catalog-refresh-token',
        client_secret: 'catalog-client-secret',
        password_hash: 'catalog-password-hash',
        credentialValue: 'catalog-credential-value',
        oauth: { refresh: 'catalog-oauth-refresh-leak' },
        api: { key: 'catalog-api-key-leak' },
        auth: { key: 'catalog-auth-key-leak' },
        headers: { authorization: 'catalog-header-authorization-leak' },
        cookies: { session: 'catalog-cookie-session-leak' },
        secrets: { key: 'catalog-secrets-key-leak' },
        nestedContainers: {
          oauth: { api: { refresh: 'catalog-layered-oauth-refresh-leak' } },
        },
        safeNestedApi: { api: { format: 'responses', value: 'safe-api-value' } },
        safeContainerValues: {
          oauth: { mode: 'pkce', value: 'safe-oauth-value' },
          api: { format: 'responses', value: 'safe-api-value' },
          auth: { mode: 'none', value: 'safe-auth-value' },
          credentials: { value: 'safe-credential-description' },
        },
      },
    })],
  };
  const config = {
    targets: [
      target('safe-name', '^model-a$', {
        viaProxy: true,
        envKey: circularEnvKey,
        port: 'stored-port-secret',
        maxResponseBytes: 'stored-max-response-secret',
        forwardHeaders: [
          'x-trace-id',
          { token: 'target-forward-token' },
        ],
        headers: { authorization: 'Bearer target-header-authorization' },
      }),
      target('null-numbers', '^model-b$', { port: null, maxResponseBytes: null }),
      target('finite-numbers', '^model-c$', { port: 443, maxResponseBytes: 4_096 }),
    ],
  };

  const state = exposeModelRoutingState(catalog, config, 'revision-safe-view', {});
  const exposedTarget = state.targets[0];
  const exposedModel = state.models[0];
  const serialized = JSON.stringify(state);

  assert.equal(exposedTarget.name, 'safe-name');
  assert.equal(exposedTarget.match, '^model-a$');
  assert.equal(exposedTarget.viaProxy, true);
  assert.equal(exposedTarget.envSet, false);
  assert.equal(Object.hasOwn(exposedTarget, 'envKey'), false);
  assert.equal(Object.hasOwn(exposedTarget, 'port'), false);
  assert.equal(Object.hasOwn(exposedTarget, 'maxResponseBytes'), false);
  assert.equal(Object.hasOwn(exposedTarget, 'forwardHeaders'), false);
  assert.equal(Object.hasOwn(exposedTarget, 'headers'), false);
  assert.equal(Object.hasOwn(state.targets[1], 'port'), false);
  assert.equal(Object.hasOwn(state.targets[1], 'maxResponseBytes'), false);
  assert.equal(state.targets[2].port, 443);
  assert.equal(state.targets[2].maxResponseBytes, 4_096);
  assert.equal(Object.hasOwn(exposedModel, 'credentials'), false);
  assert.deepEqual(exposedModel.safeExtension, {
    nested: ['first', { enabled: true }],
    value: 'safe-business-value',
    tokenizer: 'safe-tokenizer-name',
    tokenCount: 42,
    max_output_tokens: 8_192,
    safeNestedApi: {},
    nestedContainers: {},
    safeContainerValues: {},
  });
  assert.equal(exposedModel.auto_compact_token_limit, 120_000);
  assert.deepEqual(exposedModel.truncation_policy, { mode: 'tokens', limit: 1_000 });
  assert.deepEqual(exposedModel.supported_reasoning_levels, [{
    effort: 'high',
    description: 'safe-description',
  }]);
  assert.doesNotMatch(
    serialized,
    /catalog-truncation-secret|catalog-level-token|catalog-private|catalog-access|catalog-refresh|catalog-client-token|catalog-session-token|catalog-api-token|catalog-oauth-token|catalog-oauth-refresh-leak|catalog-api-key-leak|catalog-auth-key-leak|catalog-header-authorization-leak|catalog-cookie-session-leak|catalog-secrets-key-leak|catalog-layered-oauth-refresh-leak|catalog-client-secret|catalog-password|catalog-credential-value|target-env|stored-port|stored-max-response|target-forward|target-header/,
  );
  assert.doesNotMatch(serialized, /"(?:headers|authorization|apiKey|token|secret|cookie|privateKey)"\s*:/i);
});

test('精确敏感容器对 primitive、数组、对象及规范化名称一律 fail closed', () => {
  const cases = [
    ['oauth', 'OAUTH-STRING-LEAK'],
    ['auth', 42],
    ['credentials', ['CREDENTIALS-ARRAY-LEAK', 7]],
    ['headers', [['HEADERS-NESTED-ARRAY-LEAK']]],
    ['cookies', 'COOKIES-STRING-LEAK'],
    ['secrets', 73],
    ['api', ['API-ARRAY-LEAK']],
    ['oAu-Th', [['OAUTH-VARIANT-NESTED-LEAK']]],
    ['cre_den-tials', 'CREDENTIALS-VARIANT-LEAK'],
    ['oauth', { mode: 'pkce', value: 'OAUTH-OBJECT-LEAK' }],
    ['api', { format: 'responses', value: 'API-OBJECT-LEAK' }],
    ['auth', { value: 'AUTH-OBJECT-LEAK' }],
    ['credentials', { value: 'CREDENTIALS-OBJECT-LEAK' }],
  ];
  const safeMetadata = {
    apiFormat: 'responses',
    authType: 'header',
    tokenizer: 'safe-tokenizer',
    tokenCount: 12,
    max_output_tokens: 1_024,
    value: 'safe-value',
    format: 'safe-format',
    mode: 'safe-mode',
    unknown: { value: 'safe-unknown-value' },
  };

  for (const [field, value] of cases) {
    const state = exposeModelRoutingState(
      { models: [model('model-a', { metadata: { ...safeMetadata, [field]: value } })] },
      { targets: [target('target-a', '^model-a$')] },
      'revision-a',
    );
    assert.equal(Object.hasOwn(state.models[0].metadata, field), false, field);
    assert.deepEqual(state.models[0].metadata, safeMetadata);

    assert.throws(
      () => applyModelRoutingOperations({
        catalog: { models: [model('model-a')] },
        config: { targets: [target('target-a', '^model-a$')] },
        configRevision: 'revision-a',
        operations: [{
          kind: 'model.update',
          slug: 'model-a',
          patch: {
            experimental_supported_tools: [{ metadata: { ...safeMetadata, [field]: value } }],
          },
        }],
      }),
      (error) => error?.code === 'operation_sensitive_field',
      field,
    );
  }
});

test('Key 家族敏感字段按规范化精确名称过滤且不误伤普通单词', () => {
  const sentinel = 'SENTINEL-KEY-FAMILY';
  const sensitiveNames = [
    'key', 'Key', 'keyId', 'key_id', 'key-id', 'key.value',
    'access_key', 'auth-key', 'api-key', 'private-key', 'client-key', 'session-key',
    'publicKey', 'public_key', 'master_key', 'provider-key', 'displayKey', 'signing_key',
    'encryption-key', 'consumerKey', 'publishable_key', 'sshKey',
    'api', 'oauth', 'auth', 'credentials', 'headers', 'cookies', 'secrets', 'bearer',
  ];
  const safeNames = [
    'auto_compact_token_limit', 'keyboard', 'monkey', 'keynote', 'tokenizer',
  ];
  const metadata = Object.fromEntries([
    ...sensitiveNames.map((name) => [name, sentinel]),
    ...safeNames.map((name) => [name, `safe-${name}`]),
  ]);
  const exposed = exposeModelRoutingState(
    { models: [model('model-a', { metadata })] },
    { targets: [target('model-a', '^model-a$')] },
    'revision-key-family',
    { TEST_KEY: 'runtime-secret' },
  );

  assert.doesNotMatch(JSON.stringify(exposed), /SENTINEL-KEY-FAMILY/);
  assert.deepEqual(exposed.models[0].metadata, Object.fromEntries(
    safeNames.map((name) => [name, `safe-${name}`]),
  ));

  const source = baseState();
  for (const name of sensitiveNames) {
    const operation = {
      kind: 'model.update',
      slug: 'model-a',
      patch: { experimental_supported_tools: [{ metadata: { [name]: sentinel } }] },
    };
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations: [operation] }),
      (error) => error?.code === 'operation_sensitive_field'
        && !String(error.message).includes(sentinel),
    );
    const inspected = inspectModelRoutingPlan({ ...source, operations: [operation] });
    assert.equal(inspected.errors.some((issue) => issue.code === 'operation_sensitive_field'), true);
    assert.doesNotMatch(JSON.stringify(inspected), /SENTINEL-KEY-FAMILY/);
  }
});

test('路径作用域认证字段从模型全树过滤并仅允许合法 target 直接字段', () => {
  const sentinel = 'SENTINEL-PATH-SCOPED-PLAN';
  const sensitiveNames = [
    'envKey', 'ENV_KEY', 'env-key', 'eNv.Key',
    'authHeader', 'AUTH_HEADER', 'auth-header', 'aUtH.Header',
    'forwardHeaders', 'FORWARD_HEADERS', 'forward-headers', 'fOrWaRd.Headers',
  ];
  const placements = (field) => [
    { [field]: sentinel },
    { extension: { [field]: sentinel } },
    { experimental_supported_tools: [{ metadata: { [field]: sentinel } }] },
  ];
  const source = baseState();

  for (const name of sensitiveNames) {
    for (const placement of placements(name)) {
      const exposed = exposeModelRoutingState(
        { models: [model('model-a', placement)] },
        { targets: [target('model-a', '^model-a$')] },
        'revision-path-scoped',
      );
      assert.doesNotMatch(JSON.stringify(exposed), /SENTINEL-PATH-SCOPED-PLAN/);

      for (const operation of [
        { kind: 'model.create', model: model(`new-${name.length}`, placement) },
        { kind: 'model.update', slug: 'model-a', patch: placement },
      ]) {
        assert.throws(
          () => applyModelRoutingOperations({ ...source, operations: [operation] }),
          (error) => error?.code === 'operation_sensitive_field',
          name,
        );
        const inspected = inspectModelRoutingPlan({ ...source, operations: [operation] });
        assert.equal(
          inspected.errors.some((issue) => issue.code === 'operation_sensitive_field'),
          true,
          name,
        );
        assert.doesNotMatch(JSON.stringify(inspected), /SENTINEL-PATH-SCOPED-PLAN/);
      }
    }
  }

  const ref = targetReference(source.configRevision, 0, source.config.targets[0]);
  const direct = applyModelRoutingOperations({
    ...source,
    operations: [{
      kind: 'target.update',
      targetRef: ref,
      patch: {
        envKey: 'UPDATED_KEY',
        authHeader: 'x-api-key',
        forwardHeaders: ['x-request-id'],
      },
    }],
  });
  assert.deepEqual(
    {
      envKey: direct.config.targets[0].envKey,
      authHeader: direct.config.targets[0].authHeader,
      forwardHeaders: direct.config.targets[0].forwardHeaders,
    },
    {
      envKey: 'UPDATED_KEY',
      authHeader: 'x-api-key',
      forwardHeaders: ['x-request-id'],
    },
  );

  const invalidDirectExposure = exposeModelRoutingState(
    { models: [model('model-a')] },
    {
      targets: [target('model-a', '^model-a$', {
        envKey: 'BAD-KEY',
        authHeader: 'bad header',
        forwardHeaders: null,
      })],
    },
    'revision-invalid-direct-target',
  );
  assert.equal(Object.hasOwn(invalidDirectExposure.targets[0], 'envKey'), false);
  assert.equal(Object.hasOwn(invalidDirectExposure.targets[0], 'authHeader'), false);
  assert.equal(Object.hasOwn(invalidDirectExposure.targets[0], 'forwardHeaders'), false);

  for (const patch of [
    { envKey: { envKey: sentinel } },
    { authHeader: { authHeader: sentinel } },
    { forwardHeaders: [{ forwardHeaders: sentinel }] },
  ]) {
    assert.throws(
      () => applyModelRoutingOperations({
        ...source,
        operations: [{ kind: 'target.update', targetRef: ref, patch }],
      }),
      (error) => error?.code === 'operation_sensitive_field',
    );
  }
  for (const patch of [
    { envKey: 'BAD-KEY' },
    { authHeader: 'bad header' },
    { forwardHeaders: ['bad header'] },
  ]) {
    assert.throws(
      () => applyModelRoutingOperations({
        ...source,
        operations: [{ kind: 'target.update', targetRef: ref, patch }],
      }),
      (error) => error?.code === 'operation_invalid',
    );
  }
});

function baseState() {
  return {
    catalog: {
      rootExtension: { keep: true },
      models: [
        model('model-a', { description: 'old', customModelField: { keep: true } }),
        model('model-b'),
      ],
    },
    config: {
      port: 15730,
      modelContext: { slugs: ['model-a', 'model-b'], extension: 'keep' },
      supportsResponses: { slugs: ['model-a', 'model-b'] },
      modelCapabilities: [{ match: '^model-', contextWindow: 128_000 }],
      targets: [
        target('wide', '^model-'),
        target('exact', '^model-a$', { envKey: 'OTHER_KEY' }),
      ],
      customConfigField: { keep: true },
    },
    configRevision: 'revision-a',
  };
}

test('模型 create/update/delete 三类操作保持输入及未知原字段不变', () => {
  const source = baseState();
  const original = structuredClone(source);
  const result = applyModelRoutingOperations({
    ...source,
    operations: [
      { kind: 'model.create', model: model('model-c', { description: 'new' }) },
      { kind: 'model.update', slug: 'model-a', patch: { slug: 'model-renamed', description: 'changed' } },
      { kind: 'model.delete', slug: 'model-b' },
    ],
  });

  assert.deepEqual(source, original);
  assert.deepEqual(result.catalog.rootExtension, { keep: true });
  assert.deepEqual(result.catalog.models.map((item) => item.slug), ['model-renamed', 'model-c']);
  assert.deepEqual(result.catalog.models[0].customModelField, { keep: true });
  assert.equal(result.catalog.models[0].description, 'changed');
  assert.deepEqual(result.impact.models, {
    created: ['model-c'],
    updated: [{ from: 'model-a', to: 'model-renamed' }],
    deleted: ['model-b'],
  });
});

test('目标 create/update/delete 使用稳定 targetRef 且保留配置未知字段', () => {
  const source = baseState();
  const firstRef = targetReference(
    source.configRevision,
    0,
    source.config.targets[0],
  );
  const secondRef = targetReference(
    source.configRevision,
    1,
    source.config.targets[1],
  );
  const result = applyModelRoutingOperations({
    ...source,
    operations: [
      { kind: 'target.update', targetRef: firstRef, patch: { host: 'new.example.test', viaProxy: true } },
      { kind: 'target.delete', targetRef: secondRef },
      { kind: 'model.create', model: model('model-c') },
      { kind: 'target.create', target: target('created', '^model-c$', { protocol: 'https' }) },
    ],
  });

  assert.deepEqual(result.config.customConfigField, { keep: true });
  assert.deepEqual(result.config.targets.map((item) => item.name), ['wide', 'created']);
  assert.equal(result.config.targets[0].host, 'new.example.test');
  assert.equal(result.config.targets[0].viaProxy, true);
  assert.deepEqual(result.impact.targets, {
    created: ['created'],
    updated: [firstRef],
    deleted: [secondRef],
  });
});

test('target.create 只接受绑定当前目录唯一模型的规范精确 match', () => {
  const source = baseState();
  const invalidTargets = [
    { name: 'missing-match', host: 'api.example.test', envKey: 'TEST_KEY', wireApi: 'chat' },
    target('wide', '^model-'),
    target('mismatch', '^missing-model$'),
    target('non-canonical-exact', '^(?:model-a)$'),
  ];
  for (const invalidTarget of invalidTargets) {
    const operation = { kind: 'target.create', target: invalidTarget };
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations: [operation] }),
      (error) => error?.code === 'target_create_not_dedicated',
    );
    const inspected = inspectModelRoutingPlan({ ...source, operations: [operation] });
    assert.equal(
      inspected.errors.some((issue) => issue.code === 'target_create_not_dedicated'),
      true,
    );
  }

  const duplicateCatalog = {
    ...source,
    catalog: { models: [model('model-a'), model('model-a')] },
  };
  assert.throws(
    () => applyModelRoutingOperations({
      ...duplicateCatalog,
      operations: [{ kind: 'target.create', target: target('ambiguous', '^model-a$') }],
    }),
    (error) => error?.code === 'target_create_not_dedicated',
  );

  const special = 'new.model+(cn)';
  const legal = applyModelRoutingOperations({
    ...source,
    operations: [
      { kind: 'model.create', model: model(special) },
      {
        kind: 'target.create',
        target: target('new-special', `^${escapeModelSlug(special)}$`),
      },
    ],
  });
  assert.equal(legal.config.targets.at(-1).match, '^new\\.model\\+\\(cn\\)$');
});

test('target.delete 只允许执行时仍由唯一当前模型拥有的规范精确 target', () => {
  const invalidCases = [
    {
      name: 'single-owner-wide-with-backup',
      models: [model('model-a'), model('other')],
      targets: [target('wide', '^model-a'), target('backup', '^model-a$')],
    },
    {
      name: 'non-canonical-exact',
      models: [model('model-a')],
      targets: [target('non-canonical', '^(?:model-a)$')],
    },
    {
      name: 'array-match',
      models: [model('model-a')],
      targets: [target('array', ['^model-a$'])],
    },
    {
      name: 'missing-match',
      models: [model('model-a')],
      targets: [{ name: 'missing', host: 'api.example.test', envKey: 'TEST_KEY', wireApi: 'chat' }],
    },
    {
      name: 'no-owner',
      models: [model('model-a')],
      targets: [target('orphan', '^missing$')],
    },
    {
      name: 'duplicate-owner',
      models: [model('model-a'), model('model-a')],
      targets: [target('ambiguous', '^model-a$')],
    },
  ];

  for (const { name, models, targets } of invalidCases) {
    const source = baseState();
    source.catalog.models = models;
    source.config.targets = targets;
    const targetRef = targetReference(source.configRevision, 0, targets[0]);
    const operation = { kind: 'target.delete', targetRef };
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations: [operation] }),
      (error) => error?.code === 'target_not_dedicated',
      name,
    );
    assert.equal(
      inspectModelRoutingPlan({ ...source, operations: [operation] }).errors
        .some((issue) => issue.code === 'target_not_dedicated'),
      true,
      name,
    );
  }

  const deletedFirst = baseState();
  deletedFirst.catalog.models = [model('model-a')];
  deletedFirst.config.targets = [target('exact', '^model-a$')];
  const targetRef = targetReference(
    deletedFirst.configRevision,
    0,
    deletedFirst.config.targets[0],
  );
  assert.throws(
    () => applyModelRoutingOperations({
      ...deletedFirst,
      operations: [
        { kind: 'model.delete', slug: 'model-a' },
        { kind: 'target.delete', targetRef },
      ],
    }),
    (error) => error?.code === 'target_not_dedicated',
  );

  const uiOrder = applyModelRoutingOperations({
    ...deletedFirst,
    operations: [
      { kind: 'reference.removeSlug', slug: 'model-a' },
      { kind: 'target.delete', targetRef },
      { kind: 'model.delete', slug: 'model-a' },
    ],
  });
  assert.deepEqual(uiOrder.catalog.models, []);
  assert.deepEqual(uiOrder.config.targets, []);
});

test('reference replace/remove 只更新两个精确引用数组且不改能力正则', () => {
  const source = baseState();
  const result = applyModelRoutingOperations({
    ...source,
    operations: [
      { kind: 'reference.replaceSlug', from: 'model-a', to: 'model-renamed' },
      { kind: 'reference.removeSlug', slug: 'model-b' },
    ],
  });

  assert.deepEqual(result.config.modelContext, {
    slugs: ['model-renamed'],
    extension: 'keep',
  });
  assert.deepEqual(result.config.supportsResponses.slugs, ['model-renamed']);
  assert.deepEqual(result.config.modelCapabilities, source.config.modelCapabilities);
  assert.deepEqual(result.impact.references, {
    replaced: [{ from: 'model-a', to: 'model-renamed' }],
    removed: ['model-b'],
  });
});

test('新草稿最终 create 操作不替换既有孤立引用或产生引用影响', () => {
  const source = baseState();
  source.config.modelContext.slugs.push('new.model');
  const result = inspectModelRoutingPlan({
    ...source,
    operations: [
      {
        kind: 'model.create',
        model: model('new-model-v3'),
      },
      {
        kind: 'target.create',
        target: target('new-model', '^new-model-v3$'),
      },
    ],
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.impact.references.replaced, []);
  assert.deepEqual(result.config.modelContext.slugs, ['model-a', 'model-b', 'new.model']);
});

test('操作严格拒绝未知 kind、未知外层字段和模型新增未知字段', () => {
  const source = baseState();
  for (const operation of [
    { kind: 'unknown.operation' },
    { kind: 'model.delete', slug: 'model-a', extra: true },
    { kind: 'model.create', model: { ...model('new'), newUnknownField: true } },
    { kind: 'model.update', slug: 'model-a', patch: { newUnknownField: true } },
  ]) {
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations: [operation] }),
      /未知|不允许/,
    );
  }
});

test('目标写操作拒绝敏感字段和所有非白名单字段', () => {
  const source = baseState();
  const ref = targetReference(source.configRevision, 0, source.config.targets[0]);
  for (const operation of [
    { kind: 'target.create', target: { ...target('secret', '^secret$'), headers: { authorization: 'secret' } } },
    { kind: 'target.create', target: { ...target('secret', '^secret$'), token: 'secret' } },
    { kind: 'target.update', targetRef: ref, patch: { auth: { apiKey: 'secret' } } },
    { kind: 'target.update', targetRef: ref, patch: { arbitrary: true } },
  ]) {
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations: [operation] }),
      /敏感|不允许/,
    );
  }
});

test('写操作在普通类型预检前拒绝允许字段中的嵌套敏感键并安全处理循环', () => {
  const source = baseState();
  const ref = targetReference(source.configRevision, 0, source.config.targets[0]);
  const cyclic = {};
  cyclic.self = cyclic;
  cyclic.token = 'cyclic-token-secret';
  const cases = [
    {
      kind: 'target.create',
      target: target('nested-forward', '^nested$', {
        forwardHeaders: [{ token: 'forward-token-secret' }],
      }),
    },
    {
      kind: 'target.update',
      targetRef: ref,
      patch: { envKey: { accessToken: 'nested-access-token-secret' } },
    },
    {
      kind: 'model.create',
      model: model('nested-model', {
        truncation_policy: { mode: 'tokens', client_secret: 'model-client-secret' },
      }),
    },
    {
      kind: 'model.update',
      slug: 'model-a',
      patch: {
        experimental_supported_tools: [{ password_hash: 'model-password-hash' }],
      },
    },
    {
      kind: 'model.update',
      slug: 'model-a',
      patch: {
        experimental_supported_tools: [{ privateKey: 'model-private-key' }],
      },
    },
    ...['clientToken', 'sessionToken', 'apiToken', 'oauthToken'].map((field) => ({
      kind: 'model.update',
      slug: 'model-a',
      patch: {
        experimental_supported_tools: [{ [field]: `${field}-secret` }],
      },
    })),
    {
      kind: 'model.update',
      slug: 'model-a',
      patch: {
        experimental_supported_tools: [{ metadata: { oauth: { refresh: 'oauth-refresh-leak' } } }],
      },
    },
    {
      kind: 'model.update',
      slug: 'model-a',
      patch: {
        experimental_supported_tools: [{ metadata: { api: { key: 'api-key-leak' } } }],
      },
    },
    ...[
      ['auth', { key: 'auth-key-leak' }],
      ['headers', { authorization: 'header-authorization-leak' }],
      ['cookies', { session: 'cookie-session-leak' }],
      ['secrets', { key: 'secrets-key-leak' }],
      ['credentials', { key: 'credentials-key-leak' }],
    ].map(([field, value]) => ({
      kind: 'model.update',
      slug: 'model-a',
      patch: { experimental_supported_tools: [{ metadata: { [field]: value } }] },
    })),
    {
      kind: 'model.update',
      slug: 'model-a',
      patch: {
        experimental_supported_tools: [{
          metadata: { oauth: { api: { refresh: 'layered-oauth-refresh-leak' } } },
        }],
      },
    },
    {
      kind: 'target.update',
      targetRef: ref,
      patch: { forwardHeaders: [{ credentialValue: 'credential-value-secret' }] },
    },
  ];

  for (const operation of cases) {
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations: [operation] }),
      (error) => error?.code === 'operation_sensitive_field',
    );
  }
  assert.throws(
    () => applyModelRoutingOperations({
      ...source,
      operations: [{
        kind: 'target.update',
        targetRef: ref,
        patch: { forwardHeaders: [cyclic] },
      }],
    }),
    (error) => error?.code === 'operation_invalid' && /循环/.test(error.message),
  );

  const legal = applyModelRoutingOperations({
    ...source,
    operations: [
      {
        kind: 'model.update',
        slug: 'model-a',
        patch: {
          auto_compact_token_limit: 100_000,
          experimental_supported_tools: [{
            value: 'safe-business-value',
            format: 'safe-format',
            mode: 'safe-mode',
            tokenizer: 'safe-tokenizer-name',
            tokenCount: 42,
            max_output_tokens: 8_192,
            apiFormat: 'responses',
            authType: 'header',
            metadata: {
              value: 'safe-metadata-value',
              format: 'safe-metadata-format',
              mode: 'safe-metadata-mode',
              unknown: { value: 'safe-unknown-value' },
            },
          }],
        },
      },
      {
        kind: 'target.update',
        targetRef: ref,
        patch: { forwardHeaders: ['x-trace-id', 'x-request-id'] },
      },
    ],
  });
  assert.equal(legal.catalog.models[0].auto_compact_token_limit, 100_000);
  assert.deepEqual(legal.catalog.models[0].experimental_supported_tools, [{
    value: 'safe-business-value',
    format: 'safe-format',
    mode: 'safe-mode',
    tokenizer: 'safe-tokenizer-name',
    tokenCount: 42,
    max_output_tokens: 8_192,
    apiFormat: 'responses',
    authType: 'header',
    metadata: {
      value: 'safe-metadata-value',
      format: 'safe-metadata-format',
      mode: 'safe-metadata-mode',
      unknown: { value: 'safe-unknown-value' },
    },
  }]);
  assert.deepEqual(legal.config.targets[0].forwardHeaders, ['x-trace-id', 'x-request-id']);
});

test('写操作对超深和超量嵌套结构有限失败而不会无限递归', () => {
  const source = baseState();
  const ref = targetReference(source.configRevision, 0, source.config.targets[0]);
  const deep = {};
  let cursor = deep;
  for (let index = 0; index < 200; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  const many = Array.from({ length: 5_000 }, (_, index) => ({ index }));
  const manyStrings = Array.from({ length: 10_000 }, (_, index) => `x-header-${index}`);

  for (const patch of [
    { envKey: deep },
    { envKey: many },
    { forwardHeaders: manyStrings },
  ]) {
    assert.throws(
      () => applyModelRoutingOperations({
        ...source,
        operations: [{ kind: 'target.update', targetRef: ref, patch }],
      }),
      (error) => error?.code === 'operation_invalid' && /复杂度|嵌套/.test(error.message),
    );
  }
});

test('安全投影与稳定摘要不会遍历超出预算的 primitive 数组尾部', () => {
  const catalogValues = Array.from({ length: 10_000 }, (_, index) => `catalog-${index}`);
  Object.defineProperty(catalogValues, 9_999, {
    enumerable: true,
    get() { throw new Error('不应读取目录数组预算外尾部'); },
  });
  const state = exposeModelRoutingState(
    { models: [model('model-a', { safeExtension: catalogValues })] },
    { targets: [target('model-a', '^model-a$')] },
    'revision-primitive-budget',
    {},
  );
  assert.ok(state.models[0].safeExtension.length < 10_000);

  const targetValues = Array.from({ length: 10_000 }, (_, index) => `header-${index}`);
  Object.defineProperty(targetValues, 9_999, {
    enumerable: true,
    get() { throw new Error('不应读取摘要数组预算外尾部'); },
  });
  const targetState = exposeModelRoutingState(
    { models: [] },
    {
      targets: [{
        ...target('bounded-target', '^model-a$'),
        forwardHeaders: targetValues,
      }],
    },
    'revision-target-view-budget',
    {},
  );
  assert.equal(Object.hasOwn(targetState.targets[0], 'forwardHeaders'), false);
  assert.throws(
    () => targetReference('revision-primitive-budget', 0, {
      ...target('bounded-target', '^model-a$'),
      forwardHeaders: targetValues,
    }),
    /复杂度/,
  );
});

test('目标引用对超预算、超深和循环身份 fail closed 而不产生碰撞摘要', () => {
  const oversizedA = target('oversized', '^model-a$', {
    forwardHeaders: Array.from({ length: 3_000 }, (_, index) => `x-a-${index}`),
  });
  const oversizedB = target('oversized', '^model-a$', {
    forwardHeaders: Array.from({ length: 3_000 }, (_, index) => `x-b-${index}`),
  });
  const deep = target('deep', '^model-a$');
  let cursor = deep;
  for (let index = 0; index < 40; index += 1) {
    cursor.extension = {};
    cursor = cursor.extension;
  }
  const cyclic = target('cyclic', '^model-a$');
  cyclic.self = cyclic;

  for (const invalid of [oversizedA, oversizedB, deep, cyclic]) {
    assert.throws(
      () => targetReference('revision-fail-closed', 0, invalid),
      /复杂度|循环|安全|身份/,
    );
  }
});

test('目标引用拒绝非有限数，避免与 null 的 JSON 表示碰撞', () => {
  const nullReference = targetReference(
    'revision-finite-number',
    0,
    target('null-port', '^model-a$', { port: null }),
  );
  assert.match(nullReference, /^target:[a-f0-9]{64}$/);

  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => targetReference(
        'revision-finite-number',
        0,
        target('non-finite-port', '^model-a$', { port: value }),
      ),
      /有限|安全|身份/,
    );
  }
});

test('暴露状态对不可快照 model/target 安全降级且不给出可用 targetRef', () => {
  const throwingModel = {};
  Object.defineProperty(throwingModel, 'slug', {
    enumerable: true,
    get() { throw new Error('model getter boom'); },
  });
  const throwingTarget = {};
  Object.defineProperty(throwingTarget, 'name', {
    enumerable: true,
    get() { throw new Error('target getter boom'); },
  });
  const proxyModel = new Proxy(model('proxy-model'), {
    get() { throw new Error('model proxy boom'); },
  });
  const proxyTarget = new Proxy(target('proxy-target', '^proxy-model$'), {
    get() { throw new Error('target proxy boom'); },
  });
  const validTarget = target('valid', '^valid-model$');

  let state;
  assert.doesNotThrow(() => {
    state = exposeModelRoutingState(
      { models: [null, throwingModel, proxyModel, model('valid-model')] },
      { targets: [null, throwingTarget, proxyTarget, validTarget] },
      'revision-snapshot',
      {},
    );
  });
  assert.deepEqual(state.models.slice(0, 3), [{}, {}, {}]);
  for (const invalid of state.targets.slice(0, 3)) {
    assert.equal(invalid.targetRef ?? null, null);
    assert.equal(invalid.envSet, false);
  }
  assert.equal(
    state.targets[3].targetRef,
    targetReference('revision-snapshot', 3, validTarget),
  );
  assert.deepEqual(state.bindings.at(-1).targetRefs, [state.targets[3].targetRef]);
});

test('暴露状态安全读取 models/targets 根字段及带访问器的数组条目', () => {
  const catalogGetter = {};
  Object.defineProperty(catalogGetter, 'models', {
    enumerable: true,
    get() { throw new Error('catalog models getter boom'); },
  });
  const configGetter = {};
  Object.defineProperty(configGetter, 'targets', {
    enumerable: true,
    get() { throw new Error('config targets getter boom'); },
  });
  const catalogProxy = new Proxy({ models: [model('proxy-model')] }, {
    getOwnPropertyDescriptor() { throw new Error('catalog proxy boom'); },
  });
  const configProxy = new Proxy({ targets: [target('proxy-target', '^proxy-model$')] }, {
    getOwnPropertyDescriptor() { throw new Error('config proxy boom'); },
  });

  for (const [catalog, config] of [
    [catalogGetter, { targets: [] }],
    [{ models: [] }, configGetter],
    [catalogProxy, { targets: [] }],
    [{ models: [] }, configProxy],
  ]) {
    let state;
    assert.doesNotThrow(() => {
      state = exposeModelRoutingState(catalog, config, 'revision-root-container', {});
    });
    assert.deepEqual(state.models, []);
    assert.deepEqual(state.targets, []);
  }

  const models = [model('valid-model')];
  const targets = [target('valid-target', '^valid-model$')];
  Object.defineProperty(models, 0, {
    enumerable: true,
    get() { throw new Error('model entry getter boom'); },
  });
  Object.defineProperty(targets, 0, {
    enumerable: true,
    get() { throw new Error('target entry getter boom'); },
  });
  const state = exposeModelRoutingState({ models }, { targets }, 'revision-entry-getter', {});
  assert.deepEqual(state.models, [{}]);
  assert.equal(state.targets[0].targetRef, null);
});

test('targetRef 对旧 revision、错误位置或身份变化立即失效', () => {
  const source = baseState();
  const stale = targetReference('old-revision', 0, source.config.targets[0]);
  const wrongIndex = targetReference(source.configRevision, 1, source.config.targets[0]);
  const wrongIdentity = targetReference(source.configRevision, 0, {
    ...source.config.targets[0],
    host: 'changed.example.test',
  });

  for (const targetRef of [stale, wrongIndex, wrongIdentity, 'target:not-a-real-ref']) {
    assert.throws(
      () => applyModelRoutingOperations({
        ...source,
        operations: [{ kind: 'target.delete', targetRef }],
      }),
      /targetRef/,
    );
  }
});

test('target.update 优先报告 stale targetRef 而不是 patch 内容错误', () => {
  const source = baseState();
  const stale = targetReference('old-revision', 0, source.config.targets[0]);

  assert.throws(
    () => applyModelRoutingOperations({
      ...source,
      operations: [{
        kind: 'target.update',
        targetRef: stale,
        patch: { envKey: { accessToken: 'nested-sensitive-token' } },
      }],
    }),
    (error) => error?.code === 'target_ref_invalid',
  );
});

test('操作拒绝不存在或重复的模型并拒绝缺失目标引用', () => {
  const source = baseState();
  for (const operation of [
    { kind: 'model.create', model: model('model-a') },
    { kind: 'model.update', slug: 'missing', patch: { description: 'x' } },
    { kind: 'model.delete', slug: 'missing' },
    { kind: 'target.delete', targetRef: '' },
  ]) {
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations: [operation] }),
      /存在|targetRef/,
    );
  }
});

test('apply 在任何操作前按整批预算拒绝超量 primitive 和循环 operations', () => {
  const source = baseState();
  const oversized = Array.from({ length: 3_000 }, (_, index) => ({
    kind: 'reference.removeSlug',
    slug: `unused-${index}`,
  }));
  const cyclic = [{ kind: 'reference.removeSlug', slug: 'unused' }];
  cyclic.push(cyclic);

  for (const operations of [oversized, cyclic]) {
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations }),
      (error) => error?.code === 'operation_invalid' && /复杂度|循环/.test(error.message),
    );
  }
});

test('operations 非有限数稳定返回 operation_invalid 且不能形成摘要', () => {
  const source = baseState();
  for (const value of [NaN, Infinity, -Infinity]) {
    const operations = [{
      kind: 'model.update',
      slug: 'model-a',
      patch: { priority: value },
    }];
    assert.throws(
      () => applyModelRoutingOperations({ ...source, operations }),
      (error) => error?.code === 'operation_invalid' && /有限/.test(error.message),
    );
    const result = inspectModelRoutingPlan({ ...source, operations });
    assert.equal(result.errors.some((item) => item.code === 'operation_invalid'), true);
    assert.equal(result.operationDigest, null);
  }
});

test('inspect 将 operation kind getter、Proxy 和循环稳定转换为 operation_invalid', () => {
  const source = baseState();
  const getterOperation = {};
  Object.defineProperty(getterOperation, 'kind', {
    enumerable: true,
    get() { throw new Error('kind getter boom'); },
  });
  const proxyOperation = new Proxy({ kind: 'model.delete', slug: 'model-a' }, {
    get() { throw new Error('operation proxy boom'); },
  });
  const cyclicOperation = { kind: 'reference.removeSlug', slug: 'model-a' };
  cyclicOperation.self = cyclicOperation;

  for (const operations of [[getterOperation], [proxyOperation], [cyclicOperation]]) {
    let result;
    assert.doesNotThrow(() => {
      result = inspectModelRoutingPlan({ ...source, operations });
    });
    assert.equal(result.errors.some((item) => item.code === 'operation_invalid'), true);
    assert.equal(result.operationDigest, null);
  }
});

test('inspect 对 catalog/config 根 getter、Proxy 和循环返回稳定根诊断', () => {
  const source = baseState();
  const catalogGetter = {};
  Object.defineProperty(catalogGetter, 'models', {
    enumerable: true,
    get() { throw new Error('catalog root getter boom'); },
  });
  const configGetter = {};
  Object.defineProperty(configGetter, 'targets', {
    enumerable: true,
    get() { throw new Error('config root getter boom'); },
  });
  const catalogProxy = new Proxy(source.catalog, {
    getOwnPropertyDescriptor() { throw new Error('catalog root proxy boom'); },
  });
  const configProxy = new Proxy(source.config, {
    getOwnPropertyDescriptor() { throw new Error('config root proxy boom'); },
  });
  const catalogCycle = structuredClone(source.catalog);
  catalogCycle.self = catalogCycle;
  const configCycle = structuredClone(source.config);
  configCycle.self = configCycle;

  for (const catalog of [catalogGetter, catalogProxy, catalogCycle]) {
    let result;
    assert.doesNotThrow(() => {
      result = inspectModelRoutingPlan({
        ...source,
        catalog,
        operations: [],
      });
    });
    assert.equal(result.errors.some((item) => item.code === 'catalog_root_invalid'), true);
    assert.equal(result.operationDigest, null);
  }
  for (const config of [configGetter, configProxy, configCycle]) {
    let result;
    assert.doesNotThrow(() => {
      result = inspectModelRoutingPlan({
        ...source,
        config,
        operations: [],
      });
    });
    assert.equal(result.errors.some((item) => item.code === 'config_root_invalid'), true);
    assert.equal(result.operationDigest, null);
  }
});

test('联合预检合并配置与目录诊断并返回相互独立的最终副本', () => {
  const source = baseState();
  source.catalog.models[0].input_modalities = ['audio'];
  source.config.targets[0].host = '';
  const snapshot = structuredClone(source);

  const result = inspectModelRoutingPlan({
    ...source,
    operations: [],
    context: { env: { TEST_KEY: 'test-secret', OTHER_KEY: 'other-secret' } },
  });

  assert.deepEqual(result.errors.map((item) => item.code), [
    'catalog_modalities_invalid',
    'target_host_invalid',
  ]);
  assert.deepEqual(source, snapshot);
  assert.equal(result.operationDigest, null);
  result.catalog.models[0].display_name = 'changed-result-only';
  result.config.targets[0].name = 'changed-result-only';
  assert.notEqual(source.catalog.models[0].display_name, 'changed-result-only');
  assert.notEqual(source.config.targets[0].name, 'changed-result-only');
});

test('operationDigest 忽略对象键顺序但会识别操作内容变化', () => {
  const source = baseState();
  const first = inspectModelRoutingPlan({
    ...source,
    operations: [{
      kind: 'model.update',
      slug: 'model-a',
      patch: { description: 'new', display_name: 'MODEL A' },
    }],
  });
  const reordered = inspectModelRoutingPlan({
    ...source,
    operations: [{
      patch: { display_name: 'MODEL A', description: 'new' },
      slug: 'model-a',
      kind: 'model.update',
    }],
  });
  const changed = inspectModelRoutingPlan({
    ...source,
    operations: [{
      kind: 'model.update',
      slug: 'model-a',
      patch: { description: 'different', display_name: 'MODEL A' },
    }],
  });

  assert.match(first.operationDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.operationDigest, reordered.operationDigest);
  assert.notEqual(first.operationDigest, changed.operationDigest);
});

test('删除专属 target 会报告无路由模型，保留共享或备用 target 则通过', () => {
  const source = baseState();
  source.config.targets = [
    target('only-a', '^model-a$'),
    target('only-b', '^model-b$'),
  ];
  const onlyARef = targetReference(source.configRevision, 0, source.config.targets[0]);
  const missing = inspectModelRoutingPlan({
    ...source,
    operations: [{ kind: 'target.delete', targetRef: onlyARef }],
  });
  assert.deepEqual(
    missing.errors.filter((item) => item.code === 'model_route_missing').map((item) => item.path),
    ['/models/0/slug'],
  );

  source.config.targets.unshift(target('shared', '^model-'));
  const onlyANow = targetReference(source.configRevision, 1, source.config.targets[1]);
  const covered = inspectModelRoutingPlan({
    ...source,
    operations: [{ kind: 'target.delete', targetRef: onlyANow }],
  });
  assert.equal(covered.errors.some((item) => item.code === 'model_route_missing'), false);
});

test('同批按 UI 顺序删除引用、唯一 target 和模型不产生无路由错误', () => {
  const source = baseState();
  source.catalog.models = [model('model-a'), model('model-b')];
  source.config.targets = [target('only-a', '^model-a$'), target('only-b', '^model-b$')];
  const onlyARef = targetReference(source.configRevision, 0, source.config.targets[0]);

  const result = inspectModelRoutingPlan({
    ...source,
    operations: [
      { kind: 'reference.removeSlug', slug: 'model-a' },
      { kind: 'target.delete', targetRef: onlyARef },
      { kind: 'model.delete', slug: 'model-a' },
    ],
  });

  assert.equal(result.errors.some((item) => item.code === 'model_route_missing'), false);
  assert.deepEqual(result.catalog.models.map((item) => item.slug), ['model-b']);
});

test('新建精确 target 使用转义 slug 且不会误命中相似模型', () => {
  const source = baseState();
  const special = 'qwen3.8-max+(cn)[1]';
  source.catalog.models = [model(special), model('qwen3x8-max+(cn)[1]')];
  source.config.targets = [target('similar', '^qwen3x8-')];

  const result = inspectModelRoutingPlan({
    ...source,
    operations: [{
      kind: 'target.create',
      target: target('special', `^${escapeModelSlug(special)}$`),
    }],
  });

  assert.equal(result.errors.some((item) => item.code === 'model_route_missing'), false);
  const specialTarget = result.config.targets.find((item) => item.name === 'special');
  const matcher = new RegExp(specialTarget.match);
  assert.equal(matcher.test(special), true);
  assert.equal(matcher.test('qwen3x8-max+(cn)[1]'), false);
});

test('显式改名与删除会更新精确引用并提示人工复核能力正则', () => {
  const source = baseState();
  const result = inspectModelRoutingPlan({
    ...source,
    operations: [
      { kind: 'model.update', slug: 'model-a', patch: { slug: 'renamed-a' } },
      { kind: 'reference.replaceSlug', from: 'model-a', to: 'renamed-a' },
      { kind: 'model.delete', slug: 'model-b' },
      { kind: 'reference.removeSlug', slug: 'model-b' },
      { kind: 'target.create', target: target('renamed-a', '^renamed-a$') },
    ],
  });

  assert.deepEqual(result.config.modelContext.slugs, ['renamed-a']);
  assert.deepEqual(result.config.supportsResponses.slugs, ['renamed-a']);
  assert.deepEqual(result.config.modelCapabilities, source.config.modelCapabilities);
  assert.deepEqual(
    result.warnings
      .filter((item) => item.code === 'model_capability_reference_manual')
      .map((item) => item.path),
    ['/modelCapabilities/0/match', '/modelCapabilities/0/match'],
  );
});

test('非法 target 正则沿用配置检查错误且不级联无路由错误', () => {
  const source = baseState();
  source.config.targets = [target('invalid', '(')];
  const result = inspectModelRoutingPlan({ ...source, operations: [] });

  assert.deepEqual(
    result.errors.filter((item) => item.code === 'target_match_invalid').map((item) => item.path),
    ['/targets/0/match'],
  );
  assert.equal(result.errors.some((item) => item.code === 'model_route_missing'), false);
});

test('危险 target 正则沿用共享安全检查且不会在模型覆盖检查中执行', () => {
  for (const match of ['a'.repeat(1_025), '^(a+)+$', '^(a|aa)+$', '^((a|aa))+$', '^(a)\\1$']) {
    const source = baseState();
    source.config.targets = [target('unsafe', match)];
    const result = inspectModelRoutingPlan({ ...source, operations: [] });

    assert.deepEqual(
      result.errors.filter((item) => item.path === '/targets/0/match').map((item) => item.code),
      ['target_match_unsafe'],
    );
    assert.equal(result.errors.some((item) => item.code === 'model_route_missing'), false);
  }
});

test('图像模型走 vision:false 时要求合法视觉中继，vision:true 可直接通过', () => {
  const source = baseState();
  source.catalog.models = [model('vision-model', { input_modalities: ['text', 'image'] })];
  source.config.targets = [target('vision-relay', '^vision-model$', { vision: false })];
  source.config.visionRelay = false;
  const relayed = inspectModelRoutingPlan({ ...source, operations: [] });
  assert.equal(relayed.errors.some((item) => item.code === 'vision_relay_invalid'), true);

  source.config.targets = [target('vision-native', '^vision-model$', { vision: true })];
  const native = inspectModelRoutingPlan({ ...source, operations: [] });
  assert.equal(native.errors.some((item) => item.code === 'vision_relay_invalid'), false);
  assert.equal(native.errors.some((item) => item.code === 'model_route_missing'), false);
});

test('操作错误转成稳定诊断而不抛异常并保留原始状态副本', () => {
  const source = baseState();
  const result = inspectModelRoutingPlan({
    ...source,
    operations: [{ kind: 'model.delete', slug: 'missing' }],
  });

  assert.deepEqual(result.errors.filter((item) => item.path === '/operations'), [{
    severity: 'error',
    code: 'operation_invalid',
    path: '/operations',
    message: '模型不存在：missing',
  }]);
  assert.deepEqual(result.catalog, source.catalog);
  assert.deepEqual(result.config, source.config);
  assert.equal(result.operationDigest, null);
  assert.deepEqual(result.impact, {
    models: { created: [], updated: [], deleted: [] },
    targets: { created: [], updated: [], deleted: [] },
    references: { replaced: [], removed: [] },
  });
});
