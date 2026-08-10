const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value))
    .every((child) => isJsonValue(child, seen));
  seen.delete(value);
  return valid;
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameValue(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => (
    Object.hasOwn(right, key) && sameValue(left[key], right[key])
  ));
}

function decodePointerSegment(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function normalizePath(pointerOrPath) {
  let segments;
  if (typeof pointerOrPath === 'string') {
    if (!pointerOrPath.startsWith('/') || pointerOrPath.length === 1) {
      throw new TypeError('配置路径必须是非空 JSON Pointer');
    }
    segments = pointerOrPath.slice(1).split('/').map(decodePointerSegment);
  } else if (Array.isArray(pointerOrPath) && pointerOrPath.length > 0) {
    segments = pointerOrPath.map((segment) => String(segment));
  } else {
    throw new TypeError('配置路径必须是 JSON Pointer 或非空 path 数组');
  }
  if (segments.some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new TypeError('配置路径不安全');
  }
  return segments;
}

function arrayIndex(array, segment) {
  if (!/^(0|[1-9]\d*)$/.test(segment)) return null;
  const index = Number(segment);
  return Number.isSafeInteger(index) && index < array.length ? index : null;
}

function ownKey(container, segment) {
  if (Array.isArray(container)) return arrayIndex(container, segment);
  if (!isPlainObject(container) || !Object.hasOwn(container, segment)) return null;
  return segment;
}

function replaceAtPath(root, segments, value) {
  const nextRoot = clone(root);
  let cursor = nextRoot;
  for (const segment of segments.slice(0, -1)) {
    const key = ownKey(cursor, segment);
    if (key === null) throw new RangeError('配置路径不存在');
    cursor = cursor[key];
  }
  const lastKey = ownKey(cursor, segments.at(-1));
  if (lastKey === null) throw new RangeError('配置路径不存在');
  cursor[lastKey] = clone(value);
  return nextRoot;
}

function addAtPath(root, segments, value) {
  const nextRoot = clone(root);
  let cursor = nextRoot;
  for (const segment of segments.slice(0, -1)) {
    const key = ownKey(cursor, segment);
    if (key === null) throw new RangeError('配置父路径不存在');
    cursor = cursor[key];
  }
  if (!isPlainObject(cursor)) throw new TypeError('配置父路径必须是对象');
  const field = segments.at(-1);
  if (field.length === 0) throw new TypeError('配置字段名不能为空');
  if (Object.hasOwn(cursor, field)) throw new TypeError('配置字段已存在');
  cursor[field] = clone(value);
  return nextRoot;
}

function removeAtPath(root, segments) {
  const nextRoot = clone(root);
  let cursor = nextRoot;
  for (const segment of segments.slice(0, -1)) {
    const key = ownKey(cursor, segment);
    if (key === null) throw new RangeError('配置父路径不存在');
    cursor = cursor[key];
  }
  if (!isPlainObject(cursor)) throw new TypeError('配置父路径必须是对象');
  const field = segments.at(-1);
  if (!Object.hasOwn(cursor, field)) throw new RangeError('配置字段不存在');
  delete cursor[field];
  return nextRoot;
}

/**
 * 从管理 API 的配置响应建立浏览器编辑状态。
 * API 响应与编辑副本完全隔离，表单修改不会污染请求缓存。
 */
export function createConfigState(payload) {
  if (!isPlainObject(payload) || typeof payload.revision !== 'string') {
    throw new TypeError('管理 API 配置响应无效');
  }
  if (!isPlainObject(payload.config)) {
    throw new TypeError('管理 API 配置必须是对象');
  }
  const config = clone(payload.config);
  return {
    revision: payload.revision,
    secretDeleteConfirmation: payload.secretDeleteConfirmation ?? null,
    secretDeletes: Array.isArray(payload.secretDeletes) ? [...payload.secretDeletes] : [],
    config,
    originalConfig: clone(config),
    dirty: false,
  };
}

/**
 * 按 JSON Pointer 或 path 数组不可变地更新一个已有配置字段。
 * 只克隆并替换值，不重建配置结构，因此未知字段、注释和数组顺序都会保留。
 */
export function updateConfigValue(state, pointerOrPath, value) {
  if (!isPlainObject(state) || !isPlainObject(state.config) || !isPlainObject(state.originalConfig)) {
    throw new TypeError('配置编辑状态无效');
  }
  const config = replaceAtPath(state.config, normalizePath(pointerOrPath), value);
  return {
    ...state,
    config,
    dirty: !sameValue(config, state.originalConfig),
  };
}

/**
 * 只在已存在的父对象上新增一个末级字段。
 * 不自动创建中间容器，也不允许借此扩展数组，避免表单路径错误改变配置结构。
 */
export function addConfigValue(state, pointerOrPath, value) {
  if (!isPlainObject(state) || !isPlainObject(state.config) || !isPlainObject(state.originalConfig)) {
    throw new TypeError('配置编辑状态无效');
  }
  if (!isJsonValue(value)) throw new TypeError('配置值必须是有效 JSON 值');
  const config = addAtPath(state.config, normalizePath(pointerOrPath), value);
  return {
    ...state,
    config,
    dirty: !sameValue(config, state.originalConfig),
  };
}

/**
 * 只删除已存在普通父对象上的末级字段。
 * 数组结构和中间路径均不可改变，删除后的脏状态按原始配置重新计算。
 */
export function removeConfigValue(state, pointerOrPath) {
  if (!isPlainObject(state) || !isPlainObject(state.config) || !isPlainObject(state.originalConfig)) {
    throw new TypeError('配置编辑状态无效');
  }
  const config = removeAtPath(state.config, normalizePath(pointerOrPath));
  return {
    ...state,
    config,
    dirty: !sameValue(config, state.originalConfig),
  };
}

/** 返回当前配置是否相对 API 原始版本发生变化。 */
export function isConfigDirty(state) {
  if (!isPlainObject(state) || !isPlainObject(state.config) || !isPlainObject(state.originalConfig)) {
    throw new TypeError('配置编辑状态无效');
  }
  return !sameValue(state.config, state.originalConfig);
}

/** 生成配置预检和保存接口共用的提交数据。 */
export function serializeConfigState(state) {
  if (!isPlainObject(state) || typeof state.revision !== 'string' || !isPlainObject(state.config)) {
    throw new TypeError('配置编辑状态无效');
  }
  return {
    revision: state.revision,
    config: clone(state.config),
    secretDeleteConfirmation: state.secretDeleteConfirmation ?? null,
    secretDeletes: Array.isArray(state.secretDeletes) ? [...state.secretDeletes] : [],
  };
}
