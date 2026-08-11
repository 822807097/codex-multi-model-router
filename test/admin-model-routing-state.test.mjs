import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createAdminHandler } from '../lib/admin-api.mjs';
import {
  exposeModelRoutingState,
  inspectModelRoutingPlan,
} from '../lib/model-routing-plan.mjs';
import {
  addModelDraft,
  createModelRoutingState,
  isModelRoutingDirty,
  isPersistedModelRoutingTarget,
  removeModelDraft,
  serializeModelRoutingOperations,
  undoModelRoutingChange,
  updateModelDraft,
} from '../web/model-routing-state.mjs';

const CONFIG_REVISION = 'a'.repeat(64);
const CATALOG_REVISION = 'b'.repeat(64);
const SERVER_SENSITIVE_FIELD_CORPUS = [
  'authorization', 'apiKey', 'token', 'secret', 'cookie', 'password', 'credential', 'bearer',
  'privateKey', 'headers', 'auth', 'cookies', 'secrets', 'credentials', 'oauth', 'api',
  'authorizationValue', 'api_secret_value', 'userPasswordHash', 'clientCredential',
  'sessionCookie', 'accessToken', 'refresh_token', 'auth-token', 'apiTokenValue',
  'bearerTokenHash', 'idToken', 'clientToken', 'sessionToken', 'oauthToken',
  'key', 'Key', 'keyId', 'key_id', 'key-id', 'key.value', 'publicKey', 'public_key',
  'master_key', 'provider-key', 'displayKey', 'signing_key', 'encryption-key', 'consumerKey',
  'publishable_key', 'sshKey', 'ACCESS_KEY', 'Auth-Key', 'SESSION_KEY',
];
const SAFE_FIELD_CORPUS = [
  'auto_compact_token_limit', 'supported_in_api',
  'keyboard', 'monkey', 'keynote', 'tokenizer',
];
const PATH_SCOPED_SENSITIVE_FIELD_CORPUS = [
  'envKey', 'ENV_KEY', 'env-key', 'eNv.Key',
  'authHeader', 'AUTH_HEADER', 'auth-header', 'aUtH.Header',
  'forwardHeaders', 'FORWARD_HEADERS', 'forward-headers', 'fOrWaRd.Headers',
];

function modelSensitivePlacements(field, value) {
  return [
    { [field]: value },
    { extension: { [field]: value } },
    { experimental_supported_tools: [{ metadata: { [field]: value } }] },
  ];
}

function payload() {
  return {
    configRevision: CONFIG_REVISION,
    catalogRevision: CATALOG_REVISION,
    models: [
      { slug: 'shared-a', display_name: 'Shared A', vendor_note: 'keep-a' },
      { slug: 'shared-b', display_name: 'Shared B', vendor_note: 'keep-b' },
      { slug: 'solo', display_name: 'Solo', priority: 2 },
    ],
    targets: [
      {
        targetRef: 'target:shared',
        name: 'shared',
        match: '^shared-',
        host: 'shared.example',
        envKey: 'SHARED_KEY',
        envSet: true,
      },
      {
        targetRef: 'target:solo',
        name: 'solo',
        match: '^solo$',
        host: 'solo.example',
        envKey: 'SOLO_KEY',
        envSet: false,
      },
    ],
    bindings: [
      { slug: 'shared-a', targetRefs: ['target:shared'] },
      { slug: 'shared-b', targetRefs: ['target:shared'] },
      { slug: 'solo', targetRefs: ['target:solo'] },
    ],
    references: {
      modelContext: ['shared-a', 'solo'],
      supportsResponses: ['shared-a', 'shared-b', 'solo'],
    },
    errors: [],
    warnings: [],
    futureServerField: { enabled: true },
  };
}

function serverBackedFixture() {
  const configRevision = 'fixture-config-revision';
  const catalog = {
    models: [
      { slug: 'solo', display_name: 'Solo', input_modalities: ['text'] },
      { slug: 'other', display_name: 'Other', input_modalities: ['text'] },
    ],
  };
  const config = {
    port: 15730,
    modelContext: { slugs: ['solo'] },
    supportsResponses: { slugs: ['solo'] },
    targets: [
      {
        name: 'solo',
        match: '^solo$',
        host: 'solo.example',
        envKey: 'SOLO_KEY',
        wireApi: 'chat',
      },
      {
        name: 'other',
        match: '^other$',
        host: 'other.example',
        envKey: 'SOLO_KEY',
        wireApi: 'chat',
      },
    ],
  };
  const exposed = exposeModelRoutingState(
    catalog,
    config,
    configRevision,
    { SOLO_KEY: 'runtime-secret', NEW_KEY: 'runtime-secret' },
  );
  return {
    catalog,
    config,
    configRevision,
    payload: {
      configRevision,
      catalogRevision: 'fixture-catalog-revision',
      ...exposed,
      errors: [],
      warnings: [],
    },
  };
}

function inspectFixture(fixture, state) {
  return inspectModelRoutingPlan({
    catalog: fixture.catalog,
    config: fixture.config,
    configRevision: fixture.configRevision,
    operations: serializeModelRoutingOperations(state),
    context: { env: { SOLO_KEY: 'runtime-secret', NEW_KEY: 'runtime-secret' } },
  });
}

function request(server, requestPath) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

test('创建状态隔离输入、保留双 revision 和未知非敏感字段', () => {
  const source = payload();
  const state = createModelRoutingState(source);

  source.models[0].display_name = 'mutated input';
  source.targets[0].host = 'mutated.example';
  source.futureServerField.enabled = false;

  assert.equal(state.configRevision, CONFIG_REVISION);
  assert.equal(state.catalogRevision, CATALOG_REVISION);
  assert.equal(state.models[0].display_name, 'Shared A');
  assert.equal(state.models[0].vendor_note, 'keep-a');
  assert.equal(state.targets[0].host, 'shared.example');
  assert.deepEqual(state.futureServerField, { enabled: true });
  assert.equal(isModelRoutingDirty(state), false);
});

test('新增专属通道生成稳定的 model.create 再 target.create 操作', () => {
  const state = addModelDraft(createModelRoutingState(payload()), {
    slug: 'qwen3.8-max+(cn)[1]',
    display_name: 'Qwen CN',
    visibility: 'list',
    routing: {
      mode: 'dedicated',
      target: {
        name: 'qwen-cn',
        host: 'dashscope.example',
        protocol: 'https',
        envKey: 'DASHSCOPE_KEY',
        wireApi: 'responses',
      },
    },
  });

  assert.deepEqual(serializeModelRoutingOperations(state), [
    {
      kind: 'model.create',
      model: {
        slug: 'qwen3.8-max+(cn)[1]',
        display_name: 'Qwen CN',
        visibility: 'list',
      },
    },
    {
      kind: 'target.create',
      target: {
        name: 'qwen-cn',
        host: 'dashscope.example',
        protocol: 'https',
        envKey: 'DASHSCOPE_KEY',
        wireApi: 'responses',
        match: '^qwen3\\.8-max\\+\\(cn\\)\\[1\\]$',
      },
    },
  ]);
  assert.equal(isModelRoutingDirty(state), true);
});

test('新增草稿会投影专属和复用通道绑定，供管理页正确显示', () => {
  let state = addModelDraft(createModelRoutingState(payload()), {
    model: { slug: 'draft-dedicated', display_name: 'Draft Dedicated' },
    routing: {
      mode: 'dedicated',
      target: {
        name: 'draft-dedicated',
        host: 'draft.example',
        protocol: 'https',
        envKey: 'DRAFT_KEY',
        wireApi: 'responses',
      },
    },
  });
  const dedicatedBinding = state.bindings.find((binding) => binding.slug === 'draft-dedicated');
  assert.equal(dedicatedBinding.targetRefs.length, 1);
  const dedicatedTarget = state.targets.find((target) => target.targetRef === dedicatedBinding.targetRefs[0]);
  assert.deepEqual(dedicatedTarget, {
    name: 'draft-dedicated',
    host: 'draft.example',
    protocol: 'https',
    envKey: 'DRAFT_KEY',
    wireApi: 'responses',
    match: '^draft-dedicated$',
    targetRef: dedicatedBinding.targetRefs[0],
    envSet: false,
  });

  state = addModelDraft(state, {
    model: { slug: 'draft-shared', display_name: 'Draft Shared' },
    routing: { mode: 'reuse', targetRef: 'target:shared' },
  });
  assert.deepEqual(
    state.bindings.find((binding) => binding.slug === 'draft-shared').targetRefs,
    ['target:shared'],
  );
});

test('草稿专属通道不会被识别为可复用的已保存通道', () => {
  let state = addModelDraft(createModelRoutingState(payload()), {
    model: { slug: 'draft-editable', display_name: 'Draft Editable' },
    routing: {
      mode: 'dedicated',
      target: {
        name: 'draft-editable',
        host: 'draft.example',
        protocol: 'https',
        envKey: 'DRAFT_KEY',
        wireApi: 'responses',
      },
    },
  });
  const draftRef = state.bindings.find((binding) => binding.slug === 'draft-editable').targetRefs[0];
  assert.equal(isPersistedModelRoutingTarget(state, draftRef), false);
  assert.equal(isPersistedModelRoutingTarget(state, 'target:shared'), true);

  state = updateModelDraft(state, 'draft-editable', {
    model: { display_name: 'Draft Edited' },
    routing: { patch: { host: 'edited.example' } },
  });
  const created = serializeModelRoutingOperations(state).find((operation) => operation.kind === 'target.create');
  assert.equal(created.target.host, 'edited.example');
});

test('新增模型可复用既有 targetRef 且不伪造目标正文', () => {
  const state = addModelDraft(createModelRoutingState(payload()), {
    model: { slug: 'shared-new', display_name: 'Shared New' },
    routing: { mode: 'reuse', targetRef: 'target:shared' },
  });

  assert.deepEqual(serializeModelRoutingOperations(state), [{
    kind: 'model.create',
    model: { slug: 'shared-new', display_name: 'Shared New' },
  }]);
  assert.equal(state.models.at(-1).slug, 'shared-new');
});

test('普通编辑生成 model.update，连续操作不修改旧状态或 patch', () => {
  const original = createModelRoutingState(payload());
  const patch = { display_name: 'Solo Plus', priority: 8 };
  const edited = updateModelDraft(original, 'solo', patch);
  patch.priority = 99;

  assert.equal(original.models.find((model) => model.slug === 'solo').display_name, 'Solo');
  assert.deepEqual(serializeModelRoutingOperations(original), []);
  assert.equal(edited.models.find((model) => model.slug === 'solo').priority, 8);
  assert.deepEqual(serializeModelRoutingOperations(edited), [{
    kind: 'model.update',
    slug: 'solo',
    patch: { display_name: 'Solo Plus', priority: 8 },
  }]);
});

test('结构化模型更新可显式编辑关联 target，并兼容改名、连续编辑、undo 与共享选择', () => {
  const fixture = serverBackedFixture();
  fixture.config.targets.push({
    name: 'shared-editable',
    match: '^(?:solo|other|solo-alias)$',
    host: 'shared-editable.example',
    envKey: 'SOLO_KEY',
    wireApi: 'chat',
  });
  const exposed = exposeModelRoutingState(
    fixture.catalog,
    fixture.config,
    fixture.configRevision,
    { SOLO_KEY: 'runtime-secret', NEW_KEY: 'runtime-secret' },
  );
  fixture.payload = {
    configRevision: fixture.configRevision,
    catalogRevision: 'fixture-catalog-revision',
    ...exposed,
    errors: [],
    warnings: [],
  };
  const soloRef = fixture.payload.bindings.find((item) => item.slug === 'solo').targetRefs[0];
  const sharedRef = fixture.payload.targets.find((target) => target.name === 'shared-editable').targetRef;
  const unboundRef = fixture.payload.bindings.find((item) => item.slug === 'other').targetRefs
    .find((targetRef) => !fixture.payload.bindings.find((item) => item.slug === 'solo').targetRefs.includes(targetRef));

  const first = updateModelDraft(createModelRoutingState(fixture.payload), 'solo', {
    model: { display_name: 'Solo Routed' },
    routing: {
      targetRef: soloRef,
      patch: {
        host: 'routed.example',
        protocol: 'http',
        apiFormat: 'chat',
        envKey: 'NEW_KEY',
        viaProxy: false,
      },
    },
  });
  assert.deepEqual(serializeModelRoutingOperations(first), [
    { kind: 'model.update', slug: 'solo', patch: { display_name: 'Solo Routed' } },
    {
      kind: 'target.update',
      targetRef: soloRef,
      patch: {
        host: 'routed.example',
        protocol: 'http',
        apiFormat: 'chat',
        envKey: 'NEW_KEY',
        viaProxy: false,
      },
    },
  ]);
  assert.deepEqual(inspectFixture(fixture, first).errors, []);

  const renamed = updateModelDraft(first, 'solo', {
    model: { slug: 'solo-v2' },
    routing: { targetRef: soloRef, patch: { host: 'renamed.example' } },
  });
  assert.deepEqual(serializeModelRoutingOperations(renamed).slice(-3), [
    { kind: 'model.update', slug: 'solo', patch: { slug: 'solo-v2' } },
    {
      kind: 'target.update',
      targetRef: soloRef,
      patch: { host: 'renamed.example', match: '^solo-v2$' },
    },
    { kind: 'reference.replaceSlug', from: 'solo', to: 'solo-v2' },
  ]);
  assert.deepEqual(inspectFixture(fixture, renamed).errors, []);

  const continued = updateModelDraft(renamed, 'solo-v2', {
    routing: { targetRef: soloRef, patch: { prefix: '/v2' } },
  });
  assert.deepEqual(inspectFixture(fixture, continued).errors, []);
  assert.deepEqual(
    serializeModelRoutingOperations(undoModelRoutingChange(continued)),
    serializeModelRoutingOperations(renamed),
  );

  const multiState = createModelRoutingState(fixture.payload);
  assert.throws(
    () => updateModelDraft(multiState, 'solo', { routing: { patch: { host: 'missing-ref.example' } } }),
    /targetRef/u,
  );
  assert.throws(
    () => updateModelDraft(multiState, 'solo', {
      routing: { targetRef: 'target:stale', patch: { host: 'stale.example' } },
    }),
    /targetRef/u,
  );
  assert.throws(
    () => updateModelDraft(multiState, 'solo', {
      routing: { targetRef: unboundRef, patch: { host: 'unbound.example' } },
    }),
    /绑定|targetRef/u,
  );
  const sharedEdited = updateModelDraft(multiState, 'solo', {
    routing: { targetRef: sharedRef, patch: { host: 'shared-updated.example' } },
  });
  assert.deepEqual(inspectFixture(fixture, sharedEdited).errors, []);

  let reused = addModelDraft(multiState, {
    slug: 'solo-alias',
    display_name: 'Solo Alias',
    input_modalities: ['text'],
    routing: { mode: 'reuse', targetRef: sharedRef },
  });
  assert.throws(
    () => updateModelDraft(reused, 'solo-alias', {
      routing: { patch: { host: 'implicit-shared.example' } },
    }),
    /targetRef/u,
  );
  reused = updateModelDraft(reused, 'solo-alias', {
    routing: { targetRef: sharedRef, patch: { host: 'explicit-shared.example' } },
  });
  assert.deepEqual(inspectFixture(fixture, reused).errors, []);
  const reusedOperations = serializeModelRoutingOperations(reused);
  const reusedNoop = updateModelDraft(reused, 'solo-alias', {
    routing: { targetRef: sharedRef, patch: { host: 'explicit-shared.example' } },
  });
  assert.deepEqual(serializeModelRoutingOperations(reusedNoop), reusedOperations);
  assert.deepEqual(inspectFixture(fixture, reusedNoop).errors, []);

  for (const patch of [
    { match: '^override$' },
    { headers: { authorization: 'Bearer secret' } },
    { auth: { token: 'secret' } },
    { envKey: { secret: 'secret' } },
  ]) {
    assert.throws(
      () => updateModelDraft(multiState, 'solo', {
        routing: { targetRef: soloRef, patch },
      }),
      /敏感|不允许/u,
    );
  }
});

test('新建 dedicated 草稿的结构化 target 编辑重写 target.create 并可逐步撤销', () => {
  const fixture = serverBackedFixture();
  let state = addModelDraft(createModelRoutingState(fixture.payload), {
    slug: 'new-dedicated',
    display_name: 'New Dedicated',
    input_modalities: ['text'],
    routing: {
      mode: 'dedicated',
      target: {
        name: 'new-dedicated',
        host: 'initial.example',
        envKey: 'NEW_KEY',
        wireApi: 'chat',
      },
    },
  });
  state = updateModelDraft(state, 'new-dedicated', {
    model: { slug: 'new-dedicated-v2' },
    routing: {
      patch: {
        host: 'updated.example',
        protocol: 'https',
        apiFormat: 'chat',
        envKey: 'NEW_KEY',
        viaProxy: true,
      },
    },
  });
  let operations = serializeModelRoutingOperations(state);
  assert.equal(operations.some((operation) => operation.kind === 'target.update'), false);
  assert.deepEqual(operations.find((operation) => operation.kind === 'target.create').target, {
    name: 'new-dedicated',
    host: 'updated.example',
    envKey: 'NEW_KEY',
    wireApi: 'chat',
    match: '^new-dedicated-v2$',
    protocol: 'https',
    apiFormat: 'chat',
    viaProxy: true,
  });
  assert.deepEqual(inspectFixture(fixture, state).errors, []);

  const continued = updateModelDraft(state, 'new-dedicated-v2', {
    routing: { patch: { prefix: '/v2' } },
  });
  assert.deepEqual(inspectFixture(fixture, continued).errors, []);
  operations = serializeModelRoutingOperations(undoModelRoutingChange(continued));
  assert.equal(operations.find((operation) => operation.kind === 'target.create').target.prefix, undefined);
  assert.deepEqual(operations, serializeModelRoutingOperations(state));
});

test('slug 改名生成精确引用替换，后续编辑使用新 slug', () => {
  let state = createModelRoutingState(payload());
  state = updateModelDraft(state, 'solo', { slug: 'solo-v2', display_name: 'Solo V2' });
  state = updateModelDraft(state, 'solo-v2', { description: 'renamed model' });

  assert.deepEqual(serializeModelRoutingOperations(state), [
    {
      kind: 'model.update',
      slug: 'solo',
      patch: { slug: 'solo-v2', display_name: 'Solo V2' },
    },
    { kind: 'target.update', targetRef: 'target:solo', patch: { match: '^solo-v2$' } },
    { kind: 'reference.replaceSlug', from: 'solo', to: 'solo-v2' },
    {
      kind: 'model.update',
      slug: 'solo-v2',
      patch: { description: 'renamed model' },
    },
  ]);
});

test('baseline 精确通道随连续改名更新，undo 与改名后删除均通过服务端预检', () => {
  const fixture = serverBackedFixture();
  const targetRef = fixture.payload.targets[0].targetRef;
  let first = updateModelDraft(
    createModelRoutingState(fixture.payload),
    'solo',
    { slug: 'solo.v2' },
  );
  assert.deepEqual(serializeModelRoutingOperations(first), [
    { kind: 'model.update', slug: 'solo', patch: { slug: 'solo.v2' } },
    { kind: 'target.update', targetRef, patch: { match: '^solo\\.v2$' } },
    { kind: 'reference.replaceSlug', from: 'solo', to: 'solo.v2' },
  ]);
  assert.deepEqual(inspectFixture(fixture, first).errors, []);

  const second = updateModelDraft(first, 'solo.v2', { slug: 'solo-v3' });
  assert.deepEqual(serializeModelRoutingOperations(second).slice(-3), [
    { kind: 'model.update', slug: 'solo.v2', patch: { slug: 'solo-v3' } },
    { kind: 'target.update', targetRef, patch: { match: '^solo-v3$' } },
    { kind: 'reference.replaceSlug', from: 'solo.v2', to: 'solo-v3' },
  ]);
  assert.deepEqual(inspectFixture(fixture, second).errors, []);

  const undone = undoModelRoutingChange(second);
  assert.deepEqual(serializeModelRoutingOperations(undone), serializeModelRoutingOperations(first));
  assert.deepEqual(inspectFixture(fixture, undone).errors, []);

  const removed = removeModelDraft(first, 'solo.v2', {
    deleteDedicatedTarget: true,
    targetRef,
  });
  assert.deepEqual(inspectFixture(fixture, removed).errors, []);
});

test('新草稿专属通道改名重写 target.create，连续改名和 undo 均不生成 target.update', () => {
  const fixture = serverBackedFixture();
  fixture.config.modelContext.slugs.push('new.model');
  fixture.payload.references.modelContext.push('new.model');
  const target = {
    name: 'new-model',
    host: 'new.example',
    envKey: 'NEW_KEY',
    wireApi: 'chat',
  };
  let first = addModelDraft(createModelRoutingState(fixture.payload), {
    slug: 'new.model',
    display_name: 'New Model',
    input_modalities: ['text'],
    routing: { mode: 'dedicated', target },
  });
  first = updateModelDraft(first, 'new.model', { slug: 'new-model-v2' });
  let operations = serializeModelRoutingOperations(first);
  assert.equal(operations.some((operation) => operation.kind === 'target.update'), false);
  assert.equal(operations.find((operation) => operation.kind === 'target.create').target.match, '^new-model-v2$');
  assert.deepEqual(inspectFixture(fixture, first).errors, []);

  const second = updateModelDraft(first, 'new-model-v2', { slug: 'new-model-v3' });
  operations = serializeModelRoutingOperations(second);
  assert.deepEqual(operations, [
    {
      kind: 'model.create',
      model: {
        slug: 'new-model-v3',
        display_name: 'New Model',
        input_modalities: ['text'],
      },
    },
    {
      kind: 'target.create',
      target: { ...target, match: '^new-model-v3$' },
    },
  ]);
  const inspected = inspectFixture(fixture, second);
  assert.deepEqual(inspected.errors, []);
  assert.deepEqual(inspected.impact.references.replaced, []);
  assert.deepEqual(inspected.config.modelContext.slugs, ['solo', 'new.model']);

  const undone = undoModelRoutingChange(second);
  assert.equal(
    serializeModelRoutingOperations(undone).find((operation) => operation.kind === 'target.create').target.match,
    '^new-model-v2$',
  );
  assert.deepEqual(inspectFixture(fixture, undone).errors, []);

  const removed = removeModelDraft(second, 'new-model-v3');
  assert.equal(isModelRoutingDirty(removed), false);
  assert.deepEqual(inspectFixture(fixture, removed).errors, []);
});

test('专属 target 在进入草稿前严格校验字段类型、枚举和精确 match', () => {
  const fixture = serverBackedFixture();
  const validTarget = {
    name: 'new-model',
    match: '^new\\.model$',
    platform: 'custom',
    host: 'new.example',
    protocol: 'https',
    port: 443,
    prefix: '/v1',
    chatPath: '/chat/completions',
    upstreamModel: 'upstream-model',
    envKey: 'NEW_KEY',
    wireApi: 'chat',
    viaProxy: false,
    vision: true,
    useOpenAiAuth: false,
    stateDomain: 'new-domain',
    maxResponseBytes: 1_000_000,
    authType: 'bearer',
    authHeader: 'authorization',
    forwardHeaders: ['x-request-id'],
  };
  const add = (target) => addModelDraft(createModelRoutingState(fixture.payload), {
    slug: 'new.model',
    display_name: 'New Model',
    input_modalities: ['text'],
    routing: { mode: 'dedicated', target },
  });

  const valid = add(validTarget);
  assert.deepEqual(inspectFixture(fixture, valid).errors, []);
  const serverCompatible = add({ ...validTarget, port: '443', chatPath: '/' });
  assert.deepEqual(inspectFixture(fixture, serverCompatible).errors, []);
  const withoutMatch = add(Object.fromEntries(
    Object.entries(validTarget).filter(([field]) => field !== 'match'),
  ));
  assert.equal(
    serializeModelRoutingOperations(withoutMatch).find((operation) => operation.kind === 'target.create').target.match,
    '^new\\.model$',
  );

  for (const badMatch of [42, [], {}, null, '', '(', '^other$']) {
    assert.throws(() => add({ ...validTarget, match: badMatch }), /match/u);
  }
  const invalidFields = [
    ['name', []], ['host', {}], ['platform', 1], ['protocol', 'ftp'], ['port', 0],
    ['prefix', 'v1'], ['chatPath', 'chat'], ['upstreamModel', []], ['envKey', 'BAD-KEY'],
    ['wireApi', 'completion'], ['apiFormat', 'completion'], ['viaProxy', 'yes'],
    ['vision', 1], ['useOpenAiAuth', 'yes'], ['stateDomain', {}],
    ['maxResponseBytes', -1], ['authType', 'unknown'], ['authHeader', 'bad header'],
    ['forwardHeaders', ['bad header']],
  ];
  for (const [field, value] of invalidFields) {
    assert.throws(() => add({ ...validTarget, [field]: value }), new RegExp(field, 'u'));
  }
});

test('删除专属模型按引用、通道、模型的安全顺序生成操作', () => {
  const state = removeModelDraft(createModelRoutingState(payload()), 'solo', {
    deleteDedicatedTarget: true,
    targetRef: 'target:solo',
  });

  assert.deepEqual(serializeModelRoutingOperations(state), [
    { kind: 'reference.removeSlug', slug: 'solo' },
    { kind: 'target.delete', targetRef: 'target:solo' },
    { kind: 'model.delete', slug: 'solo' },
  ]);
});

test('删除共享模型默认保留共享通道且显式删除共享通道会被拒绝', () => {
  const state = removeModelDraft(createModelRoutingState(payload()), 'shared-a');
  assert.deepEqual(serializeModelRoutingOperations(state), [
    { kind: 'reference.removeSlug', slug: 'shared-a' },
    { kind: 'model.delete', slug: 'shared-a' },
  ]);
  assert.throws(
    () => removeModelDraft(createModelRoutingState(payload()), 'shared-a', {
      deleteDedicatedTarget: true,
      targetRef: 'target:shared',
    }),
    /共享|专属/u,
  );
});

test('删除 target 仅接受当前模型唯一拥有的精确 dedicated match', () => {
  for (const match of ['^solo', ['solo'], undefined]) {
    const source = payload();
    if (match === undefined) delete source.targets[1].match;
    else source.targets[1].match = match;
    assert.throws(
      () => removeModelDraft(createModelRoutingState(source), 'solo', {
        deleteDedicatedTarget: true,
        targetRef: 'target:solo',
      }),
      (error) => error?.code === 'target_not_dedicated',
    );
  }

  const fixture = serverBackedFixture();
  const exactRef = fixture.payload.bindings.find((item) => item.slug === 'solo').targetRefs[0];
  const exact = removeModelDraft(createModelRoutingState(fixture.payload), 'solo', {
    deleteDedicatedTarget: true,
  });
  assert.deepEqual(serializeModelRoutingOperations(exact).slice(-2), [
    { kind: 'target.delete', targetRef: exactRef },
    { kind: 'model.delete', slug: 'solo' },
  ]);
  assert.deepEqual(inspectFixture(fixture, exact).errors, []);
});

test('撤销最近一次用户动作，一组改名操作会整体撤销', () => {
  const clean = createModelRoutingState(payload());
  const edited = updateModelDraft(clean, 'solo', { slug: 'solo-v2' });
  const undone = undoModelRoutingChange(edited);

  assert.notEqual(undone, edited);
  assert.equal(undone.models.some((model) => model.slug === 'solo'), true);
  assert.equal(undone.models.some((model) => model.slug === 'solo-v2'), false);
  assert.deepEqual(serializeModelRoutingOperations(undone), []);
  assert.equal(isModelRoutingDirty(undone), false);
});

test('新增后取消或删除该草稿回到 clean，关闭向导本身不污染', () => {
  const clean = createModelRoutingState(payload());
  assert.equal(isModelRoutingDirty(clean), false);

  let added = addModelDraft(clean, {
    slug: 'shared-temporary',
    display_name: 'Temporary',
    routing: { mode: 'reuse', targetRef: 'target:shared' },
  });
  added = updateModelDraft(added, 'shared-temporary', { display_name: 'Temporary 2' });
  const cancelled = removeModelDraft(added, 'shared-temporary');

  assert.equal(isModelRoutingDirty(cancelled), false);
  assert.deepEqual(serializeModelRoutingOperations(cancelled), []);
  assert.equal(cancelled.models.some((model) => model.slug === 'shared-temporary'), false);
});

test('取消新草稿前仍完整校验 remove options 与敏感字段', () => {
  const fixture = serverBackedFixture();
  fixture.config.targets[0].match = '^(?:solo|new-options-validation)$';
  const exposed = exposeModelRoutingState(
    fixture.catalog,
    fixture.config,
    fixture.configRevision,
    { SOLO_KEY: 'runtime-secret' },
  );
  fixture.payload = {
    configRevision: fixture.configRevision,
    catalogRevision: 'fixture-catalog-revision',
    ...exposed,
    errors: [],
    warnings: [],
  };
  const targetRef = fixture.payload.targets[0].targetRef;
  const added = addModelDraft(createModelRoutingState(fixture.payload), {
    slug: 'new-options-validation',
    display_name: 'New Options Validation',
    input_modalities: ['text'],
    routing: { mode: 'reuse', targetRef },
  });
  assert.throws(
    () => removeModelDraft(added, 'new-options-validation', { unexpected: true }),
    /options.*不允许/u,
  );
  assert.throws(
    () => removeModelDraft(added, 'new-options-validation', { targetRef: 42 }),
    /targetRef/u,
  );
  assert.throws(
    () => removeModelDraft(added, 'new-options-validation', {
      deleteTarget: false,
      auth: { token: 'SENTINEL-NEW-DRAFT-REMOVE' },
    }),
    /敏感/u,
  );
  assert.deepEqual(serializeModelRoutingOperations(added), [{
    kind: 'model.create',
    model: {
      slug: 'new-options-validation',
      display_name: 'New Options Validation',
      input_modalities: ['text'],
    },
  }]);
  assert.deepEqual(inspectFixture(fixture, added).errors, []);
});

test('序列化只返回双 revision 与隔离 operations，不泄露 UI 元数据或路径', () => {
  const state = updateModelDraft(createModelRoutingState(payload()), 'solo', { priority: 5 });
  const operations = serializeModelRoutingOperations(state);
  operations[0].patch.priority = 100;
  operations.push({ kind: 'model.delete', slug: 'shared-a' });

  assert.deepEqual(serializeModelRoutingOperations(state), [{
    kind: 'model.update', slug: 'solo', patch: { priority: 5 },
  }]);
  assert.doesNotMatch(JSON.stringify(serializeModelRoutingOperations(state)), /baseline|history|path/i);
});

test('非法结构与 throwing Proxy fail closed，getter 零调用且透明 Proxy 复制隔离', () => {
  const invalidPayloads = [
    null,
    {},
    { ...payload(), models: {} },
  ];
  const cyclic = payload();
  cyclic.self = cyclic;
  invalidPayloads.push(cyclic);
  const deep = payload();
  let cursor = deep;
  for (let index = 0; index < 40; index += 1) cursor = cursor.next = {};
  invalidPayloads.push(deep);
  invalidPayloads.push({ ...payload(), extra: Array.from({ length: 2_100 }, () => null) });
  let getterCalls = 0;
  const getter = payload();
  Object.defineProperty(getter, 'surprise', {
    enumerable: true,
    get() { getterCalls += 1; return 'must-not-run'; },
  });
  invalidPayloads.push(getter);
  invalidPayloads.push(new Proxy(payload(), {
    ownKeys() { throw new Error('proxy trap'); },
  }));

  for (const value of invalidPayloads) {
    assert.throws(() => createModelRoutingState(value), TypeError);
  }
  assert.equal(getterCalls, 0);

  let proxyReads = 0;
  const source = payload();
  const transparent = new Proxy(source, {
    ownKeys(target) { proxyReads += 1; return Reflect.ownKeys(target); },
  });
  const copied = createModelRoutingState(transparent);
  source.models[0].display_name = 'mutated after copy';
  assert.equal(copied.models[0].display_name, 'Shared A');
  assert.equal(proxyReads > 0, true);
});

test('draft、patch、options 和 payload 中的敏感字段全部拒绝', () => {
  const withSecret = payload();
  withSecret.targets[0].headers = { authorization: 'Bearer secret' };
  assert.throws(() => createModelRoutingState(withSecret), /敏感/u);

  const state = createModelRoutingState(payload());
  assert.throws(() => addModelDraft(state, {
    slug: 'unsafe',
    display_name: 'Unsafe',
    routing: { mode: 'dedicated', target: { name: 'unsafe', apiKey: 'secret' } },
  }), /敏感/u);
  assert.throws(
    () => updateModelDraft(state, 'solo', { auth: { token: 'secret' } }),
    /敏感/u,
  );
});

test('Key 家族敏感字段统一拒绝且普通 key 单词保留', () => {
  const sentinel = 'SENTINEL-BROWSER-KEY';
  for (const name of SERVER_SENSITIVE_FIELD_CORPUS) {
    const serverExposed = exposeModelRoutingState(
      { models: [{ slug: 'model-a', display_name: 'Model A', metadata: { [name]: sentinel } }] },
      { targets: [] },
      'classifier-parity-revision',
    );
    assert.doesNotMatch(JSON.stringify(serverExposed), /SENTINEL-BROWSER-KEY/);

    const hostile = payload();
    hostile.models[0].metadata = { [name]: sentinel };
    assert.throws(() => createModelRoutingState(hostile), /敏感/u);
    const state = createModelRoutingState(payload());
    assert.throws(() => updateModelDraft(state, 'solo', {
      experimental_supported_tools: [{ metadata: { [name]: sentinel } }],
    }), /敏感/u);
    assert.doesNotMatch(JSON.stringify(serializeModelRoutingOperations(state)), /SENTINEL-BROWSER-KEY/);
  }
  const safe = payload();
  safe.models[0].metadata = Object.fromEntries(
    SAFE_FIELD_CORPUS.map((name) => [name, `safe-${name}`]),
  );
  assert.deepEqual(
    createModelRoutingState(safe).models[0].metadata,
    Object.fromEntries(SAFE_FIELD_CORPUS.map((name) => [name, `safe-${name}`])),
  );
});

test('target 专用字段仅在直接路径放行，模型任意层级及 target 嵌套继续拒绝', () => {
  const sentinel = 'SENTINEL-PATH-SCOPED-BROWSER';
  for (const name of PATH_SCOPED_SENSITIVE_FIELD_CORPUS) {
    for (const placement of modelSensitivePlacements(name, sentinel)) {
      const serverExposed = exposeModelRoutingState(
        { models: [{ slug: 'model-a', display_name: 'Model A', ...placement }] },
        { targets: [] },
        'path-scope-parity-revision',
      );
      assert.doesNotMatch(JSON.stringify(serverExposed), /SENTINEL-PATH-SCOPED-BROWSER/);

      const hostile = payload();
      Object.assign(hostile.models[0], placement);
      assert.throws(() => createModelRoutingState(hostile), /敏感/u, name);

      const state = createModelRoutingState(payload());
      assert.throws(() => addModelDraft(state, {
        slug: 'path-scoped-new',
        display_name: 'Path Scoped New',
        ...placement,
      }), /敏感/u, name);
      assert.throws(
        () => updateModelDraft(state, 'solo', placement),
        /敏感/u,
        name,
      );
      assert.doesNotMatch(
        JSON.stringify(serializeModelRoutingOperations(state)),
        /SENTINEL-PATH-SCOPED-BROWSER/,
      );
    }
  }

  const directPayload = payload();
  Object.assign(directPayload.targets[0], {
    envKey: 'SHARED_KEY',
    authHeader: 'x-api-key',
    forwardHeaders: ['x-request-id'],
  });
  const directState = createModelRoutingState(directPayload);
  assert.equal(directState.targets[0].envKey, 'SHARED_KEY');
  assert.equal(directState.targets[0].authHeader, 'x-api-key');
  assert.deepEqual(directState.targets[0].forwardHeaders, ['x-request-id']);
  for (const [field, value] of [
    ['envKey', 'BAD-KEY'],
    ['authHeader', 'bad header'],
    ['forwardHeaders', ['bad header']],
  ]) {
    const invalidDirect = payload();
    invalidDirect.targets[0][field] = value;
    assert.throws(() => createModelRoutingState(invalidDirect), new RegExp(field, 'u'));
  }

  const dedicated = addModelDraft(createModelRoutingState(payload()), {
    slug: 'path-scoped-dedicated',
    display_name: 'Path Scoped Dedicated',
    routing: {
      mode: 'dedicated',
      target: {
        name: 'path-scoped-dedicated',
        host: 'dedicated.example',
        envKey: 'DEDICATED_KEY',
        authHeader: 'x-api-key',
        forwardHeaders: ['x-request-id'],
      },
    },
  });
  assert.deepEqual(
    serializeModelRoutingOperations(dedicated).find((operation) => operation.kind === 'target.create').target,
    {
      name: 'path-scoped-dedicated',
      host: 'dedicated.example',
      envKey: 'DEDICATED_KEY',
      authHeader: 'x-api-key',
      forwardHeaders: ['x-request-id'],
      match: '^path-scoped-dedicated$',
    },
  );

  for (const [field, nested] of [
    ['envKey', { envKey: sentinel }],
    ['authHeader', { authHeader: sentinel }],
    ['forwardHeaders', [{ forwardHeaders: sentinel }]],
  ]) {
    const nestedPayload = payload();
    nestedPayload.targets[0][field] = nested;
    assert.throws(() => createModelRoutingState(nestedPayload), /敏感/u, field);
    assert.throws(() => addModelDraft(createModelRoutingState(payload()), {
      slug: `nested-${field.toLowerCase()}`,
      display_name: 'Nested Target Field',
      routing: {
        mode: 'dedicated',
        target: {
          name: `nested-${field.toLowerCase()}`,
          host: 'nested.example',
          envKey: 'NESTED_KEY',
          [field]: nested,
        },
      },
    }), /敏感/u, field);
  }
});

test('slug 必须非空且唯一，复用只校验不透明引用而不在浏览器执行服务端正则', () => {
  const state = createModelRoutingState(payload());
  assert.throws(() => addModelDraft(state, { slug: ' ', display_name: 'Blank' }), /slug/u);
  assert.throws(() => addModelDraft(state, { slug: 'solo', display_name: 'Duplicate' }), /存在|重复/u);
  const unmatched = addModelDraft(state, {
    slug: 'unmatched',
    display_name: 'Unmatched',
    routing: { mode: 'reuse', targetRef: 'target:shared' },
  });
  assert.deepEqual(serializeModelRoutingOperations(unmatched), [{
    kind: 'model.create',
    model: { slug: 'unmatched', display_name: 'Unmatched' },
  }]);
  assert.throws(() => addModelDraft(state, {
    slug: 'shared-new',
    display_name: 'Missing ref',
    routing: { mode: 'reuse', targetRef: 'target:missing' },
  }), /targetRef/u);
});

test('管理端通过两个 URL 提供浏览器状态模块并返回 JavaScript 类型', async (t) => {
  const handler = createAdminHandler({ webRoot: new URL('../web', import.meta.url).pathname.slice(1) });
  const server = http.createServer((req, res) => handler(req, res).then((handled) => {
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (const assetPath of ['/admin/model-routing-state.mjs', '/_admin/model-routing-state.mjs']) {
    const response = await request(server, assetPath);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /(?:text|application)\/javascript/);
    assert.match(response.text, /export function createModelRoutingState/);
  }
});
