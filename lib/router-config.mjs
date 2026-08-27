import path from 'node:path';

import { isSafePublicHostname } from './imagebridge.mjs';
import { resolveProvider } from './provider-adapters.mjs';
import { upstreamStateDomain } from './request-policy.mjs';
import { DEFAULT_TIMEOUTS } from './transport.mjs';
import { routeMatchSafetyIssue } from './route-match-safety.mjs';

export class RouterConfigError extends Error {
  constructor(issues) {
    super('路由配置无效');
    this.name = 'RouterConfigError';
    this.issues = issues;
  }
}

export function formatConfigIssues(issues = []) {
  return issues.map((issue) => {
    const issuePath = issue.path || '<root>';
    return `[${issue.severity}] ${issue.code} ${issuePath}: ${issue.message}`;
  });
}

function addIssue(target, severity, code, issuePath, message) {
  target.push({ severity, code, path: issuePath, message });
}

function selectedValue(env, envName, configured, fallback) {
  if (envName && Object.hasOwn(env, envName)) {
    return { value: env[envName], path: `$env/${envName}` };
  }
  if (configured !== undefined) {
    return { value: configured, path: null };
  }
  return { value: fallback, path: null };
}

function finiteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (
    normalized === '' ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)
  ) {
    return null;
  }

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, options = {}) {
  const number = finiteNumber(value);
  if (number === null || !Number.isInteger(number)) return null;

  const minimum = options.min ?? 1;
  const maximum = options.max ?? Number.MAX_SAFE_INTEGER;
  return number >= minimum && number <= maximum ? number : null;
}

function plainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const NEVER_FORWARD_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-type',
  'content-encoding',
  'accept-encoding',
  'chatgpt-account-id',
  'x-codex-session-id',
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function usableEnvironmentValue(env, key) {
  return Object.hasOwn(env, key) && nonEmptyString(env[key]);
}

function strictTargetPort(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 65_535;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= 65_535;
}

function validEndpointPath(value, allowEmpty) {
  return (
    typeof value === 'string'
    && !/[\r\n]/.test(value)
    && (allowEmpty ? value === '' || value.startsWith('/') : value.startsWith('/') && value !== '')
  );
}

function validHeaderValue(value) {
  const scalar = (item) => (
    ['string', 'number', 'boolean'].includes(typeof item)
    && !/[\r\n]/.test(String(item))
  );
  return Array.isArray(value) ? value.every(scalar) : scalar(value);
}

function canonicalLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function selectedWireField(target) {
  for (const field of ['apiFormat', 'wire_api', 'wireApi']) {
    if (Object.hasOwn(target, field) && target[field] !== undefined && target[field] !== null) {
      return field;
    }
  }
  return null;
}

function inspectTarget(target, index, env, errors, warnings) {
  const basePath = `/targets/${index}`;
  if (!plainObject(target)) {
    addIssue(
      errors,
      'error',
      'target_name_invalid',
      basePath,
      'target 必须是普通对象',
    );
    return null;
  }

  const nameValid = nonEmptyString(target.name);
  if (!nameValid) {
    addIssue(errors, 'error', 'target_name_invalid', `${basePath}/name`, '必须是非空字符串');
  }

  let matchValid = nonEmptyString(target.match);
  if (matchValid) {
    try {
      new RegExp(target.match);
    } catch {
      matchValid = false;
    }
  }
  if (!matchValid) {
    addIssue(
      errors,
      'error',
      'target_match_invalid',
      `${basePath}/match`,
      '必须是可编译的非空正则字符串',
    );
  } else if (routeMatchSafetyIssue(target.match)) {
    matchValid = false;
    addIssue(
      errors,
      'error',
      'target_match_unsafe',
      `${basePath}/match`,
      '正则不得超过 1024 字符、使用反向引用或嵌套无界量词',
    );
  }

  const hostValid = nonEmptyString(target.host) && !/[\r\n]/.test(target.host);
  if (!hostValid) {
    addIssue(
      errors,
      'error',
      'target_host_invalid',
      `${basePath}/host`,
      '必须是非空且不含换行的字符串',
    );
  }

  const protocol = target.protocol === undefined || target.protocol === null
    ? 'https'
    : target.protocol;
  const protocolValid = protocol === 'http' || protocol === 'https';
  if (!protocolValid) {
    addIssue(
      errors,
      'error',
      'target_protocol_invalid',
      `${basePath}/protocol`,
      '必须是 http 或 https',
    );
  }

  const portValid = (
    target.port === undefined
    || target.port === null
    || strictTargetPort(target.port)
  );
  if (!portValid) {
    addIssue(
      errors,
      'error',
      'target_port_invalid',
      `${basePath}/port`,
      '必须是 1..65535 的十进制整数',
    );
  }

  const prefixValid = (
    target.prefix === undefined
    || validEndpointPath(target.prefix, true)
  );
  if (!prefixValid) {
    addIssue(
      errors,
      'error',
      'target_path_invalid',
      `${basePath}/prefix`,
      '必须是空字符串或以 / 开头且不含换行的路径',
    );
  }
  const chatPathValid = (
    target.chatPath !== undefined
    && target.chatPath !== null
      ? validEndpointPath(target.chatPath, false)
      : true
  );
  if (!chatPathValid) {
    addIssue(
      errors,
      'error',
      'target_path_invalid',
      `${basePath}/chatPath`,
      '必须是以 / 开头且不含换行的非空路径',
    );
  }

  const wireField = selectedWireField(target);
  // provider 的名称推断只接收字符串；诊断仍保留原 target 与原始 path。
  const providerTarget = nameValid ? target : { ...target, name: '' };
  const provider = resolveProvider(providerTarget);
  const configuredWire = wireField === null ? null : target[wireField];
  const wireValid = (
    (wireField === null
      || (typeof configuredWire === 'string' && configuredWire.trim() !== ''))
    && ['chat', 'responses'].includes(provider.wireApi)
  );
  if (!wireValid) {
    addIssue(
      errors,
      'error',
      'target_wire_api_invalid',
      `${basePath}/${wireField ?? 'wireApi'}`,
      '必须解析为 chat 或 responses',
    );
  }

  const official = target.useOpenAiAuth === true;
  let authValid = true;
  if (
    Object.hasOwn(target, 'useOpenAiAuth')
    && target.useOpenAiAuth !== undefined
    && target.useOpenAiAuth !== null
    && typeof target.useOpenAiAuth !== 'boolean'
  ) {
    authValid = false;
    addIssue(
      errors,
      'error',
      'target_auth_conflict',
      `${basePath}/useOpenAiAuth`,
      'useOpenAiAuth 必须是 boolean',
    );
  }
  if (official) {
    for (const field of ['envKey', 'authType', 'authHeader', 'auth']) {
      if (Object.hasOwn(target, field) && target[field] !== undefined && target[field] !== null) {
        authValid = false;
        addIssue(
          errors,
          'error',
          'target_auth_conflict',
          `${basePath}/${field}`,
          '官方登录态不能同时配置替代凭据',
        );
      }
    }
  }
  // envKey 对非官方通道可省略：密钥池通道的凭据来自 channel_keys 池（vendor-presets 接入即此形态），
  // 池空/全冷却时由 acquireKey 在路由层报错。省略时不产生 env_missing 警告。
  const envKeyProvided = typeof target.envKey === 'string';
  const envKeyValid = official || !envKeyProvided || ENV_NAME.test(target.envKey);
  if (!official && envKeyProvided && !envKeyValid) {
    addIssue(
      errors,
      'error',
      'target_env_key_invalid',
      `${basePath}/envKey`,
      '必须是合法的环境变量名',
    );
  } else if (!official && envKeyProvided && !usableEnvironmentValue(env, target.envKey)) {
    addIssue(warnings, 'warning', 'env_missing', `${basePath}/envKey`, target.envKey);
  }

  let authTransportValid = true;
  if (
    protocolValid
    && protocol === 'http'
    && (official || !envKeyProvided || envKeyValid)
    && !canonicalLoopbackHost(target.host)
  ) {
    authTransportValid = false;
    addIssue(
      errors,
      'error',
      'target_insecure_auth_transport',
      `${basePath}/protocol`,
      '带凭据的 HTTP target 仅允许规范回环主机',
    );
  }

  if (protocol === 'http' && target.viaProxy === true) {
    addIssue(
      warnings,
      'warning',
      'proxy_ignored_for_http',
      `${basePath}/viaProxy`,
      'HTTP target 不会使用 CONNECT 代理',
    );
  }

  // 目标级代理 URL（可选）：http:// 或 socks5:// host:port；设置后本通道走该代理，
  // 未设置但 viaProxy=true 时跟随全局代理（V2RAY_PROXY）。节点协议（ss/vmess/vless/
  // trojan/hysteria…）由本地代理软件统一转换，路由侧协议无关。
  if (
    target.proxyUrl !== undefined
    && target.proxyUrl !== null
    && !/^(?:http|socks5|ss|trojan|vless):\/\/[^\s]+$/i.test(String(target.proxyUrl))
  ) {
    addIssue(
      errors,
      'error',
      'target_proxy_url_invalid',
      `${basePath}/proxyUrl`,
      '必须是 http://、socks5://、ss://、trojan:// 或 vless:// 链接',
    );
  }

  let headersValid = true;
  if (target.headers !== undefined && target.headers !== null) {
    headersValid = plainObject(target.headers);
    if (headersValid) {
      headersValid = Object.entries(target.headers).every(
        ([name, value]) => HEADER_NAME.test(name) && validHeaderValue(value),
      );
    }
    if (!headersValid) {
      addIssue(
        errors,
        'error',
        'target_headers_invalid',
        `${basePath}/headers`,
        'header 名称或值无效',
      );
    }
  }

  if (target.forwardHeaders !== undefined && target.forwardHeaders !== null) {
    if (!Array.isArray(target.forwardHeaders)) {
      addIssue(
        errors,
        'error',
        'target_forward_headers_invalid',
        `${basePath}/forwardHeaders`,
        '必须是合法 HTTP header 名称的字符串数组',
      );
    } else {
      target.forwardHeaders.forEach((name, headerIndex) => {
        const headerPath = `${basePath}/forwardHeaders/${headerIndex}`;
        if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
          addIssue(
            errors,
            'error',
            'target_forward_headers_invalid',
            headerPath,
            '必须是合法 HTTP header 名称',
          );
          return;
        }
        const normalized = name.toLowerCase();
        const generatedAuthHeader = String(
          provider.authHeader
            || (provider.authType === 'x-api-key' ? 'x-api-key' : 'authorization'),
        ).toLowerCase();
        if (NEVER_FORWARD_HEADERS.has(normalized) || normalized === generatedAuthHeader) {
          addIssue(
            warnings,
            'warning',
            'forward_header_ignored',
            headerPath,
            '该 header 由路由控制，不会透传',
          );
        }
      });
    }
  }

  const identityValid = (
    nameValid
    && matchValid
    && hostValid
    && protocolValid
    && portValid
    && prefixValid
    && chatPathValid
    && wireValid
    && authValid
    && authTransportValid
    && envKeyValid
    && headersValid
  );
  return {
    target,
    index,
    provider,
    matchValid,
    wireValid,
    identityValid,
  };
}

function upstreamIdentity(item) {
  const targetWithoutStateDomain = { ...item.target };
  delete targetWithoutStateDomain.stateDomain;
  return JSON.stringify([
    upstreamStateDomain(targetWithoutStateDomain, item.provider),
    item.provider.wireApi === 'chat' ? item.provider.chatPath : null,
  ]);
}

function addCrossTargetWarnings(inspectedTargets, warnings) {
  const names = new Set();
  for (const item of inspectedTargets) {
    if (!nonEmptyString(item.target.name)) continue;
    if (names.has(item.target.name)) {
      addIssue(
        warnings,
        'warning',
        'target_name_duplicate',
        `/targets/${item.index}/name`,
        'target name 与先前目标重复',
      );
    }
    names.add(item.target.name);
  }

  const identities = new Set();
  for (const item of inspectedTargets) {
    if (!item.identityValid) continue;
    const identity = JSON.stringify([
      item.target.match,
      upstreamIdentity(item),
    ]);
    if (identities.has(identity)) {
      addIssue(
        warnings,
        'warning',
        'target_duplicate',
        `/targets/${item.index}`,
        'match 与实际上游身份和先前目标重复',
      );
    } else {
      identities.add(identity);
    }
  }

  const wiresByMatch = new Map();
  for (const item of inspectedTargets) {
    if (!item.matchValid || !item.wireValid) continue;
    const wires = wiresByMatch.get(item.target.match) || new Set();
    if (wires.size > 0 && !wires.has(item.provider.wireApi)) {
      addIssue(
        warnings,
        'warning',
        'target_wire_api_mixed',
        `/targets/${item.index}`,
        '相同 match 使用了不同 wire API',
      );
    }
    wires.add(item.provider.wireApi);
    wiresByMatch.set(item.target.match, wires);
  }

  const identityByExplicitDomain = new Map();
  for (const item of inspectedTargets) {
    if (!item.identityValid) continue;
    const explicitStateDomain = typeof item.target.stateDomain === 'string'
      ? item.target.stateDomain.trim()
      : '';
    if (!explicitStateDomain) continue;
    const identity = upstreamIdentity(item);
    const domainKey = JSON.stringify([item.provider.wireApi, explicitStateDomain]);
    const previousIdentity = identityByExplicitDomain.get(domainKey);
    if (previousIdentity !== undefined && previousIdentity !== identity) {
      addIssue(
        warnings,
        'warning',
        'state_domain_suspicious',
        `/targets/${item.index}/stateDomain`,
        '显式状态域被不同上游身份复用',
      );
    } else if (previousIdentity === undefined) {
      identityByExplicitDomain.set(domainKey, identity);
    }
  }
}

function environmentObject(context) {
  const env = context?.env;
  return env !== null && typeof env === 'object' ? env : {};
}

function selectPort(config, env) {
  const selected = selectedValue(
    env,
    'ROUTER_PORT',
    config.port === null ? undefined : config.port,
    15730,
  );
  return {
    ...selected,
    number: positiveInteger(selected.value, { max: 65_535 }),
  };
}

const REQUEST_LIMIT_DEFAULTS = Object.freeze({
  maxRequestBytes: 64 * 1024 * 1024,
  maxConcurrentRequests: 8,
  maxBufferedRequestBytes: 128 * 1024 * 1024,
});
const REQUEST_LIMIT_WARNING_THRESHOLDS = Object.freeze({
  maxRequestBytes: 256 * 1024 * 1024,
  maxBufferedRequestBytes: 512 * 1024 * 1024,
});

const CHECKPOINT_DEFAULTS = Object.freeze({
  maxEntries: 128,
  maxResponseIdsPerTask: 128,
});

const RESPONSE_HISTORY_DEFAULTS = Object.freeze({
  maxEntryBytes: 1024 * 1024,
  maxBytes: 16 * 1024 * 1024,
});

const MODEL_CAPABILITY_DEFAULTS = Object.freeze({
  contextWindow: 128_000,
  maxOutputTokens: 16_000,
  safetyRatio: 0.85,
  protocolReserveTokens: 512,
});

const VISION_RELAY_DEFAULTS = Object.freeze({
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
});

// 订阅生图桥接（ChatGPT 订阅账号 → OpenAI 兼容 /v1/images/*）：
// host/prefix 为 Responses 上游（api.openai.com/v1），conversationModel 是承载
// image_generation 工具的主对话模型；viaProxy=null 继承全局代理策略。
const IMAGE_BRIDGE_DEFAULTS = Object.freeze({
  enabled: true,
  host: 'api.openai.com',
  prefix: '/v1',
  conversationModel: 'gpt-5.4-mini',
  viaProxy: null,
  timeouts: {},
});

const IMAGE_BRIDGE_TIMEOUT_FIELDS = ['connectMs', 'responseHeaderMs', 'streamIdleMs', 'requestMs'];

const OAUTH_DEFAULTS = Object.freeze({
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  refreshSkewSeconds: 30,
  refreshTimeoutMs: 30_000,
  viaProxy: null,
});

function normalizedPositiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function normalizedInteger(value, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  return positiveInteger(value, { min: minimum, max: maximum });
}

function configuredValue(object, field) {
  return object[field] !== undefined;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function addInvalid(errors, code, issuePath, message = '配置值无效') {
  addIssue(errors, 'error', code, issuePath, message);
}

function inspectTimeoutConfig(config, errors) {
  const values = { ...DEFAULT_TIMEOUTS };
  if (config.timeouts === undefined || config.timeouts === null) return values;
  if (!plainObject(config.timeouts)) {
    addInvalid(errors, 'timeout_invalid', '/timeouts', '必须是普通对象');
    return values;
  }
  for (const field of ['connectMs', 'responseHeaderMs', 'streamIdleMs', 'requestMs']) {
    if (!configuredValue(config.timeouts, field)) continue;
    const number = normalizedPositiveNumber(config.timeouts[field]);
    if (number === null) {
      addInvalid(errors, 'timeout_invalid', `/timeouts/${field}`, '必须是有限正数');
    } else {
      values[field] = number;
    }
  }
  return values;
}

function inspectRequestLimits(config, errors, warnings) {
  const values = {};
  for (const field of Object.keys(REQUEST_LIMIT_DEFAULTS)) {
    const configured = config[field];
    if (configured === undefined || configured === null) {
      values[field] = REQUEST_LIMIT_DEFAULTS[field];
    } else {
      values[field] = normalizedInteger(configured);
      if (values[field] === null) {
        addInvalid(errors, 'request_limit_invalid', `/${field}`, '必须是正整数');
      }
    }
  }
  if (
    values.maxRequestBytes !== null
    && values.maxBufferedRequestBytes !== null
    && values.maxBufferedRequestBytes < values.maxRequestBytes
  ) {
    addInvalid(
      errors,
      'request_budget_conflict',
      '/maxBufferedRequestBytes',
      '总缓冲预算不能小于单请求上限',
    );
  }
  if (values.maxRequestBytes > REQUEST_LIMIT_WARNING_THRESHOLDS.maxRequestBytes) {
    addIssue(
      warnings,
      'warning',
      'request_limit_high_risk',
      '/maxRequestBytes',
      '单请求上限超过 256 MiB，JSON 解析可能造成高内存占用',
    );
  }
  if (values.maxBufferedRequestBytes > REQUEST_LIMIT_WARNING_THRESHOLDS.maxBufferedRequestBytes) {
    addIssue(
      warnings,
      'warning',
      'request_limit_high_risk',
      '/maxBufferedRequestBytes',
      '总缓冲预算超过 512 MiB，可能造成进程内存压力',
    );
  }
  return values;
}

function inspectProviderPool(config, errors) {
  if (config.providerPool === undefined) return;
  if (!plainObject(config.providerPool)) {
    addInvalid(errors, 'provider_pool_invalid', '/providerPool', '必须是普通对象');
    return;
  }
  for (const field of ['maxEntries', 'ttlMs']) {
    if (
      configuredValue(config.providerPool, field)
      && config.providerPool[field] !== null
      && normalizedInteger(config.providerPool[field]) === null
    ) {
      addInvalid(errors, 'provider_pool_invalid', `/providerPool/${field}`, '必须是正整数');
    }
  }
  for (const field of ['allowDefaultTarget', 'modelAffinity']) {
    if (
      configuredValue(config.providerPool, field)
      && config.providerPool[field] !== null
      && typeof config.providerPool[field] !== 'boolean'
    ) {
      addInvalid(errors, 'provider_pool_invalid', `/providerPool/${field}`, '必须是 boolean');
    }
  }
}

function inspectResponseHistory(config, errors) {
  if (config.responseHistory === undefined) return;
  if (!plainObject(config.responseHistory)) {
    addInvalid(errors, 'response_history_invalid', '/responseHistory', '必须是普通对象');
    return;
  }
  const values = { ...RESPONSE_HISTORY_DEFAULTS };
  for (const field of ['maxEntries', 'maxEntryBytes', 'maxBytes', 'ttlMs']) {
    if (!configuredValue(config.responseHistory, field) || config.responseHistory[field] === null) {
      continue;
    }
    values[field] = normalizedInteger(config.responseHistory[field]);
    if (values[field] === null) {
      addInvalid(errors, 'response_history_invalid', `/responseHistory/${field}`, '必须是正整数');
    }
  }
  if (
    values.maxEntryBytes !== undefined
    && values.maxEntryBytes !== null
    && values.maxBytes !== undefined
    && values.maxBytes !== null
    && values.maxEntryBytes > values.maxBytes
  ) {
    addInvalid(
      errors,
      'response_history_conflict',
      '/responseHistory/maxEntryBytes',
      '单条记录预算不能大于总预算',
    );
  }
}

function inspectGoalCheckpoint(config, errors) {
  if (config.goalCheckpoint === undefined) return;
  if (!plainObject(config.goalCheckpoint)) {
    addInvalid(errors, 'checkpoint_invalid', '/goalCheckpoint', '必须是普通对象');
    return;
  }
  const checkpoint = config.goalCheckpoint;
  if (
    configuredValue(checkpoint, 'enabled')
    && checkpoint.enabled !== null
    && typeof checkpoint.enabled !== 'boolean'
  ) {
    addInvalid(errors, 'checkpoint_invalid', '/goalCheckpoint/enabled', '必须是 boolean');
  }
  if (checkpoint.enabled === false) return;

  const values = {
    maxEntries: CHECKPOINT_DEFAULTS.maxEntries,
    maxResponseIdsPerTask: CHECKPOINT_DEFAULTS.maxResponseIdsPerTask,
    maxResponseIndexes: null,
  };
  for (const field of ['maxEntries', 'maxResponseIdsPerTask']) {
    if (!configuredValue(checkpoint, field) || checkpoint[field] === null) continue;
    values[field] = normalizedInteger(checkpoint[field]);
    if (values[field] === null) {
      addInvalid(errors, 'checkpoint_invalid', `/goalCheckpoint/${field}`, '必须是正整数');
    }
  }
  if (values.maxEntries !== null && values.maxResponseIdsPerTask !== null) {
    values.maxResponseIndexes = values.maxEntries * values.maxResponseIdsPerTask;
  }
  if (configuredValue(checkpoint, 'maxResponseIndexes') && checkpoint.maxResponseIndexes !== null) {
    values.maxResponseIndexes = normalizedInteger(checkpoint.maxResponseIndexes);
    if (values.maxResponseIndexes === null) {
      addInvalid(
        errors,
        'checkpoint_invalid',
        '/goalCheckpoint/maxResponseIndexes',
        '必须是正整数',
      );
    }
  }
  if (configuredValue(checkpoint, 'ttlMs') && checkpoint.ttlMs !== null) {
    if (normalizedInteger(checkpoint.ttlMs) === null) {
      addInvalid(errors, 'checkpoint_invalid', '/goalCheckpoint/ttlMs', '必须是正整数');
    }
  }
  if (
    configuredValue(checkpoint, 'sourceTokenBudget')
    && checkpoint.sourceTokenBudget !== null
    && normalizedInteger(checkpoint.sourceTokenBudget, 128) === null
  ) {
    addInvalid(
      errors,
      'checkpoint_invalid',
      '/goalCheckpoint/sourceTokenBudget',
      '必须是至少 128 的整数',
    );
  }
  if (configuredValue(checkpoint, 'sourceWindowRatio') && checkpoint.sourceWindowRatio !== null) {
    const ratio = normalizedPositiveNumber(checkpoint.sourceWindowRatio);
    if (ratio === null || ratio > 1) {
      addInvalid(
        errors,
        'checkpoint_invalid',
        '/goalCheckpoint/sourceWindowRatio',
        '必须大于 0 且不大于 1',
      );
    }
  }
  if (
    configuredValue(checkpoint, 'maxOutputTokens')
    && checkpoint.maxOutputTokens !== null
    && normalizedInteger(checkpoint.maxOutputTokens, 256) === null
  ) {
    addInvalid(
      errors,
      'checkpoint_invalid',
      '/goalCheckpoint/maxOutputTokens',
      '必须是至少 256 的整数',
    );
  }
  if (configuredValue(checkpoint, 'requestMs') && checkpoint.requestMs !== null) {
    const requestMs = normalizedPositiveNumber(checkpoint.requestMs);
    if (requestMs === null || requestMs < 1_000) {
      addInvalid(
        errors,
        'checkpoint_invalid',
        '/goalCheckpoint/requestMs',
        '必须是至少 1000 的有限正数',
      );
    }
  }
  if (
    values.maxEntries !== null
    && values.maxResponseIndexes !== null
    && values.maxResponseIndexes < values.maxEntries
  ) {
    addInvalid(
      errors,
      'checkpoint_conflict',
      '/goalCheckpoint/maxResponseIndexes',
      '响应索引上限不能小于检查点上限',
    );
  }
}

function inspectCheckpointPersistence(config, context, errors, warnings) {
  const checkpoint = plainObject(config.goalCheckpoint) ? config.goalCheckpoint : null;
  const persistence = checkpoint?.persistence;
  if (persistence === undefined || persistence === null) return { enabled: false };
  if (!plainObject(persistence)) {
    addInvalid(
      errors,
      'checkpoint_invalid',
      '/goalCheckpoint/persistence',
      '必须是普通对象',
    );
    return { enabled: false };
  }
  if (
    configuredValue(persistence, 'enabled')
    && persistence.enabled !== null
    && typeof persistence.enabled !== 'boolean'
  ) {
    addInvalid(
      errors,
      'checkpoint_invalid',
      '/goalCheckpoint/persistence/enabled',
      '必须是 boolean',
    );
  }
  if (persistence.enabled !== true) return { enabled: false };
  if (checkpoint?.enabled === false) {
    addInvalid(
      errors,
      'checkpoint_conflict',
      '/goalCheckpoint/persistence/enabled',
      '检查点关闭时不能启用持久化',
    );
  }

  const selectedPath = {
    value: persistence.path,
    path: '/goalCheckpoint/persistence/path',
  };
  if (!validRuntimePath(selectedPath.value)) {
    addInvalid(errors, 'checkpoint_invalid', selectedPath.path, '启用时必须是非空安全路径');
  }
  if (
    configuredValue(persistence, 'stateGeneration')
    && !nonEmptyString(persistence.stateGeneration)
  ) {
    addInvalid(
      errors,
      'checkpoint_invalid',
      '/goalCheckpoint/persistence/stateGeneration',
      '必须是非空字符串',
    );
  }

  const rules = [
    ['debounceMs', 10, 1_000],
    ['maxBytes', 1_024, 16 * 1024 * 1024],
    ['lockHeartbeatMs', 100, 5_000],
    ['lockStaleMs', 300, 30_000],
  ];
  const values = {};
  for (const [field, minimum, fallback] of rules) {
    const configured = persistence[field];
    const value = configured === undefined || configured === null
      ? fallback
      : normalizedInteger(configured, minimum);
    values[field] = value;
    if (value === null) {
      addInvalid(
        errors,
        'checkpoint_invalid',
        `/goalCheckpoint/persistence/${field}`,
        `必须是至少 ${minimum} 的整数`,
      );
    }
  }
  if (
    values.lockHeartbeatMs !== null
    && values.lockStaleMs !== null
    && values.lockStaleMs < values.lockHeartbeatMs * 3
  ) {
    addInvalid(
      errors,
      'checkpoint_invalid',
      '/goalCheckpoint/persistence/lockStaleMs',
      '必须至少是锁心跳间隔的三倍',
    );
  }

  return {
    enabled: true,
    path: resolveSelectedPath(selectedPath, contextBaseDirectory(context), warnings),
    stateGeneration: persistence.stateGeneration || '',
    debounceMs: values.debounceMs,
    maxBytes: values.maxBytes,
    lockHeartbeatMs: values.lockHeartbeatMs,
    lockStaleMs: values.lockStaleMs,
  };
}

function compilablePattern(value) {
  if (!nonEmptyString(value)) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function inspectModelCapabilities(config, errors) {
  if (config.modelCapabilities === undefined || config.modelCapabilities === null) return;
  if (!Array.isArray(config.modelCapabilities)) {
    addInvalid(errors, 'model_capability_invalid', '/modelCapabilities', '必须是数组');
    return;
  }
  config.modelCapabilities.forEach((capability, index) => {
    const basePath = `/modelCapabilities/${index}`;
    if (!plainObject(capability)) {
      addInvalid(errors, 'model_capability_invalid', basePath, '必须是普通对象');
      return;
    }

    if (!compilablePattern(capability.match)) {
      addInvalid(
        errors,
        'model_capability_invalid',
        `${basePath}/match`,
        '必须是可编译的非空正则字符串',
      );
    }

    const resolved = { ...MODEL_CAPABILITY_DEFAULTS };
    const validity = {};
    for (const field of ['contextWindow', 'maxOutputTokens']) {
      if (!configuredValue(capability, field)) continue;
      const value = normalizedInteger(capability[field]);
      validity[field] = value !== null;
      if (validity[field]) resolved[field] = value;
      else addInvalid(errors, 'model_capability_invalid', `${basePath}/${field}`, '必须是正整数');
    }
    if (configuredValue(capability, 'safetyRatio')) {
      const ratio = normalizedPositiveNumber(capability.safetyRatio);
      validity.safetyRatio = ratio !== null && ratio <= 1;
      if (validity.safetyRatio) resolved.safetyRatio = ratio;
      else {
        addInvalid(
          errors,
          'model_capability_invalid',
          `${basePath}/safetyRatio`,
          '必须大于 0 且不大于 1',
        );
      }
    }
    for (const field of ['protocolReserveTokens', 'imageTokens']) {
      if (!configuredValue(capability, field)) continue;
      const value = capability[field] === null
        ? 0
        : normalizedInteger(capability[field], field === 'imageTokens' ? 1 : 0);
      validity[field] = value !== null;
      if (validity[field]) resolved[field] = value;
      else {
        addInvalid(
          errors,
          'model_capability_invalid',
          `${basePath}/${field}`,
          field === 'imageTokens' ? '必须是正整数' : '必须是非负整数',
        );
      }
    }

    const windowFieldsValid = [
      'contextWindow',
      'maxOutputTokens',
      'safetyRatio',
      'protocolReserveTokens',
    ].every((field) => validity[field] !== false);
    if (
      windowFieldsValid
      && Math.floor(resolved.contextWindow * resolved.safetyRatio)
        <= resolved.maxOutputTokens + resolved.protocolReserveTokens
    ) {
      addInvalid(
        errors,
        'model_capability_invalid',
        `${basePath}/maxOutputTokens`,
        '安全上下文窗口必须大于输出与协议预留之和',
      );
    }
  });
}

function inspectModelContext(config, errors) {
  if (config.modelContext === undefined || config.modelContext === null) return;
  if (!plainObject(config.modelContext)) {
    addInvalid(errors, 'model_context_invalid', '/modelContext', '必须是普通对象');
    return;
  }
  const modelContext = config.modelContext;
  if (
    configuredValue(modelContext, 'enabled')
    && modelContext.enabled !== null
    && typeof modelContext.enabled !== 'boolean'
  ) {
    addInvalid(errors, 'model_context_invalid', '/modelContext/enabled', '必须是 boolean');
  }
  if (modelContext.enabled === false) return;

  const values = {};
  if (configuredValue(modelContext, 'contextWindow')) {
    values.contextWindow = normalizedInteger(modelContext.contextWindow);
    if (values.contextWindow === null) {
      addInvalid(
        errors,
        'model_context_invalid',
        '/modelContext/contextWindow',
        '必须是正整数',
      );
    }
  }
  if (configuredValue(modelContext, 'autoCompactTokenLimit')) {
    if (modelContext.autoCompactTokenLimit === null) {
      values.autoCompactTokenLimit = null;
    } else {
      values.autoCompactTokenLimit = normalizedInteger(modelContext.autoCompactTokenLimit, 0);
    }
    if (values.autoCompactTokenLimit === null && modelContext.autoCompactTokenLimit !== null) {
      addInvalid(
        errors,
        'model_context_invalid',
        '/modelContext/autoCompactTokenLimit',
        '必须是非负整数',
      );
    }
  }
  if (
    configuredValue(modelContext, 'slugs')
    && modelContext.slugs !== null
    && !stringArray(modelContext.slugs)
  ) {
    addInvalid(
      errors,
      'model_context_invalid',
      '/modelContext/slugs',
      '必须是字符串数组',
    );
  }
  // 按 slug 覆盖：每项 { slug, contextWindow?, autoCompactTokenLimit? }。
  if (configuredValue(modelContext, 'overrides') && modelContext.overrides !== null) {
    if (!Array.isArray(modelContext.overrides)) {
      addInvalid(errors, 'model_context_invalid', '/modelContext/overrides', '必须是数组');
    } else {
      modelContext.overrides.forEach((entry, index) => {
        const at = `/modelContext/overrides/${index}`;
        if (!plainObject(entry) || typeof entry.slug !== 'string' || !entry.slug) {
          addInvalid(errors, 'model_context_invalid', at, '必须是含非空 slug 字符串的对象');
          return;
        }
        if (entry.contextWindow !== undefined && normalizedInteger(entry.contextWindow) === null) {
          addInvalid(errors, 'model_context_invalid', `${at}/contextWindow`, '必须是正整数');
        }
        if (
          entry.autoCompactTokenLimit !== undefined
          && entry.autoCompactTokenLimit !== null
          && normalizedInteger(entry.autoCompactTokenLimit, 0) === null
        ) {
          addInvalid(errors, 'model_context_invalid', `${at}/autoCompactTokenLimit`, '必须是非负整数');
        }
        if (
          Number.isFinite(Number(entry.contextWindow)) && Number(entry.contextWindow) > 0
          && Number.isFinite(Number(entry.autoCompactTokenLimit))
          && Number(entry.autoCompactTokenLimit) > Number(entry.contextWindow)
        ) {
          addInvalid(errors, 'model_context_invalid', `${at}/autoCompactTokenLimit`, '自动压缩阈值不能大于上下文窗口');
        }
      });
    }
  }
  if (
    values.contextWindow !== undefined
    && values.contextWindow !== null
    && values.autoCompactTokenLimit !== undefined
    && values.autoCompactTokenLimit !== null
    && values.autoCompactTokenLimit > values.contextWindow
  ) {
    addInvalid(
      errors,
      'model_context_invalid',
      '/modelContext/autoCompactTokenLimit',
      '自动压缩阈值不能大于上下文窗口',
    );
  }
}

function inspectSupportsResponses(config, errors) {
  if (config.supportsResponses === undefined || config.supportsResponses === null) return;
  if (!plainObject(config.supportsResponses)) {
    addInvalid(errors, 'model_capability_invalid', '/supportsResponses', '必须是普通对象');
    return;
  }
  if (
    configuredValue(config.supportsResponses, 'slugs')
    && config.supportsResponses.slugs !== null
    && !stringArray(config.supportsResponses.slugs)
  ) {
    addInvalid(
      errors,
      'model_capability_invalid',
      '/supportsResponses/slugs',
      '必须是字符串数组',
    );
  }
}

function inspectOauth(config, errors) {
  const values = { ...OAUTH_DEFAULTS };
  if (config.oauth === undefined) return values;
  if (!plainObject(config.oauth)) {
    addInvalid(errors, 'oauth_invalid', '/oauth', '必须是普通对象');
    return values;
  }
  const oauth = config.oauth;
  if (
    configuredValue(oauth, 'client_id')
    && oauth.client_id !== null
    && !nonEmptyString(oauth.client_id)
  ) {
    addInvalid(errors, 'oauth_invalid', '/oauth/client_id', '必须是非空字符串');
  }
  for (const field of ['refresh_skew_seconds', 'refresh_timeout_ms']) {
    if (
      configuredValue(oauth, field)
      && oauth[field] !== null
      && normalizedPositiveNumber(oauth[field]) === null
    ) {
      addInvalid(errors, 'oauth_invalid', `/oauth/${field}`, '必须是有限正数');
    }
  }
  if (
    configuredValue(oauth, 'viaProxy')
    && oauth.viaProxy !== null
    && typeof oauth.viaProxy !== 'boolean'
  ) {
    addInvalid(errors, 'oauth_invalid', '/oauth/viaProxy', '必须是 null 或 boolean');
  }
  if (nonEmptyString(oauth.client_id)) values.clientId = oauth.client_id;
  const refreshSkewSeconds = normalizedPositiveNumber(oauth.refresh_skew_seconds);
  if (refreshSkewSeconds !== null) values.refreshSkewSeconds = refreshSkewSeconds;
  const refreshTimeoutMs = normalizedPositiveNumber(oauth.refresh_timeout_ms);
  if (refreshTimeoutMs !== null) values.refreshTimeoutMs = refreshTimeoutMs;
  if (typeof oauth.viaProxy === 'boolean') values.viaProxy = oauth.viaProxy;
  return values;
}

function validRuntimePath(value) {
  return nonEmptyString(value) && !/[\r\n]/.test(value);
}

function contextBaseDirectory(context) {
  if (validRuntimePath(context?.baseDir)) return context.baseDir;
  if (validRuntimePath(context?.configPath)) return path.dirname(context.configPath);
  return undefined;
}

function resolveSelectedPath(selected, baseDir, warnings) {
  if (!validRuntimePath(selected.value)) return undefined;
  if (path.isAbsolute(selected.value)) return selected.value;
  addIssue(
    warnings,
    'warning',
    'relative_path',
    selected.path,
    '相对路径已按配置基准目录解析',
  );
  return baseDir === undefined
    ? undefined
    : path.normalize(path.join(baseDir, selected.value));
}

function inspectRuntimePaths(config, context, env, errors, warnings) {
  const configuredPaths = plainObject(config.paths) ? config.paths : {};
  if (
    config.paths !== undefined
    && config.paths !== null
    && !plainObject(config.paths)
  ) {
    addInvalid(errors, 'path_invalid', '/paths', '必须是普通对象');
  } else {
    for (const field of ['auth', 'catalog']) {
      const value = configuredPaths[field];
      if (value === undefined || value === null) continue;
      if (!validRuntimePath(value)) {
        addInvalid(
          errors,
          'path_invalid',
          `/paths/${field}`,
          '必须是非空且不含换行的字符串',
        );
      }
    }
  }

  let codexHome;
  if (Object.hasOwn(env, 'CODEX_HOME')) {
    if (validRuntimePath(env.CODEX_HOME)) {
      codexHome = env.CODEX_HOME;
    } else {
      addInvalid(
        errors,
        'path_invalid',
        '$env/CODEX_HOME',
        '必须是非空且不含换行的字符串',
      );
    }
  } else if (validRuntimePath(context?.defaultCodexHome)) {
    codexHome = context.defaultCodexHome;
  }

  const baseDir = contextBaseDirectory(context);
  const selectConfiguredPath = (field, envName, filename) => {
    if (Object.hasOwn(env, envName)) {
      const selected = { value: env[envName], path: `$env/${envName}` };
      if (!validRuntimePath(selected.value)) {
        addInvalid(
          errors,
          'path_invalid',
          selected.path,
          '必须是非空且不含换行的字符串',
        );
        return undefined;
      }
      return resolveSelectedPath(selected, baseDir, warnings);
    }
    if (
      configuredPaths[field] !== undefined
      && configuredPaths[field] !== null
      && validRuntimePath(configuredPaths[field])
    ) {
      return resolveSelectedPath(
        { value: configuredPaths[field], path: `/paths/${field}` },
        baseDir,
        warnings,
      );
    }
    return codexHome === undefined ? undefined : path.join(codexHome, filename);
  };

  return {
    codexHome,
    authPath: selectConfiguredPath('auth', 'CODEX_AUTH_PATH', 'auth.json'),
    catalogPath: selectConfiguredPath('catalog', 'CODEX_CATALOG_PATH', 'models.json'),
  };
}

const VISION_RELAY_TIMEOUT_FIELDS = [
  'connectMs',
  'responseHeaderMs',
  'streamIdleMs',
  'requestMs',
];

function normalizedVisionRelay(configured) {
  const relay = { ...VISION_RELAY_DEFAULTS };
  if (!plainObject(configured)) return relay;

  // 未知扩展字段原样深克隆；已知字段只在类型安全时覆盖默认值。
  const knownFields = new Set([
    ...Object.keys(VISION_RELAY_DEFAULTS),
    'prompt',
    'timeouts',
  ]);
  for (const [field, value] of Object.entries(configured)) {
    if (!knownFields.has(field)) relay[field] = structuredClone(value);
  }

  if (nonEmptyString(configured.host) && !/[\r\n]/.test(configured.host)) {
    relay.host = configured.host;
  }
  if (validEndpointPath(configured.prefix, false)) relay.prefix = configured.prefix;
  if (nonEmptyString(configured.model)) relay.model = configured.model;
  if (nonEmptyString(configured.envKey) && ENV_NAME.test(configured.envKey)) {
    relay.envKey = configured.envKey;
  }
  if (typeof configured.viaProxy === 'boolean') relay.viaProxy = configured.viaProxy;

  const concurrency = normalizedInteger(configured.concurrency, 1, 8);
  if (concurrency !== null) relay.concurrency = concurrency;
  for (const field of ['maxImagesPerRequest', 'cacheMaxEntries', 'cacheMaxBytes', 'maxTokens']) {
    const number = normalizedInteger(configured[field]);
    if (number !== null) relay[field] = number;
  }

  if (nonEmptyString(configured.prompt)) relay.prompt = configured.prompt;
  if (plainObject(configured.timeouts)) {
    const timeouts = {};
    for (const [field, value] of Object.entries(configured.timeouts)) {
      if (!VISION_RELAY_TIMEOUT_FIELDS.includes(field)) {
        timeouts[field] = structuredClone(value);
        continue;
      }
      const number = normalizedPositiveNumber(value);
      if (number !== null) timeouts[field] = number;
    }
    relay.timeouts = timeouts;
  }
  return relay;
}

function inspectVisionRelay(config, env, errors, warnings) {
  const needsRelay = Array.isArray(config.targets)
    && config.targets.some((target) => plainObject(target) && target.vision === false);
  const configuredIsObject = plainObject(config.visionRelay);
  const configured = configuredIsObject ? config.visionRelay : {};
  const relay = normalizedVisionRelay(configured);
  if (!needsRelay) return relay;

  if (
    config.visionRelay !== undefined
    && config.visionRelay !== null
    && !configuredIsObject
  ) {
    addInvalid(errors, 'vision_relay_invalid', '/visionRelay', '必须是普通对象');
    return relay;
  }

  for (const [field, message, validate] of [
    ['host', '必须是非空且不含换行的字符串', (value) => nonEmptyString(value) && !/[\r\n]/.test(value)],
    ['prefix', '必须是以 / 开头且不含换行的非空路径', (value) => validEndpointPath(value, false)],
    ['model', '必须是非空字符串', nonEmptyString],
    ['envKey', '必须是合法环境变量名', (value) => nonEmptyString(value) && ENV_NAME.test(value)],
  ]) {
    if (configuredValue(configured, field) && !validate(configured[field])) {
      addInvalid(errors, 'vision_relay_invalid', `/visionRelay/${field}`, message);
    }
  }
  if (
    configuredValue(configured, 'viaProxy')
    && configured.viaProxy !== null
    && typeof configured.viaProxy !== 'boolean'
  ) {
    addInvalid(errors, 'vision_relay_invalid', '/visionRelay/viaProxy', '必须是 boolean');
  }
  if (
    configuredValue(configured, 'concurrency')
    && configured.concurrency !== null
    && normalizedInteger(configured.concurrency, 1, 8) === null
  ) {
    addInvalid(errors, 'vision_relay_invalid', '/visionRelay/concurrency', '必须是 1..8 的整数');
  }
  for (const field of ['maxImagesPerRequest', 'cacheMaxEntries', 'cacheMaxBytes', 'maxTokens']) {
    if (
      configuredValue(configured, field)
      && configured[field] !== null
      && normalizedInteger(configured[field]) === null
    ) {
      addInvalid(errors, 'vision_relay_invalid', `/visionRelay/${field}`, '必须是正整数');
    }
  }
  if (
    configuredValue(configured, 'prompt')
    && configured.prompt !== null
    && !nonEmptyString(configured.prompt)
  ) {
    addInvalid(errors, 'vision_relay_invalid', '/visionRelay/prompt', '必须是非空字符串');
  }

  // 多端点支持：endpoints 数组每项独立校验（host/model/envKey 必填，协议/前缀/代理可选）。
  // 运行时按轮询 + 额度冷却自动切换，单点额度耗尽不影响任务。
  if (configured.endpoints !== undefined && configured.endpoints !== null) {
    if (!Array.isArray(configured.endpoints) || configured.endpoints.length === 0) {
      addInvalid(errors, 'vision_relay_invalid', '/visionRelay/endpoints', '必须是至少一项的数组');
    } else {
      configured.endpoints.forEach((endpoint, index) => {
        const epPath = `/visionRelay/endpoints/${index}`;
        if (!plainObject(endpoint)) {
          addInvalid(errors, 'vision_relay_invalid', epPath, '必须是普通对象');
          return;
        }
        // 必填字段（host/model/envKey）：缺失或非法都报错；可选字段（prefix 等）仅存在时校验
        for (const [field, message, validate] of [
          ['host', '必须是非空且不含换行的字符串', (value) => nonEmptyString(value) && !/[\r\n]/.test(value)],
          ['model', '必须是非空字符串', nonEmptyString],
          ['envKey', '必须是合法环境变量名', (value) => nonEmptyString(value) && ENV_NAME.test(value)],
        ]) {
          if (endpoint[field] === undefined || endpoint[field] === null || !validate(endpoint[field])) {
            addInvalid(errors, 'vision_relay_invalid', `${epPath}/${field}`, message);
          }
        }
        if (
          endpoint.prefix !== undefined
          && endpoint.prefix !== null
          && !validEndpointPath(endpoint.prefix, true)
        ) {
          addInvalid(errors, 'vision_relay_invalid', `${epPath}/prefix`, '必须是以 / 开头且不含换行的路径');
        }
        if (
          endpoint.protocol !== undefined
          && endpoint.protocol !== null
          && endpoint.protocol !== 'http'
          && endpoint.protocol !== 'https'
        ) {
          addInvalid(errors, 'vision_relay_invalid', `${epPath}/protocol`, '必须是 http 或 https');
        }
        if (endpoint.viaProxy !== undefined && endpoint.viaProxy !== null && typeof endpoint.viaProxy !== 'boolean') {
          addInvalid(errors, 'vision_relay_invalid', `${epPath}/viaProxy`, '必须是 boolean');
        }
        if (
          endpoint.proxyUrl !== undefined
          && endpoint.proxyUrl !== null
          && !/^(?:http|socks5|ss|trojan|vless):\/\/[^\s]+$/i.test(String(endpoint.proxyUrl))
        ) {
          addInvalid(errors, 'vision_relay_invalid', `${epPath}/proxyUrl`, '必须是代理/节点链接');
        }
        if (endpoint.port !== undefined && endpoint.port !== null && strictTargetPort(endpoint.port) === false) {
          addInvalid(errors, 'vision_relay_invalid', `${epPath}/port`, '必须是 1..65535 的端口');
        }
      });
    }
  }

  if (configuredValue(configured, 'timeouts') && configured.timeouts !== null) {
    if (!plainObject(configured.timeouts)) {
      addInvalid(errors, 'vision_relay_invalid', '/visionRelay/timeouts', '必须是普通对象');
    } else {
      for (const field of VISION_RELAY_TIMEOUT_FIELDS) {
        if (
          configuredValue(configured.timeouts, field)
          && normalizedPositiveNumber(configured.timeouts[field]) === null
        ) {
          addInvalid(
            errors,
            'vision_relay_invalid',
            `/visionRelay/timeouts/${field}`,
            '必须是有限正数',
          );
        }
      }
    }
  }

  const envKeyValid = nonEmptyString(relay.envKey) && ENV_NAME.test(relay.envKey);
  if (envKeyValid && !usableEnvironmentValue(env, relay.envKey)) {
    addIssue(warnings, 'warning', 'env_missing', '/visionRelay/envKey', relay.envKey);
  }
  return relay;
}

function normalizedImageBridge(configured) {
  const bridge = { ...IMAGE_BRIDGE_DEFAULTS };
  if (!plainObject(configured)) return bridge;
  const knownFields = new Set([
    ...Object.keys(IMAGE_BRIDGE_DEFAULTS),
  ]);
  for (const [field, value] of Object.entries(configured)) {
    if (!knownFields.has(field)) bridge[field] = structuredClone(value);
  }
  if (typeof configured.enabled === 'boolean') bridge.enabled = configured.enabled;
  if (nonEmptyString(configured.host) && !/[\r\n]/.test(configured.host)) bridge.host = configured.host;
  if (validEndpointPath(configured.prefix, false)) bridge.prefix = configured.prefix;
  if (nonEmptyString(configured.conversationModel)) bridge.conversationModel = configured.conversationModel;
  if (typeof configured.viaProxy === 'boolean') bridge.viaProxy = configured.viaProxy;
  if (plainObject(configured.timeouts)) {
    const timeouts = {};
    for (const [field, value] of Object.entries(configured.timeouts)) {
      if (!IMAGE_BRIDGE_TIMEOUT_FIELDS.includes(field)) {
        timeouts[field] = structuredClone(value);
        continue;
      }
      const number = normalizedPositiveNumber(value);
      if (number !== null) timeouts[field] = number;
    }
    bridge.timeouts = timeouts;
  }
  return bridge;
}

function inspectImageBridge(config, errors) {
  const configuredIsObject = plainObject(config.imageBridge);
  const bridge = normalizedImageBridge(configuredIsObject ? config.imageBridge : {});
  if (config.imageBridge !== undefined && config.imageBridge !== null && !configuredIsObject) {
    addInvalid(errors, 'image_bridge_invalid', '/imageBridge', '必须是普通对象');
    return bridge;
  }
  const configured = configuredIsObject ? config.imageBridge : {};
  if (configuredValue(configured, 'enabled') && typeof configured.enabled !== 'boolean') {
    addInvalid(errors, 'image_bridge_invalid', '/imageBridge/enabled', '必须是 boolean');
  }
  // 显式禁用时跳过取值校验：功能已关闭，坏配置值不应让整个路由拒启动。
  if (configuredValue(configured, 'enabled') && configured.enabled === false) {
    return bridge;
  }
  for (const [field, message, validate] of [
    ['host', '必须是非空且不含换行的公开域名（拒绝 localhost/内网/IP 字面量）',
      (value) => nonEmptyString(value) && !/[\r\n:]/.test(value) && isSafePublicHostname(value)],
    ['prefix', '必须是以 / 开头且不含换行的非空路径', (value) => validEndpointPath(value, false)],
    ['conversationModel', '必须是非空字符串', nonEmptyString],
  ]) {
    if (configuredValue(configured, field) && !validate(configured[field])) {
      addInvalid(errors, 'image_bridge_invalid', `/imageBridge/${field}`, message);
    }
  }
  if (
    configuredValue(configured, 'viaProxy')
    && configured.viaProxy !== null
    && typeof configured.viaProxy !== 'boolean'
  ) {
    addInvalid(errors, 'image_bridge_invalid', '/imageBridge/viaProxy', '必须是 boolean 或 null');
  }
  if (configuredValue(configured, 'timeouts') && configured.timeouts !== null) {
    if (!plainObject(configured.timeouts)) {
      addInvalid(errors, 'image_bridge_invalid', '/imageBridge/timeouts', '必须是普通对象');
    } else {
      for (const field of IMAGE_BRIDGE_TIMEOUT_FIELDS) {
        if (
          configuredValue(configured.timeouts, field)
          && normalizedPositiveNumber(configured.timeouts[field]) === null
        ) {
          addInvalid(errors, 'image_bridge_invalid', `/imageBridge/timeouts/${field}`, '必须是有限正数');
        }
      }
    }
  }
  return bridge;
}

function inspectRouterConfigState(config, context = {}) {
  const isPlainObject = plainObject(config);

  if (!isPlainObject) {
    return {
      inspection: {
        errors: [
          {
            severity: 'error',
            code: 'config_root_invalid',
            path: '',
            message: '配置根节点必须是普通对象',
          },
        ],
        warnings: [],
      },
    };
  }

  const errors = [];
  const warnings = [];
  const env = environmentObject(context);
  const port = selectPort(config, env);
  if (port.number === null) {
    addIssue(
      errors,
      'error',
      'port_invalid',
      port.path ?? '/port',
      '必须是 1..65535 的整数',
    );
  }

  const proxyMissing = config.proxy === undefined || config.proxy === null;
  const proxyInvalid = !proxyMissing && !plainObject(config.proxy);
  const configuredProxy = proxyMissing || proxyInvalid ? {} : config.proxy;
  const proxyHost = selectedValue(
    env,
    'V2RAY_HOST',
    configuredProxy.host === null ? undefined : configuredProxy.host,
    '127.0.0.1',
  );
  const proxyPort = selectedValue(
    env,
    'V2RAY_PORT',
    configuredProxy.port === null ? undefined : configuredProxy.port,
    10808,
  );
  const proxyPortNumber = positiveInteger(proxyPort.value, { max: 65_535 });
  if (proxyInvalid) {
    addIssue(
      errors,
      'error',
      'proxy_invalid',
      '/proxy',
      '必须是普通对象',
    );
  } else {
    if (
      typeof proxyHost.value !== 'string' ||
      proxyHost.value.trim() === '' ||
      /[\r\n]/.test(proxyHost.value)
    ) {
      addIssue(
        errors,
        'error',
        'proxy_invalid',
        proxyHost.path ?? '/proxy/host',
        '必须是非空且不含换行的字符串',
      );
    }
    if (proxyPortNumber === null) {
      addIssue(
        errors,
        'error',
        'proxy_invalid',
        proxyPort.path ?? '/proxy/port',
        '必须是 1..65535 的整数',
      );
    }
  }

  const heartbeat = selectedValue(
    env,
    'ROUTER_HEARTBEAT_MS',
    config.heartbeatMs === null ? undefined : config.heartbeatMs,
    15_000,
  );
  const heartbeatNumber = finiteNumber(heartbeat.value);
  if (heartbeatNumber === null || heartbeatNumber <= 0) {
    addIssue(
      errors,
      'error',
      'heartbeat_invalid',
      heartbeat.path ?? '/heartbeatMs',
      '必须是有限正数',
    );
  }

  const inspectedTargets = [];
  if (!Array.isArray(config.targets) || config.targets.length === 0) {
    addIssue(
      errors,
      'error',
      'targets_required',
      '/targets',
      '必须是非空数组',
    );
  } else {
    config.targets.forEach((target, index) => {
      const inspectedTarget = inspectTarget(target, index, env, errors, warnings);
      if (inspectedTarget) inspectedTargets.push(inspectedTarget);
    });
    // 本地 warning 全部按 target 顺序完成后，再按固定类别执行跨 target 检查。
    addCrossTargetWarnings(inspectedTargets, warnings);
  }

  const timeouts = inspectTimeoutConfig(config, errors);
  const requestLimits = inspectRequestLimits(config, errors, warnings);
  inspectProviderPool(config, errors);
  inspectResponseHistory(config, errors);
  inspectGoalCheckpoint(config, errors);
  const goalCheckpointPersistence = inspectCheckpointPersistence(
    config,
    context,
    errors,
    warnings,
  );
  inspectModelCapabilities(config, errors);
  inspectModelContext(config, errors);
  inspectSupportsResponses(config, errors);
  const oauth = inspectOauth(config, errors);
  const runtimePaths = inspectRuntimePaths(config, context, env, errors, warnings);
  const visionRelay = inspectVisionRelay(config, env, errors, warnings);
  const imageBridge = inspectImageBridge(config, errors);

  return {
    inspection: { errors, warnings },
    values: {
      port: port.number,
      configPath: context?.configPath,
      ...runtimePaths,
      proxy: {
        host: proxyHost.value,
        port: proxyPortNumber,
      },
      timeouts,
      heartbeatMs: heartbeatNumber === null ? null : Math.max(10, heartbeatNumber),
      maxRequestBytes: requestLimits.maxRequestBytes,
      requestBudget: {
        maxActive: requestLimits.maxConcurrentRequests,
        maxBytes: requestLimits.maxBufferedRequestBytes,
      },
      goalCheckpointPersistence,
      oauth,
      visionRelay,
      imageBridge,
    },
  };
}

export function inspectRouterConfig(config, context = {}) {
  return inspectRouterConfigState(config, context).inspection;
}

export function prepareRouterConfig(config, context = {}) {
  const inspected = inspectRouterConfigState(config, context);
  const inspection = inspected.inspection;
  if (inspection.errors.length > 0) {
    throw new RouterConfigError(inspection.errors);
  }

  const preparedConfig = structuredClone(config);
  // prepare 只消费 inspect 已校验且规范化的值，避免再次解析原始配置造成漂移。
  const runtime = inspected.values;

  const targets = Array.isArray(preparedConfig.targets)
    ? preparedConfig.targets.map((target) => {
        const compiled = structuredClone(target);
        compiled.matchSource = compiled.match;
        compiled.match = new RegExp(compiled.match);
        return compiled;
      })
    : [];

  return {
    config: preparedConfig,
    runtime,
    targets,
    warnings: inspection.warnings,
  };
}
