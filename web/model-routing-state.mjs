const MAX_TREE_DEPTH = 32;
const MAX_TREE_NODES = 2_048;
const MAX_STRING_LENGTH = 65_536;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const MODEL_FIELDS = new Set([
  'slug',
  'display_name',
  'description',
  'visibility',
  'supported_in_api',
  'priority',
  'input_modalities',
  'default_reasoning_level',
  'supported_reasoning_levels',
  'shell_type',
  'support_verbosity',
  'truncation_policy',
  'supports_parallel_tool_calls',
  'experimental_supported_tools',
  'base_instructions',
  'context_window',
  'max_context_window',
  'effective_context_window_percent',
  'auto_compact_token_limit',
]);

const TARGET_FIELDS = new Set([
  'name',
  'match',
  'platform',
  'host',
  'protocol',
  'port',
  'prefix',
  'chatPath',
  'upstreamModel',
  'envKey',
  'wireApi',
  'apiFormat',
  'viaProxy',
  'vision',
  'useOpenAiAuth',
  'stateDomain',
  'maxResponseBytes',
  'authType',
  'authHeader',
  'forwardHeaders',
]);
const PAYLOAD_TARGET_FIELDS = new Set([...TARGET_FIELDS, 'targetRef', 'envSet']);
const TARGET_PATCH_FIELDS = new Set([...TARGET_FIELDS].filter((field) => field !== 'match'));
const TARGET_DIRECT_SENSITIVE_FIELDS = new Set(['envKey', 'authHeader', 'forwardHeaders']);
const SAFE_KEY_WORDS = new Set(['keyboard', 'monkey', 'keynote', 'tokenizer']);
const SENSITIVE_NAMES = new Set([
  'api',
  'auth',
  'authheader',
  'authorization',
  'bearer',
  'headers',
  'oauth',
  'cookies',
  'secrets',
  'credentials',
  'secret',
  'token',
  'password',
  'credential',
  'cookie',
  'envkey',
  'forwardheaders',
]);
const SENSITIVE_FRAGMENTS = [
  'authorization',
  'secret',
  'password',
  'credential',
  'cookie',
];

// WeakMap 只保存模块自己建立的可信快照，调用方无法伪造 history 或 operation。
const INTERNAL = new WeakMap();
let nextDraftId = 1;

function normalizedField(field) {
  return field.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sensitiveField(field) {
  const normalized = normalizedField(field);
  if (SAFE_KEY_WORDS.has(normalized)) return false;
  return SENSITIVE_NAMES.has(normalized)
    || SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment))
    || normalized.startsWith('key')
    || normalized.endsWith('key')
    || /^(?:access|refresh|auth|api|bearer|id|client|session|oauth)token(?:value|hash)?$/.test(normalized);
}

function invalid(message, code = 'model_routing_state_invalid') {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

/**
 * 不调用 data object getter 的有界 JSON 快照。公开输入契约要求 JSON.parse 或表单
 * 建立的普通 data object；throwing Proxy 会 fail closed。标准 JavaScript 无法在零 trap
 * 条件下识别透明 Proxy，因此透明 Proxy 只保证输出复制隔离，不保证读取时零副作用。
 */
function strictClone(
  value,
  label = '输入',
  state = { nodes: 0, seen: new WeakSet() },
  depth = 0,
  options = {},
) {
  const path = options.path ?? [];
  if (depth > MAX_TREE_DEPTH || state.nodes >= MAX_TREE_NODES) {
    throw invalid(`${label} 嵌套或节点数量超出限制`);
  }
  state.nodes += 1;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw invalid(`${label} 字符串超出限制`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${label} 含非有限数`);
    return value;
  }
  if (typeof value !== 'object') throw invalid(`${label} 必须是安全 JSON 值`);
  if (state.seen.has(value)) throw invalid(`${label} 含循环引用`);
  state.seen.add(value);

  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype) {
      throw invalid(`${label} 含非普通对象`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) throw invalid(`${label} 含 Symbol 字段`);
    const dataKeys = keys.filter((key) => !(array && key === 'length'));
    if (dataKeys.length > MAX_TREE_NODES - state.nodes) {
      throw invalid(`${label} 节点数量超出限制`);
    }
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_TREE_NODES) {
        throw invalid(`${label} 数组长度无效`);
      }
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get || descriptor.set) {
          throw invalid(`${label} 含空洞或访问器`);
        }
        result.push(strictClone(descriptor.value, label, state, depth + 1, {
          ...options,
          path: [...path, String(index)],
        }));
      }
      if (dataKeys.some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) {
        throw invalid(`${label} 数组含额外字段`);
      }
      return result;
    }

    const result = {};
    for (const key of dataKeys) {
      const allowedDirectTargetField = TARGET_DIRECT_SENSITIVE_FIELDS.has(key)
        && options.allowDirectTargetField?.(path, key) === true;
      if (sensitiveField(key) && !allowedDirectTargetField) {
        throw invalid(`${label} 含敏感字段：${key}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) throw invalid(`${label} 含访问器字段`);
      result[key] = strictClone(descriptor.value, label, state, depth + 1, {
        ...options,
        path: [...path, key],
      });
    }
    return result;
  } catch (error) {
    if (error?.code === 'model_routing_state_invalid') throw error;
    throw invalid(`${label} 无法安全读取`);
  } finally {
    state.seen.delete(value);
  }
}

function strictSnapshot(value, label, allowDirectTargetField) {
  return strictClone(value, label, undefined, 0, { allowDirectTargetField, path: [] });
}

function clone(value) {
  return strictClone(value, 'state');
}

function payloadTargetField(path) {
  return path.length === 2 && path[0] === 'targets' && /^(?:0|[1-9]\d*)$/.test(path[1]);
}

function draftTargetField(path) {
  return (path.length === 1 && path[0] === 'target')
    || (path.length === 2 && path[0] === 'routing' && path[1] === 'target');
}

function updateTargetField(path) {
  return path.length === 2 && path[0] === 'routing' && path[1] === 'patch';
}

function rootTargetField(path) {
  return path.length === 0;
}

function clonePayload(value) {
  return strictSnapshot(value, 'state', payloadTargetField);
}

function cloneTarget(value) {
  return strictSnapshot(value, 'state', rootTargetField);
}

function operationTargetKey(operation) {
  return operation?.kind === 'target.create'
    ? 'target'
    : operation?.kind === 'target.update' ? 'patch' : null;
}

function cloneOperation(operation) {
  const targetKey = operationTargetKey(operation);
  return strictSnapshot(
    operation,
    'state',
    (path) => targetKey !== null && path.length === 1 && path[0] === targetKey,
  );
}

function cloneOperations(operations) {
  return strictSnapshot(
    operations,
    'state',
    (path) => {
      if (path.length !== 2) return false;
      const index = Number(path[0]);
      return Number.isSafeInteger(index)
        && path[1] === operationTargetKey(operations[index]);
    },
  );
}

function cloneGroups(groups) {
  return strictSnapshot(
    groups,
    'state',
    (path) => {
      if (path.length === 2 && path[1] === 'createdTargetPatch') return true;
      if (path.length !== 4 || path[1] !== 'operations') return false;
      const groupIndex = Number(path[0]);
      const operationIndex = Number(path[2]);
      const operation = groups[groupIndex]?.operations?.[operationIndex];
      return Number.isSafeInteger(groupIndex)
        && Number.isSafeInteger(operationIndex)
        && path[3] === operationTargetKey(operation);
    },
  );
}

function validSlug(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.length <= 256
    && !CONTROL_CHARACTERS.test(value);
}

function requireSlug(value, label = 'slug') {
  if (!validSlug(value)) throw invalid(`${label} 必须是安全的非空字符串`);
  return value;
}

function onlyFields(value, fields, label) {
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw invalid(`${label} 含不允许字段：${field}`);
  }
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]),
  );
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactMatch(slug) {
  return `^${escapeRegex(slug)}$`;
}

function internal(state) {
  const value = INTERNAL.get(state);
  if (!value) throw invalid('模型路由 state 无效');
  return value;
}

function projectedRecords(meta) {
  const records = meta.baseline.models.map((model, index) => ({
    id: `baseline:${index}`,
    baselineSlug: model.slug,
    model: clone(model),
  }));
  for (const group of meta.groups) {
    for (const operation of group.operations) {
      if (operation.kind === 'model.create') {
        records.push({
          id: group.entityId,
          baselineSlug: null,
          model: clone(operation.model),
        });
      } else if (operation.kind === 'model.update') {
        const record = records.find((item) => item.model.slug === operation.slug);
        if (record) record.model = { ...record.model, ...clone(operation.patch) };
      } else if (operation.kind === 'model.delete') {
        const index = records.findIndex((item) => item.model.slug === operation.slug);
        if (index >= 0) records.splice(index, 1);
      }
    }
    if (group.createdModelPatch) {
      const record = records.find((item) => item.id === group.entityId);
      if (record) record.model = { ...record.model, ...clone(group.createdModelPatch) };
    }
  }
  return records;
}

function flattenOperations(groups) {
  const operations = [];
  const createdModelIndexes = new Map();
  const createdTargetIndexes = new Map();
  for (const group of groups) {
    for (const operation of group.operations) {
      operations.push(cloneOperation(operation));
      if (operation.kind === 'model.create') {
        createdModelIndexes.set(group.entityId, operations.length - 1);
      }
      if (operation.kind === 'target.create') {
        createdTargetIndexes.set(group.entityId, operations.length - 1);
      }
    }
    if (group.createdModelPatch) {
      const index = createdModelIndexes.get(group.entityId);
      const model = index === undefined ? null : operations[index]?.model;
      if (model) Object.assign(model, clone(group.createdModelPatch));
    }
    if (group.createdTargetPatch) {
      const index = createdTargetIndexes.get(group.entityId);
      const target = index === undefined ? null : operations[index]?.target;
      if (target) Object.assign(target, cloneTarget(group.createdTargetPatch));
    }
  }
  return operations;
}

function projectedTargets(meta) {
  const targets = meta.baseline.targets.map((target) => cloneTarget(target));
  for (const group of meta.groups) {
    for (const operation of group.operations) {
      if (operation.kind === 'target.create') {
        // 草稿 target 尚未写入文件，使用仅限浏览器状态的引用供界面关联；序列化时不会带出。
        targets.push({
          ...cloneTarget(operation.target),
          targetRef: draftTargetRef(group.entityId),
          envSet: false,
        });
      } else if (operation.kind === 'target.update') {
        const target = targets.find((item) => item.targetRef === operation.targetRef);
        if (target) Object.assign(target, cloneTarget(operation.patch));
      } else if (operation.kind === 'target.delete') {
        const index = targets.findIndex((item) => item.targetRef === operation.targetRef);
        if (index >= 0) targets.splice(index, 1);
      }
    }
    if (group.createdTargetPatch) {
      const target = targets.find((item) => item.targetRef === draftTargetRef(group.entityId));
      if (target) Object.assign(target, cloneTarget(group.createdTargetPatch));
    }
  }
  return targets;
}

/** 返回草稿专属 target 的临时引用；该引用绝不会提交给管理 API。 */
function draftTargetRef(entityId) {
  return `draft-target:${entityId}`;
}

/** 将待保存的模型操作投影为界面可读的绑定关系，避免卡片误报“未绑定通道”。 */
function projectedBindings(meta, targets) {
  const existingRefs = new Set(targets.map((target) => target.targetRef));
  return projectedRecords(meta).map((record) => {
    if (record.baselineSlug !== null) {
      const binding = meta.baseline.bindings.find((item) => item.slug === record.baselineSlug);
      return {
        slug: record.model.slug,
        targetRefs: (binding?.targetRefs ?? []).filter((targetRef) => existingRefs.has(targetRef)),
      };
    }
    const group = addGroupForRecord(meta, record);
    const created = group?.operations.some((operation) => operation.kind === 'target.create');
    const targetRef = created ? draftTargetRef(record.id) : group?.reuseTargetRef;
    return {
      slug: record.model.slug,
      targetRefs: targetRef && existingRefs.has(targetRef) ? [targetRef] : [],
    };
  });
}

function build(meta) {
  const baseline = clonePayload(meta.baseline);
  const models = projectedRecords(meta).map((record) => clone(record.model));
  const targets = projectedTargets(meta);
  const bindings = projectedBindings(meta, targets);
  const operations = flattenOperations(meta.groups);
  const state = {
    ...clonePayload(baseline),
    models,
    targets,
    bindings,
    operations: cloneOperations(operations),
    baseline: clonePayload(baseline),
  };
  INTERNAL.set(state, {
    baseline: clonePayload(baseline),
    groups: cloneGroups(meta.groups),
  });
  return state;
}

function assertPayload(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw invalid('管理 API 模型路由响应无效');
  }
  if (typeof snapshot.configRevision !== 'string' || snapshot.configRevision === '') {
    throw invalid('管理 API 响应缺少 configRevision');
  }
  if (typeof snapshot.catalogRevision !== 'string' || snapshot.catalogRevision === '') {
    throw invalid('管理 API 响应缺少 catalogRevision');
  }
  if (!Array.isArray(snapshot.models) || !Array.isArray(snapshot.targets) || !Array.isArray(snapshot.bindings)) {
    throw invalid('管理 API 响应缺少 models、targets 或 bindings');
  }
  if (!snapshot.references || typeof snapshot.references !== 'object' || Array.isArray(snapshot.references)) {
    throw invalid('管理 API 响应缺少 references');
  }
  for (const model of snapshot.models) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      throw invalid('管理 API models 必须是普通对象数组');
    }
    requireSlug(model.slug);
  }
  const slugs = new Set(snapshot.models.map((model) => model.slug));
  if (slugs.size !== snapshot.models.length) throw invalid('管理 API models 含重复 slug');
  for (const target of snapshot.targets) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw invalid('管理 API targets 必须是普通对象数组');
    }
    if (!Object.hasOwn(target, 'targetRef') || !Object.hasOwn(target, 'envSet')) {
      throw invalid('管理 API target 缺少 targetRef 或 envSet');
    }
    if (target.targetRef !== null && typeof target.targetRef !== 'string') {
      throw invalid('管理 API targetRef 无效');
    }
    if (typeof target.envSet !== 'boolean') throw invalid('管理 API envSet 无效');
    onlyFields(target, PAYLOAD_TARGET_FIELDS, '管理 API target');
    validateTargetDirectFields(target, '管理 API target');
  }
  for (const binding of snapshot.bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || !validSlug(binding.slug)
      || !Array.isArray(binding.targetRefs)
      || binding.targetRefs.some((ref) => typeof ref !== 'string')) {
      throw invalid('管理 API bindings 无效');
    }
  }
}

/** 从 GET model-routing 的安全视图创建隔离的联合编辑状态。 */
export function createModelRoutingState(payload) {
  let snapshot;
  try {
    snapshot = strictSnapshot(payload, '管理 API 响应', payloadTargetField);
  } catch (error) {
    throw error instanceof TypeError ? error : invalid('管理 API 模型路由响应无效');
  }
  assertPayload(snapshot);
  return build({ baseline: snapshot, groups: [] });
}

function modelAndRouting(draft) {
  const snapshot = strictSnapshot(draft, 'draft', draftTargetField);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw invalid('draft 必须是普通对象');
  }
  let model;
  if (Object.hasOwn(snapshot, 'model')) {
    const allowed = new Set(['model', 'routing', 'target', 'targetRef']);
    onlyFields(snapshot, allowed, 'draft');
    model = snapshot.model;
  } else {
    model = Object.fromEntries(Object.entries(snapshot).filter(
      ([key]) => !['routing', 'target', 'targetRef'].includes(key),
    ));
  }
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw invalid('draft.model 必须是普通对象');
  }
  onlyFields(model, MODEL_FIELDS, 'draft.model');
  requireSlug(model.slug);
  const routing = snapshot.routing ?? (
    snapshot.target ? { mode: 'dedicated', target: snapshot.target }
      : snapshot.targetRef ? { mode: 'reuse', targetRef: snapshot.targetRef }
        : null
  );
  if (routing !== null && (typeof routing !== 'object' || Array.isArray(routing))) {
    throw invalid('draft.routing 必须是普通对象');
  }
  return { model, routing };
}

function targetByRef(meta, targetRef) {
  return meta.baseline.targets.find((target) => target.targetRef === targetRef);
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateTargetDirectFields(target, label) {
  if (Object.hasOwn(target, 'envKey')
    && (typeof target.envKey !== 'string' || !ENV_NAME.test(target.envKey))) {
    throw invalid(`${label}.envKey 必须是合法环境变量名`);
  }
  if (Object.hasOwn(target, 'authHeader')
    && (typeof target.authHeader !== 'string' || !HEADER_NAME.test(target.authHeader))) {
    throw invalid(`${label}.authHeader 必须是合法 header 名称`);
  }
  if (Object.hasOwn(target, 'forwardHeaders')
    && (!Array.isArray(target.forwardHeaders)
      || target.forwardHeaders.some((name) => typeof name !== 'string' || !HEADER_NAME.test(name)))) {
    throw invalid(`${label}.forwardHeaders 必须是合法 header 名称数组`);
  }
}

function requireTargetString(target, field, label, options = {}) {
  if (!Object.hasOwn(target, field)) {
    if (options.required) throw invalid(`${label}.${field} 必须是非空字符串`);
    return;
  }
  const value = target[field];
  if (typeof value !== 'string'
    || (!options.allowEmpty && value.trim() === '')
    || CONTROL_CHARACTERS.test(value)) {
    throw invalid(`${label}.${field} 必须是安全字符串`);
  }
}

function validateTargetFields(source, label, options = {}) {
  const target = cloneTarget(source);
  requireTargetString(target, 'name', label, { required: options.requireCore === true });
  requireTargetString(target, 'host', label, { required: options.requireCore === true });
  for (const field of ['platform', 'upstreamModel', 'stateDomain']) {
    requireTargetString(target, field, label);
  }
  if (Object.hasOwn(target, 'protocol') && !['http', 'https'].includes(target.protocol)) {
    throw invalid(`${label}.protocol 必须是 http 或 https`);
  }
  if (Object.hasOwn(target, 'port')) {
    const port = typeof target.port === 'string' && /^\d+$/.test(target.port)
      ? Number(target.port)
      : target.port;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw invalid(`${label}.port 必须是 1..65535 的十进制整数`);
    }
  }
  if (Object.hasOwn(target, 'prefix')
    && (typeof target.prefix !== 'string'
      || (target.prefix !== '' && !target.prefix.startsWith('/'))
      || /[\r\n]/.test(target.prefix))) {
    throw invalid(`${label}.prefix 必须为空或以 / 开头`);
  }
  if (Object.hasOwn(target, 'chatPath')
    && (typeof target.chatPath !== 'string'
      || !target.chatPath.startsWith('/')
      || /[\r\n]/.test(target.chatPath))) {
    throw invalid(`${label}.chatPath 必须是以 / 开头的非空路径`);
  }
  for (const field of ['wireApi', 'apiFormat']) {
    if (Object.hasOwn(target, field) && !['chat', 'responses'].includes(target[field])) {
      throw invalid(`${label}.${field} 必须是 chat 或 responses`);
    }
  }
  for (const field of ['viaProxy', 'vision', 'useOpenAiAuth']) {
    if (Object.hasOwn(target, field) && typeof target[field] !== 'boolean') {
      throw invalid(`${label}.${field} 必须是 boolean`);
    }
  }
  if (Object.hasOwn(target, 'maxResponseBytes')
    && (!Number.isSafeInteger(target.maxResponseBytes) || target.maxResponseBytes < 1)) {
    throw invalid(`${label}.maxResponseBytes 必须是正整数`);
  }
  if (Object.hasOwn(target, 'authType')
    && !['bearer', 'x-api-key', 'header'].includes(target.authType)) {
    throw invalid(`${label}.authType 枚举无效`);
  }
  validateTargetDirectFields(target, label);

  const effective = { ...(options.base ?? {}), ...target };
  if (typeof effective.wireApi === 'string' && typeof effective.apiFormat === 'string'
    && effective.wireApi !== effective.apiFormat) {
    throw invalid(`${label} wireApi 与 apiFormat 必须一致`);
  }
  if (effective.useOpenAiAuth === true) {
    for (const field of ['envKey', 'authType', 'authHeader']) {
      if (effective[field] !== undefined && effective[field] !== null) {
        throw invalid(`${label}.${field} 不能与 useOpenAiAuth 同时设置`);
      }
    }
  } else if ((options.requireEnv === true || Object.hasOwn(target, 'useOpenAiAuth'))
    && (typeof effective.envKey !== 'string' || !ENV_NAME.test(effective.envKey))) {
    throw invalid(`${label}.envKey 必须是合法环境变量名`);
  }

  if (options.slug !== undefined) {
    const expectedMatch = exactMatch(options.slug);
    if (!Object.hasOwn(target, 'match')) {
      target.match = expectedMatch;
    } else if (typeof target.match !== 'string' || target.match !== expectedMatch) {
      throw invalid(`${label}.match 必须是当前 slug 的精确正则`);
    }
  }
  return target;
}

function validateDedicatedTarget(source, slug) {
  return validateTargetFields(source, 'draft.routing.target', {
    requireCore: true,
    requireEnv: true,
    slug,
  });
}

function validateTargetPatch(source, base) {
  const patch = cloneTarget(source);
  onlyFields(patch, TARGET_PATCH_FIELDS, 'patch.routing.patch');
  return validateTargetFields(patch, 'patch.routing.patch', { base });
}

/** 新增目录草稿；routing 可省略、复用 targetRef，或创建一个安全专属 target。 */
export function addModelDraft(state, draft) {
  const meta = internal(state);
  const { model, routing } = modelAndRouting(draft);
  const records = projectedRecords(meta);
  if (records.some((record) => record.model.slug === model.slug)) {
    throw invalid(`模型 slug 已存在：${model.slug}`);
  }

  const operations = [{ kind: 'model.create', model: clone(model) }];
  let reuseTargetRef = null;
  if (routing) {
    const mode = routing.mode ?? routing.type;
    if (mode === 'reuse' || Object.hasOwn(routing, 'targetRef')) {
      onlyFields(routing, new Set(['mode', 'type', 'targetRef']), 'draft.routing');
      if (typeof routing.targetRef !== 'string' || routing.targetRef === '') {
        throw invalid('复用通道必须提供 targetRef');
      }
      if (!targetByRef(meta, routing.targetRef)) throw invalid('复用的 targetRef 不存在');
      reuseTargetRef = routing.targetRef;
    } else if (mode === 'dedicated' || mode === 'create' || Object.hasOwn(routing, 'target')) {
      onlyFields(routing, new Set(['mode', 'type', 'target']), 'draft.routing');
      if (!routing.target || typeof routing.target !== 'object' || Array.isArray(routing.target)) {
        throw invalid('专属通道 target 必须是普通对象');
      }
      onlyFields(routing.target, TARGET_FIELDS, 'draft.routing.target');
      const target = validateDedicatedTarget(routing.target, model.slug);
      operations.push({ kind: 'target.create', target });
    } else {
      throw invalid('draft.routing mode 无效');
    }
  }

  return build({
    baseline: meta.baseline,
    groups: [...meta.groups, {
      entityId: `draft:${nextDraftId++}`,
      operations,
      ...(reuseTargetRef ? { reuseTargetRef } : {}),
    }],
  });
}

function modelUpdateParts(patch) {
  const snapshot = strictSnapshot(patch, 'patch', updateTargetField);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw invalid('patch 必须是普通对象');
  }
  const structured = Object.hasOwn(snapshot, 'model') || Object.hasOwn(snapshot, 'routing');
  if (!structured) {
    onlyFields(snapshot, MODEL_FIELDS, 'patch');
    return { modelPatch: snapshot, routing: null };
  }
  onlyFields(snapshot, new Set(['model', 'routing']), 'patch');
  const modelPatch = snapshot.model ?? {};
  if (!modelPatch || typeof modelPatch !== 'object' || Array.isArray(modelPatch)) {
    throw invalid('patch.model 必须是普通对象');
  }
  onlyFields(modelPatch, MODEL_FIELDS, 'patch.model');
  if (snapshot.routing === undefined) return { modelPatch, routing: null };
  const routing = snapshot.routing;
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    throw invalid('patch.routing 必须是普通对象');
  }
  onlyFields(routing, new Set(['targetRef', 'patch']), 'patch.routing');
  if (!routing.patch || typeof routing.patch !== 'object' || Array.isArray(routing.patch)) {
    throw invalid('patch.routing.patch 必须是普通对象');
  }
  onlyFields(routing.patch, TARGET_PATCH_FIELDS, 'patch.routing.patch');
  if (Object.hasOwn(routing, 'targetRef')
    && (typeof routing.targetRef !== 'string' || routing.targetRef === '')) {
    throw invalid('patch.routing.targetRef 必须是非空字符串');
  }
  return { modelPatch, routing };
}

function createdTargetForEntity(meta, entityId) {
  let target = null;
  for (const group of meta.groups) {
    if (group.entityId !== entityId) continue;
    const created = group.operations.find((operation) => operation.kind === 'target.create');
    if (created) target = cloneTarget(created.target);
    if (target && group.createdTargetPatch) {
      Object.assign(target, cloneTarget(group.createdTargetPatch));
    }
  }
  return target;
}

function addGroupForRecord(meta, record) {
  return meta.groups.find((group) => (
    group.entityId === record.id
    && group.operations.some((operation) => operation.kind === 'model.create')
  ));
}

function routingAssociation(meta, record, routing) {
  if (!routing) return null;
  if (record.baselineSlug === null) {
    const createdTarget = createdTargetForEntity(meta, record.id);
    if (createdTarget) {
      if (Object.hasOwn(routing, 'targetRef')) {
        throw invalid('新建 dedicated 草稿编辑 target 时不能提供 targetRef');
      }
      return { created: true, target: createdTarget, targetRef: null };
    }
    const addGroup = addGroupForRecord(meta, record);
    if (!routing.targetRef || routing.targetRef !== addGroup?.reuseTargetRef) {
      throw invalid('复用或共享 target 编辑必须提供原 targetRef');
    }
    const target = projectedTargets(meta).find((item) => item.targetRef === routing.targetRef);
    if (!target) throw invalid('patch.routing.targetRef 已失效或不存在');
    return { created: false, target, targetRef: routing.targetRef };
  }

  if (!routing.targetRef) throw invalid('关联 target 编辑必须显式提供 targetRef');
  const target = projectedTargets(meta).find((item) => item.targetRef === routing.targetRef);
  if (!target) throw invalid('patch.routing.targetRef 已失效或不存在');
  const binding = meta.baseline.bindings.find((item) => item.slug === record.baselineSlug);
  if (!binding?.targetRefs.includes(routing.targetRef)) {
    throw invalid('patch.routing.targetRef 未绑定当前模型');
  }
  return { created: false, target, targetRef: routing.targetRef };
}

function changedFields(current, patch) {
  return Object.fromEntries(Object.entries(patch).filter(
    ([field, value]) => !sameValue(current?.[field], value),
  ));
}

/** 按当前 slug 更新模型及其显式关联 target；旧 flat model patch 继续兼容。 */
export function updateModelDraft(state, slug, patch) {
  const meta = internal(state);
  requireSlug(slug);
  const { modelPatch, routing } = modelUpdateParts(patch);
  const records = projectedRecords(meta);
  const record = records.find((item) => item.model.slug === slug);
  if (!record) throw invalid(`模型不存在：${slug}`);

  const effectiveModelPatch = changedFields(record.model, modelPatch);
  if (Object.hasOwn(effectiveModelPatch, 'slug')) {
    requireSlug(effectiveModelPatch.slug, 'patch.slug');
    if (records.some((item) => item.id !== record.id && item.model.slug === effectiveModelPatch.slug)) {
      throw invalid(`模型 slug 已存在：${effectiveModelPatch.slug}`);
    }
  }

  const association = routingAssociation(meta, record, routing);
  const validatedTargetPatch = routing
    ? validateTargetPatch(routing.patch, association.target)
    : {};
  const effectiveTargetPatch = association
    ? changedFields(association.target, validatedTargetPatch)
    : {};
  if (Object.keys(effectiveModelPatch).length === 0
    && Object.keys(effectiveTargetPatch).length === 0) {
    return build({ baseline: meta.baseline, groups: meta.groups });
  }

  const operations = [];
  const createdModelPatch = record.baselineSlug === null ? effectiveModelPatch : null;
  if (record.baselineSlug !== null && Object.keys(effectiveModelPatch).length > 0) {
    operations.push({ kind: 'model.update', slug, patch: effectiveModelPatch });
  }
  let createdTargetPatch = association?.created ? effectiveTargetPatch : null;
  if (association && !association.created && Object.keys(effectiveTargetPatch).length > 0) {
    operations.push({
      kind: 'target.update',
      targetRef: association.targetRef,
      patch: effectiveTargetPatch,
    });
  }

  if (Object.hasOwn(effectiveModelPatch, 'slug')) {
    const nextSlug = effectiveModelPatch.slug;
    const createdTarget = record.baselineSlug === null
      ? createdTargetForEntity(meta, record.id)
      : null;
    if (createdTarget) {
      createdTargetPatch = { ...(createdTargetPatch ?? {}), match: exactMatch(nextSlug) };
    } else if (record.baselineSlug !== null) {
      const binding = meta.baseline.bindings.find((item) => item.slug === record.baselineSlug);
      const targets = projectedTargets(meta);
      for (const targetRef of binding?.targetRefs ?? []) {
        const target = targets.find((item) => item.targetRef === targetRef);
        if (target?.match !== exactMatch(slug)) continue;
        const existing = operations.find(
          (operation) => operation.kind === 'target.update' && operation.targetRef === targetRef,
        );
        if (existing) existing.patch = { ...existing.patch, match: exactMatch(nextSlug) };
        else operations.push({
          kind: 'target.update',
          targetRef,
          patch: { match: exactMatch(nextSlug) },
        });
      }
    }
    if (record.baselineSlug !== null) {
      operations.push({ kind: 'reference.replaceSlug', from: slug, to: nextSlug });
    }
  }

  return build({
    baseline: meta.baseline,
    groups: [...meta.groups, {
      entityId: record.id,
      operations,
      ...(createdTargetPatch && Object.keys(createdTargetPatch).length > 0
        ? { createdTargetPatch }
        : {}),
      ...(createdModelPatch && Object.keys(createdModelPatch).length > 0
        ? { createdModelPatch }
        : {}),
    }],
  });
}

function deleteTargetOption(options) {
  const snapshot = options === undefined ? {} : strictSnapshot(options, 'options');
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw invalid('options 必须是普通对象');
  }
  onlyFields(snapshot, new Set([
    'deleteDedicatedTarget',
    'deleteTarget',
    'removeTarget',
    'targetRef',
    'deleteTargetRef',
    'dedicatedTargetRef',
  ]), 'options');
  for (const field of ['deleteDedicatedTarget', 'removeTarget']) {
    if (Object.hasOwn(snapshot, field) && typeof snapshot[field] !== 'boolean') {
      throw invalid(`options.${field} 必须是 boolean`);
    }
  }
  if (Object.hasOwn(snapshot, 'deleteTarget')
    && typeof snapshot.deleteTarget !== 'boolean'
    && (typeof snapshot.deleteTarget !== 'string' || snapshot.deleteTarget === '')) {
    throw invalid('options.deleteTarget 必须是 boolean 或非空 targetRef');
  }
  for (const field of ['targetRef', 'deleteTargetRef', 'dedicatedTargetRef']) {
    if (Object.hasOwn(snapshot, field)
      && (typeof snapshot[field] !== 'string' || snapshot[field] === '')) {
      throw invalid(`options.${field} 必须是非空字符串`);
    }
  }
  const deleteTarget = snapshot.deleteDedicatedTarget === true
    || snapshot.deleteTarget === true
    || typeof snapshot.deleteTarget === 'string'
    || snapshot.removeTarget === true;
  const targetRef = snapshot.targetRef
    ?? snapshot.deleteTargetRef
    ?? snapshot.dedicatedTargetRef
    ?? (typeof snapshot.deleteTarget === 'string' ? snapshot.deleteTarget : null);
  return { deleteTarget, targetRef };
}

function dedicatedRefs(meta, record) {
  if (record.baselineSlug === null) return [];
  const binding = meta.baseline.bindings.find((item) => item.slug === record.baselineSlug);
  if (!binding) return [];
  const targets = projectedTargets(meta);
  return binding.targetRefs.filter((targetRef) => {
    const owners = meta.baseline.bindings.filter((item) => item.targetRefs.includes(targetRef));
    const target = targets.find((item) => item.targetRef === targetRef);
    return owners.length === 1
      && owners[0].slug === record.baselineSlug
      && target?.match === exactMatch(record.model.slug);
  });
}

/** 删除已有模型，或取消尚未保存的新建模型。共享通道从不默认删除。 */
export function removeModelDraft(state, slug, options) {
  const meta = internal(state);
  requireSlug(slug);
  const records = projectedRecords(meta);
  const record = records.find((item) => item.model.slug === slug);
  if (!record) throw invalid(`模型不存在：${slug}`);
  const requested = deleteTargetOption(options);

  // 新建模型的所有动作均以 entityId 关联，取消时整条草稿链一起移除。
  if (record.baselineSlug === null) {
    return build({
      baseline: meta.baseline,
      groups: meta.groups.filter((group) => group.entityId !== record.id),
    });
  }

  const operations = [{ kind: 'reference.removeSlug', slug }];
  if (requested.deleteTarget) {
    const dedicated = dedicatedRefs(meta, record);
    const targetRef = requested.targetRef ?? (dedicated.length === 1 ? dedicated[0] : null);
    if (!targetRef || !dedicated.includes(targetRef)) {
      throw invalid(
        '只能删除当前模型唯一拥有的精确专属通道',
        'target_not_dedicated',
      );
    }
    operations.push({ kind: 'target.delete', targetRef });
  }
  operations.push({ kind: 'model.delete', slug });
  return build({
    baseline: meta.baseline,
    groups: [...meta.groups, { entityId: record.id, operations }],
  });
}

/** 撤销最近一次用户动作；一个动作中的多个实体操作会整体撤销。 */
export function undoModelRoutingChange(state) {
  const meta = internal(state);
  return build({ baseline: meta.baseline, groups: meta.groups.slice(0, -1) });
}

/** dirty 只取决于用户动作组，不遍历可能被调用方修改的公开对象。 */
export function isModelRoutingDirty(state) {
  return internal(state).groups.length > 0;
}

/** 判断 targetRef 是否来自已保存基线，草稿专属通道的临时引用不可被复用或回传给 API。 */
export function isPersistedModelRoutingTarget(state, targetRef) {
  if (typeof targetRef !== 'string' || targetRef === '') return false;
  return internal(state).baseline.targets.some((target) => target.targetRef === targetRef);
}

/** 返回可直接交给 model-routing API 的隔离 operations 数组。 */
export function serializeModelRoutingOperations(state) {
  return flattenOperations(internal(state).groups);
}
