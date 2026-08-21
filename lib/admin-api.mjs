import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { inspectRouterConfig } from './router-config.mjs';
import { buildProviderAuthHeaders, resolveProvider } from './provider-adapters.mjs';
import { upstreamModel } from './chat-request.mjs';
import { rawHttpsRequest } from './transport.mjs';
import {
  commitRevisionedJson,
  readRevisionedJson,
} from './json-file-store.mjs';
import {
  exposeModelRoutingState,
  inspectModelRoutingPlan,
} from './model-routing-plan.mjs';
import { createModelRoutingTransaction } from './model-routing-transaction.mjs';
import {
  adminSecurityHeaders,
  inspectAdminRequest,
} from './admin-request-policy.mjs';
import {
  dbGetDashboardStats,
  dbSaveAccount,
  dbListAccounts,
  dbDeleteAccount,
  getDatabase,
} from './db.mjs';
import {
  VENDOR_PRESETS,
  getVendorPreset,
  buildTargetFromPreset,
  presetTargetKey,
  targetKeyOf,
  presetCategoryLabel,
} from './vendor-presets.mjs';
import {
  generateCodeVerifier,
  generateHexCodeVerifier,
  generateCodeChallenge,
  generateState,
  startLoopbackServer,
  openDefaultBrowser,
  extractCodeFromInput,
} from './auth/oauth-core.mjs';
import {
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleUserInfo,
  discoverGoogleProject,
} from './auth/google-sub-auth.mjs';
import {
  buildOpenAiAuthUrl,
  exchangeOpenAiCode,
  decodeOpenAiIdToken,
} from './auth/openai-sub-auth.mjs';
import {
  buildClaudeAuthUrl,
  exchangeClaudeCode,
  fetchClaudeModels,
} from './auth/claude-sub-auth.mjs';
import { fetchGoogleAvailableModels } from './auth/google-sub-auth.mjs';
import { CODEX_KNOWN_MODELS, fetchOpenAiCodexModels } from './auth/openai-sub-auth.mjs';
import { createApiKeyStore } from './api-keys.mjs';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_ADMIN_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PLACEHOLDER_TOKENS = 512;
const MAX_SECRET_DELETE_TOKENS = 64;
const MAX_CHECKPOINT_CONFIRMATIONS = 64;
const MAX_MODEL_ROUTING_CONFIRMATIONS = 128;
const ADMIN_CONFIRMATION_TTL_MS = 60_000;
const MODEL_ROUTING_CONFIRMATION_TTL_MS = 60_000;
// 模型连通性探测：回环请求经过完整路由管线，等待上游响应头的最长时间。
const MODEL_PROBE_TIMEOUT_MS = 30_000;
const MODEL_PROBE_ERROR_BODY_BYTES = 8 * 1024;
const ADMIN_SECURITY_HEADERS = adminSecurityHeaders();
const SAFE_ADMIN_ERROR_MESSAGES = Object.freeze({
  revision_conflict: '文件已被其他页面或进程修改',
  confirmation_invalid: '确认已失效，请重新预检',
  admin_body_too_large: '请求正文超过管理接口上限',
  admin_body_incomplete: '请求正文未完整传输',
  request_invalid: '管理请求内容无效',
  invalid_json: '请求正文不是有效 JSON',
  config_invalid: '配置预检未通过',
  config_too_large: '配置文件超过管理接口上限',
  config_write_failed: '配置保存失败，原文件已保留',
  secret_placeholder_invalid: '敏感字段占位已失效',
  secret_field_add_forbidden: '不得通过管理页新增敏感字段',
  secret_delete_confirmation_invalid: '敏感字段删除确认已失效',
  secret_delete_invalid: '敏感字段删除请求无效',
  model_routing_read_failed: '模型路由状态暂时不可用',
  model_routing_unavailable: '模型路由状态暂时不可用',
  transaction_failed: '模型路由事务未完成',
});
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',  'api-key',
  'cookie',
  'set-cookie',
]);

// 目标通道敏感头集合：内置认证头 + 自定义 authHeader/auth.header（脱敏专用）
function sensitiveHeadersForTarget(target) {
  const names = new Set(SENSITIVE_HEADERS);
  // 自定义认证头与常见认证头同样必须脱敏，不能因为换了名称就进入浏览器。
  for (const name of [target?.authHeader, target?.auth?.header]) {
    if (typeof name === 'string' && name.trim()) names.add(name.trim().toLowerCase());
  }
  return names;
}

// RFC6901 JSON Pointer 编码（~ 与 / 转义）
function jsonPointer(segments) {
  return `/${segments.map((segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

// 统一 JSON 响应：安全头 + no-store，杜绝浏览器缓存管理响应
function jsonResponse(res, status, body) {
  res.writeHead(status, {
    ...ADMIN_SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

// 管理错误脱敏：只输出白名单消息，路径/堆栈/内部细节不外泄
function safeAdminError(error) {
  const candidate = typeof error?.code === 'string' ? error.code : '';
  const code = Object.hasOwn(SAFE_ADMIN_ERROR_MESSAGES, candidate) ? candidate : 'admin_error';
  return {
    code,
    message: SAFE_ADMIN_ERROR_MESSAGES[code] || '管理请求未完成',
  };
}

// 带错误码的管理配置异常（响应映射用 code 区分状态）
function configIssue(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertOnlyFields(value, allowed, label) {
  if (!plainObject(value)) throw configIssue('request_invalid', `${label}必须是对象`);
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) throw configIssue('request_invalid', `${label}含未知字段`);
}

function validRevision(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function modelRoutingRequest(payload, allowConfirmation) {
  const allowed = new Set(['configRevision', 'catalogRevision', 'operations']);
  if (allowConfirmation) allowed.add('confirmation');
  assertOnlyFields(payload, allowed, '模型路由请求');
  if (!validRevision(payload.configRevision) || !validRevision(payload.catalogRevision)) {
    throw configIssue('request_invalid', 'configRevision 和 catalogRevision 必须是有效 revision');
  }
  if (!Array.isArray(payload.operations)) {
    throw configIssue('request_invalid', 'operations 必须是数组');
  }
  if (
    Object.hasOwn(payload, 'confirmation')
    && typeof payload.confirmation !== 'string'
  ) {
    throw configIssue('request_invalid', 'confirmation 必须是字符串');
  }
  return payload;
}

// 计划公开视图：只暴露影响摘要与确认需求，不含内部对象引用
function publicPlan(plan) {
  return {
    errors: plan.errors,
    warnings: plan.warnings,
    impact: plan.impact,
    operationDigest: plan.operationDigest,
  };
}

// 计划非法操作检查：返回首个阻止提交的错误描述
function operationPlanError(plan) {
  // catalog_* 是模型/通道语义错误，应走 422（带回 errors 明细），不是 400 结构性非法操作。
  return plan.errors.find((issue) => (
    (issue.path === '/operations' && !String(issue.code).startsWith('catalog_'))
    || issue.code === 'operation_invalid'
    || issue.code === 'operation_kind_unknown'
    || issue.code === 'target_ref_invalid'
    || issue.code === 'operation_sensitive_field'
    || issue.code === 'sensitive_field_forbidden'
  ));
}

function operationErrorResponse(res, issue) {
  const messages = {
    operation_kind_unknown: '操作 kind 无效',
    target_ref_invalid: 'targetRef 已失效或不存在',
    target_create_not_dedicated: '新增 target 必须精确绑定唯一模型',
    target_not_dedicated: '只能删除唯一模型拥有的精确专属 target',
    operation_sensitive_field: '操作含禁止的敏感字段',
    sensitive_field_forbidden: '操作含禁止的敏感字段',
  };
  jsonResponse(res, 400, {
    error: {
      code: issue.code,
      message: messages[issue.code] || '操作无效',
    },
  });
}

function destructiveImpact(impact) {
  return impact.models.deleted.length > 0
    || impact.targets.deleted.length > 0
    || impact.references.removed.length > 0
    || impact.references.replaced.length > 0
    || impact.models.updated.some((item) => item.from !== item.to);
}

function safeTxid(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)
    ? value
    : null;
}

function setBounded(map, key, value, maxEntries) {
  // 重复 key 视为最近访问，避免活跃页面的确认值先于旧页面被淘汰。
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) map.delete(map.keys().next().value);
}

function sensitiveValues(root) {
  const found = new Map();
  const walk = (value, segments, parentKey, sensitiveHeaders = SENSITIVE_HEADERS) => {
    if (Array.isArray(value)) {
      // 配置中的 targets 等集合也要继续递归，避免数组内的敏感请求头泄漏到管理页。
      value.forEach((child, index) => walk(
        child,
        [...segments, index],
        parentKey,
        parentKey === 'targets' ? sensitiveHeadersForTarget(child) : sensitiveHeaders,
      ));
      return;
    }
    if (!value || typeof value !== 'object') {
      if (parentKey === 'headers' && sensitiveHeaders.has(String(segments.at(-1)).toLowerCase())) {
        found.set(jsonPointer(segments), value);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (parentKey === 'headers' && sensitiveHeaders.has(key.toLowerCase())) {
        found.set(jsonPointer([...segments, key]), child);
      } else {
        walk(child, [...segments, key], key === 'headers' ? 'headers' : key, sensitiveHeaders);
      }
    }
  };
  walk(root, [], '');
  return found;
}

// JSON Pointer 写入（管理配置局部更新用）
function setAtPointer(root, pointer, value) {
  const segments = pointerSegments(pointer);
  let cursor = root;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment];
  cursor[segments.at(-1)] = value;
}

// JSON Pointer 反解：~1→/ 、~0→~
function pointerSegments(pointer) {
  return pointer.slice(1).split('/').map((segment) => (
    segment.replace(/~1/g, '/').replace(/~0/g, '~')
  ));
}

// JSON Pointer 删除：数组下标 splice、对象 delete，缺失返回 false
function deleteAtPointer(root, pointer) {
  const segments = pointerSegments(pointer);
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) return false;
    cursor = cursor[segment];
  }
  const last = segments.at(-1);
  if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, last)) return false;
  if (Array.isArray(cursor) && /^(0|[1-9]\d*)$/.test(last)) {
    cursor.splice(Number(last), 1);
  } else {
    delete cursor[last];
  }
  return true;
}

// JSON Pointer 读取：缺失路径返回 undefined
function getAtPointer(root, pointer) {
  const segments = pointerSegments(pointer);
  let cursor = root;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

// 配置存储选项（revision 键名等，供读写/提交共用）
function configStoreOptions(options) {
  return {
    maxBytes: MAX_CONFIG_BYTES,
    ...(options.configFileSystem ? { fileSystem: options.configFileSystem } : {}),
  };
}

// 读取管理配置（带 JSON 大小与错误码包装）
function readAdminConfig(options) {
  try {
    return readRevisionedJson(options.configPath, configStoreOptions(options));
  } catch (error) {
    if (error?.code === 'json_too_large') {
      throw configIssue('config_too_large', '配置文件超过大小上限');
    }
    throw error;
  }
}

// 读取并解析 JSON 请求体（超限排空但继续复用连接）
async function readJsonBody(req, maxBytes = MAX_ADMIN_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      if (tooLarge) continue;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        // 超限后释放已缓存引用，但继续排空请求流，以便稳定复用 keep-alive 连接。
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
  } catch {
    throw configIssue('admin_body_incomplete', '管理请求体未完整接收');
  }
  if (tooLarge) throw configIssue('admin_body_too_large', '管理请求体超过大小上限');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text || '{}');
  } catch {
    throw configIssue('invalid_json', '管理请求体必须是有效 UTF-8 JSON');
  }
}

// 原子提交管理配置（revision 冲突时抛错保留原文件）
function commitAdminConfig(options, config, expectedRevision) {
  try {
    return commitRevisionedJson(
      options.configPath,
      config,
      expectedRevision,
      configStoreOptions(options),
    );
  } catch (error) {
    if (error?.code === 'revision_conflict') throw error;
    throw configIssue('config_write_failed', '配置保存失败，原文件已保留');
  }
}

// ---------- 订阅账号 OAuth 授权会话 ----------
// 每平台最多一个进行中的授权会话；start 重复调用时旧的 loopback 服务器会被关闭。
// google/openai 走全自动 loopback 回调；claude 走「复制链接 + 粘贴 code」半自动模式
// （Anthropic redirect 白名单不含 localhost，与 sub2api 交互一致）。
const oauthSessions = new Map(); // provider -> session

function resetOAuthSession(provider) {
  const previous = oauthSessions.get(provider);
  if (previous?.server) {
    try { previous.server.close(); } catch { /* 已关闭 */ }
  }
  oauthSessions.delete(provider);
}

// OAuth 流程错误（带错误码与 HTTP 状态）
function oauthError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

// 令牌过期时间：上游秒数扣 300s 余量后转 epoch ms
function tokenExpiry(expiresIn) {
  return Date.now() + Math.max(60, Number(expiresIn || 3600) - 300) * 1000;
}

// ---------- 目标通道上游模型列表拉取 ----------
const TARGET_MODELS_MAX_BYTES = 4 * 1024 * 1024;
const TARGET_MODELS_MAX_ENTRIES = 512;

function fetchModelsError(code, message, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/** 把上游错误响应体提炼成一行人类可读摘要（JSON error/message/detail 或截断原文）。 */
function upstreamModelsErrorSummary(text) {
  let message = '';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error?.message === 'string') message = parsed.error.message;
    else if (typeof parsed?.message === 'string') message = parsed.message;
    else if (typeof parsed?.detail === 'string') message = parsed.detail;
  } catch { /* 非 JSON 错误体 */ }
  if (!message) message = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return message || '无错误详情';
}

/**
 * 解析 OpenAI 兼容的模型列表响应：{data:[{id}]} / {models:[{name|id}]} / 顶层数组。
 * 返回去重后的 [{ name }]，格式不可识别时返回 null。
 */
function parseUpstreamModelList(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed?.data) ? parsed.data
    : Array.isArray(parsed?.models) ? parsed.models
      : Array.isArray(parsed) ? parsed
        : null;
  if (!list) return null;
  const seen = new Set();
  const models = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry
      : typeof entry?.id === 'string' ? entry.id
        : typeof entry?.name === 'string' ? entry.name
          : '';
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    models.push({ name: trimmed });
    if (models.length >= TARGET_MODELS_MAX_ENTRIES) break;
  }
  return models;
}

/**
 * 向目标通道上游发起 GET 拉取可用模型列表。
 * 依次尝试 {prefix}/models、/v1/models、/models（404 时换下一个候选路径）；
 * 网络错误直接抛出，非 2xx 提炼上游错误摘要，响应格式不可识别时明确报错。
 */
async function fetchTargetModelList(target, apiKey, proxy) {
  const provider = resolveProvider(target);
  const headers = {
    accept: 'application/json',
    ...buildProviderAuthHeaders(provider, apiKey),
  };
  const prefix = typeof target.prefix === 'string' ? target.prefix.replace(/\/+$/, '') : '';
  const candidates = [...new Set([
    prefix ? `${prefix}/models` : null,
    '/v1/models',
    '/models',
  ].filter(Boolean))];
  let sawNotFound = false;
  for (const requestPath of candidates) {
    let outcome;
    try {
      outcome = await rawHttpsRequest({
        protocol: target.protocol === 'http' ? 'http' : 'https',
        host: target.host,
        port: target.port || undefined,
        path: requestPath,
        method: 'GET',
        viaProxy: target.viaProxy === true || Boolean(target.proxyUrl),
        proxy: target.proxyUrl || proxy,
        headers,
        timeouts: { connectMs: 10_000, responseHeaderMs: 20_000, requestMs: 25_000 },
        maxResponseBytes: TARGET_MODELS_MAX_BYTES,
      });
    } catch (error) {
      // 网络层失败换路径无意义，直接报错（错误正文只含主机与底层原因，不含凭据）
      throw fetchModelsError(
        'upstream_unreachable',
        `无法连接上游 ${target.host}：${error.message}`,
      );
    }
    if (outcome.status === 404) {
      sawNotFound = true;
      continue;
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      throw fetchModelsError(
        'upstream_error',
        `上游返回 ${outcome.status}：${upstreamModelsErrorSummary(outcome.bodyText)}`,
        outcome.status,
      );
    }
    const models = parseUpstreamModelList(outcome.bodyText);
    if (models) return models;
    throw fetchModelsError(
      'model_list_unrecognized',
      '上游响应不是可识别的模型列表格式（缺少 data/models 数组）',
    );
  }
  throw fetchModelsError(
    sawNotFound ? 'model_list_not_found' : 'fetch_models_failed',
    '上游未提供模型列表接口（候选路径均返回 404），请改用手动添加',
  );
}

export function createAdminHandler(options) {
  const placeholderTokens = new Map();
  const secretDeleteTokens = new Map();
  const modelRoutingConfirmations = new Map();
  const checkpointConfirmations = new Map();

  // ---------- API Key 管理（多工具接入：Trae / Qoder / OpenCode / Codex） ----------
  const apiKeyStore = options.apiKeyStore || createApiKeyStore({ db: getDatabase() });
  // 通道密钥池（同通道多账号 key / 双形态 / 优先级 / 冷却持久化）；未注入时相关端点整体不可用
  const keyPool = options.keyPool || null;
  // 内部回环探针 key 明文：进程启动后首次探测时轮换签发，仅存内存
  let internalProbeKey = '';

  /**
   * Codex 接入同步：把 [model_providers.router] 切到 env_key 模式。
   * 备份 config.toml 后原子写回；仅做段内精确行级替换，不动其他配置。
   */
  function syncCodexConfigEnvKey(enable) {
    const codexHome = options.defaultCodexHome;
    const configPath = codexHome ? path.join(codexHome, 'config.toml') : null;
    if (!configPath || !fs.existsSync(configPath)) {
      const err = new Error(`未找到 Codex 配置: ${configPath || '(defaultCodexHome 未注入)'}`);
      err.code = 'codex_config_missing';
      throw err;
    }
    const original = fs.readFileSync(configPath, 'utf8');
    const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const lines = original.split(/\r?\n/);
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*\[model_providers\.router\]\s*$/.test(lines[i])) start = i;
      else if (start !== -1 && /^\s*\[/.test(lines[i])) { end = i; break; }
    }
    if (start === -1) {
      const err = new Error('config.toml 中未找到 [model_providers.router] 段');
      err.code = 'codex_provider_missing';
      throw err;
    }
    const changes = [];
    let envKeyLine = -1;
    let authLine = -1;
    for (let i = start + 1; i < end; i += 1) {
      if (/^\s*env_key\s*=/.test(lines[i])) envKeyLine = i;
      if (/^\s*requires_openai_auth\s*=/.test(lines[i])) authLine = i;
    }
    if (enable) {
      if (envKeyLine === -1) {
        lines.splice(start + 1, 0, 'env_key = "ROUTER_API_KEY"');
        changes.push('新增 env_key = "ROUTER_API_KEY"');
      } else if (!/ROUTER_API_KEY/.test(lines[envKeyLine])) {
        lines[envKeyLine] = 'env_key = "ROUTER_API_KEY"';
        changes.push('改写 env_key = "ROUTER_API_KEY"');
      }
      if (authLine !== -1 && /true/.test(lines[authLine])) {
        lines[authLine] = lines[authLine].replace(/true/, 'false');
        changes.push('requires_openai_auth = false（改用 env_key Bearer）');
      }
    } else if (envKeyLine !== -1) {
      lines.splice(envKeyLine, 1);
      changes.push('移除 env_key 行');
      if (authLine !== -1 && /false/.test(lines[authLine])) {
        lines[authLine] = lines[authLine].replace(/false/, 'true');
        changes.push('requires_openai_auth = true（还原）');
      }
    }
    if (!changes.length) {
      return { changed: false, changes: [], backup: null };
    }
    fs.writeFileSync(backup, original, 'utf8');
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
    fs.renameSync(tmp, configPath);
    return { changed: true, changes, backup };
  }

  function setRouterEnvKeyVariable(key) {
    if (process.platform === 'win32') {
      execFileSync('setx', ['ROUTER_API_KEY', key], { stdio: 'ignore' });
      return 'setx ROUTER_API_KEY（用户级环境变量，重启 Codex 后生效）';
    }
    return '非 Windows 平台请手工 export ROUTER_API_KEY';
  }

  function syncKeyToCodexConfig(apiKey) {
    const configResult = syncCodexConfigEnvKey(true);
    const envResult = setRouterEnvKeyVariable(apiKey);
    return { config: configResult, env: envResult };
  }

  function restoreCodexConfig() {
    const configResult = syncCodexConfigEnvKey(false);
    return { config: configResult };
  }


  /**
   * 真实连通性探测：从本机回环向路由自身的 /v1/responses 发一条最小请求，
   * 让流量走完整路由管线（模型匹配 → 通道选择 → 凭据装配 → 上游连接）。
   * 延迟计到上游响应头返回为止；非 2xx 时透传路由/上游的真实错误摘要。
   * 与旧版随机数假数据的差别：目录里不存在的模型会得到 unknown_model，
   * 凭据缺失/额度冷却/上游 4xx/5xx 都会如实呈现。
   */
  function probeModelConnectivity(model) {
    // input 必须是 Responses 条目数组（字符串形式会被 chatgpt 后端拒绝：Input must be a list）；
    // stream 必须为 true（chatgpt 后端拒绝非流式：Stream must be set to true），
    // 探测只读到上游响应头即断开，不消费完整响应。
    const body = JSON.stringify({
      model,
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'ping' }],
      }],
      stream: true,
      max_output_tokens: 16,
    });
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve({ model, latencyMs: Date.now() - startedAt, ...result });
      };
      const probeHeaders = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      };
      // 鉴权开启时回环探测同样受 /v1/* 拦截：带上内部探针 key（不计入鉴权模式、
      // 不出现在管理页列表；明文只在进程内存中持有）。
      try {
        if (!internalProbeKey) internalProbeKey = apiKeyStore.rotateInternalProbeKey();
        if (internalProbeKey) probeHeaders.authorization = `Bearer ${internalProbeKey}`;
      } catch { /* 探针签发失败时退化为无鉴权探测（开放模式下仍可用） */ }
      const probe = http.request({
        host: '127.0.0.1',
        port: options.port,
        path: '/v1/responses',
        method: 'POST',
        headers: probeHeaders,
        timeout: MODEL_PROBE_TIMEOUT_MS,
      });
      probe.on('response', (probeRes) => {
        const status = probeRes.statusCode || 0;
        if (status >= 200 && status < 300) {
          // 上游已确认连通（SSE 首帧或 JSON 头已返回），无需读完响应体。
          probeRes.destroy();
          finish({ ok: true, status, message: `连接成功 (${Date.now() - startedAt}ms)` });
          return;
        }
        const chunks = [];
        let size = 0;
        probeRes.on('data', (chunk) => {
          if (size >= MODEL_PROBE_ERROR_BODY_BYTES) {
            probeRes.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        probeRes.on('error', () => { /* 提前断开按已收到的片段解析 */ });
        probeRes.once('close', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          finish({ ok: false, status, error: probeErrorSummary(status, text) });
        });
      });
      probe.on('timeout', () => {
        probe.destroy();
        finish({ ok: false, status: 0, error: `连接超时（${Math.round(MODEL_PROBE_TIMEOUT_MS / 1000)} 秒内上游无响应）` });
      });
      probe.on('error', (error) => {
        finish({ ok: false, status: 0, error: `回环探测失败: ${error.message}` });
      });
      probe.end(body);
    });
  }

  /** 把路由错误体（{error:{code,message,...}}）提炼成一行人类可读摘要。 */
  function probeErrorSummary(status, text) {
    let code = '';
    let message = '';
    let retryAt = '';
    try {
      const parsed = JSON.parse(text);
      const error = parsed?.error;
      if (error && typeof error === 'object') {
        code = typeof error.code === 'string' ? error.code : '';
        message = typeof error.message === 'string' ? error.message : '';
        retryAt = typeof error.retry_at === 'string' ? error.retry_at : '';
      }
      // 上游原生错误体（如 chatgpt 后端的 {"detail":"..."}）也提炼出来
      if (!message && typeof parsed?.detail === 'string') message = parsed.detail;
    } catch { /* 非 JSON 错误体 */ }
    if (!message) message = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    message = message.replace(/^router error:\s*/i, '');
    // 额度耗尽类原始英文摘要转中文友好提示
    const quotaMatch = message.match(/quota exhausted, retry at ([^\]]+)\]?/i);
    if (quotaMatch) {
      const when = new Date(quotaMatch[1]);
      const whenText = Number.isNaN(when.getTime()) ? quotaMatch[1] : when.toLocaleString('zh-CN');
      return `上游额度已耗尽，预计 ${whenText} 恢复`;
    }
    if (code === 'unknown_model') return '模型未在路由目录中注册（没有匹配的目标通道）';
    if (code === 'model_quota_cooldown') {
      return retryAt
        ? `模型处于额度冷却期，预计 ${new Date(retryAt).toLocaleString('zh-CN')} 恢复`
        : '模型处于额度冷却期';
    }
    if (message) return `HTTP ${status}: ${message}`;
    return `HTTP ${status}: 上游拒绝连接`;
  }

  /**
   * 授权完成后的统一入库：db 元数据 + vault 凭据 + authManager 内存态。
   * 账号 ID 以 email 为锚（重复授权同一账号 = 幂等覆盖）。
   * 账号代理跟随全局 oauthProxy（V2RAY_PORT 可改），避免硬编码默认端口在代理迁移后失效。
   */
  function persistAuthorizedAccount({ provider, email, planType, projectId, organizationUuid, credentials, extraMetadata = {} }) {
    const safeEmail = String(email || '').trim().toLowerCase();
    const accountId = safeEmail ? `${provider}_${safeEmail.replace(/[^a-z0-9._-]+/g, '_')}` : `${provider}_${Date.now()}`;
    const alias = safeEmail
      ? `${provider === 'google' ? 'Google' : provider === 'openai' ? 'ChatGPT' : 'Claude'} (${safeEmail})`
      : `${provider} account`;
    const accountProxyUrl = options.oauthProxy?.host
      ? `http://${options.oauthProxy.host}:${options.oauthProxy.port || 10808}`
      : 'http://127.0.0.1:10808';

    dbSaveAccount({
      id: accountId,
      provider,
      email: safeEmail,
      alias,
      proxy_enabled: 1,
      proxy_url: accountProxyUrl,
      metadata: JSON.stringify({
        planType: planType || '',
        projectId: projectId || '',
        organizationUuid: organizationUuid || '',
        ...extraMetadata,
      }),
    });
    options.credentialsVault?.set(accountId, credentials);

    const authManager = options.authManager;
    if (authManager) {
      const existing = authManager.getAccount(accountId);
      const metadata = {
        planType: planType || '',
        projectId: projectId || '',
        organizationUuid: organizationUuid || '',
        ...extraMetadata,
      };
      if (existing) {
        authManager.updateAccount(accountId, {
          credentials,
          email: safeEmail,
          expiresAt: credentials.expiresAt || 0,
          metadata,
        });
      } else {
        authManager.addAccount({
          id: accountId,
          provider,
          alias,
          email: safeEmail,
          credentials,
          expiresAt: credentials.expiresAt || 0,
          proxy: { enabled: true, url: accountProxyUrl },
          metadata,
        });
      }
    }

    return { id: accountId, provider, email: safeEmail, alias, planType: planType || '', projectId: projectId || '' };
  }

  /**
   * 用授权 code 完成三平台各自的 token 交换 + 账号信息补全 + 入库。
   */
  async function completeAuthorization(provider, { code, codeVerifier, redirectUri }) {
    const proxy = options.oauthProxy;
    if (provider === 'google') {
      const tokens = await exchangeGoogleCode({ code, codeVerifier, redirectUri, proxy });
      if (!tokens.refreshToken) {
        throw oauthError(
          'google_no_refresh_token',
          'Google 未返回 refresh_token（此前授权过且未撤销）。请到 Google 账号 → 安全 → 第三方访问 中撤销本应用后重试。',
        );
      }
      let email = '';
      let planType = '';
      let projectId = '';
      // userinfo / project 发现失败不阻塞授权（token 已到手，可后续刷新时补全）
      try { email = (await fetchGoogleUserInfo({ accessToken: tokens.accessToken, proxy })).email; } catch { /* 容错 */ }
      try {
        const discovered = await discoverGoogleProject({ accessToken: tokens.accessToken, proxy });
        planType = discovered.planType;
        projectId = discovered.projectId;
      } catch { /* 容错 */ }
      return persistAuthorizedAccount({
        provider,
        email,
        planType,
        projectId,
        credentials: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokenExpiry(tokens.expiresIn),
        },
      });
    }

    if (provider === 'openai') {
      const tokens = await exchangeOpenAiCode({ code, codeVerifier, redirectUri, proxy });
      if (!tokens.refreshToken) {
        throw oauthError('openai_no_refresh_token', 'OpenAI 未返回 refresh_token，请重试授权。');
      }
      let email = '';
      let planType = '';
      let organizationId = '';
      let chatgptAccountId = '';
      try {
        const claims = decodeOpenAiIdToken(tokens.idToken);
        email = claims.email;
        planType = claims.planType;
        organizationId = claims.organizationId;
        chatgptAccountId = claims.chatgptAccountId || '';
      } catch { /* ID token 缺失或不可解析时仅跳过展示信息 */ }
      return persistAuthorizedAccount({
        provider,
        email,
        planType,
        projectId: organizationId,
        extraMetadata: chatgptAccountId
          ? { chatgptAccountId }
          : {},
        credentials: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          expiresAt: tokenExpiry(tokens.expiresIn),
        },
      });
    }

    if (provider === 'claude') {
      const tokens = await exchangeClaudeCode({ code, codeVerifier, proxy });
      if (!tokens.refreshToken) {
        throw oauthError('claude_no_refresh_token', 'Claude 未返回 refresh_token，请重试授权。');
      }
      return persistAuthorizedAccount({
        provider,
        email: tokens.email,
        planType: tokens.organizationUuid ? 'Claude' : '',
        organizationUuid: tokens.organizationUuid,
        credentials: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          organizationUuid: tokens.organizationUuid,
          expiresAt: tokenExpiry(tokens.expiresIn),
        },
      });
    }

    throw oauthError('unsupported_provider', `不支持的授权平台: ${provider}`, 404);
  }

  /**
   * loopback 收到 code 后自动完成交换并更新会话状态（google/openai 全自动路径）。
   */
  function driveLoopbackCompletion(provider, session) {
    session.server.waitForCode().then(async ({ code }) => {
      session.status = 'exchanging';
      try {
        session.account = await completeAuthorization(provider, {
          code,
          codeVerifier: session.codeVerifier,
          redirectUri: session.server.redirectUri,
        });
        session.status = 'done';
      } catch (err) {
        session.status = 'error';
        session.error = { code: err.code || 'oauth_exchange_failed', message: err.message };
      } finally {
        try { session.server.close(); } catch { /* 已关闭 */ }
      }
    }).catch((err) => {
      session.status = 'error';
      session.error = { code: err.code || 'oauth_callback_failed', message: err.message };
      try { session.server.close(); } catch { /* 已关闭 */ }
    });
  }

  // 静态资源清单：管理页入口 + Vite 构建产物（web/assets/**）动态扫描，
  // 同时兼容根路径（/assets/**）与 /admin 前缀（/admin/assets/**）两种引用方式。
  const webAssets = new Map([
    ['/admin', ['index.html', 'text/html; charset=utf-8']],
    ['/admin/', ['index.html', 'text/html; charset=utf-8']],
    ['/admin/index.html', ['index.html', 'text/html; charset=utf-8']],
  ]);
  const MIME_BY_EXTENSION = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };
  if (options.webRoot) {
    try {
      for (const entry of fs.readdirSync(path.join(options.webRoot, 'assets'), { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const contentType = MIME_BY_EXTENSION[path.extname(entry.name).toLowerCase()];
        if (!contentType) continue;
        webAssets.set(`/assets/${entry.name}`, [`assets/${entry.name}`, contentType]);
        webAssets.set(`/admin/assets/${entry.name}`, [`assets/${entry.name}`, contentType]);
      }
    } catch { /* assets 目录不存在时仅保留入口页 */ }
  }

  // 清单是启动快照；web 重新构建后哈希文件名会变化，旧进程的清单会 miss。
  // 这里对 /assets/** 未命中的请求回退读磁盘，避免"重新构建后页面空白"。
  function diskAsset(assetPath) {
    if (!options.webRoot) return null;
    // 仅允许 assets 目录下的单个文件名，杜绝路径穿越与目录列举。
    const fileName = String(assetPath || '').replace(/^\/+/, '');
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return null;
    const contentType = MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()];
    if (!contentType) return null;
    try {
      const filePath = path.join(options.webRoot, 'assets', fileName);
      if (!fs.statSync(filePath).isFile()) return null;
      return [`assets/${fileName}`, contentType];
    } catch {
      return null;
    }
  }

  function context() {
    return {
      configPath: options.configPath,
      baseDir: path.dirname(options.configPath),
      defaultCodexHome: options.defaultCodexHome,
      env: options.env || {},
    };
  }

  function exposeConfig() {
    const current = readAdminConfig(options);
    const config = structuredClone(current.value);
    for (const pointer of sensitiveValues(current.value).keys()) {
      const token = crypto.randomUUID();
      // 令牌只记录校验所需元数据，不在内存缓存中重复保留原始敏感值。
      setBounded(placeholderTokens, token, {
        revision: current.revision,
        pointer,
      }, MAX_PLACEHOLDER_TOKENS);
      setAtPointer(config, pointer, { $preserveSecret: token });
    }
    const secretDeleteConfirmation = crypto.randomUUID();
    setBounded(
      secretDeleteTokens,
      secretDeleteConfirmation,
      {
        revision: current.revision,
        operation: 'config.secret-delete',
        expiresAt: (options.now || Date.now)() + ADMIN_CONFIRMATION_TTL_MS,
      },
      MAX_SECRET_DELETE_TOKENS,
    );
    return {
      revision: current.revision,
      config,
      secretDeleteConfirmation,
    };
  }

  function restoreSecrets(payload, current) {
    if (!payload || payload.revision !== current.revision) {
      throw configIssue('revision_conflict', '配置已被其他页面或进程修改，请重新载入');
    }
    if (!payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config)) {
      throw configIssue('config_invalid', 'config 必须是对象');
    }
    const restored = structuredClone(payload.config);
    const deletes = new Set(Array.isArray(payload.secretDeletes) ? payload.secretDeletes : []);
    const currentSecrets = sensitiveValues(current.value);
    // 第一版管理页只允许保留或确认删除已有敏感头，不能借请求体新增明文凭据。
    for (const pointer of sensitiveValues(restored).keys()) {
      if (!currentSecrets.has(pointer)) {
        throw configIssue('secret_field_add_forbidden', `管理页不能新增敏感字段：${pointer}`);
      }
    }
    if (deletes.size > 0) {
      const token = payload.secretDeleteConfirmation;
      const record = typeof token === 'string' ? secretDeleteTokens.get(token) : null;
      const now = (options.now || Date.now)();
      if (
        !record
        || record.revision !== current.revision
        || record.operation !== 'config.secret-delete'
        || record.expiresAt <= now
      ) {
        if (record?.expiresAt <= now) secretDeleteTokens.delete(token);
        throw configIssue('secret_delete_confirmation_invalid', '敏感字段删除确认值无效');
      }
    }
    for (const [pointer, originalValue] of currentSecrets) {
      if (deletes.has(pointer)) {
        if (!deleteAtPointer(restored, pointer)) {
          throw configIssue('secret_delete_invalid', `待删除敏感字段不存在：${pointer}`);
        }
        deletes.delete(pointer);
        continue;
      }
      const placeholder = getAtPointer(restored, pointer);
      const token = placeholder?.$preserveSecret;
      const record = typeof token === 'string' ? placeholderTokens.get(token) : null;
      if (
        !record
        || record.revision !== current.revision
        || record.pointer !== pointer
      ) {
        throw configIssue('secret_placeholder_invalid', `敏感字段占位无效：${pointer}`);
      }
      setAtPointer(restored, pointer, structuredClone(originalValue));
    }
    if (deletes.size > 0) {
      throw configIssue('secret_delete_invalid', `待删除敏感字段无效：${[...deletes][0]}`);
    }
    // 正常保留已还原原值，显式删除也已移除字段；任何剩余占位都不得进入预检或磁盘。
    const scan = (value) => {
      if (!value || typeof value !== 'object') return;
      if (!Array.isArray(value) && Object.hasOwn(value, '$preserveSecret')) {
        throw configIssue('secret_placeholder_invalid', '发现残留的敏感字段占位');
      }
      for (const child of Object.values(value)) scan(child);
    };
    scan(restored);
    return restored;
  }

  function statusBody() {
    return {
      port: options.runtime?.port,
      configPath: options.configPath,
      startedAt: options.startedAt,
      uptimeMs: Math.max(0, Date.now() - options.startedAt),
      warningCount: options.warnings?.length || 0,
      persistence: options.persistence?.status?.() || { mode: 'disabled' },
      targets: (options.targets || []).map((target) => {
        const provider = resolveProvider(target);
        return {
          name: target.name,
          match: target.matchSource || target.match,
          wireApi: provider.wireApi,
          upstreamModel: upstreamModel(target, ''),
          viaProxy: target.viaProxy === true,
          proxyUrl: typeof target.proxyUrl === 'string' ? target.proxyUrl : null,
          envKey: target.envKey || null,
          envSet: target.useOpenAiAuth === true
            || Boolean(target.envKey && Object.hasOwn(options.env || {}, target.envKey)
              && options.env[target.envKey]),
        };
      }),
    };
  }

  function checkpointBody() {
    const snapshot = options.checkpointStore.exportSnapshot();
    const expirations = snapshot.entries.map((entry) => entry.expiresAt).filter(Number.isFinite);
    const token = crypto.randomUUID();
    const record = {
      operation: 'checkpoints.clear',
      expiresAt: (options.now || Date.now)() + ADMIN_CONFIRMATION_TTL_MS,
    };
    setBounded(
      checkpointConfirmations,
      token,
      record,
      MAX_CHECKPOINT_CONFIRMATIONS,
    );
    return {
      count: snapshot.entries.length,
      bytes: Buffer.byteLength(JSON.stringify(snapshot)),
      earliestExpiresAt: expirations.length ? Math.min(...expirations) : null,
      latestExpiresAt: expirations.length ? Math.max(...expirations) : null,
      mode: options.persistence?.status?.().mode || 'disabled',
      confirmation: token,
    };
  }

  function readModelRoutingFiles() {
    if (typeof options.catalogPath !== 'string' || options.catalogPath === '') {
      throw configIssue('model_routing_unavailable', '模型目录路径未配置');
    }
    try {
      return {
        config: readRevisionedJson(options.configPath, { maxBytes: MAX_CONFIG_BYTES }),
        catalog: readRevisionedJson(options.catalogPath, { maxBytes: MAX_CATALOG_BYTES }),
      };
    } catch {
      // 文件路径和底层异常正文不进入联合管理 API。
      throw configIssue('model_routing_read_failed', '无法读取模型路由文件');
    }
  }

  function assertCurrentRevisions(payload, current) {
    if (
      payload.configRevision !== current.config.revision
      || payload.catalogRevision !== current.catalog.revision
    ) {
      throw configIssue('revision_conflict', '模型路由文件已被其他页面或进程修改，请重新载入');
    }
  }

  function inspectCurrentModelRouting(current, operations) {
    return inspectModelRoutingPlan({
      catalog: current.catalog.value,
      config: current.config.value,
      configRevision: current.config.revision,
      operations,
      context: context(),
    });
  }

  function confirmationFor(current, plan) {
    const now = (options.now || Date.now)();
    const token = (options.randomUUID || crypto.randomUUID)();
    const record = {
      configRevision: current.config.revision,
      catalogRevision: current.catalog.revision,
      operationDigest: plan.operationDigest,
      expiresAt: now + MODEL_ROUTING_CONFIRMATION_TTL_MS,
    };
    setBounded(
      modelRoutingConfirmations,
      token,
      record,
      MAX_MODEL_ROUTING_CONFIRMATIONS,
    );
    return { token, expiresAt: record.expiresAt };
  }

  function consumeConfirmation(payload, plan) {
    const record = modelRoutingConfirmations.get(payload.confirmation);
    const now = (options.now || Date.now)();
    if (
      !record
      || record.expiresAt <= now
      || record.configRevision !== payload.configRevision
      || record.catalogRevision !== payload.catalogRevision
      || record.operationDigest !== plan.operationDigest
    ) {
      if (record?.expiresAt <= now) modelRoutingConfirmations.delete(payload.confirmation);
      throw configIssue('confirmation_invalid', '破坏性操作确认值无效或已过期');
    }
    // 在任何 await 前同步消费，避免两个并发请求同时通过一次性校验。
    modelRoutingConfirmations.delete(payload.confirmation);
  }

  function transactionErrorResponse(res, error) {
    if (error?.code === 'revision_conflict') {
      jsonResponse(res, 409, {
        error: { code: 'revision_conflict', message: '模型路由文件已被外部修改' },
      });
      return;
    }
    if (error?.code === 'transaction_rolled_back') {
      jsonResponse(res, 409, {
        error: { code: 'transaction_rolled_back', message: '事务失败并已安全回滚' },
      });
      return;
    }
    if (error?.code === 'transaction_in_doubt') {
      const txid = safeTxid(error.txid);
      jsonResponse(res, 500, {
        error: {
          code: 'transaction_in_doubt',
          ...(txid ? { txid } : {}),
        },
      });
      return;
    }
    const code = new Set(['transaction_failed', 'invalid_transaction_paths']).has(error?.code)
      ? error.code
      : 'transaction_failed';
    jsonResponse(res, 500, {
      error: { code, message: '模型路由事务未提交' },
    });
  }

  // 内存缓存网关 admin 会话 cookie（跨请求复用，避免每个面板操作都重登一遍网关），
  // 失效时 ensureSession 会重新登录并覆盖。
  const gatewayCookieJar = { cookie: '' };

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url === '/_admin/api/status') {
      jsonResponse(res, 200, statusBody());
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/config') {
      jsonResponse(res, 200, exposeConfig());
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/models') {
      // 聚合目录模型与匹配通道，输出模型卡片所需的精简视图（不含任何凭据）。
      const current = readModelRoutingFiles();
      const exposed = exposeModelRoutingState(
        current.catalog.value,
        current.config.value,
        current.config.revision,
        options.env || {},
      );
      const targetByRef = new Map(exposed.targets.map((state) => [state.targetRef, state]));
      const models = exposed.models
        .filter((model) => typeof model?.slug === 'string' && model.slug)
        .map((model) => {
          const refs = exposed.bindings.find((binding) => binding.slug === model.slug)?.targetRefs || [];
          const primary = refs.length ? targetByRef.get(refs[0]) : null;
          return {
            slug: model.slug,
            displayName: typeof model.display_name === 'string' && model.display_name
              ? model.display_name
              : model.slug,
            contextWindow: Number(model.context_window) > 0 ? Number(model.context_window) : null,
            description: typeof model.description === 'string' ? model.description : '',
            // catalog 的实际字段是 default_reasoning_level（reasoning_effort 是历史误读，保留兼容兜底）
            reasoningEffort: typeof model.default_reasoning_level === 'string'
              ? model.default_reasoning_level
              : (typeof model.reasoning_effort === 'string' ? model.reasoning_effort : null),
            supportedReasoningLevels: Array.isArray(model.supported_reasoning_levels)
              ? model.supported_reasoning_levels
                  .map((level) => (typeof level?.effort === 'string' ? level.effort : null))
                  .filter(Boolean)
              : [],
            inputModalities: Array.isArray(model.input_modalities)
              ? model.input_modalities.filter((modality) => typeof modality === 'string')
              : ['text'],
            // Codex 增强插件能力（goal/computer_use 工具声明、web_search 浏览器搜索）
            supportedTools: Array.isArray(model.experimental_supported_tools)
              ? model.experimental_supported_tools.filter((tool) => typeof tool === 'string')
              : [],
            webSearchToolType: typeof model.web_search_tool_type === 'string'
              ? model.web_search_tool_type
              : null,
            supportsSearchTool: model.supports_search_tool === true,
            includeSkills: model.include_skills_usage_instructions === true,
            target: primary ? {
              name: primary.name,
              wireApi: primary.wireApi,
              vision: primary.vision !== false,
              envSet: primary.envSet === true,
              viaProxy: primary.viaProxy === true,
              proxyUrl: typeof primary.proxyUrl === 'string' ? primary.proxyUrl : null,
            } : null,
            matchedTargetCount: refs.length,
          };
        });
      jsonResponse(res, 200, {
        ok: true,
        models,
        configRevision: current.config.revision,
        catalogRevision: current.catalog.revision,
      });
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/model-routing') {
      const current = readModelRoutingFiles();
      const plan = inspectCurrentModelRouting(current, []);
      const exposed = exposeModelRoutingState(
        current.catalog.value,
        current.config.value,
        current.config.revision,
        options.env || {},
      );
      jsonResponse(res, 200, {
        configRevision: current.config.revision,
        catalogRevision: current.catalog.revision,
        ...exposed,
        errors: plan.errors,
        warnings: plan.warnings,
      });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/model-routing/validate') {
      const payload = modelRoutingRequest(await readJsonBody(req), false);
      const current = readModelRoutingFiles();
      assertCurrentRevisions(payload, current);
      const plan = inspectCurrentModelRouting(current, payload.operations);
      const invalidOperation = operationPlanError(plan);
      if (invalidOperation) {
        operationErrorResponse(res, invalidOperation);
        return true;
      }
      const response = publicPlan(plan);
      if (
        plan.errors.length === 0
        && plan.operationDigest
        && destructiveImpact(plan.impact)
      ) {
        response.confirmation = confirmationFor(current, plan);
      }
      jsonResponse(res, 200, response);
      return true;
    }
    if (req.method === 'PUT' && url === '/_admin/api/model-routing') {
      const payload = modelRoutingRequest(await readJsonBody(req), true);
      const current = readModelRoutingFiles();
      assertCurrentRevisions(payload, current);
      // 保存时必须重新从双文件计算，不能信任此前 validate 的结果。
      const plan = inspectCurrentModelRouting(current, payload.operations);
      const invalidOperation = operationPlanError(plan);
      if (invalidOperation) {
        operationErrorResponse(res, invalidOperation);
        return true;
      }
      if (plan.errors.length > 0) {
        jsonResponse(res, 422, publicPlan(plan));
        return true;
      }
      if (destructiveImpact(plan.impact)) consumeConfirmation(payload, plan);
      const transactionFactory = options.transactionFactory || createModelRoutingTransaction;
      try {
        const committed = await transactionFactory({
          configPath: options.configPath,
          catalogPath: options.catalogPath,
        }).commit({
          configRevision: current.config.revision,
          catalogRevision: current.catalog.revision,
          config: plan.config,
          catalog: plan.catalog,
        });
        if (
          !validRevision(committed?.configRevision)
          || !validRevision(committed?.catalogRevision)
          || !safeTxid(committed?.txid)
        ) {
          throw configIssue('transaction_failed', '模型路由事务返回值无效');
        }
        jsonResponse(res, 200, {
          configRevision: committed.configRevision,
          catalogRevision: committed.catalogRevision,
          txid: committed.txid,
          warnings: plan.warnings,
          restartRequired: true,
          clientRestartRequired: true,
        });
      } catch (error) {
        transactionErrorResponse(res, error);
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/config/validate') {
      const payload = await readJsonBody(req);
      const current = readAdminConfig(options);
      const config = restoreSecrets(payload, current);
      const result = inspectRouterConfig(config, context());
      jsonResponse(res, 200, result);
      return true;
    }
    if (req.method === 'PUT' && url === '/_admin/api/config') {
      const payload = await readJsonBody(req);
      const current = readAdminConfig(options);
      const config = restoreSecrets(payload, current);
      const inspected = inspectRouterConfig(config, context());
      if (inspected.errors.length) {
        jsonResponse(res, 422, inspected);
        return true;
      }
      const committed = commitAdminConfig(options, config, current.revision);
      if (Array.isArray(payload.secretDeletes) && payload.secretDeletes.length > 0) {
        secretDeleteTokens.delete(payload.secretDeleteConfirmation);
      }
      jsonResponse(res, 200, {
        revision: committed.revision,
        warnings: inspected.warnings,
        restartRequired: true,
      });
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/checkpoints') {
      jsonResponse(res, 200, checkpointBody());
      return true;
    }
    if (req.method === 'DELETE' && url === '/_admin/api/checkpoints') {
      const payload = await readJsonBody(req);
      const record = typeof payload.confirmation === 'string'
        ? checkpointConfirmations.get(payload.confirmation)
        : null;
      const now = (options.now || Date.now)();
      if (
        !record
        || record.operation !== 'checkpoints.clear'
        || record.expiresAt <= now
      ) {
        if (record?.expiresAt <= now) checkpointConfirmations.delete(payload.confirmation);
        jsonResponse(res, 409, {
          error: { code: 'confirmation_invalid', message: '检查点清空确认值无效或已过期' },
        });
        return true;
      }
      checkpointConfirmations.delete(payload.confirmation);
      if (options.persistence?.status?.().mode === 'readonly') {
        jsonResponse(res, 409, {
          error: { code: 'persistence_readonly', message: '当前实例未持有持久化写锁' },
        });
        return true;
      }
      try {
        const result = options.persistence?.clearRecoverably
          ? await options.persistence.clearRecoverably()
          : {
            removed: options.checkpointStore.clear(),
            backupPath: null,
            recoveryHint: '未启用持久化，仅清空当前内存检查点',
          };
        jsonResponse(res, 200, {
          ok: true,
          removed: result.removed,
          backupPath: result.backupPath,
          recoveryHint: result.recoveryHint,
        });
      } catch (error) {
        const status = error.code === 'persistence_readonly' ? 409 : 500;
        jsonResponse(res, status, {
          error: {
            code: error.code || 'checkpoint_clear_failed',
            message: error.code === 'persistence_readonly'
              ? '检查点持久化当前为只读'
              : '检查点清空失败，原状态已保留',
          },
        });
      }
      return true;
    }
    if (req.method === 'GET' && url.startsWith('/_admin/api/dashboard')) {
      const urlObj = new URL(req.url, 'http://127.0.0.1:15730');
      // days 仅接受 1..365 的有限整数，非法/越界回退默认 30 天
      const parsedDays = parseInt(urlObj.searchParams.get('days') || '30', 10);
      const days = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365
        ? parsedDays
        : 30;
      try {
        const stats = dbGetDashboardStats(days);
        jsonResponse(res, 200, { ok: true, ...stats });
      } catch (err) {
        jsonResponse(res, 500, { error: { code: 'dashboard_error', message: err.message } });
      }
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/token-usage') {
      const tracker = options.tokenTracker;
      if (!tracker) {
        jsonResponse(res, 200, {
          ok: true,
          enabled: false,
          summary: { totalRequests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
          models: {},
          timeline: [],
        });
        return true;
      }
      const models = {};
      for (const entry of tracker.getModelBreakdown()) models[entry.model] = entry;
      jsonResponse(res, 200, {
        ok: true,
        enabled: true,
        summary: tracker.getSummary(),
        models,
        timeline: tracker.getTimeline(),
      });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/token-usage/reset') {
      const tracker = options.tokenTracker;
      if (tracker && typeof tracker.reset === 'function') {
        tracker.reset();
      }
      jsonResponse(res, 200, { ok: true, message: 'Token 统计已重置' });
      return true;
    }

    // ---------- API Keys 密钥管理（为 Trae / Qoder / OpenCode / Codex 签发与鉴权） ----------
    if (req.method === 'GET' && url === '/_admin/api/keys') {
      jsonResponse(res, 200, {
        ok: true,
        keys: apiKeyStore.listKeys(),
        authEnforced: apiKeyStore.hasKeys(),
      });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/keys/create') {
      const payload = await readJsonBody(req);
      const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
      if (!name) {
        jsonResponse(res, 400, { error: { code: 'missing_name', message: '请填写密钥名称（如 trae / qoder / opencode / codex）' } });
        return true;
      }
      const client = typeof payload?.client === 'string' ? payload.client.trim().slice(0, 32) : 'generic';
      const description = typeof payload?.description === 'string' ? payload.description.trim().slice(0, 255) : '';
      try {
        const created = apiKeyStore.createKey({ name, client, description });
        jsonResponse(res, 200, { ok: true, key: created, authEnforced: true });
      } catch (err) {
        jsonResponse(res, 400, { error: { code: 'create_key_failed', message: err.message } });
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/keys/revoke') {
      const payload = await readJsonBody(req);
      const keyId = typeof payload?.id === 'string' ? payload.id.trim() : '';
      if (!keyId) {
        jsonResponse(res, 400, { error: { code: 'invalid_id', message: '请提供 key id' } });
        return true;
      }
      const revoked = apiKeyStore.revokeKey(keyId);
      jsonResponse(res, 200, { ok: true, revoked, authEnforced: apiKeyStore.hasKeys() });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/keys/sync-codex') {
      const payload = await readJsonBody(req);
      const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
      if (!apiKey || !apiKey.startsWith('sk-router-')) {
        jsonResponse(res, 400, { error: { code: 'invalid_key', message: '请提供有效的 sk-router-* 密钥' } });
        return true;
      }
      try {
        const synced = syncKeyToCodexConfig(apiKey);
        jsonResponse(res, 200, { ok: true, ...synced });
      } catch (err) {
        jsonResponse(res, 500, { error: { code: 'sync_codex_failed', message: err.message } });
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/keys/unsync-codex') {
      try {
        const unsynced = restoreCodexConfig();
        jsonResponse(res, 200, { ok: true, ...unsynced });
      } catch (err) {
        jsonResponse(res, 500, { error: { code: 'unsync_codex_failed', message: err.message } });
      }
      return true;
    }

    // ---------- 通道密钥池（同通道多账号 key / 双形态 / 优先级 / 冷却持久化） ----------

    // 生成不与既有 target 冲突的通道名（预设接入时避免与手建同名通道撞车）
    function uniqueTargetName(targets, baseName) {
      if (!targets.some((item) => item?.name === baseName)) return baseName;
      for (let i = 2; i < 100; i += 1) {
        const candidate = `${baseName}-${i}`;
        if (!targets.some((item) => item?.name === candidate)) return candidate;
      }
      throw configIssue('target_name_conflict', `无法为通道 ${baseName} 生成唯一名称`);
    }

    function resolveEnvValue(name) {
      if (typeof name !== 'string' || name.length === 0) return undefined;
      if (typeof options.getKey === 'function') return options.getKey(name);
      return (options.env || {})[name];
    }

    function codexConfigTomlPath() {
      const codexHome = options.defaultCodexHome;
      return codexHome ? path.join(codexHome, 'config.toml') : null;
    }

    // 按通道分组的密钥池全量（供管理页「密钥来源」列与通道级汇总）
    function groupEntriesByTarget(entries) {
      const groups = new Map();
      for (const entry of entries) {
        if (!groups.has(entry.target)) groups.set(entry.target, []);
        groups.get(entry.target).push(entry);
      }
      return Array.from(groups, ([target, items]) => ({ target, count: items.length, entries: items }));
    }

    if (req.method === 'GET' && url.startsWith('/_admin/api/channel-keys')) {
      // 管理入口统一剥离 query（url 已去 query），这里从原始 req.url 解析
      const rawQuery = (req.url || '').split('?')[1] || '';
      const targetName = new URLSearchParams(rawQuery).get('target') || '';
      if (targetName && (targetName.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(targetName))) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_target', message: 'target 必须是 1..128 字符且不含控制字符' },
        });
        return true;
      }
      if (!keyPool) {
        jsonResponse(res, 503, { error: { code: 'key_pool_unavailable', message: '通道密钥池未启用' } });
        return true;
      }
      const entries = keyPool.listWithCooldown(targetName || null);
      // 不传 target 时按通道分组返回全量（计划 3.4：按通道分组）
      const groups = targetName ? null : groupEntriesByTarget(entries);
      jsonResponse(res, 200, {
        ok: true,
        entries,
        groups,
        grouped: !targetName,
      });
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/channel-keys/create') {
      const payload = await readJsonBody(req);
      const targetName = typeof payload?.target === 'string' ? payload.target.trim() : '';
      const kind = payload?.kind === 'env_ref' ? 'env_ref' : 'plaintext';
      const label = typeof payload?.label === 'string' ? payload.label.trim().slice(0, 120) : '';
      const keyValue = typeof payload?.key === 'string' ? payload.key.trim() : '';
      const priority = Number.isFinite(Number(payload?.priority))
        ? Math.max(0, Math.floor(Number(payload.priority)))
        : 0;
      if (!keyPool) {
        jsonResponse(res, 503, { error: { code: 'key_pool_unavailable', message: '通道密钥池未启用' } });
        return true;
      }
      if (!targetName || targetName.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(targetName)) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_target', message: 'target 必须是 1..128 字符且不含控制字符' },
        });
        return true;
      }
      if (!keyValue || keyValue.length > 4096) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_key', message: 'key 不能为空且不超过 4096 字符' },
        });
        return true;
      }
      const current = readAdminConfig(options);
      const target = (Array.isArray(current.value?.targets) ? current.value.targets : [])
        .find((item) => item?.name === targetName);
      if (!target) {
        jsonResponse(res, 404, {
          error: { code: 'target_not_found', message: `未找到目标通道：${targetName}` },
        });
        return true;
      }
      if (target.useOpenAiAuth === true) {
        jsonResponse(res, 400, {
          error: { code: 'target_auth_unsupported', message: '该通道使用官方登录态（OAuth 订阅），无需配置 key' },
        });
        return true;
      }
      // plaintext 存 key 本身；env_ref 存变量名（运行时经 envKeySource 解析）
      if (kind === 'env_ref') {
        const resolved = resolveEnvValue(keyValue);
        if (!resolved) {
          jsonResponse(res, 400, {
            error: { code: 'env_ref_missing', message: `环境变量 ${keyValue} 未设置（请先配置后重试）` },
          });
          return true;
        }
      }
      // 直连验证按计划默认执行（skipVerify 跳过；env_ref 先解析再验证，变量不存在直接报错）
      if (payload?.skipVerify !== true) {
        const verifyValue = kind === 'env_ref' ? resolveEnvValue(keyValue) : keyValue;
        try {
          await fetchTargetModelList(target, verifyValue, options.oauthProxy || options.proxy);
        } catch (error) {
          jsonResponse(res, 400, {
            error: { code: 'key_verify_failed', message: `直连验证失败：${error.message}` },
          });
          return true;
        }
      }
      const entryId = keyPool.createEntry({
        target: targetName,
        kind,
        label,
        key: keyValue,
        priority,
      });
      jsonResponse(res, 200, { ok: true, id: entryId });
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/channel-keys/update') {
      const payload = await readJsonBody(req);
      const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
      if (!keyPool) {
        jsonResponse(res, 503, { error: { code: 'key_pool_unavailable', message: '通道密钥池未启用' } });
        return true;
      }
      if (!id || !keyPool.getEntry(id)) {
        jsonResponse(res, 404, { error: { code: 'not_found', message: '未找到该密钥条目' } });
        return true;
      }
      const patch = {};
      if (payload.label !== undefined && typeof payload.label === 'string') {
        patch.label = payload.label.trim().slice(0, 120);
      }
      const kindChanging = payload.kind !== undefined
        && (payload.kind === 'env_ref' ? 'env_ref' : 'plaintext') !== keyPool.getEntry(id).kind;
      if (payload.kind !== undefined) {
        patch.kind = payload.kind === 'env_ref' ? 'env_ref' : 'plaintext';
      }
      // 切换形态必须同时提供新 key：否则 key_value 语义错位（明文被当变量名 / 变量名被当明文）
      if (kindChanging && !(typeof payload?.key === 'string' && payload.key.trim())) {
        jsonResponse(res, 400, {
          error: { code: 'kind_switch_requires_key', message: '切换 key 形态必须同时填写新 key' },
        });
        return true;
      }
      if (payload.priority !== undefined && Number.isFinite(Number(payload.priority))) {
        patch.priority = Math.max(0, Math.floor(Number(payload.priority)));
      }
      if (typeof payload?.key === 'string' && payload.key.trim()) {
        if (payload.key.length > 4096) {
          jsonResponse(res, 400, { error: { code: 'invalid_key', message: 'key 不超过 4096 字符' } });
          return true;
        }
        const nextKind = patch.kind || keyPool.getEntry(id).kind;
        if (nextKind === 'env_ref') {
          const resolved = resolveEnvValue(payload.key.trim());
          if (!resolved) {
            jsonResponse(res, 400, {
              error: { code: 'env_ref_missing', message: `环境变量 ${payload.key.trim()} 未设置` },
            });
            return true;
          }
        }
        patch.key_value = payload.key.trim();
      }
      keyPool.updateEntry(id, patch);
      jsonResponse(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/channel-keys/revoke') {
      const payload = await readJsonBody(req);
      const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
      if (!keyPool) {
        jsonResponse(res, 503, { error: { code: 'key_pool_unavailable', message: '通道密钥池未启用' } });
        return true;
      }
      if (!id || !keyPool.getEntry(id)) {
        jsonResponse(res, 404, { error: { code: 'not_found', message: '未找到该密钥条目' } });
        return true;
      }
      keyPool.revokeEntry(id);
      jsonResponse(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/channel-keys/test') {
      const payload = await readJsonBody(req);
      const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
      if (!keyPool) {
        jsonResponse(res, 503, { error: { code: 'key_pool_unavailable', message: '通道密钥池未启用' } });
        return true;
      }
      const entry = keyPool.getEntry(id);
      if (!entry || entry.revoked) {
        jsonResponse(res, 404, { error: { code: 'not_found', message: '未找到该密钥条目' } });
        return true;
      }
      const current = readAdminConfig(options);
      const target = (Array.isArray(current.value?.targets) ? current.value.targets : [])
        .find((item) => item?.name === entry.target);
      if (!target) {
        jsonResponse(res, 404, {
          error: { code: 'target_not_found', message: `未找到目标通道：${entry.target}` },
        });
        return true;
      }
      const testKey = entry.kind === 'env_ref' ? resolveEnvValue(entry.key_value) : entry.key_value;
      if (!testKey) {
        jsonResponse(res, 400, {
          error: { code: 'env_ref_missing', message: `环境变量 ${entry.key_value} 未设置` },
        });
        return true;
      }
      const startedAt = Date.now();
      try {
        const models = await fetchTargetModelList(target, testKey, options.oauthProxy || options.proxy);
        jsonResponse(res, 200, {
          ok: true,
          latencyMs: Date.now() - startedAt,
          modelCount: models.length,
        });
      } catch (error) {
        jsonResponse(res, 200, { ok: false, error: error.message || '验证失败' });
      }
      return true;
    }

    // ---------- 厂商预设库（cc-switch 式一键接入） ----------

    if (req.method === 'GET' && url === '/_admin/api/vendor-presets') {
      const current = readAdminConfig(options);
      const existingTargets = Array.isArray(current.value?.targets) ? current.value.targets : [];
      jsonResponse(res, 200, {
        ok: true,
        presets: VENDOR_PRESETS.map((preset) => {
          const matched = existingTargets.find((target) => targetKeyOf(target) === presetTargetKey(preset));
          return {
            id: preset.id,
            name: preset.name,
            category: preset.category,
            categoryLabel: presetCategoryLabel(preset.category),
            planLabel: preset.planLabel,
            quotaWindow: preset.quotaWindow,
            host: preset.host,
            prefix: preset.prefix,
            protocol: preset.protocol,
            port: preset.port || null,
            wireApi: preset.wireApi,
            defaultMatch: preset.defaultMatch,
            websiteUrl: preset.websiteUrl,
            apiKeyUrl: preset.apiKeyUrl,
            modelCount: preset.models.length,
            models: preset.models.map((model) => ({
              slug: model.slug,
              contextWindow: model.contextWindow,
              defaultReasoningLevel: model.defaultReasoningLevel,
            })),
            existingTarget: matched ? matched.name : null,
          };
        }),
      });
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/vendor-presets/activate') {
      const payload = await readJsonBody(req);
      const vendorId = typeof payload?.vendorId === 'string' ? payload.vendorId.trim() : '';
      const preset = getVendorPreset(vendorId);
      if (!preset) {
        jsonResponse(res, 404, { error: { code: 'preset_not_found', message: `未找到厂商预设：${vendorId || '(空)'}` } });
        return true;
      }
      const rawKeys = Array.isArray(payload?.keys) ? payload.keys : [];
      if (rawKeys.length === 0) {
        jsonResponse(res, 400, { error: { code: 'keys_required', message: '至少提供一把 key' } });
        return true;
      }
      const normalizedKeys = [];
      for (const item of rawKeys) {
        const kind = item?.kind === 'env_ref' ? 'env_ref' : 'plaintext';
        const value = typeof item?.key === 'string' ? item.key.trim() : '';
        const label = typeof item?.label === 'string' ? item.label.trim().slice(0, 120) : '';
        const priority = Number.isFinite(Number(item?.priority))
          ? Math.max(0, Math.floor(Number(item.priority)))
          : 0;
        if (!value || value.length > 4096) {
          jsonResponse(res, 400, { error: { code: 'invalid_key', message: 'key 不能为空且不超过 4096 字符' } });
          return true;
        }
        if (kind === 'env_ref') {
          const resolved = resolveEnvValue(value);
          if (!resolved) {
            jsonResponse(res, 400, {
              error: { code: 'env_ref_missing', message: `环境变量 ${value} 未设置（请先配置后重试）` },
            });
            return true;
          }
        }
        normalizedKeys.push({ kind, value, label, priority });
      }

      const current = readModelRoutingFiles();
      const config = structuredClone(current.config.value);
      const targets = Array.isArray(config.targets) ? config.targets : [];
      const changes = [];
      let targetName = targets.find((target) => targetKeyOf(target) === presetTargetKey(preset))?.name || null;
      if (!targetName) {
        targetName = uniqueTargetName(targets, preset.id);
        targets.push(buildTargetFromPreset(preset));
        config.targets = targets;
        changes.push(`新增通道 ${targetName}（${preset.host}${preset.prefix || ''}）`);
      } else {
        changes.push(`复用既有通道 ${targetName}（host/prefix 相同，仅追加密钥）`);
      }

      // 预设默认模型写入 catalog（slug 去重，已存在跳过）；接入后可用「自动拉取模型」覆盖
      const catalog = structuredClone(current.catalog.value);
      const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
      let addedModels = 0;
      const addCatalog = payload?.addCatalog !== false;
      // 可选：接入时直接拉取真实模型清单（计划 3.7 接入动作第 3 步）——
      // 用用户提交的第一把 key 直连上游 GET /models；失败不阻塞接入，回退预设清单
      let fetchedModels = null;
      let fetchWarning = '';
      if (addCatalog && payload?.fetchModels === true) {
        const firstKey = normalizedKeys[0];
        const fetchValue = firstKey.kind === 'env_ref' ? resolveEnvValue(firstKey.value) : firstKey.value;
        const fetchTarget = buildTargetFromPreset(preset);
        try {
          const fetched = await fetchTargetModelList(fetchTarget, fetchValue, options.oauthProxy || options.proxy);
          fetchedModels = fetched.length;
          const known = new Set(catalogModels.map((item) => item?.slug));
          for (const model of fetched) {
            if (known.has(model.name)) continue;
            catalogModels.push({
              slug: model.name,
              display_name: model.name,
              description: `${preset.name}（自动拉取）`,
              visibility: 'list',
              supported_in_api: true,
              priority: 10,
              input_modalities: ['text'],
            });
            known.add(model.name);
          }
          if (fetched.length > 0) catalog.models = catalogModels;
        } catch (error) {
          fetchWarning = error.message || '拉取失败';
        }
      }
      if (addCatalog && fetchedModels === null) {
        const knownSlugs = new Set(catalogModels.map((item) => item?.slug));
        for (const model of preset.models) {
          if (knownSlugs.has(model.slug)) continue;
          catalogModels.push({
            slug: model.slug,
            display_name: model.slug,
            description: `${preset.name}（${preset.planLabel}）`,
            visibility: 'list',
            supported_in_api: true,
            priority: 10,
            input_modalities: ['text'],
            default_reasoning_level: model.defaultReasoningLevel || 'medium',
            ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
          });
          knownSlugs.add(model.slug);
          addedModels += 1;
        }
        if (addedModels > 0) catalog.models = catalogModels;
      }

      const inspected = inspectRouterConfig(config, context());
      if (inspected.errors.length > 0) {
        jsonResponse(res, 422, inspected);
        return true;
      }
      const transactionFactory = options.transactionFactory || createModelRoutingTransaction;
      let committed;
      try {
        committed = await transactionFactory({
          configPath: options.configPath,
          catalogPath: options.catalogPath,
        }).commit({
          configRevision: current.config.revision,
          catalogRevision: current.catalog.revision,
          config,
          catalog,
        });
      } catch (error) {
        transactionErrorResponse(res, error);
        return true;
      }

      // 双文件提交成功后，密钥写入池（失败不回滚 config，报错提示补录）
      let keyIds = [];
      try {
        keyIds = normalizedKeys.map((item) => keyPool.createEntry({
          target: targetName,
          kind: item.kind,
          label: item.label,
          key: item.value,
          priority: item.priority,
        }));
      } catch (error) {
        jsonResponse(res, 500, {
          error: {
            code: 'key_pool_write_failed',
            message: `通道已接入但密钥写入失败：${error.message}（可到密钥池手动补录）`,
          },
        });
        return true;
      }

      jsonResponse(res, 200, {
        ok: true,
        target: targetName,
        vendorId: preset.id,
        changes,
        addedModels,
        ...(fetchedModels !== null ? { fetchedModels } : {}),
        ...(fetchWarning ? { fetchWarning } : {}),
        keyCount: keyIds.length,
        keyIds,
        configRevision: committed.configRevision,
        catalogRevision: committed.catalogRevision,
        restartRequired: true,
      });
      return true;
    }

    // ---------- Codex 默认启动模型（config.toml 顶部 model = "..."） ----------

    if (req.method === 'GET' && url === '/_admin/api/codex-default-model') {
      let current = null;
      let configPath = null;
      const tomlPath = codexConfigTomlPath();
      if (tomlPath && fs.existsSync(tomlPath)) {
        configPath = tomlPath;
        const text = fs.readFileSync(tomlPath, 'utf8');
        const match = text.match(/^model\s*=\s*"([^"]+)"/m);
        current = match ? match[1] : null;
      }
      let models = [];
      try {
        const catalog = readRevisionedJson(options.catalogPath, { maxBytes: MAX_CATALOG_BYTES }).value;
        models = (Array.isArray(catalog?.models) ? catalog.models : [])
          .map((model) => ({
            slug: model.slug,
            displayName: typeof model.display_name === 'string' && model.display_name
              ? model.display_name
              : model.slug,
          }))
          .filter((model) => typeof model.slug === 'string' && model.slug)
          .sort((a, b) => a.slug.localeCompare(b.slug));
      } catch { /* catalog 不可读时模型清单为空，仅返回当前值 */ }
      jsonResponse(res, 200, { ok: true, current, models, configPath });
      return true;
    }

    if (req.method === 'PUT' && url === '/_admin/api/codex-default-model') {
      const payload = await readJsonBody(req);
      const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
      if (!model || model.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(model)) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_model', message: 'model 必须是 1..256 字符且不含控制字符' },
        });
        return true;
      }
      const configPath = codexConfigTomlPath();
      if (!configPath || !fs.existsSync(configPath)) {
        jsonResponse(res, 404, {
          error: { code: 'codex_config_missing', message: `未找到 Codex 配置: ${configPath || '(defaultCodexHome 未注入)'}` },
        });
        return true;
      }
      const original = fs.readFileSync(configPath, 'utf8');
      const backup = `${configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const lines = original.split(/\r?\n/);
      let modelLine = -1;
      for (let i = 0; i < lines.length; i += 1) {
        if (/^model\s*=/.test(lines[i])) { modelLine = i; break; }
      }
      const change = `model = "${model}"`;
      if (modelLine >= 0) {
        if (lines[modelLine].trim() === change) {
          jsonResponse(res, 200, {
            ok: true,
            changed: false,
            backup: null,
            current: model,
            restartRequired: true,
          });
          return true;
        }
        lines[modelLine] = change;
      } else {
        lines.unshift(change);
      }
      fs.writeFileSync(backup, original, 'utf8');
      const tmp = `${configPath}.tmp`;
      fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
      fs.renameSync(tmp, configPath);
      jsonResponse(res, 200, {
        ok: true,
        changed: true,
        backup,
        current: model,
        restartRequired: true,
      });
      return true;
    }

    // ---------- 订阅账号一键授权（google / openai / claude） ----------
    if (url.startsWith('/_admin/api/oauth/')) {
      const parts = url.slice('/_admin/api/oauth/'.length).split('/');
      const provider = parts[0];
      const action = parts[1];

      if (req.method === 'POST' && action === 'start') {
        const payload = await readJsonBody(req);
        const codeVerifier = generateCodeVerifier();
        const codeChallenge = generateCodeChallenge(codeVerifier);
        const state = generateState();

        if (provider === 'google') {
          resetOAuthSession('google');
          const server = await startLoopbackServer({ path: '/oauth-callback', state });
          const authUrl = buildGoogleAuthUrl({
            state,
            codeChallenge,
            redirectUri: server.redirectUri,
          });
          const session = { status: 'pending', server, codeVerifier, authUrl };
          oauthSessions.set('google', session);
          driveLoopbackCompletion('google', session);
          if (payload?.openBrowser !== false) openDefaultBrowser(authUrl);
          jsonResponse(res, 200, { ok: true, mode: 'loopback', authUrl, redirectUri: server.redirectUri });
          return true;
        }

        if (provider === 'openai') {
          resetOAuthSession('openai');
          let server = null;
          let mode = 'loopback';
          let redirectUri = 'http://localhost:1455/auth/callback';
          try {
            server = await startLoopbackServer({ path: '/auth/callback', state, port: 1455 });
            redirectUri = server.redirectUri;
          } catch {
            mode = 'manual';
          }
          const authUrl = buildOpenAiAuthUrl({ state, codeChallenge, redirectUri });
          const session = { status: 'pending', server, codeVerifier, authUrl, state, redirectUri };
          oauthSessions.set('openai', session);
          if (server) driveLoopbackCompletion('openai', session);
          if (payload?.openBrowser !== false) openDefaultBrowser(authUrl);
          jsonResponse(res, 200, { ok: true, mode, authUrl, redirectUri });
          return true;
        }

        if (provider === 'claude') {
          resetOAuthSession('claude');
          const authUrl = buildClaudeAuthUrl({ state, codeChallenge });
          const session = { status: 'pending', codeVerifier, authUrl, state };
          oauthSessions.set('claude', session);
          if (payload?.openBrowser !== false) openDefaultBrowser(authUrl);
          jsonResponse(res, 200, { ok: true, mode: 'manual', authUrl });
          return true;
        }

        jsonResponse(res, 404, { error: { code: 'unsupported_provider', message: `不支持的平台: ${provider}` } });
        return true;
      }

      if (req.method === 'GET' && action === 'status') {
        const session = oauthSessions.get(provider);
        if (!session) {
          jsonResponse(res, 200, { ok: true, complete: false, status: 'idle' });
          return true;
        }
        if (session.status === 'done') {
          oauthSessions.delete(provider);
          jsonResponse(res, 200, { ok: true, complete: true, account: session.account });
          return true;
        }
        if (session.status === 'error') {
          const err = session.error;
          oauthSessions.delete(provider);
          jsonResponse(res, 200, { ok: true, complete: false, error: err });
          return true;
        }
        jsonResponse(res, 200, {
          ok: true,
          complete: false,
          status: session.status,
          mode: session.server ? 'loopback' : 'manual',
          authUrl: session.authUrl,
        });
        return true;
      }

      if (req.method === 'POST' && action === 'exchange') {
        const payload = await readJsonBody(req);
        const session = oauthSessions.get(provider);
        const code = extractCodeFromInput(payload?.code || payload?.callbackUrl || '');
        if (!code) {
          jsonResponse(res, 400, { error: { code: 'code_missing', message: '请提供授权码 Code 或浏览器回调 URL' } });
          return true;
        }
        // 无进行中的授权会话时不允许交换：新生成的 verifier 与 start 时的 code_challenge
        // 必然不匹配（PKCE），明确报错避免用户拿到含糊的 invalid_grant
        if (!session) {
          jsonResponse(res, 400, {
            error: { code: 'oauth_session_missing', message: '没有进行中的授权会话，请先发起一键授权后再粘贴 Code' },
          });
          return true;
        }
        // 已完成/已失败的会话不允许再次兑换：codeVerifier 只对一次授权有效，
        // 复用旧会话会让用户以为可以重复粘贴 Code（PKCE 也会拒，但报错更明确）。
        if (session.status === 'done' || session.status === 'error') {
          oauthSessions.delete(provider);
          jsonResponse(res, 400, {
            error: { code: 'oauth_session_expired', message: '该授权会话已结束，请重新发起一键授权' },
          });
          return true;
        }
        const codeVerifier = session.codeVerifier;
        const redirectUri = session.redirectUri || (provider === 'openai' ? 'http://localhost:1455/auth/callback' : undefined);
        try {
          const account = await completeAuthorization(provider, { code, codeVerifier, redirectUri });
          oauthSessions.delete(provider);
          jsonResponse(res, 200, { ok: true, complete: true, account });
        } catch (err) {
          jsonResponse(res, 400, { error: { code: err.code || 'exchange_failed', message: err.message } });
        }
        return true;
      }

      jsonResponse(res, 404, { error: { code: 'not_found', message: '未知 OAuth 操作' } });
      return true;
    }

    if (req.method === 'GET' && url === '/_admin/api/accounts') {
      const authManager = options.authManager;
      const accounts = authManager ? authManager.listAccounts({ sanitized: true }) : [];
      // 老账号授权时未存 chatgptAccountId：从 vault 的 idToken 解码补全（用于路由请求额度计数）
      for (const acc of accounts) {
        if (acc.provider !== 'openai' || acc.metadata?.chatgptAccountId) continue;
        try {
          const creds = options.credentialsVault?.get(acc.id);
          if (!creds?.idToken) continue;
          const claims = decodeOpenAiIdToken(creds.idToken);
          if (!claims.chatgptAccountId) continue;
          authManager?.updateAccount(acc.id, { metadata: { chatgptAccountId: claims.chatgptAccountId } });
          acc.metadata = { ...(acc.metadata || {}), chatgptAccountId: claims.chatgptAccountId };
        } catch { /* 解码失败不阻塞列表 */ }
      }
      jsonResponse(res, 200, { ok: true, accounts });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/accounts/add') {
      const payload = await readJsonBody(req);
      const authManager = options.authManager;
      if (!authManager) {
        jsonResponse(res, 500, { error: { code: 'auth_manager_unavailable', message: '账号管理器未初始化' } });
        return true;
      }
      if (!payload.provider || !payload.credentials) {
        jsonResponse(res, 400, { error: { code: 'invalid_account_payload', message: '请提供 provider 与凭据 credentials' } });
        return true;
      }
      // 手动导入与 OAuth 授权共用同一 ID 锚定规则：有 email 时按 provider+email 幂等覆盖
      // （重复绑定同一邮箱 = 更新而非新建），无 email 才退回时间戳唯一 ID。
      const accountEmail = String(payload.email || '').trim().toLowerCase();
      const accountId = payload.id
        || (accountEmail ? `${payload.provider}_${accountEmail.replace(/[^a-z0-9._-]+/g, '_')}` : `${payload.provider}_${Date.now()}`);
      const account = {
        id: accountId,
        provider: payload.provider,
        alias: payload.alias || `${payload.provider} Account`,
        email: accountEmail,
        status: 'active',
        credentials: payload.credentials,
        expiresAt: payload.expiresAt || null,
        metadata: payload.metadata || {},
      };
      authManager.addAccount(account);
      // 元数据入 SQLite；凭据本体入 vault（重启可恢复）
      dbSaveAccount({
        id: accountId,
        provider: account.provider,
        email: account.email,
        alias: account.alias,
        proxy_enabled: payload.proxy?.enabled ?? 1,
        proxy_url: payload.proxy?.url || 'http://127.0.0.1:10808',
        metadata: JSON.stringify(account.metadata || {}),
      });
      options.credentialsVault?.set(accountId, payload.credentials);
      jsonResponse(res, 200, { ok: true, account: { id: account.id, provider: account.provider, alias: account.alias, email: account.email, status: account.status } });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/accounts/delete') {
      const payload = await readJsonBody(req);
      const authManager = options.authManager;
      if (payload.id) {
        authManager?.removeAccount(payload.id);
        try { dbDeleteAccount(payload.id); } catch { /* 容错 */ }
        options.credentialsVault?.delete(payload.id);
      }
      jsonResponse(res, 200, { ok: true, message: '账号已移除' });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/accounts/fetch-models') {
      const payload = await readJsonBody(req);
      const authManager = options.authManager;
      const account = payload?.id ? authManager?.getAccount(payload.id) : null;
      if (!account) {
        jsonResponse(res, 404, { error: { code: 'account_not_found', message: '账号不存在，请先完成一键授权绑定' } });
        return true;
      }
      const proxy = options.oauthProxy;
      try {
        // getValidCredentials 自动刷新临期 access token（三平台 refresher 已注册）
        const credentials = await authManager.getValidCredentials(account.id);
        let models;
        let source;
        if (account.provider === 'google') {
          let projectId = credentials.projectId || account.metadata?.projectId || '';
          if (!projectId || projectId === '{}') {
            try {
              const discovered = await discoverGoogleProject({ accessToken: credentials.accessToken, proxy });
              projectId = discovered.projectId;
              if (projectId) {
                authManager.updateAccount(account.id, { metadata: { ...account.metadata, projectId } });
                options.credentialsVault?.set(account.id, { ...credentials, projectId });
              }
            } catch { /* 补全失败继续走模型拉取，由其报缺 project */ }
          }
          models = await fetchGoogleAvailableModels({
            accessToken: credentials.accessToken,
            projectId,
            proxy,
          });
          source = 'upstream';
        } else if (account.provider === 'claude') {
          models = await fetchClaudeModels({ accessToken: credentials.accessToken, proxy });
          source = 'upstream';
        } else if (account.provider === 'openai') {
          // 实时拉取 Codex 额度池模型清单（对齐 sub2api：GET /backend-api/codex/models）；
          // 拉取失败（网络/上游变更）时回退内置实测清单，保证功能可用。
          try {
            models = await fetchOpenAiCodexModels({
              accessToken: credentials.accessToken,
              proxy,
            });
            source = 'upstream';
          } catch (error) {
            models = CODEX_KNOWN_MODELS.map((m) => ({ ...m }));
            source = 'builtin';
          }
        } else {
          jsonResponse(res, 400, { error: { code: 'unsupported_provider', message: `不支持的平台: ${account.provider}` } });
          return true;
        }
        jsonResponse(res, 200, { ok: true, provider: account.provider, source, count: models.length, models });
      } catch (err) {
        jsonResponse(res, 500, { error: { code: err.code || 'fetch_models_failed', message: err.message } });
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/accounts/test-model') {
      // 订阅账号模型测试（sub2api 式）：用该账号的登录凭据真实请求上游生成最小响应，
      // 验证账号可用 + 模型可调用；与网络/代理链路测试互补。
      const payload = await readJsonBody(req);
      const provider = typeof payload?.provider === 'string' ? payload.provider.trim().toLowerCase() : '';
      const accountId = typeof payload?.accountId === 'string' ? payload.accountId.trim() : '';
      const model = typeof payload?.model === 'string' ? payload.model.trim() : '';
      const authManager = options.authManager;
      if (!authManager || !accountId) {
        jsonResponse(res, 400, { error: { code: 'invalid_account', message: '缺少账号' } });
        return true;
      }
      let creds;
      try {
        creds = await authManager.getValidCredentials(accountId);
      } catch (error) {
        jsonResponse(res, 200, { ok: false, error: `账号凭据获取/刷新失败：${error.message || '未知错误'}` });
        return true;
      }
      if (!creds?.accessToken) {
        jsonResponse(res, 200, { ok: false, error: '账号没有可用凭据（请重新授权）' });
        return true;
      }
      const startedAt = Date.now();
      const proxy = options.oauthProxy || options.proxy;
      const account = authManager.getAccount(accountId);
      const accountIdHeader = account?.metadata?.chatgptAccountId || creds.accountId || '';
      try {
        if (provider === 'openai') {
          if (!model) {
            jsonResponse(res, 400, { error: { code: 'invalid_model', message: '缺少模型名' } });
            return true;
          }
          const body = JSON.stringify({
            model,
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
            stream: true,
            store: false,
          });
          const upstreamRes = await rawHttpsRequest({
            protocol: 'https',
            host: 'chatgpt.com',
            path: '/backend-api/codex/responses',
            method: 'POST',
            viaProxy: true,
            proxy,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${creds.accessToken}`,
              ...(accountIdHeader ? { 'chatgpt-account-id': accountIdHeader } : {}),
            },
            body,
            timeouts: { connectMs: 10_000, responseHeaderMs: 30_000, requestMs: 45_000 },
            maxResponseBytes: 512 * 1024,
          });
          const latencyMs = Date.now() - startedAt;
          const ok = upstreamRes.status === 200 && /response\.(created|completed)/.test(upstreamRes.bodyText);
          jsonResponse(res, 200, {
            ok,
            latencyMs,
            status: upstreamRes.status,
            note: ok
              ? `账号可用 ✓ 模型 ${model} 响应正常`
              : `服务器已响应（${upstreamRes.status}），但模型 ${model} 未正常返回（${upstreamModelsErrorSummary(upstreamRes.bodyText).slice(0, 120)}）`,
          });
          return true;
        }
        if (provider === 'claude') {
          if (!model) {
            jsonResponse(res, 400, { error: { code: 'invalid_model', message: '缺少模型名' } });
            return true;
          }
          const body = JSON.stringify({
            model,
            max_tokens: 8,
            messages: [{ role: 'user', content: 'ping' }],
          });
          const upstreamRes = await rawHttpsRequest({
            protocol: 'https',
            host: 'api.anthropic.com',
            path: '/v1/messages',
            method: 'POST',
            viaProxy: true,
            proxy,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${creds.accessToken}`,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
              'user-agent': 'claude-cli/2.1.220 (external, cli)',
            },
            body,
            timeouts: { connectMs: 10_000, responseHeaderMs: 30_000, requestMs: 45_000 },
            maxResponseBytes: 512 * 1024,
          });
          const latencyMs = Date.now() - startedAt;
          jsonResponse(res, 200, {
            ok: upstreamRes.status === 200,
            latencyMs,
            status: upstreamRes.status,
            note: upstreamRes.status === 200
              ? `账号可用 ✓ 模型 ${model} 响应正常`
              : `服务器已响应（${upstreamRes.status}）：${upstreamModelsErrorSummary(upstreamRes.bodyText).slice(0, 120)}`,
          });
          return true;
        }
        if (provider === 'google') {
          // Google 订阅走 codeassist 私有后端：验证 token 有效 + 账号状态（模型级端点无公开接口）
          const { fetchGoogleUserInfo } = await import('./auth/google-sub-auth.mjs');
          const info = await fetchGoogleUserInfo({ accessToken: creds.accessToken, proxy });
          const latencyMs = Date.now() - startedAt;
          jsonResponse(res, 200, {
            ok: Boolean(info.email),
            latencyMs,
            status: 200,
            note: info.email
              ? `账号可用 ✓（${info.email}）；Google 模型经订阅后端调用，模型级测试暂由「拉取可用模型」验证`
              : '账号凭据有效但未取到用户信息',
          });
          return true;
        }
        jsonResponse(res, 400, { error: { code: 'unsupported_provider', message: `不支持的平台: ${provider}` } });
      } catch (error) {
        jsonResponse(res, 200, {
          ok: false,
          error: `测试失败：${error.message || '网络/凭据错误'}`,
          latencyMs: Date.now() - startedAt,
        });
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/targets/fetch-models') {
      // 自动拉取：按目标通道的上游接口获取可用模型列表，供管理页勾选后批量写入 catalog。
      const payload = await readJsonBody(req);
      const targetName = typeof payload?.targetName === 'string' ? payload.targetName.trim() : '';
      if (!targetName || targetName.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(targetName)) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_target', message: 'targetName 必须是 1..128 字符且不含控制字符' },
        });
        return true;
      }
      const current = readAdminConfig(options);
      const configuredTargets = Array.isArray(current.value?.targets) ? current.value.targets : [];
      const target = configuredTargets.find((item) => item?.name === targetName);
      if (!target) {
        jsonResponse(res, 404, {
          error: { code: 'target_not_found', message: `未找到目标通道：${targetName}` },
        });
        return true;
      }
      if (target.useOpenAiAuth === true) {
        jsonResponse(res, 400, {
          error: {
            code: 'target_auth_unsupported',
            message: '该通道使用官方登录态（ChatGPT 订阅），无公开模型列表接口，请改用手动添加',
          },
        });
        return true;
      }
      // 凭据解析与路由请求同路径：密钥池优先（池空/全冷却回退 envKey 热更新源）
      const resolveKey = typeof options.getKey === 'function'
        ? options.getKey
        : (name) => (options.env || {})[name];
      let apiKey = '';
      if (keyPool) {
        const acquired = keyPool.acquireKey(target);
        if (acquired) apiKey = acquired.value;
      }
      if (!apiKey && target.envKey) apiKey = resolveKey(target.envKey);
      if (!apiKey) {
        jsonResponse(res, 400, {
          error: {
            code: 'env_key_missing',
            message: `通道 ${targetName} 的凭据环境变量 ${target.envKey || '(未配置)'} 未设置，请先配置后再拉取`,
          },
        });
        return true;
      }
      try {
        const models = await fetchTargetModelList(target, apiKey, options.oauthProxy || options.proxy);
        jsonResponse(res, 200, {
          ok: true,
          target: targetName,
          source: 'upstream',
          count: models.length,
          models,
        });
      } catch (error) {
        jsonResponse(res, error.status || 502, {
          error: {
            code: error.code || 'fetch_models_failed',
            message: error.message || '模型列表拉取失败',
          },
        });
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/models/prefix-platform') {
      // 模型显示名加/去平台前缀（Codex 下拉区分平台，如 opencode/deepseek-v4-pro）。
      // 前缀 = 模型路由目标短名（target.name 第一个 '-' 前段：opencode-go-chat → opencode）。
      const payload = await readJsonBody(req);
      const mode = payload?.mode === 'remove' ? 'remove' : 'add';
      const current = readModelRoutingFiles();
      const exposed = exposeModelRoutingState(
        current.catalog.value,
        current.config.value,
        current.config.revision,
        options.env || {},
      );
      const targetByRef = new Map(exposed.targets.map((state) => [state.targetRef, state]));
      // 官方登录态通道（useOpenAiAuth，如 ChatGPT 订阅）模型不加平台前缀——Codex 原生即知平台。
      // 仅 add 模式跳过官方目标；remove 模式处理全部模型（含历史误加前缀的官方模型）。
      const officialTargetNames = new Set(
        exposed.targets.filter((state) => state.useOpenAiAuth === true).map((state) => state.name),
      );
      const slugToTargetName = new Map();
      for (const binding of exposed.bindings) {
        const primaryRef = binding.targetRefs?.[0];
        if (!primaryRef) continue;
        const target = targetByRef.get(primaryRef);
        if (target?.name && (mode === 'remove' || !officialTargetNames.has(target.name))) {
          slugToTargetName.set(binding.slug, target.name);
        }
      }
      const catalog = structuredClone(current.catalog.value);
      const models = Array.isArray(catalog?.models) ? catalog.models : [];
      let changed = 0;
      for (const model of models) {
        if (typeof model?.display_name !== 'string') continue;
        const targetName = slugToTargetName.get(model.slug);
        const prefix = targetName ? String(targetName).split('-')[0] : '';
        if (!prefix) continue;
        const prefixed = model.display_name.startsWith(`${prefix}/`);
        if (mode === 'add' && !prefixed) {
          model.display_name = `${prefix}/${model.display_name || model.slug}`;
          changed += 1;
        } else if (mode === 'remove' && prefixed) {
          model.display_name = model.display_name.slice(prefix.length + 1);
          changed += 1;
        }
      }
      if (changed === 0) {
        jsonResponse(res, 200, { ok: true, changed: 0, restartRequired: true, message: '无需变更（已加/已去前缀或无可匹配目标）' });
        return true;
      }
      const inspected = inspectRouterConfig(current.config.value, context());
      if (inspected.errors.length > 0) {
        jsonResponse(res, 422, inspected);
        return true;
      }
      const transactionFactory = options.transactionFactory || createModelRoutingTransaction;
      try {
        const committed = await transactionFactory({
          configPath: options.configPath,
          catalogPath: options.catalogPath,
        }).commit({
          configRevision: current.config.revision,
          catalogRevision: current.catalog.revision,
          config: current.config.value,
          catalog,
        });
        jsonResponse(res, 200, {
          ok: true,
          changed,
          mode,
          configRevision: committed.configRevision,
          catalogRevision: committed.catalogRevision,
          restartRequired: true,
          clientRestartRequired: true,
        });
      } catch (error) {
        transactionErrorResponse(res, error);
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/targets/test') {
      // 代理/通道连通性测试：用已保存配置（targetName）或编辑中的表单配置（target）
      // 真实请求上游 GET /models（走目标级代理或全局代理），返回延迟与模型数。
      const payload = await readJsonBody(req);
      let target;
      if (typeof payload?.targetName === 'string' && payload.targetName.trim()) {
        const current = readAdminConfig(options);
        target = (Array.isArray(current.value?.targets) ? current.value.targets : [])
          .find((item) => item?.name === payload.targetName.trim());
        if (!target) {
          jsonResponse(res, 404, {
            error: { code: 'target_not_found', message: `未找到目标通道：${payload.targetName}` },
          });
          return true;
        }
      } else if (payload?.target && typeof payload.target === 'object' && !Array.isArray(payload.target)) {
        target = payload.target; // 编辑弹窗未保存的表单配置
        if (typeof target.host !== 'string' || !target.host.trim()) {
          jsonResponse(res, 400, { error: { code: 'invalid_target', message: '表单配置缺少 host' } });
          return true;
        }
      } else {
        jsonResponse(res, 400, { error: { code: 'invalid_request', message: '需要 targetName 或 target 表单配置' } });
        return true;
      }
      // 连通性测试与密钥/额度无关：真实建立连接（走代理/节点）并拿到任意 HTTP 响应即「链路通」，
      // 状态码只作附带说明（401=认证未过、429=额度/限流、404=路径不对，都说明服务器可达）。
      // 仅网络/代理/TLS 层失败才判定「链路不通」。
      const startedAt = Date.now();
      try {
        const outcome = await rawHttpsRequest({
          protocol: target.protocol === 'http' ? 'http' : 'https',
          host: target.host,
          port: target.port || (target.protocol === 'http' ? 80 : 443),
          path: '/',
          method: 'GET',
          viaProxy: target.viaProxy === true || Boolean(target.proxyUrl),
          proxy: target.proxyUrl || options.oauthProxy || options.proxy,
          headers: { accept: '*/*' },
          timeouts: { connectMs: 10_000, responseHeaderMs: 20_000, requestMs: 25_000 },
          maxResponseBytes: 4 * 1024 * 1024,
        });
        const latencyMs = Date.now() - startedAt;
        const status = Number(outcome.status) || 0;
        let note = `链路通 ✓（服务器响应 ${status}）`;
        if (status === 401 || status === 403) {
          note = '链路通 ✓（服务器已响应），认证未通过（401）——密钥/账号问题，与网络无关';
        } else if (status === 429) {
          note = '链路通 ✓（服务器已响应），额度/限流（429）——与网络无关';
        } else if (status >= 200 && status < 400) {
          note = '链路通 ✓（服务器响应正常）';
        } else if (status >= 500) {
          note = `链路通 ✓（服务器已响应，服务端状态 ${status}）`;
        }
        jsonResponse(res, 200, {
          ok: true,
          latencyMs,
          status,
          note,
          proxy: target.proxyUrl || (target.viaProxy ? '全局代理' : '直连'),
        });
      } catch (error) {
        // 响应体超限说明连接与响应头都成功了（页面过大）——同样视为链路通
        if (/too large/i.test(String(error.message || ''))) {
          jsonResponse(res, 200, {
            ok: true,
            latencyMs: Date.now() - startedAt,
            status: 0,
            note: '链路通 ✓（服务器已响应，页面内容过大未完整读取）',
            proxy: target.proxyUrl || (target.viaProxy ? '全局代理' : '直连'),
          });
          return true;
        }
        jsonResponse(res, 200, {
          ok: false,
          error: `无法连接：${error.message || '网络/代理/TLS 失败'}`,
          latencyMs: Date.now() - startedAt,
          proxy: target.proxyUrl || (target.viaProxy ? '全局代理' : '直连'),
        });
      }
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/vision-relay/test') {
      // 视觉中继连通性测试：用表单配置（relay）或当前 config 的 visionRelay 端点，
      // 真实发送一张 1x1 图片给视觉模型；拿到任何 HTTP 响应即链路通（状态码只作说明）。
      const payload = await readJsonBody(req);
      let relay;
      if (payload?.relay && typeof payload.relay === 'object' && !Array.isArray(payload.relay)) {
        relay = payload.relay;
        if (typeof relay.host !== 'string' || !relay.host.trim()) {
          jsonResponse(res, 400, { error: { code: 'invalid_relay', message: '表单配置缺少 host' } });
          return true;
        }
      } else {
        const current = readAdminConfig(options);
        relay = (current.value && typeof current.value.visionRelay === 'object') ? current.value.visionRelay : {};
      }
      const model = typeof relay.model === 'string' && relay.model ? relay.model : '';
      if (!model) {
        jsonResponse(res, 400, { error: { code: 'invalid_relay', message: '缺少视觉模型名 (model)' } });
        return true;
      }
      const apiKey = relay.envKey ? resolveEnvValue(relay.envKey) : '';
      if (!apiKey) {
        jsonResponse(res, 200, { ok: false, error: `环境变量 ${relay.envKey || '(未配置)'} 未设置` });
        return true;
      }
      const pixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const body = JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pixelPng}` } },
            { type: 'text', text: 'ping' },
          ],
        }],
        max_tokens: 8,
      });
      const prefix = typeof relay.prefix === 'string' ? relay.prefix.replace(/\/+$/, '') : '';
      const startedAt = Date.now();
      try {
        const upstreamRes = await rawHttpsRequest({
          protocol: relay.protocol === 'http' ? 'http' : 'https',
          host: relay.host,
          port: relay.port || undefined,
          path: `${prefix}/chat/completions`,
          method: 'POST',
          viaProxy: relay.viaProxy === true || Boolean(relay.proxyUrl),
          proxy: relay.proxyUrl || options.oauthProxy || options.proxy,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body,
          // 免费共享端点（如 NVIDIA TriaI）响应可到数十秒，测试超时放宽到 2.5 分钟，
          // 避免「点测试像没反应」；生产链路超时由全局/端点配置控制，与此无关。
          timeouts: { connectMs: 15_000, responseHeaderMs: 60_000, requestMs: 150_000 },
          maxResponseBytes: 256 * 1024,
        });
        const latencyMs = Date.now() - startedAt;
        const status = Number(upstreamRes.status) || 0;
        let note = `链路通 ✓（服务器响应 ${status}）`;
        if (status === 200) {
          note = '链路通 ✓，视觉模型响应正常';
        } else if (status === 401 || status === 403) {
          note = '链路通 ✓（服务器已响应），认证未通过（401）——密钥/账号问题，与网络无关';
        } else if (status === 429) {
          note = '链路通 ✓（服务器已响应），额度/限流（429）——与网络无关';
        }
        jsonResponse(res, 200, { ok: true, latencyMs, status, note, model });
      } catch (error) {
        jsonResponse(res, 200, {
          ok: false,
          error: `无法连接：${error.message || '网络/代理/TLS 失败'}`,
          latencyMs: Date.now() - startedAt,
        });
      }
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/models/test') {
      const payload = await readJsonBody(req);
      const model = typeof payload.model === 'string' ? payload.model.trim() : '';
      if (!model || model.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(model)) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_model', message: 'model 必须是 1..256 字符且不含控制字符' },
        });
        return true;
      }
      // 真实探测：回环走完整路由管线，返回真实状态码与延迟（替代旧版随机假数据）。
      const result = await probeModelConnectivity(model);
      jsonResponse(res, 200, result);
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/service/restart') {
      import('node:child_process').then(({ spawn }) => {
        // 重启脚本可能位于源码目录的 scripts/ 下，也可能直接放在运行目录根部（部署副本布局）。
        const runDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
        const scriptsDir = path.join(runDir, 'scripts');
        const scriptName = process.platform === 'win32' ? 'restart-router.ps1' : 'restart-router.sh';
        const candidates = [path.join(scriptsDir, scriptName), path.join(runDir, scriptName)]
          .filter((candidate) => {
            try {
              return fs.statSync(candidate).isFile();
            } catch {
              return false;
            }
          });
        const command = process.platform === 'win32' ? 'powershell.exe' : 'bash';
        try {
          for (const script of candidates) {
            const args = process.platform === 'win32'
              ? ['-ExecutionPolicy', 'Bypass', '-File', script]
              : [script];
            spawn(command, args, { detached: true, stdio: 'ignore', cwd: path.dirname(script) }).unref();
          }
        } catch { /* 容错 */ }
      });
      jsonResponse(res, 200, {
        ok: true,
        message: '已触发优雅重启，预计 3 秒后服务重新可用',
      });
      return true;
    }

    // ---------- Cursor 订阅网关（Web 面板管理：状态/账号池/生命周期） ----------
    // cursor2api 作为内部网关由路由统一托管；面板经此代理管理其账号池（增删 crsr_ key/状态）。
    // 网关自身鉴权用 admin 密码（环境变量 CURSOR_GATEWAY_ADMIN_PASSWORD）；面板访问经路由同源+CSRF，key不明文外泄。
    if (url.startsWith('/_admin/api/cursor-gateway')) {
      const action = url.slice('/_admin/api/cursor-gateway'.length).replace(/^\/+/, '');
      const gatewayPort = Number(process.env.CURSOR_GATEWAY_PORT || 6718);
      // 网关管理员密码只从环境变量读取（不在源码/文档中留任何默认凭据字面量）
      const gatewayPassword = process.env.CURSOR_GATEWAY_ADMIN_PASSWORD;

      function gwFetch(gwPath, method = 'GET', body = null) {
        const headers = { 'content-type': 'application/json' };
        if (gatewayCookieJar.cookie) headers.cookie = gatewayCookieJar.cookie;
        const payload = body ? JSON.stringify(body) : null;
        if (payload) headers['content-length'] = Buffer.byteLength(payload);
        return rawHttpsRequest({
          protocol: 'http',
          host: '127.0.0.1',
          port: gatewayPort,
          path: gwPath,
          method,
          headers,
          body: payload,
          timeouts: { connectMs: 3000, responseHeaderMs: 8000, requestMs: 12000 },
          maxResponseBytes: 2 * 1024 * 1024,
        }).then(
          (r) => ({ status: r.status, bodyText: r.bodyText, headers: r.headers }),
          (error) => (
            { status: 502, bodyText: JSON.stringify({ error: { code: 'gateway_unreachable', message: `Cursor 网关不可达: ${error.message}` } }), headers: {} }
          ),
        );
      }

      async function ensureSession() {
        const st = await gwFetch('/api/auth/status');
        // 已登录才会返回 authenticated:true；缺字段或为 false 都需要重新登录
        let authed = false;
        if (st.status === 200) {
          try {
            const parsed = JSON.parse(st.bodyText || '{}');
            authed = parsed.authenticated === true;
          } catch { /* 非 JSON 视为未登录 */ }
        }
        if (authed) return;
        if (!gatewayPassword) {
          const err = new Error('未配置 CURSOR_GATEWAY_ADMIN_PASSWORD：请设置 Cursor 网关管理员密码环境变量后重启路由');
          throw err;
        }
        const login = await gwFetch('/api/auth/login', 'POST', { password: gatewayPassword });
        if (login.status >= 300) {
          // 登录失败：清空缓存的 cookie，抛错让调用方收到明确 502（不把 401 当成功缓存）
          gatewayCookieJar.cookie = '';
          const err = new Error(`Cursor 网关登录失败 (HTTP ${login.status})，请检查 CURSOR_GATEWAY_ADMIN_PASSWORD`);
          throw err;
        }
        const setCookie = login.headers?.['set-cookie'];
        const cookieVal = Array.isArray(setCookie) ? setCookie[0] : setCookie;
        const match = /cursor2api_session=([^;]+)/.exec(String(cookieVal || ''));
        if (match) gatewayCookieJar.cookie = `cursor2api_session=${match[1]}`;
        else throw new Error('Cursor 网关登录后未返回会话 cookie');
      }

      try {
        if (action === 'status') {
          const h = await gwFetch('/health');
          jsonResponse(res, 200, {
            ok: true,
            running: h.status === 200,
            port: gatewayPort,
            ...(h.status === 200 ? JSON.parse(h.bodyText || '{}') : {}),
            error: h.status === 200 ? undefined : (JSON.parse(h.bodyText || '{}').error?.message || '网关未运行'),
          });
          return true;
        }
        if (action === 'login') {
          await ensureSession();
          jsonResponse(res, 200, { ok: true, message: '网关会话已建立' });
          return true;
        }
        if (req.method === 'GET' && action === 'accounts') {
          await ensureSession();
          const data = await gwFetch('/api/credentials');
          const payload = data.status < 300 ? JSON.parse(data.bodyText || '{}') : { error: JSON.parse(data.bodyText || '{}') };
          jsonResponse(res, 200, { ok: true, ...payload });
          return true;
        }
        if (req.method === 'POST' && action === 'accounts/add') {
          const payload = await readJsonBody(req);
          // 面板可留空（用 CURSOR_KEY 环境变量），但空值要明确提示而非透传到网关
          const rawKey = typeof payload?.cursorApiKey === 'string' ? payload.cursorApiKey.trim() : '';
          const label = typeof payload?.label === 'string' && payload.label.trim() ? payload.label.trim() : 'main';
          if (!rawKey && !process.env.CURSOR_KEY) {
            jsonResponse(res, 400, {
              ok: false,
              error: { code: 'cursor_key_missing', message: '请填写 crsr_ Key，或在环境变量 CURSOR_KEY 中配置' },
            });
            return true;
          }
          await ensureSession();
          const data = await gwFetch('/api/credentials', 'POST', {
            cursorApiKey: rawKey || process.env.CURSOR_KEY,
            label,
          });
          const parsed = (() => {
            try { return JSON.parse(data.bodyText || '{}'); } catch { return {}; }
          })();
          jsonResponse(res, data.status === 201 ? 200 : (data.status < 500 ? data.status : 502), {
            ok: data.status === 201,
            ...parsed,
          });
          return true;
        }
        if (req.method === 'POST' && action === 'accounts/remove') {
          const payload = await readJsonBody(req);
          await ensureSession();
          const data = await gwFetch(`/api/credentials/${encodeURIComponent(payload?.id || '')}`, 'DELETE');
          const parsed = (() => {
            try { return JSON.parse(data.bodyText || '{}'); } catch { return {}; }
          })();
          // 按网关真实结果回传状态：删除失败也要如实告知，不能报成功
          jsonResponse(res, data.status < 300 ? 200 : (data.status < 500 ? data.status : 502), {
            ok: data.status < 300,
            ...parsed,
          });
          return true;
        }
        jsonResponse(res, 404, { error: { code: 'not_found', message: '未知 cursor-gateway 操作' } });
      } catch (error) {
        jsonResponse(res, 502, { error: { code: 'gateway_proxy_error', message: error.message || '网关代理失败' } });
      }
      return true;
    }
    return false;
  }

  return async function adminHandler(req, res) {
    const url = (req.url || '/').split('?')[0];
    // 兼容根路径与 /admin 前缀两种资源引用方式；未命中清单的走磁盘回退。
    const assetPath = url.startsWith('/assets/') ? url.slice('/assets/'.length - 1)
      : url.startsWith('/admin/assets/') ? url.slice('/admin/assets/'.length - 1)
        : null;
    const isAdminRequest = url.startsWith('/_admin/') || webAssets.has(url) || assetPath !== null;
    if (!isAdminRequest) return false;
    const policy = inspectAdminRequest({
      host: req.headers.host,
      origin: req.headers.origin,
      secFetchSite: req.headers['sec-fetch-site'],
      method: req.method,
      localPort: req.socket.localPort,
    });
    if (!policy.allowed) {
      jsonResponse(res, policy.status, {
        error: {
          code: policy.code,
          message: policy.code === 'admin_host_forbidden'
            ? '管理请求 Host 无效'
            : '拒绝跨站管理请求',
        },
      });
      return true;
    }
    try {
      if (url.startsWith('/_admin/api/')) return await handleApi(req, res, url);
      const asset = webAssets.get(url) || (assetPath ? diskAsset(assetPath) : null);
      if (!asset || req.method !== 'GET' || !options.webRoot) return false;
      const [fileName, contentType] = asset;
      const bytes = fs.readFileSync(path.join(options.webRoot, fileName));
      res.writeHead(200, {
        ...ADMIN_SECURITY_HEADERS,
        'content-type': contentType,
        'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'pragma': 'no-cache',
        'expires': '0',
        'content-length': bytes.length,
      });
      res.end(bytes);
      return true;
    } catch (error) {
      const status = error.code === 'revision_conflict' ? 409
        : error.code === 'confirmation_invalid' ? 409
        : error.code === 'admin_body_too_large' ? 413
          : error.code === 'config_write_failed' ? 500
          : 400;
      jsonResponse(res, status, { error: safeAdminError(error) });
      return true;
    }
  };
}
