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
  escapeModelSlug,
} from './model-routing-plan.mjs';
import { createModelRoutingTransaction } from './model-routing-transaction.mjs';
import {
  adminSecurityHeaders,
  inspectAdminRequest,
} from './admin-request-policy.mjs';
import {
  OFFICIAL_MODEL_SLUGS,
  filterOfficialModels,
  selectModels,
  dedupeCatalogEntries,
  assertDesktopSafeModels,
  buildOfficialConfigToml,
  buildRouterConfigToml,
  parseConfigTomlModel,
  detectAccessMode,
  readJsonFile,
  writeWithBackup,
  buildModelsJson,
  resolveDesktopPaths,
  snapshotDesktopCatalog,
  readCatalogSnapshot,
  mergeCatalogWithSnapshot,
  ensureDesktopModelDefaults,
  genericInstructions,
} from './codex-desktop-config.mjs';
import { createSelfUpdate } from './self-update.mjs';

// 写入 config.toml 的 model 值会落在 `model = "..."` 引号内：最小安全规则是
// 禁引号/反斜杠/控制字符（防 TOML 注入与解析失败）；其余字符（含平台前缀的 /）均合法。
function isValidTomlModelSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && !/["\\]/.test(value);
}

// config.toml 顶层字符串键读取（到首个段头为止）：段内（如 [projects.*]）的同名键不算。
function readTopLevelTomlString(text, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`);
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*\[{1,2}[^\]]*\]{1,2}\s*$/.test(line)) break;
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return '';
}
import {
  dbGetDashboardStats,
  dbSaveAccount,
  dbListAccounts,
  dbDeleteAccount,
  dbRenameChannelKeyTarget,
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
import { buildCodexAuthJson } from './openai-auth.mjs';
import { parseCodexRateLimitHeaders, probeCodexRateLimits } from './account-quota.mjs';
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
  toml_precheck_failed: '生成的 TOML 配置未通过写前校验，已拒绝写入（原文件未动）',
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
      } else if (key === 'proxyUrl' && typeof child === 'string'
        && /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(child)) {
        // 代理 URL 内嵌账号密码（http://user:pass@host）：与管理页展示的其他凭据同权脱敏
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

// 授权放弃后的会话回收：loopback 监听 socket + 会话对象不随进程常驻
const OAUTH_SESSION_TTL_MS = 10 * 60_000;

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

  // 面板自更新（检查开源仓库新版本 / 一键更新）：runDir=源码仓库工作副本
  const selfUpdate = createSelfUpdate({
    runDir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    proxy: options.oauthProxy || null,
    log: (event) => options.log?.(event),
  });
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
    // 复用统一的原子写入（唯一 tmp + fsync + TOML 写前校验 + 备份保留上限）。
    const backup = writeWithBackup(configPath, lines.join('\n'));
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

  // 完整测试（sub2api 式「看到真实请求与回复」）：真实对话一轮，消费完整 SSE，
  // 返回模型回复原文——连接探测只读响应头即断开，看不到回复，故分开两个探测。
  function probeModelReply(model) {
    const body = JSON.stringify({
      model,
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '请用一句中文简短介绍你自己。' }],
      }],
      stream: true,
      max_output_tokens: 256,
    });
    const requestBodyPretty = JSON.stringify(JSON.parse(body), null, 2);
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      let reply = '';
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve({ model, latencyMs: Date.now() - startedAt, reply, requestBody: requestBodyPretty, ...result });
      };
      const probeHeaders = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      };
      try {
        if (!internalProbeKey) internalProbeKey = apiKeyStore.rotateInternalProbeKey();
        if (internalProbeKey) probeHeaders.authorization = `Bearer ${internalProbeKey}`;
      } catch { /* 探针签发失败时退化为无鉴权探测 */ }
      const probe = http.request({
        host: '127.0.0.1',
        port: options.port,
        path: '/v1/responses',
        method: 'POST',
        headers: probeHeaders,
        timeout: 60_000,
      });
      probe.on('response', (probeRes) => {
        const status = probeRes.statusCode || 0;
        if (status < 200 || status >= 300) {
          const chunks = [];
          let size = 0;
          probeRes.on('data', (chunk) => {
            if (size < MODEL_PROBE_ERROR_BODY_BYTES) {
              chunks.push(chunk);
              size += chunk.length;
            }
          });
          probeRes.on('close', () => {
            finish({ ok: false, status, error: probeErrorSummary(status, Buffer.concat(chunks).toString('utf8')) });
          });
          return;
        }
        // 消费完整 SSE，拼接模型回复（output_text.delta）
        let lineBuffer = '';
        probeRes.setEncoding('utf8');
        probeRes.on('data', (chunk) => {
          lineBuffer += chunk;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
            try {
              const payload = JSON.parse(trimmed.slice(6));
              if (payload?.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
                reply += payload.delta;
              }
            } catch { /* 非 JSON 行忽略 */ }
          }
        });
        probeRes.on('error', () => finish({ ok: reply.length > 0, status, error: '响应流中断' }));
        probeRes.on('end', () => finish({ ok: true, status, message: `回复完成 (${reply.length} 字符)` }));
      });
      probe.on('timeout', () => {
        probe.destroy();
        finish({ ok: false, error: '测试超时（60 秒内未完成回复）' });
      });
      probe.on('error', (error) => {
        finish({ ok: false, error: `回环测试失败: ${error.message}` });
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
    // 代理不写死兜底：仅当部署环境显式配置了 oauthProxy 才启用账号级代理。
    // 写死 127.0.0.1:10808 会让开源用户（无本地代理客户端）的账号出站全部
    // ECONNREFUSED（2026-09-04 开源用户反馈实锤）。无代理 = 直连。
    const accountProxyUrl = options.oauthProxy?.host
      ? `http://${options.oauthProxy.host}:${options.oauthProxy.port || 10808}`
      : '';

    dbSaveAccount({
      id: accountId,
      provider,
      email: safeEmail,
      alias,
      proxy_enabled: accountProxyUrl ? 1 : 0,
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
          proxy: accountProxyUrl ? { enabled: true, url: accountProxyUrl } : { enabled: false, url: '' },
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
  // Codex 账号切换互斥（闭包级：跨请求生效；逐请求声明会让互斥完全失效）
  let codexSwitchInFlight = false;
  // 桌面端配置写入互斥（restore-official/apply-router/codex-default-model 的多文件读改写窗口）
  const codexDesktopMutex = (() => { let tail = Promise.resolve(); return { async acquire() { const prev = tail; let release; tail = new Promise((r) => { release = r; }); await prev; return release; } }; })();

  async function handleApi(req, res, url) {
    if (req.method === 'GET' && url === '/_admin/api/status') {
      jsonResponse(res, 200, statusBody());
      return true;
    }
    // 全局默认压缩阈值（modelContext.autoCompactTokenLimit）：null=不设置（客户端按自身默认策略），
    // 正整数=所有未单设阈值的模型共用的自动压缩触发线。官方模型由内置 overrides 单独管理，不受影响。
    if (req.method === 'GET' && url === '/_admin/api/model-context/defaults') {
      const current = readAdminConfig(options);
      const mc = current.value?.modelContext || {};
      jsonResponse(res, 200, {
        enabled: mc.enabled !== false,
        contextWindow: Number(mc.contextWindow) > 0 ? Number(mc.contextWindow) : null,
        autoCompactTokenLimit: Number(mc.autoCompactTokenLimit) > 0 ? Number(mc.autoCompactTokenLimit) : null,
      });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/model-context/defaults') {
      const payload = await readJsonBody(req);
      const raw = payload?.autoCompactTokenLimit;
      const value = raw === null || raw === undefined || raw === ''
        ? null
        : Math.floor(Number(raw));
      if (value !== null && (!Number.isFinite(value) || value <= 0)) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_compact_limit', message: '压缩阈值必须为正整数（tokens），留空表示不设置' },
        });
        return true;
      }
      const current = readAdminConfig(options);
      const config = structuredClone(current.value);
      const mc = config.modelContext || (config.modelContext = {});
      mc.enabled = mc.enabled !== false;
      if (value === null) delete mc.autoCompactTokenLimit;
      else mc.autoCompactTokenLimit = value;
      const inspected = inspectRouterConfig(config, context());
      if (inspected.errors.length) {
        jsonResponse(res, 422, {
          error: { code: 'config_invalid', message: `配置校验失败：${inspected.errors[0]?.message || inspected.errors[0]?.code || '未知错误'}` },
        });
        return true;
      }
      const committed = commitAdminConfig(options, config, current.revision);
      jsonResponse(res, 200, {
        revision: committed.revision,
        autoCompactTokenLimit: value,
        restartRequired: true,
      });
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
            autoCompactTokenLimit: Number(model.auto_compact_token_limit) > 0 ? Number(model.auto_compact_token_limit) : null,
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
        // 标准错误形状：前端 toast / 对话框读 error.message；明细挂 errors 供排查
        jsonResponse(res, 422, {
          error: {
            code: 'plan_invalid',
            message: `操作未通过校验：${plan.errors[0]?.message || plan.errors[0]?.code || '未知错误'}`,
          },
          ...publicPlan(plan),
        });
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
        // 通道改名联动：密钥池条目按通道名关联，旧名条目迁移到新名（幂等，失败仅记日志）
        const renamed = plan.impact?.targets?.renamed || [];
        for (const { from, to } of renamed) {
          if (!from || !to || from === to) continue;
          try {
            const migrated = dbRenameChannelKeyTarget(from, to);
            if (migrated > 0) {
              console.warn(`[admin] target renamed ${from} -> ${to}: 迁移密钥池 ${migrated} 条`);
            }
          } catch { /* 密钥池迁移失败不阻塞响应；旧名条目保留，用户可在密钥池页补录 */ }
        }
        // 模型删除联动：桌面端目录（models.desktop.json）同步移除被删条目，
        // 避免「管理面已删、桌面选择器还在」（2026-09-03 用户实锤）。失败仅记
        // 日志不阻塞响应；桌面端下次全量写入（apply-router）也会自然纠正。
        const deletedModels = Array.isArray(plan.impact?.models?.deleted) ? plan.impact.models.deleted : [];
        if (deletedModels.length > 0) {
          try {
            const desktopPaths = resolveDesktopPaths(options.codexHome || options.defaultCodexHome);
            if (fs.existsSync(desktopPaths.modelsDesktopJson)) {
              const parsed = JSON.parse(fs.readFileSync(desktopPaths.modelsDesktopJson, 'utf8'));
              const list = Array.isArray(parsed?.models) ? parsed.models : [];
              const removed = new Set(deletedModels);
              const next = list.filter((m) => !removed.has(m?.slug));
              if (next.length !== list.length) {
                writeWithBackup(desktopPaths.modelsDesktopJson, buildModelsJson(next));
                console.warn(`[admin] model deleted ${deletedModels.join(',')}: 桌面端目录已同步移除 ${list.length - next.length} 条`);
              }
            }
          } catch (error) {
            console.warn(`[admin] desktop catalog cleanup failed: ${error?.message || error}`);
          }
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
        // 标准错误形状（前端读 error.message）；明细挂 errors 供排查
        jsonResponse(res, 422, {
          error: {
            code: 'config_invalid',
            message: `配置校验失败：${inspected.errors[0]?.message || inspected.errors[0]?.code || '未知错误'}`,
          },
          errors: inspected.errors,
        });
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
        // 剥离本地路径细节（错误消息可能内嵌 configPath）
        const detail = String(err.message || '同步失败').replace(/[A-Za-z]:\\[^\s'"]+/g, '<本地路径>');
        jsonResponse(res, 500, { error: { code: 'sync_codex_failed', message: detail } });
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/keys/unsync-codex') {
      try {
        const unsynced = restoreCodexConfig();
        jsonResponse(res, 200, { ok: true, ...unsynced });
      } catch (err) {
        jsonResponse(res, 500, { error: { code: 'unsync_codex_failed', message: String(err.message || '取消同步失败').replace(/[A-Za-z]:\[^s'"]+/g, '<本地路径>') } });
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
            billingUrl: preset.billingUrl || null,
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

      // 小白免配置：激活预设时若无同 match 的 modelCapabilities，自动写推荐参数
      //（上下文窗口取预设真实模型清单的最大值），防止全局预算把小窗口模型打超限。
      const caps = Array.isArray(config.modelCapabilities) ? config.modelCapabilities : [];
      if (!caps.some((item) => item?.match === preset.defaultMatch)) {
        const windows = preset.models
          .map((model) => Number(model?.contextWindow))
          .filter((value) => Number.isFinite(value) && value > 0);
        if (windows.length) {
          const maxWindow = Math.max(...windows);
          caps.push({
            _comment: `${preset.name} 预设推荐参数（接入时自动生成）`,
            match: preset.defaultMatch,
            contextWindow: maxWindow,
            maxOutputTokens: 8192,
            safetyRatio: 0.9,
            protocolReserveTokens: 1024,
            imageTokens: 2048,
          });
          config.modelCapabilities = caps;
          changes.push(`已写入 ${preset.name} 推荐参数（上下文窗口 ${maxWindow} tokens）`);
        }
      }

      const addCatalog = payload?.addCatalog !== false;
      // 用户自定义模型清单（vendor 弹窗可自由编辑）：优先于预设默认清单。
      // 自定义 slug 若不命中预设 defaultMatch（如 my-glm 不以 deepseek 开头），
      // 需要扩展通道 match 枚举并写入 modelMap（对外用 slug、对厂商用真实码）。
      const customModels = Array.isArray(payload?.models)
        ? payload.models
            .map((item) => {
              if (typeof item === 'string') return { slug: item.trim(), upstream: '' };
              const slug = typeof item?.slug === 'string' ? item.slug.trim() : '';
              const upstream = typeof item?.upstream === 'string' ? item.upstream.trim() : '';
              return { slug, upstream };
            })
            .filter((item) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.slug))
        : null;
      if (payload?.models !== undefined && (!customModels || customModels.length === 0)) {
        jsonResponse(res, 400, {
          error: { code: 'models_invalid', message: '自定义模型清单为空或格式非法（每行一个 slug，或 slug=上游码）' },
        });
        return true;
      }

      // 代理配置（payload.proxy）：新建/复用通道都应用。
      // viaProxy=true 走全局代理；proxyUrl 指向自定义节点；null 清除自定义节点。
      if (payload?.proxy && typeof payload.proxy === 'object') {
        const targetObj = targets.find((target) => target.name === targetName);
        if (targetObj) {
          const before = JSON.stringify({ viaProxy: targetObj.viaProxy === true, proxyUrl: targetObj.proxyUrl || null });
          if (typeof payload.proxy.viaProxy === 'boolean') targetObj.viaProxy = payload.proxy.viaProxy;
          if (typeof payload.proxy.proxyUrl === 'string' && payload.proxy.proxyUrl.trim()) {
            targetObj.proxyUrl = payload.proxy.proxyUrl.trim().slice(0, 2048);
          } else if (payload.proxy.proxyUrl === null) {
            delete targetObj.proxyUrl;
          }
          const after = JSON.stringify({ viaProxy: targetObj.viaProxy === true, proxyUrl: targetObj.proxyUrl || null });
          if (before !== after) {
            changes.push(after.includes('"viaProxy":true')
              ? '通道已设置走代理'
              : (targetObj.proxyUrl ? '通道已设置自定义代理节点' : '通道已改为直连'));
          }
        }
      }

      // 自定义 slug 不命中 defaultMatch 的（如 my-glm 不以 deepseek 开头）：
      // 扩展通道 match 枚举让路由可达；带上游码的写 modelMap（对外 slug、对厂商真实码）。
      if (addCatalog && customModels && customModels.length > 0) {
        let presetMatch = null;
        try { presetMatch = new RegExp(preset.defaultMatch); } catch { /* 预设正则非法时按全部需扩展处理 */ }
        const needsExtension = customModels.filter((m) => !presetMatch || !presetMatch.test(m.slug));
        const targetObj = targets.find((target) => target.name === targetName);
        if (needsExtension.length > 0 && targetObj) {
          const extension = `^(?:${needsExtension.map((m) => escapeModelSlug(m.slug)).join('|')})$`;
          const original = typeof targetObj.match === 'string' ? targetObj.match : '';
          if (original && !original.includes(extension)) {
            targetObj.match = `${original}|${extension}`;
            changes.push(`已扩展通道 match 覆盖 ${needsExtension.length} 个自定义模型名`);
          }
        }
        const mapEntries = customModels.filter((m) => m.upstream && m.upstream !== m.slug);
        if (mapEntries.length > 0 && targetObj) {
          const merged = { ...(targetObj.modelMap || {}) };
          for (const m of mapEntries) merged[m.slug] = m.upstream;
          targetObj.modelMap = merged;
          changes.push(`已写入 ${mapEntries.length} 条模型码映射（对外别名 → 厂商真实模型码）`);
        }
      }

      // 预设默认模型写入 catalog（slug 去重，已存在跳过）；接入后可用「自动拉取模型」覆盖
      const catalog = structuredClone(current.catalog.value);
      const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
      let renamedModels = 0;
      let addedModels = 0;
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
      if (addCatalog && fetchedModels === null && customModels) {
        // 用户编辑过的清单优先：按清单写入（slug 对外用自定义名，显示名带厂商前缀）
        const knownSlugs = new Set(catalogModels.map((item) => item?.slug));
        const presetBySlug = new Set((preset.models || []).map((model) => model.slug));
        for (const item of customModels) {
          if (knownSlugs.has(item.slug)) continue;
          catalogModels.push({
            slug: item.slug,
            display_name: `${preset.id}/${item.slug}`,
            description: `${preset.name}（${presetBySlug.has(item.slug) ? preset.planLabel : '自定义清单'}）`,
            visibility: 'list',
            supported_in_api: true,
            priority: 10,
            input_modalities: ['text'],
          });
          knownSlugs.add(item.slug);
          addedModels += 1;
        }
        if (addedModels > 0) catalog.models = catalogModels;
      }
      if (addCatalog && fetchedModels === null && !customModels) {
        const knownSlugs = new Set(catalogModels.map((item) => item?.slug));
        for (const model of preset.models) {
          // 显示名统一带厂商前缀（deepseek/deepseek-v4-flash）：管理页按厂商前缀
          // 自动归组（groupOf 前缀优先于预置 slug 表），一键接入的模型进厂商分组。
          const displayName = `${preset.id}/${model.slug}`;
          const existing = catalogModels.find((item) => item?.slug === model.slug);
          if (!existing) {
            const entry = {
              slug: model.slug,
              display_name: displayName,
              description: `${preset.name}（${preset.planLabel}）`,
              visibility: 'list',
              supported_in_api: true,
              priority: 10,
              input_modalities: ['text'],
              default_reasoning_level: model.defaultReasoningLevel || 'medium',
              ...(model.contextWindow ? { context_window: model.contextWindow } : {}),
            };
            ensureDesktopModelDefaults(entry);
            catalogModels.push(entry);
            knownSlugs.add(model.slug);
            addedModels += 1;
          } else if (existing.display_name === existing.slug || !existing.display_name) {
            // 存量裸名（历史接入未带前缀且用户未自定义过显示名）：升级为厂商前缀
            if (existing.display_name !== displayName) {
              existing.display_name = displayName;
              renamedModels += 1;
            }
          }
        }
        if (addedModels > 0 || renamedModels > 0) catalog.models = catalogModels;
      }

      const inspected = inspectRouterConfig(config, context());
      if (inspected.errors.length > 0) {
        // 标准错误形状（前端 toast / 对话框就地提示都读 error.message）；
        // 明细挂在 errors 供排查，不再返回裸 inspected 导致前端只显示笼统文案。
        jsonResponse(res, 422, {
          error: {
            code: 'config_invalid',
            message: `配置校验失败：${inspected.errors[0]?.message || inspected.errors[0]?.code || '未知错误'}`,
          },
          errors: inspected.errors,
        });
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

    // ---------- 谷歌订阅通道一键接入 ----------
    // 用已绑定的谷歌账号拉取订阅模型清单，自动创建 platform:'google' 专属通道
    //（每模型一个精确 match target，账号池 OAuth 鉴权）并把模型写入桌面目录。
    if (req.method === 'POST' && url === '/_admin/api/google-channel/setup') {
      const authManager = options.authManager;
      const googleAccounts = (authManager?.listAccounts?.('google') || [])
        .filter((acc) => acc.status === 'active' || acc.status === 'cooldown');
      if (googleAccounts.length === 0) {
        jsonResponse(res, 400, {
          error: { code: 'google_account_missing', message: '还没有绑定谷歌订阅账号：请先在「订阅账号」页完成 Google 一键授权' },
        });
        return true;
      }
      const proxy = options.oauthProxy;
      let account = null;
      let credentials = null;
      let models = null;
      let fetchError = '';
      for (const candidate of googleAccounts) {
        try {
          const creds = await authManager.getValidCredentials(candidate.id);
          if (!creds?.accessToken) continue;
          let projectId = creds.projectId || candidate.metadata?.projectId || '';
          if (!projectId || projectId === '{}') {
            try {
              const discovered = await discoverGoogleProject({ accessToken: creds.accessToken, proxy });
              projectId = discovered.projectId || '';
              if (projectId) {
                authManager.updateAccount(candidate.id, { metadata: { ...(candidate.metadata || {}), projectId } });
              }
            } catch { /* 无 project 的账号跳过 */ }
          }
          if (!projectId) continue;
          models = await fetchGoogleAvailableModels({ accessToken: creds.accessToken, projectId, proxy });
          account = candidate;
          credentials = { ...creds, projectId };
          break;
        } catch (error) {
          fetchError = error.message || '拉取失败';
        }
      }
      if (!models) {
        jsonResponse(res, 502, {
          error: { code: 'google_models_fetch_failed', message: `谷歌订阅模型清单拉取失败：${fetchError || '没有可用 project 的账号'}` },
        });
        return true;
      }

      const current = readModelRoutingFiles();
      const config = structuredClone(current.config.value);
      const catalog = structuredClone(current.catalog.value);
      const targets = Array.isArray(config.targets) ? config.targets : [];
      const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];
      const knownSlugs = new Set(catalogModels.map((item) => item?.slug));
      const changes = [];
      let addedModels = 0;
      let addedTargets = 0;
      const pushCatalogModel = (entrySlug, displayName, level, images) => {
        catalogModels.push({
          slug: entrySlug,
          display_name: displayName,
          description: '谷歌 AI 订阅（Antigravity）',
          visibility: 'list',
          supported_in_api: true,
          priority: 10,
          // base_instructions 是桌面端解析目录的必填非空字段：缺失会导致这些模型
          // 在「接入路由」弹窗勾选后 apply-router 校验失败（2026-09-01 实锤）。
          base_instructions: genericInstructions(displayName),
          input_modalities: images ? ['text', 'image'] : ['text'],
          default_reasoning_level: level || 'high',
          supported_reasoning_levels: [
            { effort: 'low', description: '快速响应，较轻推理' },
            { effort: 'medium', description: '平衡速度与推理深度' },
            { effort: 'high', description: '复杂问题的更深推理' },
          ],
        });
        addedModels += 1;
      };
      const pushTarget = (entrySlug, upstreamName) => {
        // 超长 slug 截断后可能撞名（两个截断名相同）：撞名时追加 8 位哈希去重
        let targetName = `google-${entrySlug}`.slice(0, 64);
        if (entrySlug.length + 'google-'.length > 64 && targets.some((item) => item.name === targetName)) {
          targetName = `${targetName}-${crypto.createHash('sha256').update(entrySlug).digest('hex').slice(0, 8)}`;
        }
        if (targets.some((item) => item.name === targetName)) return;
        targets.push({
          name: targetName,
          match: `^${escapeModelSlug(entrySlug)}$`,
          platform: 'google',
          host: 'cloudcode-pa.googleapis.com',
          wireApi: 'chat',
          upstreamModel: upstreamName,
          viaProxy: true,
        });
        addedTargets += 1;
      };
      for (const info of models) {
        const slug = typeof info?.name === 'string' ? info.name.trim() : '';
        if (!slug || knownSlugs.has(slug)) continue;
        knownSlugs.add(slug);
        pushCatalogModel(slug, info.displayName || slug, 'high', info.images);
        pushTarget(slug, slug);
      }
      // 档位变体合成（Antigravity Tools 式）：上游 -tiered 后缀模型 = thinkingLevel 可调载体，
      // 为其生成 -low/-medium/-high 三个用户友好变体（slug 后缀在谷歌派发器解析为
      // thinkingLevel，upstreamModel 映射回 tiered 载体——对齐 gemini-3.7-flash-high 实测）。
      const TIER_LEVELS = ['low', 'medium', 'high'];
      for (const info of models) {
        const slug = typeof info?.name === 'string' ? info.name.trim() : '';
        if (!slug || !/-tiered$/i.test(slug)) continue;
        const baseSlug = slug.replace(/-tiered$/i, '');
        for (const level of TIER_LEVELS) {
          const variantSlug = `${baseSlug}-${level}`;
          if (knownSlugs.has(variantSlug)) continue;
          knownSlugs.add(variantSlug);
          pushCatalogModel(variantSlug, `${info.displayName || slug} (${level})`, level, info.images);
          pushTarget(variantSlug, slug);
        }
      }
      if (addedModels > 0) catalog.models = catalogModels;
      if (addedTargets > 0) config.targets = targets;
      changes.push(`账号 ${account.email || account.id} 拉取 ${models.length} 个模型；新增 ${addedModels} 个模型 / ${addedTargets} 个通道`);
      if (addedModels === 0 && addedTargets === 0) {
        jsonResponse(res, 200, { ok: true, addedModels: 0, addedTargets: 0, models: models.length, message: '谷歌订阅模型已全部在目录中，无需变更' });
        return true;
      }
      const inspected = inspectRouterConfig(config, context());
      if (inspected.errors.length > 0) {
        jsonResponse(res, 422, {
          error: {
            code: 'config_invalid',
            message: `配置校验失败：${inspected.errors[0]?.message || inspected.errors[0]?.code || '未知错误'}`,
          },
          errors: inspected.errors,
        });
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
      jsonResponse(res, 200, {
        ok: true,
        account: account.email || account.id,
        fetched: models.length,
        addedModels,
        addedTargets,
        changes,
        configRevision: committed.configRevision,
        catalogRevision: committed.catalogRevision,
        restartRequired: true,
        message: `已接入谷歌订阅通道（新增 ${addedModels} 个模型 / ${addedTargets} 个专属通道）；重启路由与 Codex 后生效`,
      });
      return true;
    }

    // ---------- Codex 登录账号一键切换（用订阅池凭据替换 auth.json + 自动重启桌面端） ----------
    const codexAuthPath = () => path.join(
      path.dirname(resolveDesktopPaths(options.codexHome || options.defaultCodexHome).configToml),
      'auth.json',
    );

    // 当前 Codex 登录身份（解码 auth.json 的 id_token，不做签名校验——仅展示用）
    if (req.method === 'GET' && url === '/_admin/api/codex-desktop/auth-identity') {
      try {
        const raw = JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8'));
        const idToken = raw?.tokens?.id_token || '';
        const claims = idToken ? decodeOpenAiIdToken(idToken) : {};
        jsonResponse(res, 200, {
          ok: true,
          loggedIn: Boolean(raw?.tokens?.access_token),
          email: claims.email || '',
          chatgptAccountId: raw?.tokens?.account_id || claims.chatgptAccountId || '',
          planType: claims.planType || '',
          lastRefresh: raw?.last_refresh || '',
        });
      } catch {
        jsonResponse(res, 200, { ok: true, loggedIn: false, email: '', chatgptAccountId: '' });
      }
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/codex-desktop/switch-account') {
      // 并发互斥：切换 = 杀桌面端→写 auth.json→重启，两路并发会互相杀掉对方刚拉起的
      // 桌面端并 last-write-wins 覆盖登录态。
      if (codexSwitchInFlight) {
        jsonResponse(res, 409, { error: { code: 'switch_in_progress', message: '已有一次切换在进行中，请等它完成（约 15 秒）再试' } });
        return true;
      }
      codexSwitchInFlight = true;
      try {
      const payload = await readJsonBody(req);
      const accountId = typeof payload?.accountId === 'string' ? payload.accountId.trim() : '';
      const authManager = options.authManager;
      const account = accountId ? authManager?.getAccount(accountId) : null;
      if (!account || account.provider !== 'openai') {
        jsonResponse(res, 404, { error: { code: 'account_not_found', message: 'ChatGPT 订阅账号不存在' } });
        return true;
      }
      if (process.platform !== 'win32') {
        jsonResponse(res, 400, { error: { code: 'desktop_restart_unsupported', message: '仅 Windows 支持自动切换（需重启桌面端）' } });
        return true;
      }
      let creds = null;
      try {
        creds = await authManager.getValidCredentials(account.id);
      } catch (error) {
        jsonResponse(res, 502, { error: { code: 'credentials_refresh_failed', message: `账号凭据刷新失败：${error.message || '未知错误'}` } });
        return true;
      }
      if (!creds?.accessToken || !creds?.refreshToken || !creds?.idToken) {
        jsonResponse(res, 502, { error: { code: 'credentials_incomplete', message: '该账号凭据不完整（缺 id_token/refresh_token），请重新授权此账号' } });
        return true;
      }
      let claims = {};
      try { claims = decodeOpenAiIdToken(creds.idToken); } catch { /* 展示信息缺失不影响切换 */ }
      const chatgptAccountId = account.metadata?.chatgptAccountId || claims.chatgptAccountId || '';

      // 顺序很关键：先完全退出桌面端（运行中的桌面端退出时会覆盖 auth.json），
      // 杀完必须轮询确认真的退出——失败就明确报错且不写登录态（否则写完会被
      // 活着的桌面端用内存态覆盖回去，2026-08-29 实测踩中）。
      const { spawn, execFile } = await import('node:child_process');
      const chatgptRunning = () => new Promise((resolve) => {
        execFile('tasklist', ['/FI', 'IMAGENAME eq ChatGPT.exe'], { windowsHide: true }, (err, stdout) => {
          resolve(!err && String(stdout).includes('ChatGPT.exe'));
        });
      });
      if (await chatgptRunning()) {
        let stopped = false;
        for (let killAttempt = 0; killAttempt < 3 && !stopped; killAttempt += 1) {
          await new Promise((resolve) => {
            const kill = spawn('taskkill', ['/IM', 'ChatGPT.exe', '/F'], { stdio: 'ignore', windowsHide: true });
            kill.on('close', resolve);
            kill.on('error', resolve);
          });
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            if (!(await chatgptRunning())) { stopped = true; break; }
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
        }
        if (!stopped) {
          jsonResponse(res, 409, {
            error: { code: 'desktop_stop_failed', message: '无法退出 Codex 桌面端（可能权限不足）。请手动完全退出桌面端后重试；本次未修改登录态' },
          });
          return true;
        }
      }
      // 桌面端已确认退出，等待 1 秒让文件句柄释放
      await new Promise((resolve) => setTimeout(resolve, 1000));

      let backup = null;
      try {
        backup = writeWithBackup(codexAuthPath(), JSON.stringify(buildCodexAuthJson({
          idToken: creds.idToken,
          accessToken: creds.accessToken,
          refreshToken: creds.refreshToken,
          accountId: chatgptAccountId || undefined,
        }), null, 2) + '\n');
      } catch (error) {
        jsonResponse(res, 500, { error: { code: 'auth_write_failed', message: `写入 auth.json 失败：${error.message}` } });
        return true;
      }
      spawn('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'], { stdio: 'ignore', windowsHide: true }).unref?.();
      jsonResponse(res, 200, {
        ok: true,
        email: claims.email || account.email || account.alias || '',
        planType: claims.planType || account.metadata?.planType || '',
        backup,
        message: `已把 Codex 切换为 ${claims.email || account.email || account.id} 的登录态（原登录已备份）；桌面端已自动重启，约 10 秒后可用`,
      });
      return true;
      } finally {
        codexSwitchInFlight = false;
      }
    }

    // ---------- Codex 默认启动模型（config.toml 顶部 model = "..."） ----------

    if (req.method === 'GET' && url === '/_admin/api/codex-default-model') {
      let current = null;
      let configPath = null;
      const tomlPath = codexConfigTomlPath();
      if (tomlPath && fs.existsSync(tomlPath)) {
        configPath = tomlPath;
        const text = fs.readFileSync(tomlPath, 'utf8');
        current = readTopLevelTomlString(text, 'model') || null;
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
      if (!model || model.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(model) || /["\\]/.test(model)) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_model', message: 'model 必须是 1..256 字符且不含控制字符、引号与反斜杠' },
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
      const lines = original.split(/\r?\n/);
      let modelLine = -1;
      for (let i = 0; i < lines.length; i += 1) {
        // 只改顶层 model 行（允许缩进）；[projects.*] 等段内的项目级 model 设置不动。
        if (/^\s*\[{1,2}[^\]]*\]{1,2}\s*$/.test(lines[i])) break;
        if (/^\s*model\s*=/.test(lines[i])) { modelLine = i; break; }
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
      const backup = writeWithBackup(configPath, lines.join('\n'));
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
          session.ttlTimer = setTimeout(() => resetOAuthSession('google'), OAUTH_SESSION_TTL_MS);
          session.ttlTimer.unref?.();
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
          if (server) {
            session.ttlTimer = setTimeout(() => resetOAuthSession('openai'), OAUTH_SESSION_TTL_MS);
            session.ttlTimer.unref?.();
            driveLoopbackCompletion('openai', session);
          }
          if (payload?.openBrowser !== false) openDefaultBrowser(authUrl);
          jsonResponse(res, 200, { ok: true, mode, authUrl, redirectUri });
          return true;
        }

        if (provider === 'claude') {
          resetOAuthSession('claude');
          const authUrl = buildClaudeAuthUrl({ state, codeChallenge });
          const session = { status: 'pending', codeVerifier, authUrl, state };
          oauthSessions.set('claude', session);
          session.ttlTimer = setTimeout(() => resetOAuthSession('claude'), OAUTH_SESSION_TTL_MS);
          session.ttlTimer.unref?.();
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
      // id/provider 白名单校验：防 "__proto__"/"constructor" 等危险键进入 vault/内存 map
      //（普通对象赋值 map[accountId]=... 会把凭据挂到原型上，persistAll 序列化不到 → 凭据静默丢失）。
      const accountEmail = String(payload.email || '').trim().toLowerCase();
      const SAFE_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
      const rawProvider = String(payload.provider || '').trim();
      const accountId = SAFE_ACCOUNT_ID.test(String(payload.id || ''))
        ? String(payload.id)
        : (accountEmail ? `${rawProvider}_${accountEmail.replace(/[^a-z0-9._-]+/g, '_')}` : `${rawProvider}_${Date.now()}`);
      if (!SAFE_ACCOUNT_ID.test(accountId) || !/^[a-z0-9_-]{2,32}$/.test(rawProvider)) {
        jsonResponse(res, 400, { error: { code: 'invalid_account_id', message: '账号 id/provider 含非法字符（仅允许字母数字与 . _ -）' } });
        return true;
      }
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
    if (req.method === 'POST' && url === '/_admin/api/accounts/clear-cooldown') {
      // 手动解除账号冷却（2026-09-02 实锤：桌面登录账号恰在池内冷却时，同账号守卫
      // 会连兜底一起挡掉——「有额度账号不自动切换」。用户确认账号真实可用后手动复位。
      const payload = await readJsonBody(req);
      const authManager = options.authManager;
      const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
      if (!id || !authManager?.getAccount(id)) {
        jsonResponse(res, 404, { error: { code: 'account_not_found', message: '账号不存在，无法解除冷却' } });
        return true;
      }
      const ok = authManager.clearCooldown(id);
      jsonResponse(res, 200, { ok, message: ok ? `已解除「${id}」的冷却，将参与额度轮换` : '账号状态未变（非冷却状态）' });
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
    // 订阅账号真实额度：ChatGPT=上游 rate_limits（5h/周窗口，与 Codex CLI 同源）；
    // Google=无公开配额接口（sub2api 同判），返回本地周计数与说明。
    if (req.method === 'GET' && url.startsWith('/_admin/api/accounts/quota')) {
      // 上游的 url 已剥查询串，参数从原始 req.url 解析
      const query = new URL(req.url || url, 'http://local').searchParams;
      const accountId = (query.get('id') || '').trim();
      const authManager = options.authManager;
      const account = accountId ? authManager?.getAccount(accountId) : null;
      if (!account) {
        jsonResponse(res, 404, { error: { code: 'account_not_found', message: '账号不存在' } });
        return true;
      }
      if (account.provider === 'openai') {
        // Codex 无独立配额端点：额度随官方通道响应头返回，由路由捕获在 metadata.rateLimits；
        // 零流量账号自动发一条最小探测请求读响应头（约 1 条消息的成本），结果写入后即可展示
        const rl = account.metadata?.rateLimits;
        if (rl?.fiveHour || rl?.weekly) {
          jsonResponse(res, 200, {
            ok: true,
            provider: 'openai',
            fiveHour: rl.fiveHour || null,
            weekly: rl.weekly || null,
            planType: rl.planType || account.metadata?.planType || '',
            updatedAt: rl.updatedAt || 0,
          });
          return true;
        }
        try {
          const creds = await authManager.getValidCredentials(account.id);
          if (!creds?.accessToken) throw new Error('账号没有可用凭据，请重新授权');
          const accountIdHeader = account.metadata?.chatgptAccountId || creds.accountId || '';
          const limits = await probeCodexRateLimits({
            accessToken: creds.accessToken,
            accountId: accountIdHeader,
            proxy: options.oauthProxy,
          });
          if (!limits) throw new Error('上游未返回额度头，稍后重试');
          authManager.updateAccount(account.id, { metadata: { ...(account.metadata || {}), rateLimits: { ...limits, updatedAt: Date.now() } } });
          jsonResponse(res, 200, {
            ok: true,
            provider: 'openai',
            fiveHour: limits.fiveHour || null,
            weekly: limits.weekly || null,
            planType: limits.planType || account.metadata?.planType || '',
            updatedAt: Date.now(),
          });
        } catch (error) {
          jsonResponse(res, 200, { ok: false, provider: 'openai', error: `额度探测失败：${error.message || '未知错误'}` });
        }
        return true;
      }
      if (account.provider === 'google') {
        const value = {
          ok: true,
          provider: 'google',
          supported: false,
          localWeeklyUsed: account.quota?.used || 0,
          note: '谷歌订阅无公开配额接口（按分钟/按模型限额，触发时会自动换号并在约 1 分钟恢复）；此处为本地 7 天请求计数',
        };
        jsonResponse(res, 200, value);
        return true;
      }
      jsonResponse(res, 200, { ok: true, provider: account.provider, supported: false });
      return true;
    }
    // 订阅账号额度消耗顺序：priority 数字越小越先消耗（写入 metadata，账号池选号时排序）。
    // 未设置（空）= 自动按套餐档位排；同一平台建议只给一个账号设最优先。
    // 账号级代理编辑：每个订阅账号可独立配置代理（或清空 = 直连）
    if (req.method === 'POST' && url === '/_admin/api/accounts/set-proxy') {
      const payload = await readJsonBody(req);
      const authManager = options.authManager;
      const accountId = typeof payload?.id === 'string' ? payload.id.trim() : '';
      const account = accountId ? authManager?.getAccount(accountId) : null;
      if (!account) {
        jsonResponse(res, 404, { error: { code: 'account_not_found', message: '账号不存在' } });
        return true;
      }
      const url = typeof payload?.proxyUrl === 'string' ? payload.proxyUrl.trim() : '';
      const enabled = payload?.enabled === true && url !== '';
      if (enabled) {
        if (!/^(http|socks5|ss|trojan|vless):\/\//.test(url)) {
          jsonResponse(res, 400, {
            error: { code: 'invalid_proxy_url', message: '代理链接必须是 http://、socks5://、ss://、trojan:// 或 vless:// 开头' },
          });
          return true;
        }
        if (url.length > 2048) {
          jsonResponse(res, 400, { error: { code: 'invalid_proxy_url', message: '代理链接过长（≤2048 字符）' } });
          return true;
        }
      }
      authManager.updateAccount(account.id, {
        proxy: enabled ? { enabled: true, url } : { enabled: false, url: '' },
      });
      const store = options.credentialsVault || null;
      jsonResponse(res, 200, {
        ok: true,
        id: account.id,
        proxy: enabled ? { enabled: true, url } : { enabled: false, url: '' },
        message: enabled ? `已为该账号启用独立代理（${url.slice(0, 60)}…）` : '已清空该账号的独立代理（恢复直连/跟随全局）',
      });
      return true;
    }

    if (req.method === 'POST' && url === '/_admin/api/accounts/set-priority') {
      const payload = await readJsonBody(req);
      const authManager = options.authManager;
      const accountId = typeof payload?.id === 'string' ? payload.id.trim() : '';
      const account = accountId ? authManager?.getAccount(accountId) : null;
      if (!account) {
        jsonResponse(res, 404, { error: { code: 'account_not_found', message: '账号不存在' } });
        return true;
      }
      let priority = payload?.priority;
      if (priority === null || priority === undefined || priority === '') {
        priority = undefined; // 清空 = 回到自动（按套餐）
      } else {
        priority = Math.max(0, Math.min(99, Math.floor(Number(priority))));
        if (!Number.isFinite(priority)) {
          jsonResponse(res, 400, { error: { code: 'invalid_priority', message: '优先级必须是 0..99 的数字（0 = 最先消耗）' } });
          return true;
        }
      }
      const metadata = { ...(account.metadata || {}) };
      if (priority === undefined) delete metadata.priority;
      else metadata.priority = priority;
      authManager.updateAccount(account.id, { metadata });
      jsonResponse(res, 200, {
        ok: true,
        id: account.id,
        priority: priority === undefined ? null : priority,
        message: priority === undefined
          ? '已恢复自动顺序（按套餐档位）'
          : `已设置 ${account.email || account.id} 为优先级 ${priority}（数字越小越先消耗额度）`,
      });
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
      // 完整测试：回环走完整路由管线，真实对话一轮并返回模型回复原文
      //（sub2api 式「看到真实请求与回复」；只读响应头的连通探测保留在 probeModelConnectivity）。
      const result = await probeModelReply(model);
      jsonResponse(res, 200, result);
      return true;
    }
    // ---- 面板自更新：检查开源仓库新版本 / 一键更新（git 同步 + 保留运行配置）----
    if (req.method === 'GET' && url === '/_admin/api/update/check') {
      if (!selfUpdate) {
        jsonResponse(res, 200, { supported: false, message: '当前部署形态不支持自更新' });
        return true;
      }
      try {
        const info = await selfUpdate.checkLatest();
        jsonResponse(res, 200, { supported: true, ...info });
      } catch (error) {
        jsonResponse(res, 502, {
          error: { code: 'update_check_failed', message: String(error.message || error).slice(0, 300) },
        });
      }
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/update/apply') {
      if (!selfUpdate) {
        jsonResponse(res, 400, { error: { code: 'update_unsupported', message: '当前部署形态不支持自更新' } });
        return true;
      }
      try {
        const result = await selfUpdate.applyUpdateFromGit();
        // 更新完成后触发优雅重启（新代码随后生效）；响应先返回，重启由脚本异步完成
        import('node:child_process').then(({ spawn }) => {
          const runDir = path.dirname(fileURLToPath(import.meta.url));
          const scriptsDir = path.join(runDir, '..');
          const scriptName = process.platform === 'win32' ? 'restart-router.ps1' : 'restart-router.sh';
          const script = path.join(scriptsDir, scriptName);
          if (fs.statSync(script).isFile()) {
            const command = process.platform === 'win32' ? 'powershell.exe' : 'bash';
            const args = process.platform === 'win32'
              ? ['-ExecutionPolicy', 'Bypass', '-File', script]
              : [script];
            spawn(command, args, { detached: true, stdio: 'ignore', cwd: path.dirname(script) }).unref();
          }
        }).catch(() => { /* 重启容错 */ });
        jsonResponse(res, 200, {
          ok: true,
          ...result,
          message: `已更新到最新代码（${result.head}）；服务正在优雅重启，约 3 秒后刷新页面`,
        });
      } catch (error) {
        jsonResponse(res, 500, {
          error: { code: 'update_apply_failed', message: String(error.message || error).slice(0, 400) },
        });
      }
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

    // 定位内置 Cursor 网关目录（server.mjs 所在）：运行实例同级 / 父级 external/cursor2api。
function resolveCursorGatewayDir(options) {
  const candidates = [
    path.join(process.cwd(), 'external', 'cursor2api'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'external', 'cursor2api'),
    path.join(path.dirname(options.configPath || process.cwd()), '..', 'external', 'cursor2api'),
    path.join(path.dirname(options.configPath || process.cwd()), 'external', 'cursor2api'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'server.mjs'))) return dir;
    } catch { /* 容错 */ }
  }
  return null;
}

// 停掉监听指定端口的所有进程（Windows netstat + taskkill；非本进程一律结束）。
async function stopListenersOnPorts(ports) {
  const { execFile } = await import('node:child_process');
  const stopped = [];
  const seen = new Set();
  await new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (error, stdout) => {
      if (!error) {
        for (const line of String(stdout).split(/\r?\n/)) {
          const match = /:(\d+)\s+.*\s+LISTENING\s+(\d+)$/.exec(line.trim());
          if (!match) continue;
          const port = Number(match[1]);
          const pid = match[2];
          if (!ports.includes(port) || seen.has(pid)) continue;
          seen.add(pid);
          stopped.push(Number(pid));
        }
      }
      resolve();
    });
  });
  for (const pid of stopped) {
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => resolve());
    });
  }
  return stopped;
}

    // ---------- Codex 桌面端接入管理（一键恢复官方直连 / 一键接入路由 + 模型动态加载） ----------
    // 读写 CODEX_HOME 下的 config.toml 与 models.json；每次覆盖前自动时间戳备份。
    const desktopPaths = resolveDesktopPaths(options.codexHome || options.defaultCodexHome);
    const readDesktopToml = () => {
      try { return fs.readFileSync(desktopPaths.configToml, 'utf8'); } catch { return ''; }
    };
    const readDesktopCatalog = () => {
      const data = readJsonFile(desktopPaths.modelsJson);
      return Array.isArray(data?.models) ? data.models : [];
    };
    // 桌面端「已加载」精简目录（models.desktop.json）：选择器实际显示的集合
    const readDesktopLoadedCatalog = () => {
      const data = readJsonFile(desktopPaths.modelsDesktopJson);
      return Array.isArray(data?.models) ? data.models : [];
    };
    // 路由侧目录「池」：全部已知模型（优先 catalogPath，兜底 models.json）
    const readPoolCatalog = () => {
      const data = options.catalogPath ? readJsonFile(options.catalogPath) : null;
      if (data && Array.isArray(data.models)) return data.models;
      return readDesktopCatalog();
    };
    // 请求/响应查看器：环形日志的列表与详情（sub2api 式排障入口）
    const requestLogMatch = /^\/_admin\/api\/requests\/([^/]+)$/.exec(url);
    if (req.method === 'GET' && url === '/_admin/api/requests') {
      const limit = Number(new URL(`http://x${url}`).searchParams.get('limit')) || 50;
      jsonResponse(res, 200, { requests: options.requestLog ? options.requestLog.list({ limit }) : [] });
      return true;
    }
    if (req.method === 'GET' && requestLogMatch) {
      const entry = options.requestLog ? options.requestLog.get(decodeURIComponent(requestLogMatch[1])) : null;
      if (!entry) {
        jsonResponse(res, 404, { error: { code: 'request_log_missing', message: '日志条目不存在或已过期（环形缓冲/TTL 淘汰）' } });
        return true;
      }
      jsonResponse(res, 200, { entry });
      return true;
    }
    if (req.method === 'GET' && url === '/_admin/api/codex-desktop/state') {
      const toml = readDesktopToml();
      // 可选模型 = 池 ∪ 已加载（去重保序）；loaded 标记当前选择器里实际显示的
      const poolModels = readPoolCatalog();
      const loadedModels = readDesktopLoadedCatalog();
      const loadedSet = new Set(loadedModels.map((entry) => entry?.slug).filter(Boolean));
      const bySlug = new Map();
      for (const entry of [...poolModels, ...loadedModels]) {
        if (entry?.slug && !bySlug.has(entry.slug)) bySlug.set(entry.slug, entry);
      }
      const entries = [...bySlug.values()].map((entry) => ({
        slug: entry.slug || '',
        displayName: entry.display_name || entry.slug || '',
        official: OFFICIAL_MODEL_SLUGS.includes(entry.slug),
        loaded: loadedSet.has(entry.slug) || OFFICIAL_MODEL_SLUGS.includes(entry.slug),
      })).filter((entry) => entry.slug);
      // loadedCount = 已加载的路由侧模型数（官方全量常驻，不重复计数）
      jsonResponse(res, 200, {
        ok: true,
        mode: detectAccessMode(toml, entries.map((e) => e.slug)),
        defaultModel: parseConfigTomlModel(toml) || '',
        models: entries,
        loadedCount: entries.filter((e) => e.loaded && !e.official).length,
        routerBaseUrl: `http://127.0.0.1:${options.runtime?.port ?? 15730}/v1`,
        officialSlugs: [...OFFICIAL_MODEL_SLUGS],
      });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/codex-desktop/restore-official') {
      const payload = await readJsonBody(req);
      const defaultModel = typeof payload?.defaultModel === 'string' && payload.defaultModel
        ? payload.defaultModel.trim()
        : 'gpt-5.6-sol';
      if (!isValidTomlModelSlug(defaultModel)) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_model', message: 'defaultModel 不能包含引号、反斜杠或控制字符（长度 ≤256），防止破坏 config.toml' },
        });
        return true;
      }
      const currentToml = readDesktopToml();
      if (!currentToml) {
        jsonResponse(res, 400, { error: { code: 'desktop_config_missing', message: '读取不到 config.toml，无法恢复' } });
        return true;
      }
      // 只剥离路由接入痕迹（model_provider / model_catalog_json / [model_providers.router] 段），
      // 保留桌面端主题/插件/MCP 等全部既有配置；聊天记录引用的是目录里的模型，
      // 恢复官方直连绝不缩减模型目录，否则历史会话引用的模型消失会导致桌面端打不开。
      // 切回官方后桌面端会自行同步裁剪目录，先快照「已加载」目录与池，
      // 下次「接入路由」可把被裁掉的勾选模型自动找回。
      snapshotDesktopCatalog(desktopPaths.modelsDesktopJson);
      snapshotDesktopCatalog(desktopPaths.modelsJson);
      const backupToml = writeWithBackup(desktopPaths.configToml, buildOfficialConfigToml(defaultModel, currentToml));
      jsonResponse(res, 200, {
        ok: true,
        mode: 'official',
        backupToml,
        message: '已恢复官方直连配置（保留全部现有配置与模型目录）；请完全退出并重启 Codex 桌面端生效',
      });
      return true;
    }
    if (req.method === 'POST' && url === '/_admin/api/codex-desktop/apply-router') {
      const payload = await readJsonBody(req);
      // 勾选解析：池 ∪ 已加载目录 ∪ 快照回填。池（models.json/catalogPath）是全部
      // 已知模型——一键接入拉取的新模型先进池，用户在弹窗勾选了才带入桌面选择器
      //（2026-09-02 前：目录池与桌面目录同一文件，一键接入直接涌入选择器）。
      const poolModels = readPoolCatalog();
      const loadedModels = readDesktopLoadedCatalog();
      const snapshotEntries = [
        ...readCatalogSnapshot(desktopPaths.modelsDesktopJson),
        ...readCatalogSnapshot(desktopPaths.modelsJson),
      ];
      const { unknownSlugs, pool: catalogPool } = mergeCatalogWithSnapshot(
        dedupeCatalogEntries([...poolModels, ...loadedModels]),
        snapshotEntries,
        Array.isArray(payload?.slugs) ? payload.slugs : [],
      );
      const requested = Array.isArray(payload?.slugs) ? payload.slugs : [];
      if (unknownSlugs.length) {
        jsonResponse(res, 400, {
          error: { code: 'desktop_models_invalid', message: `所选模型在目录中不存在：${unknownSlugs.join(', ')}` },
        });
        return true;
      }
      // 写入桌面目录的模型 = 官方存量全集 ∪ 勾选模型：官方模型常驻目录，
      // 聊天记录引用的官方模型不会被「只勾选几个」挤掉；勾选只追加路由侧模型。
      const official = filterOfficialModels(catalogPool);
      const picked = selectModels(catalogPool, requested);
      const pickedNonOfficial = picked.filter((entry) => !OFFICIAL_MODEL_SLUGS.includes(entry.slug));
      const merged = [...official];
      for (const entry of pickedNonOfficial) {
        if (!merged.some((existing) => existing.slug === entry.slug)) merged.push(entry);
      }
      if (merged.length === 0) {
        jsonResponse(res, 400, { error: { code: 'desktop_models_invalid', message: '所选模型在目录中不存在' } });
        return true;
      }
      // 历史目录条目（如早期谷歌订阅一键导入的模型）可能缺 base_instructions 等
      // 桌面端必填字段：写入前补全缺省，避免勾选即报错；已有合法值者保留原值。
      for (const entry of merged) ensureDesktopModelDefaults(entry);
      try {
        assertDesktopSafeModels(merged);
      } catch (error) {
        // 校验仍不通过时把具体原因带给前端（纯静态文案，无路径/堆栈，可安全展示），
        // 而不是被外层兜底成「管理请求未完成」让用户无从排查。
        jsonResponse(res, 400, { error: { code: 'desktop_models_invalid', message: `模型目录校验未通过：${error.message}` } });
        return true;
      }
      // 默认模型必须真实存在于最终目录；未指定时优先用户勾选的第一个路由侧模型
      //（model_provider=router 下回退官方 slug 会导致默认模型 unknown_model）。
      const defaultModel = typeof payload?.defaultModel === 'string' && payload.defaultModel
        && merged.some((entry) => entry.slug === payload.defaultModel)
        ? payload.defaultModel
        : (pickedNonOfficial[0]?.slug || merged[0].slug);
      // defaultModel 会被写进 config.toml 的 model = "..."：TOML 安全校验兜底
      //（目录 slug 理论上可能带引号等字符）。
      if (!isValidTomlModelSlug(defaultModel)) {
        jsonResponse(res, 400, {
          error: { code: 'invalid_model', message: `默认模型 ${defaultModel.slice(0, 64)} 含 TOML 非法字符，无法写入 config.toml` },
        });
        return true;
      }
      const currentToml = readDesktopToml();
      let backupToml;
      let backupModels;
      // 官方周/分钟额度耗尽时桌面端把选择器锁成 Luna 降级档（官方产品行为）——
      // 面板可选「API-key 接入（额度耗尽也能用自定义模型）」：脱钩官方登录态，
      // 但需要一把永久明文 key 写进 provider 段（2026-09-02 实测实锤）。
      const apiKeyMode = payload?.apiKeyAuth === true;
      let apiBearerToken = '';
      if (apiKeyMode) {
        try {
          const created = apiKeyStore.createKey({
            name: 'desktop-apikey',
            client: 'codex-desktop',
            description: '桌面端 LocalRouter API-key 接入（自动生成）',
          });
          apiBearerToken = created.key;
        } catch { /* key 生成失败则保持 login 态接入（写路径不变） */ }
      }
      try {
        backupToml = writeWithBackup(
          desktopPaths.configToml,
          buildRouterConfigToml(defaultModel, currentToml, {
            port: options.runtime?.port ?? 15730,
            modelsJsonPath: desktopPaths.modelsDesktopJson,
            apiKeyAuth: apiKeyMode && Boolean(apiBearerToken),
            apiBearerToken,
          }),
        );
        backupModels = writeWithBackup(desktopPaths.modelsDesktopJson, buildModelsJson(merged));
      } catch (error) {
        // 写盘失败（Windows 文件被桌面端占用 rename EPERM / TOML 写前校验拒绝）：
        // 映射到白名单文案，绝不让用户只看到「管理请求未完成」无从排查。
        const code = error?.code === 'toml_precheck_failed' ? 'toml_precheck_failed' : 'config_write_failed';
        throw configIssue(code, error?.message || String(error));
      }
      // 接入后的已加载目录是最新状态，顺手刷新快照（此后桌面端再裁剪也有得回填）。
      snapshotDesktopCatalog(desktopPaths.modelsDesktopJson);
      // 历史会话联动：旧会话 rollout 元数据记着旧 provider/认证形态，桌面端恢复
      // 「继续任务」时按元数据直发旧通道（2026-09-03 实锤：apiKey 接入后旧会话仍报
      // "not supported ... ChatGPT account"）。接入成功即自动迁移，失败不阻塞接入。
      let sessionSyncNote = '';
      try {
        const { syncSessionProviders } = await import('./codex-session-sync.mjs');
        const sync = syncSessionProviders({ targetProvider: 'router' });
        if (sync.sqliteThreads > 0 || sync.rolloutFiles > 0) {
          sessionSyncNote = `；已同步 ${sync.sqliteThreads} 个历史会话到路由（重启桌面端后「继续任务」生效）`;
        }
      } catch { /* 会话元数据不可读时跳过，可用面板「同步会话」手动补 */ }
      jsonResponse(res, 200, {
        ok: true,
        mode: 'router',
        models: merged.length,
        defaultModel,
        apiKeyAuth: Boolean(apiBearerToken),
        backupToml,
        backupModels,
        message: (apiKeyMode && apiBearerToken
          ? `已接入路由（API-key 形态：官方额度耗尽也能用自定义模型；桌面端将识别为 LocalRouter，不再显示官方额度条）。已新增一把桌面端专用 API Key，请保留密文（${apiBearerToken.slice(0, 10)}...），也可在「API 密钥管理」吊销；完全退出重启桌面端生效`
          : `已接入路由（${merged.length} 个模型，默认 ${defaultModel}）；请完全退出并重启 Codex 桌面端生效`) + sessionSyncNote,
      });
      return true;
    }

    // 会话 Provider 同步（一次性修复历史任务）：旧会话 model_provider 仍指向 openai
    // 时，API-key/路由接入后「继续接续任务」会直连 api.openai.com 报 401（2026-09-02
    // 实锤：threads 表 3257 条/rollout 1200 条中 544 条仍为 openai）。该端点把
    // openai（官方直连）会话的 threads 表 + rollout session_meta 一并迁到 router，
    // 保留 custom/deepseek/bailian 等历史自定义通道 provider 原义。
    if (req.method === 'POST' && url === '/_admin/api/codex-desktop/sync-session-providers') {
      const { syncSessionProviders } = await import('./codex-session-sync.mjs');
      const targetProvider = 'router';
      try {
        const result = syncSessionProviders({ targetProvider });
        jsonResponse(res, 200, {
          ok: true,
          targetProvider,
          sqliteThreads: result.sqliteThreads,
          sqliteProjects: result.sqliteProjects,
          rolloutFiles: result.rolloutFiles,
          errors: result.errors,
          message: `已把 ${result.sqliteThreads} 个历史会话迁移到路由（同时修订 ${result.rolloutFiles} 个会话记录）；重启桌面端后历史任务可继续`,
        });
        return true;
      } catch (error) {
        jsonResponse(res, 500, {
          error: { code: 'session_sync_failed', message: `会话同步失败：${String(error?.message || error).slice(0, 160)}` },
        });
        return true;
      }
    }

    // 重启 ChatGPT 桌面端（应用后必须完全重启才生效；Windows 专用辅助动作）。
    if (req.method === 'POST' && url === '/_admin/api/codex-desktop/restart-app') {
      if (process.platform !== 'win32') {
        jsonResponse(res, 400, { error: { code: 'desktop_restart_unsupported', message: '仅 Windows 支持自动重启桌面端' } });
        return true;
      }
      try {
        const { spawn } = await import('node:child_process');
        const kill = spawn('taskkill', ['/IM', 'ChatGPT.exe', '/F'], { stdio: 'ignore', windowsHide: true });
        kill.unref();
        setTimeout(() => {
          const launch = spawn('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'], { stdio: 'ignore', windowsHide: true });
          launch.unref();
        }, 2500);
        jsonResponse(res, 200, {
          ok: true,
          message: '已退出并重新拉起 ChatGPT 桌面端（约 5 秒后打开，请稍候）',
        });
        return true;
      } catch (error) {
        jsonResponse(res, 500, { error: { code: 'desktop_restart_failed', message: String(error?.message || error) } });
        return true;
      }
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
          // 200 但非 JSON（如被反代拦截）按不可达处理，不让解析异常冒成 502
          let healthPayload = {};
          if (h.status === 200) {
            try { healthPayload = JSON.parse(h.bodyText || '{}'); } catch { healthPayload = {}; }
          }
          let healthError = '网关未运行';
          if (h.status !== 200) {
            try { healthError = JSON.parse(h.bodyText || '{}').error?.message || healthError; } catch { /* 保留默认 */ }
          }
          jsonResponse(res, 200, {
            ok: true,
            running: h.status === 200,
            port: gatewayPort,
            ...(h.status === 200 ? healthPayload : {}),
            error: h.status === 200 ? undefined : healthError,
          });
          return true;
        }
        if (action === 'login') {
          await ensureSession();
          jsonResponse(res, 200, { ok: true, message: '网关会话已建立' });
          return true;
        }
        // 启动 / 重启 Cursor 网关（内置管理的独立侧车进程）：停掉 6718/6719 上的旧进程，
        // 再以同一目录的 server.mjs start 后台拉起；凭据沿用其自身持久化的 auth/账号池。
        // start 与 restart 同一逻辑：网关未运行时 restart 本就是「拉起」，统一入口避免小白困惑。
        if (req.method === 'POST' && (action === 'restart' || action === 'start')) {
          try {
            // 先确认网关目录存在再停端口：目录缺失时不误杀 6718/6719 上的任何进程
            const dir = resolveCursorGatewayDir(options);
            if (!dir) {
              jsonResponse(res, 500, { error: { code: 'cursor_gateway_missing', message: '未找到 external/cursor2api 网关目录' } });
              return true;
            }
            const stopped = await stopListenersOnPorts([gatewayPort, gatewayPort + 1]);
            const { spawn } = await import('node:child_process');
            const child = spawn(
              process.execPath,
              ['server.mjs', 'start', '--port', String(gatewayPort)],
              {
                cwd: dir,
                detached: true,
                stdio: 'ignore',
                // Windows：隐藏新控制台窗口，网关全程后台运行不弹窗
                windowsHide: true,
                env: {
                  ...process.env,
                  CURSOR_GATEWAY_PORT: String(gatewayPort),
                },
              },
            );
            child.unref();
            jsonResponse(res, 200, {
              ok: true,
              stopped,
              startedPid: child.pid || null,
              message: action === 'start' && stopped.length === 0
                ? `网关已启动（端口 ${gatewayPort}），约 5 秒后就绪`
                : `网关已重新拉起（端口 ${gatewayPort}），约 5 秒后就绪`,
            });
            return true;
          } catch (error) {
            jsonResponse(res, 500, { error: { code: 'cursor_gateway_restart_failed', message: String(error?.message || error) } });
            return true;
          }
        }
        // 模型清单：路由目录中的 cursor-* 模型（网关实际可服务的型号），
        // 不依赖网关进程在线，面板随时可看。
        if (req.method === 'GET' && action === 'models') {
          let models = [];
          try {
            const catalog = readRevisionedJson(options.catalogPath, { maxBytes: MAX_CATALOG_BYTES }).value;
            models = (Array.isArray(catalog?.models) ? catalog.models : [])
              .filter((model) => typeof model?.slug === 'string' && model.slug.startsWith('cursor-'))
              .map((model) => ({
                slug: model.slug,
                displayName: typeof model.display_name === 'string' && model.display_name
                  ? model.display_name
                  : model.slug,
              }));
          } catch { /* 目录不可读时返回空清单 */ }
          jsonResponse(res, 200, { ok: true, models });
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
    // 未命中的 /_admin/api/* 一律 404/405 收口：穿透进代理管线会烧额度/产生噪音请求
    if (url.startsWith('/_admin/api/')) {
      jsonResponse(res, req.method === 'GET' ? 404 : 405, {
        error: { code: 'not_found', message: `未知管理接口：${req.method} ${url}` },
      });
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
      // Codex 桌面端配置写入互斥：restore-official/apply-router/codex-default-model
      // 多文件读-改-写窗口内串行化，防并发丢更新（switch-account 另有自身互斥）
      const desktopWriteLock = url === '/_admin/api/codex-desktop/restore-official'
        || url === '/_admin/api/codex-desktop/apply-router'
        || (url === '/_admin/api/codex-default-model' && req.method === 'PUT');
      if (desktopWriteLock) {
        const release = await codexDesktopMutex.acquire();
        try {
          return await handleApi(req, res, url);
        } finally {
          release();
        }
      }
      if (url.startsWith('/_admin/api/')) return await handleApi(req, res, url);
      const asset = webAssets.get(url) || (assetPath ? diskAsset(assetPath) : null);
      if (req.method !== 'GET' || !options.webRoot) return false;
      if (!asset) {
        // 静态路径未命中必须 404 兜底：掉进主管线会被 API key 门控误报 401 invalid_api_key，
        // 用户浏览器缓存旧 index.html 引用已清理 chunk 时就表现为"面板 401"。
        jsonResponse(res, 404, {
          error: { code: 'asset_not_found', message: '页面资源不存在（可能是浏览器缓存了旧版本），请按 Ctrl+F5 强制刷新' },
        });
        return true;
      }
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
      // 脱敏响应之外，在服务端日志保留真实原因（code/message，不含堆栈中的敏感路径展开）。
      // console.* 只进控制台日志（易被覆盖/截断），再镜像一份到结构化 router.log，
      // 保证「管理请求未完成」类兜底错误可追溯（2026-09-01 apply-router 排障实锤）。
      const adminErrorDetail = {
        event: 'admin.request.failed',
        method: req.method,
        path: url,
        code: error?.code || null,
        message: String(error?.message || error).slice(0, 300),
      };
      console.warn(`[admin] ${req.method} ${url} failed:`, error?.code || '(no code)', '-', error?.message || error);
      try { options.log?.(adminErrorDetail); } catch { /* 日志旁路 */ }
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
