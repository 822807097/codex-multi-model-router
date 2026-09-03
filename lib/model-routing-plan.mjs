import crypto from 'node:crypto';
import { types as utilTypes } from 'node:util';

import { inspectRouterConfig } from './router-config.mjs';
import { routeMatchSafetyIssue } from './route-match-safety.mjs';
// 桌面端目录缺省字段补全的共享模板（与 codex-desktop-config 的 ensureDesktopModelDefaults 同源）
import { genericInstructions } from './codex-desktop-config.mjs';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_NAME_LENGTH = 256;
const MAX_SAFE_TREE_DEPTH = 32;
const MAX_SAFE_TREE_NODES = 4_096;
const OMIT_VALUE = Symbol('omit-value');
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SAFE_TARGET_FIELDS = Object.freeze([
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
  'proxyUrl',
  'vision',
  'useOpenAiAuth',
  'stateDomain',
  'maxResponseBytes',
  'authType',
  'authHeader',
  'forwardHeaders',
  'modelMap',
]);
const SAFE_TARGET_FIELD_SET = new Set(SAFE_TARGET_FIELDS);
const TARGET_STRING_FIELDS = new Set([
  'name',
  'match',
  'platform',
  'host',
  'protocol',
  'prefix',
  'chatPath',
  'upstreamModel',
  'envKey',
  'wireApi',
  'apiFormat',
  'stateDomain',
  'authType',
  'authHeader',
]);
const TARGET_BOOLEAN_FIELDS = new Set(['viaProxy', 'vision', 'useOpenAiAuth']);
const TARGET_NUMBER_FIELDS = new Set(['port', 'maxResponseBytes']);
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
  'supports_search_tool',
  'web_search_tool_type',
  'apply_patch_tool_type',
  'tool_mode',
  'include_skills_usage_instructions',
  'base_instructions',
  'context_window',
  'max_context_window',
  'effective_context_window_percent',
  'auto_compact_token_limit',
]);
const SENSITIVE_FIELD_NAMES = new Set([
  'authorization',
  'authheader',
  'token',
  'secret',
  'cookie',
  'password',
  'credential',
  'bearer',
  'envkey',
  'forwardheaders',
]);
const SENSITIVE_CONTAINER_NAMES = new Set([
  'headers',
  'auth',
  'cookies',
  'secrets',
  'credentials',
  'oauth',
  'api',
]);
const SAFE_KEY_WORDS = new Set(['keyboard', 'monkey', 'keynote', 'tokenizer']);
const TARGET_DIRECT_SENSITIVE_FIELDS = new Set(['envKey', 'authHeader', 'forwardHeaders']);
const SENSITIVE_FIELD_FRAGMENTS = [
  'authorization',
  'secret',
  'password',
  'credential',
  'cookie',
];
const OPERATION_FIELDS = Object.freeze({
  'model.create': new Set(['kind', 'model']),
  'model.update': new Set(['kind', 'slug', 'patch']),
  'model.delete': new Set(['kind', 'slug']),
  'target.create': new Set(['kind', 'target']),
  'target.update': new Set(['kind', 'targetRef', 'patch']),
  'target.delete': new Set(['kind', 'targetRef']),
  'reference.replaceSlug': new Set(['kind', 'from', 'to']),
  'reference.removeSlug': new Set(['kind', 'slug']),
});

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function clone(value) {
  return structuredClone(value);
}

function treeError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function inspectStrictTree(value, label, state = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  if (depth > MAX_SAFE_TREE_DEPTH || state.nodes >= MAX_SAFE_TREE_NODES) {
    throw treeError('tree_complexity', `${label} 嵌套或节点复杂度超出限制`);
  }
  state.nodes += 1;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw treeError('tree_invalid', `${label} 含非有限数`);
  }
  if (value === null || typeof value !== 'object') return;
  if (state.seen.has(value)) throw treeError('tree_cycle', `${label} 含循环引用`);
  state.seen.add(value);

  let array;
  try {
    array = Array.isArray(value);
    if (!array && !plainObject(value)) {
      throw treeError('tree_invalid', `${label} 含不安全对象`);
    }
    if (array) {
      if (value.length > MAX_SAFE_TREE_NODES - state.nodes) {
        throw treeError('tree_complexity', `${label} 节点复杂度超出限制`);
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor) continue;
        if (descriptor.get || descriptor.set) {
          throw treeError('tree_accessor', `${label} 含访问器字段`);
        }
        inspectStrictTree(descriptor.value, label, state, depth + 1);
      }
      return;
    }

    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw treeError('tree_accessor', `${label} 含访问器字段`);
      }
      inspectStrictTree(descriptor.value, label, state, depth + 1);
    }
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('tree_')) throw error;
    throw treeError('tree_invalid', `${label} 无法安全读取`);
  }
}

function strictSnapshot(value, label) {
  inspectStrictTree(value, label);
  try {
    return structuredClone(value);
  } catch {
    throw treeError('tree_clone', `${label} 无法安全快照`);
  }
}

function stableValue(
  value,
  state = { nodes: 0, seen: new WeakMap() },
  depth = 0,
) {
  if (depth > MAX_SAFE_TREE_DEPTH || state.nodes >= MAX_SAFE_TREE_NODES) {
    throw treeError('tree_complexity', '稳定摘要结构复杂度超出限制');
  }
  state.nodes += 1;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw treeError('tree_invalid', '稳定摘要含非有限数');
  }
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || typeof value === 'number'
  ) {
    return value;
  }
  if (!Array.isArray(value) && !plainObject(value)) {
    throw treeError('tree_invalid', '稳定摘要含不安全值');
  }
  if (state.seen.has(value)) throw treeError('tree_cycle', '稳定摘要含循环引用');
  state.seen.set(value, state.nodes);
  if (Array.isArray(value)) {
    const stable = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.nodes >= MAX_SAFE_TREE_NODES) {
        throw treeError('tree_complexity', '稳定摘要节点复杂度超出限制');
      }
      stable.push(stableValue(value[index], state, depth + 1));
    }
    return stable;
  }
  const keys = Object.keys(value);
  return Object.fromEntries(keys.sort().map(
    (key) => [key, stableValue(value[key], state, depth + 1)],
  ));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function addIssue(target, severity, code, path, message) {
  target.push({ severity, code, path, message });
}

function validCatalogName(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.length <= MAX_NAME_LENGTH
    && !CONTROL_CHARACTERS.test(value);
}

function safeInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function inspectCatalogNumber(errors, model, index, field, options = {}) {
  // 官方 models.json 对未启用的字段显式写 null（无值语义），与字段缺失同等对待。
  if (!Object.hasOwn(model, field) || model[field] === null) return;
  const value = model[field];
  const valid = options.integer === false
    ? Number.isFinite(value) && value >= options.minimum && value <= options.maximum
    : safeInteger(value, options.minimum, options.maximum);
  if (!valid) {
    addIssue(
      errors,
      'error',
      'catalog_number_invalid',
      `/models/${index}/${field}`,
      '模型数值字段超出安全范围',
    );
  }
}

/** 校验模型目录的稳定结构和 Codex 菜单需要的核心字段。 */
export function inspectModelCatalog(catalog) {
  const errors = [];
  const warnings = [];
  if (!plainObject(catalog)) {
    addIssue(errors, 'error', 'catalog_root_invalid', '', '模型目录根节点必须是普通对象');
    return { errors, warnings };
  }
  if (!Array.isArray(catalog.models)) {
    addIssue(errors, 'error', 'catalog_models_invalid', '/models', 'models 必须是数组');
    return { errors, warnings };
  }

  const slugs = new Set();
  catalog.models.forEach((model, index) => {
    const basePath = `/models/${index}`;
    if (!plainObject(model)) {
      addIssue(errors, 'error', 'catalog_model_invalid', basePath, '模型条目必须是普通对象');
      return;
    }
    if (!validCatalogName(model.slug)) {
      addIssue(errors, 'error', 'catalog_slug_invalid', `${basePath}/slug`, 'slug 必须是安全的非空短字符串');
    } else if (slugs.has(model.slug)) {
      addIssue(errors, 'error', 'catalog_slug_duplicate', `${basePath}/slug`, 'slug 不能重复');
    } else {
      slugs.add(model.slug);
    }
    if (!validCatalogName(model.display_name)) {
      addIssue(
        errors,
        'error',
        'catalog_display_name_invalid',
        `${basePath}/display_name`,
        'display_name 必须是安全的非空短字符串',
      );
    }
    if (Object.hasOwn(model, 'input_modalities')) {
      const modalities = model.input_modalities;
      if (
        !Array.isArray(modalities)
        || !modalities.includes('text')
        || modalities.some((item) => item !== 'text' && item !== 'image')
      ) {
        addIssue(
          errors,
          'error',
          'catalog_modalities_invalid',
          `${basePath}/input_modalities`,
          'input_modalities 只能包含 text/image 且必须包含 text',
        );
      }
    }
    inspectCatalogNumber(errors, model, index, 'priority', { minimum: 0 });
    inspectCatalogNumber(errors, model, index, 'context_window', { minimum: 1 });
    inspectCatalogNumber(errors, model, index, 'max_context_window', { minimum: 1 });
    inspectCatalogNumber(errors, model, index, 'effective_context_window_percent', {
      integer: false,
      minimum: 0,
      maximum: 100,
    });
    inspectCatalogNumber(errors, model, index, 'auto_compact_token_limit', { minimum: 0 });
    // 桌面端对 apply_patch_tool_type 有枚举约束（报错实证：unknown variant `apply_patch_legacy`,
    // expected `freeform`）——非法值会导致整个 catalog 解析失败、桌面端打不开，必须预检拦截。
    if (
      Object.hasOwn(model, 'apply_patch_tool_type')
      && model.apply_patch_tool_type !== null
      && model.apply_patch_tool_type !== 'freeform'
    ) {
      addIssue(
        errors,
        'error',
        'catalog_apply_patch_tool_type_invalid',
        `${basePath}/apply_patch_tool_type`,
        '桌面端仅支持 freeform（apply_patch_legacy 会使应用无法启动）',
      );
    }
    // web_search_tool_type 同理（报错实证：unknown variant `web_search`, expected `text` or
    // `text_and_image`）；shell_type 等其余工具字段随官方 models.json 演进，不做硬编码枚举。
    if (
      Object.hasOwn(model, 'web_search_tool_type')
      && model.web_search_tool_type !== null
      && model.web_search_tool_type !== 'text'
      && model.web_search_tool_type !== 'text_and_image'
    ) {
      addIssue(
        errors,
        'error',
        'catalog_web_search_tool_type_invalid',
        `${basePath}/web_search_tool_type`,
        '桌面端仅支持 text / text_and_image',
      );
    }
    if (plainObject(model.truncation_policy) && Object.hasOwn(model.truncation_policy, 'limit')) {
      if (!safeInteger(model.truncation_policy.limit, 1)) {
        addIssue(
          errors,
          'error',
          'catalog_number_invalid',
          `${basePath}/truncation_policy/limit`,
          '截断上限必须是正安全整数',
        );
      }
    }
  });
  return { errors, warnings };
}

/** 转义模型 slug，使调用方可以安全拼成 ^escaped$ 精确正则。 */
export function escapeModelSlug(slug) {
  if (!validCatalogName(slug)) throw new TypeError('slug 必须是安全的非空短字符串');
  return slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 生成绑定配置 revision、数组位置和完整目标身份的不透明引用。 */
export function targetReference(configRevision, index, target) {
  if (typeof configRevision !== 'string' || configRevision === '') {
    throw new TypeError('configRevision 必须是非空字符串');
  }
  if (!Number.isSafeInteger(index) || index < 0 || !plainObject(target)) {
    throw new TypeError('目标位置或身份无效');
  }
  const identity = strictSnapshot({ configRevision, index, target }, '目标身份');
  return `target:${sha256(stableJson(identity))}`;
}

function compiledMatch(source) {
  if (typeof source !== 'string' || source === '' || routeMatchSafetyIssue(source)) return null;
  try { return new RegExp(source); } catch { return null; }
}

function ownDataValue(container, field) {
  try {
    if (container === null || typeof container !== 'object' || utilTypes.isProxy(container)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(container, field);
    if (!descriptor || descriptor.get || descriptor.set) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function ownDataArray(container, field) {
  const value = ownDataValue(container, field);
  return Array.isArray(value) && !utilTypes.isProxy(value) ? value : [];
}

function safeArrayEntries(array) {
  const entries = [];
  const length = Math.min(array.length, MAX_SAFE_TREE_NODES);
  for (let index = 0; index < length; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
      entries.push(
        descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined,
      );
    } catch {
      entries.push(undefined);
    }
  }
  return entries;
}

function exactReferences(config, field) {
  const group = ownDataValue(config, field);
  const slugs = ownDataArray(group, 'slugs');
  return safeArrayEntries(slugs).filter((slug) => typeof slug === 'string');
}

function normalizedFieldName(field) {
  return field.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function sensitiveField(field) {
  const normalized = normalizedFieldName(field);
  if (SAFE_KEY_WORDS.has(normalized)) return false;
  if (SENSITIVE_CONTAINER_NAMES.has(normalized)) return true;
  return SENSITIVE_FIELD_NAMES.has(normalized)
    || SENSITIVE_FIELD_FRAGMENTS.some((fragment) => normalized.includes(fragment))
    || normalized.startsWith('key')
    || normalized.endsWith('key')
    || /^(?:access|refresh|auth|api|bearer|id|client|session|oauth)token(?:value|hash)?$/.test(normalized);
}

function sanitizeTree(
  value,
  state = { nodes: 0, seen: new WeakSet() },
  depth = 0,
) {
  if (depth > MAX_SAFE_TREE_DEPTH || state.nodes >= MAX_SAFE_TREE_NODES) {
    return OMIT_VALUE;
  }
  state.nodes += 1;
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object') return OMIT_VALUE;
  if (state.seen.has(value)) return OMIT_VALUE;
  state.seen.add(value);

  if (Array.isArray(value)) {
    const sanitized = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.nodes >= MAX_SAFE_TREE_NODES) break;
      const next = sanitizeTree(value[index], state, depth + 1);
      if (next !== OMIT_VALUE) sanitized.push(next);
    }
    return sanitized;
  }
  if (!plainObject(value)) return OMIT_VALUE;
  const sanitized = {};
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (state.nodes >= MAX_SAFE_TREE_NODES) break;
    if (sensitiveField(key)) continue;
    const next = sanitizeTree(value[key], state, depth + 1);
    if (next !== OMIT_VALUE) sanitized[key] = next;
  }
  return sanitized;
}

function exposedTargetValue(field, value) {
  if (TARGET_NUMBER_FIELDS.has(field)) {
    return typeof value === 'number' && Number.isFinite(value) ? value : OMIT_VALUE;
  }
  if (TARGET_STRING_FIELDS.has(field)) {
    if (field === 'envKey') return typeof value === 'string' && ENV_NAME.test(value)
      ? value
      : OMIT_VALUE;
    if (field === 'authHeader') return typeof value === 'string' && HEADER_NAME.test(value)
      ? value
      : OMIT_VALUE;
    return typeof value === 'string' ? value : OMIT_VALUE;
  }
  if (field === 'forwardHeaders') {
    return (
      Array.isArray(value)
      && value.length < MAX_SAFE_TREE_NODES
      && value.every((item) => typeof item === 'string' && HEADER_NAME.test(item))
    )
      ? [...value]
      : OMIT_VALUE;
  }
  if (field === 'modelMap') {
    if (!plainObject(value)) return OMIT_VALUE;
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.some(([k, v]) => typeof k !== 'string' || typeof v !== 'string')) {
      return OMIT_VALUE;
    }
    return Object.fromEntries(entries);
  }
  if (value === null) return null;
  if (TARGET_BOOLEAN_FIELDS.has(field)) {
    return typeof value === 'boolean' ? value : OMIT_VALUE;
  }
  return OMIT_VALUE;
}

function exposedModel(model) {
  try {
    const snapshot = strictSnapshot(model, '模型条目');
    const exposed = sanitizeTree(snapshot);
    return plainObject(exposed) ? exposed : {};
  } catch (error) {
    // 超预算条目仍可做有界投影；访问器、Proxy 和循环结构直接安全降级。
    if (error?.code !== 'tree_complexity') return {};
    try {
      const exposed = sanitizeTree(model);
      return plainObject(exposed) ? exposed : {};
    } catch {
      return {};
    }
  }
}

function exposedTarget(target, index, configRevision, env) {
  let snapshot;
  let referenceSource;
  try {
    const strict = strictSnapshot(target, '目标条目');
    if (plainObject(strict)) {
      snapshot = strict;
      referenceSource = strict;
    }
  } catch (error) {
    if (error?.code === 'tree_cycle') {
      try {
        const bounded = sanitizeTree(target);
        if (plainObject(bounded)) snapshot = bounded;
      } catch {
        snapshot = undefined;
      }
    }
  }

  const exposed = {};
  if (snapshot) {
    for (const field of SAFE_TARGET_FIELDS) {
      if (!Object.hasOwn(snapshot, field)) continue;
      const value = exposedTargetValue(field, snapshot[field]);
      if (value !== OMIT_VALUE) exposed[field] = value;
    }
  }
  exposed.targetRef = null;
  if (referenceSource) {
    try {
      exposed.targetRef = targetReference(configRevision, index, referenceSource);
    } catch {
      exposed.targetRef = null;
    }
  }
  exposed.envSet = Boolean(snapshot) && (
    snapshot.useOpenAiAuth === true
    || Boolean(
      typeof snapshot.envKey === 'string'
      && Object.hasOwn(env, snapshot.envKey)
      && typeof env[snapshot.envKey] === 'string'
      && env[snapshot.envKey].trim()
    )
  );
  return { exposed, snapshot };
}

/** 暴露模型路由联合编辑所需的安全视图，任何请求头或凭据正文都不会进入返回值。 */
export function exposeModelRoutingState(catalog, config, configRevision, env = {}) {
  const targets = safeArrayEntries(ownDataArray(config, 'targets'));
  const targetStates = targets.map(
    (target, index) => exposedTarget(target, index, configRevision, env),
  );
  const exposedTargets = targetStates.map((state) => state.exposed);
  const matchers = targetStates.map((state) => compiledMatch(state.snapshot?.match));
  const models = safeArrayEntries(ownDataArray(catalog, 'models')).map(exposedModel);
  const bindings = models.map((model) => ({
    slug: model.slug,
    targetRefs: targets.flatMap((target, index) => {
      const matcher = matchers[index];
      const targetRef = exposedTargets[index].targetRef;
      if (!matcher || !targetRef) return [];
      matcher.lastIndex = 0;
      return matcher.test(model.slug) ? [targetRef] : [];
    }),
  }));
  return {
    models,
    targets: exposedTargets,
    bindings,
    references: {
      modelContext: exactReferences(config, 'modelContext'),
      supportsResponses: exactReferences(config, 'supportsResponses'),
    },
  };
}

function operationError(message, code = 'operation_invalid') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertOnlyFields(value, allowed, label) {
  if (!plainObject(value)) throw operationError(`${label} 必须是普通对象`);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw operationError(`${label} 含未知字段：${unknown}`);
}

function assertSafeStructure(value, label, options = {}) {
  const seen = new WeakSet();
  let nodes = 0;
  const visit = (current, depth) => {
    if (depth > MAX_SAFE_TREE_DEPTH) {
      throw operationError(`${label} 嵌套复杂度超出限制`);
    }
    nodes += 1;
    if (nodes > MAX_SAFE_TREE_NODES) {
      throw operationError(`${label} 节点复杂度超出限制`);
    }
    if (current === null || typeof current !== 'object') return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        visit(current[index], depth + 1);
      }
      return;
    }
    const keys = [];
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      const allowedDirectTargetField = depth === 0
        && options.directTargetFields?.has(key);
      if (sensitiveField(key) && !allowedDirectTargetField) {
        throw operationError(
          `${label} 禁止写入敏感字段`,
          'operation_sensitive_field',
        );
      }
      keys.push(key);
      if (keys.length > MAX_SAFE_TREE_NODES) {
        throw operationError(`${label} 节点复杂度超出限制`);
      }
    }
    for (const key of keys) {
      visit(current[key], depth + 1);
    }
  };
  visit(value, 0);
}

function assertModelFields(value, label) {
  assertSafeStructure(value, label);
  assertOnlyFields(value, MODEL_FIELDS, label);
}

// 桌面端必填字段（2026-08-18 三次踩坑后实锤；2026-08-19 补 supported_in_api）：
// slug/display_name/description/input_modalities 为既有约束 + 必填；
// default_reasoning_level 必须是非空字符串；supported_reasoning_levels 必须是非空
// 含 effort 的数组；supported_in_api 必须是布尔——缺失会令桌面端解析 models.json
// 失败、整个应用打不开（报 missing field `supported_in_api`）。
// 只对路由写入（model.create/update）强制；既有 catalog 历史条目不拦（避免启动失败）。
function assertDesktopCompatibleModel(model, label) {
  if (!plainObject(model)) throw operationError(`${label} 必须是普通对象`);
  if (!validCatalogName(model.display_name)) {
    throw operationError(`${label}.display_name 必须是非空字符串`,
      'catalog_display_name_invalid');
  }
  if (typeof model.default_reasoning_level !== 'string' || model.default_reasoning_level.trim() === '') {
    throw operationError(`${label}.default_reasoning_level 桌面端必填（缺失会使应用无法解析目录）`,
      'catalog_default_reasoning_level_required');
  }
  if (!Array.isArray(model.supported_reasoning_levels) || model.supported_reasoning_levels.length === 0) {
    throw operationError(`${label}.supported_reasoning_levels 桌面端必填的非空数组（缺失会使应用无法解析目录）`,
      'catalog_supported_reasoning_levels_required');
  }
  if (model.supported_reasoning_levels.some((level) => (
    !plainObject(level) || typeof level?.effort !== 'string' || !level.effort
  ))) {
    throw operationError(`${label}.supported_reasoning_levels 每项必须是含 effort 字符串的对象`,
      'catalog_supported_reasoning_levels_invalid');
  }
  if (typeof model.supported_in_api !== 'boolean') {
    throw operationError(`${label}.supported_in_api 桌面端必填布尔（缺失会使应用无法解析目录）`,
      'catalog_supported_in_api_invalid');
  }
  if (!Number.isSafeInteger(model.priority) || model.priority < 0) {
    throw operationError(`${label}.priority 桌面端必填的非负整数（缺失会使应用无法解析目录）`,
      'catalog_priority_invalid');
  }
  // 桌面端要求每个模型必须有指令模板（base_instructions 或 model_messages.instructions_template 至少其一）；
  // 路由只能写 base_instructions（model_messages 不在白名单），故此处强制其非空。
  if (typeof model.base_instructions !== 'string' || model.base_instructions.trim() === '') {
    throw operationError(`${label}.base_instructions 桌面端必填的非空指令模板（缺失会使应用无法解析目录）`,
      'catalog_base_instructions_required');
  }
}

// 新模型默认 priority：取现有最大优先级 + 1（首个为 1），保证模型选择器里有稳定顺序
function nextPriority(models) {
  let max = 0;
  for (const item of Array.isArray(models) ? models : []) {
    if (item && Number.isSafeInteger(item.priority) && item.priority > max) max = item.priority;
  }
  return max + 1;
}

function assertTargetFields(value, label) {
  if (!plainObject(value)) throw operationError(`${label} 必须是普通对象`);
  // 先递归拒绝敏感键，避免恶意内容借合法外层字段进入暂存配置。
  assertSafeStructure(value, label, { directTargetFields: TARGET_DIRECT_SENSITIVE_FIELDS });
  for (const field of Object.keys(value)) {
    if (!SAFE_TARGET_FIELD_SET.has(field)) {
      throw operationError(`${label} 含不允许字段：${field}`);
    }
  }
  if (Object.hasOwn(value, 'envKey')
    && (typeof value.envKey !== 'string' || !ENV_NAME.test(value.envKey))) {
    throw operationError(`${label}.envKey 必须是合法环境变量名`);
  }
  if (Object.hasOwn(value, 'authHeader')
    && (typeof value.authHeader !== 'string' || !HEADER_NAME.test(value.authHeader))) {
    throw operationError(`${label}.authHeader 必须是合法 header 名称`);
  }
  if (Object.hasOwn(value, 'forwardHeaders')
    && (!Array.isArray(value.forwardHeaders)
      || value.forwardHeaders.some((name) => typeof name !== 'string' || !HEADER_NAME.test(name)))) {
    throw operationError(`${label}.forwardHeaders 必须是合法 header 名称数组`);
  }
  if (Object.hasOwn(value, 'modelMap')) {
    const map = value.modelMap;
    const entries = Object.entries(map ?? {});
    if (!plainObject(map)
      || entries.length === 0
      || entries.length > 32
      || entries.some(([requested, upstream]) => (
        !/^[A-Za-z0-9._-]{1,128}$/.test(requested)
        || typeof upstream !== 'string'
        || upstream.trim().length === 0
        || upstream.length > 256
      ))) {
      throw operationError(`${label}.modelMap 必须是「模型标识 → 上游模型码」的映射（≤32 条）`);
    }
  }
}

function initialImpact() {
  return {
    models: { created: [], updated: [], deleted: [] },
    targets: { created: [], updated: [], deleted: [], renamed: [] },
    references: { replaced: [], removed: [] },
  };
}

function modelIndex(models, slug) {
  return models.findIndex((item) => plainObject(item) && item.slug === slug);
}

function replaceExactSlug(config, from, to) {
  for (const field of ['modelContext', 'supportsResponses']) {
    const slugs = config?.[field]?.slugs;
    if (!Array.isArray(slugs)) continue;
    const next = [];
    for (const slug of slugs) {
      const value = slug === from ? to : slug;
      if (!next.includes(value)) next.push(value);
    }
    config[field].slugs = next;
  }
}

function removeExactSlug(config, removedSlug) {
  for (const field of ['modelContext', 'supportsResponses']) {
    const slugs = config?.[field]?.slugs;
    if (Array.isArray(slugs)) config[field].slugs = slugs.filter((slug) => slug !== removedSlug);
  }
}

function targetRecords(config, configRevision) {
  return (Array.isArray(config.targets) ? config.targets : []).map((value, index) => ({
    ref: targetReference(configRevision, index, value),
    value,
  }));
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value === '') throw operationError(`${label} 不存在或无效`);
  return value;
}

function assertDedicatedTarget(target, models, operation, code) {
  // 「专属通道」判定：match 必须是完全锚定的精确枚举（^slug$ 或 ^(?:slug-a|slug-b)$），
  // 且每条分支恰好是目录中一个已存在模型的规范转义 slug——支持厂商批量多模型通道；
  // 含通配元字符、指向目录外模型或目录内重名形态一律拒绝（防宽松正则吞路由）。
  const match = typeof target.match === 'string' ? target.match : '';
  const branchForm = /^\^\(\?:(.+)\)\$$/.exec(match) || /^\^(.+)\$$/.exec(match);
  const branches = branchForm ? branchForm[1].split('|') : [];
  const slugList = (Array.isArray(models) ? models : [])
    .filter((model) => validCatalogName(model?.slug))
    .map((model) => escapeModelSlug(model.slug));
  const uniqueBranches = new Set(branches);
  const exactEnumeration = branches.length > 0
    && uniqueBranches.size === branches.length
    && branches.every((branch) => slugList.filter((slug) => slug === branch).length === 1);
  if (!exactEnumeration) {
    throw operationError(
      `${operation} 必须使用当前目录已存在模型 slug 的完全锚定精确枚举（如 ^(?:slug-a|slug-b)$）`,
      code,
    );
  }
}

function snapshotOperations(operations) {
  let snapshot;
  try {
    snapshot = strictSnapshot(operations, 'operations');
  } catch (error) {
    throw operationError(error instanceof Error ? error.message : 'operations 无法安全读取');
  }
  if (!Array.isArray(snapshot)) throw operationError('operations 必须是数组');
  return snapshot;
}

/**
 * 在内存副本上依次应用模型、目标和精确引用操作。
 * 操作层只负责受限结构变换；完整目录和路由语义由联合预检统一判定。
 */
export function applyModelRoutingOperations({ catalog, config, configRevision, operations }) {
  // 整批操作先完成一次全局预算和无访问器快照，后续逻辑只读取可信副本。
  const operationList = snapshotOperations(operations);
  const nextCatalog = clone(catalog);
  const nextConfig = clone(config);
  const models = Array.isArray(nextCatalog?.models) ? nextCatalog.models : [];
  const records = targetRecords(nextConfig, configRevision);
  const impact = initialImpact();

  for (const operation of operationList) {
    if (!plainObject(operation) || !OPERATION_FIELDS[operation.kind]) {
      throw operationError(`未知操作 kind：${operation?.kind ?? '(missing)'}`, 'operation_kind_unknown');
    }
    assertOnlyFields(operation, OPERATION_FIELDS[operation.kind], '操作');
    switch (operation.kind) {
      case 'model.create': {
        assertModelFields(operation.model, 'model.create.model');
        const slug = requiredString(operation.model.slug, 'model.create slug');
        if (modelIndex(models, slug) >= 0) throw operationError(`模型已存在：${slug}`);
        // 桌面端必填字段兜底：管理 API/前端未填时补默认值，避免写入缺失字段导致
        // 桌面端解析 models.json 失败打不开（2026-08-18 三次踩坑的根治）。
        const created = { ...clone(operation.model) };
        // 自动补全技术性默认字段：description/input_modalities/default_reasoning_level/
        // supported_reasoning_levels（桌面端必填，缺失会打不开目录）。display_name 不自动补——
        // 它是用户可见标识，缺失仍走既有 catalog_display_name_invalid 报错路径（既有契约）。
        if (!created.description) created.description = slug;
        if (!created.input_modalities) created.input_modalities = ['text'];
        if (typeof created.default_reasoning_level !== 'string' || !created.default_reasoning_level) {
          created.default_reasoning_level = 'medium';
        }
        if (!Array.isArray(created.supported_reasoning_levels) || created.supported_reasoning_levels.length === 0) {
          created.supported_reasoning_levels = [
            { effort: 'low', description: '快速响应，较轻推理' },
            { effort: 'medium', description: '平衡速度与推理深度' },
            { effort: 'high', description: '复杂问题的更深推理' },
            { effort: 'max', description: '最大推理深度' },
          ];
        }
        // Codex 插件默认声明：管理 API/前端未显式指定时，默认启用完整插件集
        // （apply_patch/shell/goal/computer_use/web_search/tool_search/MCP 读/写 + skills），
        // 让任意新模型都能在 Codex 里启用全部插件（上游不支持的工具由路由/上游忽略）。
        // 与前端编辑弹窗写入的字段对齐；已有调用方显式给值时保留原值。
        if (!Array.isArray(created.experimental_supported_tools)) {
          created.experimental_supported_tools = [
            'apply_patch', 'shell', 'goal', 'computer_use',
            'web_search', 'tool_search', 'mcp_read', 'mcp_write',
            'image_generation',
          ];
        }
        if (created.visibility === undefined) created.visibility = 'list';
        if (created.supports_search_tool === undefined) created.supports_search_tool = true;
        if (created.web_search_tool_type === undefined) created.web_search_tool_type = 'text_and_image';
        if (created.apply_patch_tool_type === undefined) created.apply_patch_tool_type = 'freeform';
        if (created.include_skills_usage_instructions === undefined) created.include_skills_usage_instructions = true;
        if (created.shell_type === undefined) created.shell_type = 'shell_command';
        if (created.tool_mode === undefined) created.tool_mode = 'code_mode_only';
        if (created.use_responses_lite === undefined) created.use_responses_lite = false;
        if (created.supports_parallel_tool_calls === undefined) created.supports_parallel_tool_calls = true;
        if (created.supported_in_api === undefined) created.supported_in_api = true;
        if (!Number.isSafeInteger(created.priority) || created.priority < 0) created.priority = nextPriority(models);
        if (typeof created.base_instructions !== 'string' || !created.base_instructions.trim()) {
          created.base_instructions = genericInstructions(created.display_name || created.slug);
        }
        // 2026-09-02 第 2 轮实锤：optional-but-required-key 字段（缺 key 即整目录解析失败）
        for (const field of ['availability_nux', 'upgrade', 'default_verbosity', 'apply_patch_tool_type']) {
          if (!Object.hasOwn(created, field)) created[field] = null;
        }
        // 补全后必须仍是桌面端可解析的完整条目（防再写入残缺模型打不开目录）
        assertDesktopCompatibleModel(created, 'model.create.model');
        models.push(created);
        impact.models.created.push(slug);
        break;
      }
      case 'model.update': {
        const slug = requiredString(operation.slug, 'model.update slug');
        assertModelFields(operation.patch, 'model.update.patch');
        const index = modelIndex(models, slug);
        if (index < 0) throw operationError(`模型不存在：${slug}`);
        const nextSlug = Object.hasOwn(operation.patch, 'slug')
          ? requiredString(operation.patch.slug, 'model.update patch.slug')
          : slug;
        const duplicate = modelIndex(models, nextSlug);
        if (duplicate >= 0 && duplicate !== index) throw operationError(`模型已存在：${nextSlug}`);
        const merged = { ...models[index], ...clone(operation.patch) };
        // 更新不得把目录变回桌面端不可解析的残缺条目
        if (!merged.display_name) merged.display_name = nextSlug;
        if (!merged.description) merged.description = nextSlug;
        if (typeof merged.default_reasoning_level !== 'string' || !merged.default_reasoning_level) {
          merged.default_reasoning_level = 'medium';
        }
        if (!Array.isArray(merged.supported_reasoning_levels) || merged.supported_reasoning_levels.length === 0) {
          merged.supported_reasoning_levels = [
            { effort: 'low', description: '快速响应，较轻推理' },
            { effort: 'medium', description: '平衡速度与推理深度' },
            { effort: 'high', description: '复杂问题的更深推理' },
            { effort: 'max', description: '最大推理深度' },
          ];
        }
        // 更新后同样确保 Codex 插件默认声明存在（与 create 补全一致，显式给值者保留）
        if (!Array.isArray(merged.experimental_supported_tools)) {
          merged.experimental_supported_tools = [
            'apply_patch', 'shell', 'goal', 'computer_use',
            'web_search', 'tool_search', 'mcp_read', 'mcp_write',
            'image_generation',
          ];
        }
        if (merged.visibility === undefined) merged.visibility = 'list';
        if (merged.supports_search_tool === undefined) merged.supports_search_tool = true;
        if (merged.web_search_tool_type === undefined) merged.web_search_tool_type = 'text_and_image';
        if (merged.apply_patch_tool_type === undefined) merged.apply_patch_tool_type = 'freeform';
        if (merged.include_skills_usage_instructions === undefined) merged.include_skills_usage_instructions = true;
        if (merged.shell_type === undefined) merged.shell_type = 'shell_command';
        if (merged.tool_mode === undefined) merged.tool_mode = 'code_mode_only';
        if (merged.use_responses_lite === undefined) merged.use_responses_lite = false;
        if (merged.supported_in_api === undefined) merged.supported_in_api = true;
        if (!Number.isSafeInteger(merged.priority) || merged.priority < 0) merged.priority = nextPriority(models);
        if (typeof merged.base_instructions !== 'string' || !merged.base_instructions.trim()) {
          merged.base_instructions = genericInstructions(merged.display_name || nextSlug);
        }
        // 2026-09-02 第 2 轮实锤：以下字段无 serde(default)（optional-but-required-key）——
        // 缺 key 即整目录解析失败静默回退官方，即使语义允许 null 也必须显式写出。
        for (const field of ['availability_nux', 'upgrade', 'default_verbosity', 'apply_patch_tool_type']) {
          if (!Object.hasOwn(merged, field)) merged[field] = null;
        }
        assertDesktopCompatibleModel(merged, 'model.update.patch');
        models[index] = merged;
        impact.models.updated.push({ from: slug, to: nextSlug });
        break;
      }
      case 'model.delete': {
        const slug = requiredString(operation.slug, 'model.delete slug');
        const index = modelIndex(models, slug);
        if (index < 0) throw operationError(`模型不存在：${slug}`);
        models.splice(index, 1);
        impact.models.deleted.push(slug);
        break;
      }
      case 'target.create': {
        assertTargetFields(operation.target, 'target.create.target');
        assertDedicatedTarget(
          operation.target,
          models,
          'target.create',
          'target_create_not_dedicated',
        );
        const value = clone(operation.target);
        records.push({ ref: null, value });
        impact.targets.created.push(value.name ?? null);
        break;
      }
      case 'target.update': {
        requiredString(operation.targetRef, 'targetRef');
        const record = records.find((item) => item.ref === operation.targetRef);
        if (!record) throw operationError('targetRef 已失效或不存在', 'target_ref_invalid');
        assertTargetFields(operation.patch, 'target.update.patch');
        // 改名撞名校验：name 是密钥池/选中框等处的关联键，必须全局唯一
        const oldName = record.value.name ?? null;
        const newName = operation.patch.name;
        if (typeof newName === 'string' && newName.trim()
          && newName !== oldName
          && records.some((item) => item !== record && item.value?.name === newName)) {
          throw operationError(`通道名称已存在：${newName}`, 'target_name_duplicate');
        }
        record.value = { ...record.value, ...clone(operation.patch) };
        impact.targets.updated.push(operation.targetRef);
        // 改名联动：密钥池按通道名关联，旧名条目必须迁移（见 admin PUT 处理）
        if (typeof newName === 'string' && newName.trim() && newName !== oldName) {
          impact.targets.renamed.push({ from: oldName ?? '', to: newName });
        }
        break;
      }
      case 'target.delete': {
        requiredString(operation.targetRef, 'targetRef');
        const index = records.findIndex((item) => item.ref === operation.targetRef);
        if (index < 0) throw operationError('targetRef 已失效或不存在', 'target_ref_invalid');
        // 不做「精确专属 match」前置校验（2026-09-02 实锤：宽松匹配的多模型通道如
        // ^deepseek-(?!v4-flash$) 永远不满足精确唯一，导致通道永远删不掉）。
        // 删除后失去路由的模型由 inspectModelRoutes 的 before/after 对比兜底：
        // 同事务先删模型则无孤儿；未删则报清晰的 model_route_missing 引导用户处理。
        records.splice(index, 1);
        impact.targets.deleted.push(operation.targetRef);
        break;
      }
      case 'reference.replaceSlug': {
        const from = requiredString(operation.from, 'reference.replaceSlug from');
        const to = requiredString(operation.to, 'reference.replaceSlug to');
        replaceExactSlug(nextConfig, from, to);
        impact.references.replaced.push({ from, to });
        break;
      }
      case 'reference.removeSlug': {
        const slug = requiredString(operation.slug, 'reference.removeSlug slug');
        removeExactSlug(nextConfig, slug);
        impact.references.removed.push(slug);
        break;
      }
      default:
        throw operationError(`未知操作 kind：${operation.kind}`, 'operation_kind_unknown');
    }
  }
  nextConfig.targets = records.map((record) => record.value);
  return { catalog: nextCatalog, config: nextConfig, impact };
}

function operationDigest(operations) {
  const snapshot = strictSnapshot(operations, 'operations 摘要');
  if (!Array.isArray(snapshot)) throw treeError('tree_invalid', 'operations 摘要必须是数组');
  return sha256(stableJson(snapshot));
}

function validTargetMatchers(config) {
  if (!Array.isArray(config?.targets)) return { invalid: false, matchers: [] };
  const matchers = config.targets.map((target) => compiledMatch(target?.match));
  return {
    invalid: matchers.some((matcher) => matcher === null),
    matchers,
  };
}

function matchesSlug(matcher, slug) {
  matcher.lastIndex = 0;
  return matcher.test(slug);
}

function inspectModelRoutes(before, next, errors, warnings) {
  if (!Array.isArray(next?.catalog?.models)) return;
  const nextMatch = validTargetMatchers(next.config);
  // 正则错误由配置检查给出精确位置；此处不再级联成所有模型无路由。
  if (nextMatch.invalid) return;
  // 硬错误只针对「本次操作新引入」的无路由状态：新建/改名成无路由的模型，
  // 或删除/改动通道把原本有路由的模型变成孤儿（防止把通道从模型脚下抽走）。
  // 存量本就无路由的模型（如通道早已移除的遗留目录项）降级为警告——
  // 否则任何一个此类模型会封锁全部模型事务，连删除它自己都被挡死
  // （2026-08-28 事故：opencode 通道移除后其目录模型把增/删/改/预设接入全部 422 锁死）。
  const beforeMatch = validTargetMatchers(before.config);
  const beforeSlugs = new Set(
    Array.isArray(before?.catalog?.models)
      ? before.catalog.models.map((model) => model?.slug).filter((slug) => typeof slug === 'string')
      : [],
  );
  const matchedBefore = (slug) => (
    beforeMatch.invalid
      || beforeMatch.matchers.some((matcher) => matchesSlug(matcher, slug))
  );
  next.catalog.models.forEach((model, index) => {
    if (!validCatalogName(model?.slug)) return;
    if (nextMatch.matchers.some((matcher) => matchesSlug(matcher, model.slug))) return;
    const newlyIntroduced = !beforeSlugs.has(model.slug) || matchedBefore(model.slug);
    if (newlyIntroduced) {
      addIssue(
        errors,
        'error',
        'model_route_missing',
        `/models/${index}/slug`,
        `模型 ${model.slug} 没有匹配任何路由目标，请求会无处转发`,
      );
    } else {
      addIssue(
        warnings,
        'warning',
        'model_route_missing',
        `/models/${index}/slug`,
        `模型 ${model.slug} 未匹配任何路由目标（存量遗留，可删除模型或补建通道）`,
      );
    }
  });
}

function changedModelSlugs(impact) {
  const slugs = [];
  for (const item of impact.models.updated) {
    if (item.from !== item.to) slugs.push(item.from);
  }
  slugs.push(...impact.models.deleted);
  return slugs;
}

function inspectCapabilityReferences(config, impact, warnings) {
  if (!Array.isArray(config?.modelCapabilities)) return;
  for (const slug of changedModelSlugs(impact)) {
    config.modelCapabilities.forEach((capability, index) => {
      const matcher = compiledMatch(capability?.match);
      if (!matcher || !matchesSlug(matcher, slug)) return;
      addIssue(
        warnings,
        'warning',
        'model_capability_reference_manual',
        `/modelCapabilities/${index}/match`,
        `能力正则仍命中已改名或删除的模型 ${slug}，需要人工复核`,
      );
    });
  }
}

function inspectionRootSnapshot(value, label) {
  try {
    const snapshot = strictSnapshot(value, label);
    return plainObject(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

/**
 * 在不写磁盘的前提下应用联合编辑，并汇总目录、配置和跨资源语义诊断。
 * 操作失败会返回稳定错误及原始状态副本，调用方可以安全展示而无需捕获异常。
 */
export function inspectModelRoutingPlan({
  catalog,
  config,
  configRevision,
  operations,
  context = {},
}) {
  const catalogSnapshot = inspectionRootSnapshot(catalog, 'catalog 根节点');
  const configSnapshot = inspectionRootSnapshot(config, 'config 根节点');
  let nextCatalog = catalogSnapshot;
  let nextConfig = configSnapshot;
  let impact = initialImpact();
  let operationIssue;
  if (catalogSnapshot && configSnapshot) {
    try {
      const applied = applyModelRoutingOperations({
        catalog: catalogSnapshot,
        config: configSnapshot,
        configRevision,
        operations,
      });
      nextCatalog = applied.catalog;
      nextConfig = applied.config;
      impact = applied.impact;
    } catch (error) {
      // catch 只克隆已经验证的根快照，绝不再次接触原始恶意对象。
      nextCatalog = clone(catalogSnapshot);
      nextConfig = clone(configSnapshot);
      operationIssue = {
        severity: 'error',
        code: typeof error?.code === 'string' ? error.code : 'operation_invalid',
        path: '/operations',
        message: error instanceof Error ? error.message : '操作无效',
      };
    }
  }

  let digest = null;
  try {
    digest = operationDigest(operations);
  } catch (error) {
    if (!operationIssue) {
      operationIssue = {
        severity: 'error',
        code: 'operation_invalid',
        path: '/operations',
        message: error instanceof Error ? error.message : '操作摘要无效',
      };
    }
  }

  const catalogInspection = inspectModelCatalog(nextCatalog);
  const configInspection = inspectRouterConfig(nextConfig, context);
  const errors = [
    ...catalogInspection.errors,
    ...configInspection.errors,
  ];
  const warnings = [
    ...catalogInspection.warnings,
    ...configInspection.warnings,
  ];
  if (operationIssue) errors.push(operationIssue);
  // 前后状态都用净化快照：原始入参可能是带抛错 getter 的恶意根对象。
  inspectModelRoutes(
    { catalog: catalogSnapshot, config: configSnapshot },
    { catalog: nextCatalog, config: nextConfig },
    errors,
    warnings,
  );
  inspectCapabilityReferences(nextConfig, impact, warnings);

  return {
    catalog: nextCatalog,
    config: nextConfig,
    errors,
    warnings,
    impact,
    operationDigest: errors.length === 0 ? digest : null,
  };
}
