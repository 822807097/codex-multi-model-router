import { types as utilTypes } from 'node:util';

import { resolveStrongTaskKey } from './goal-checkpoint.mjs';
import {
  adaptOfficialResponsesBody,
  buildProviderAuthHeaders,
  enforceToolOutputAdjacency,
  ensureResponsesCallIds,
  repairOrphanToolCalls,
  resolveRequestProtocol,
  resolveProvider,
  sanitizeEncryptedAgentMessages,
  sanitizeThirdPartyResponsesTools,
} from './provider-adapters.mjs';
import {
  isRetryableProviderFailure,
  requestAffinityKeys,
} from './provider-pool.mjs';
import {
  forwardRequestHeaders,
  hasStandaloneConversationInput,
  isChatGptBackend,
  mergeGeneratedHeaders,
  upstreamStateDomain,
} from './request-policy.mjs';
import fs from 'node:fs';
import { openHttpsStream, resolveTimeouts } from './transport.mjs';
import { openGoogleChatStream } from './google-channel.mjs';
import { parseCodexRateLimitHeaders } from './account-quota.mjs';
import { buildModelList, readModelCatalogFile } from './model-catalog.mjs';
import { ensureDesktopModelDefaults } from './codex-desktop-config.mjs';
import { inspectModelCatalog } from './model-routing-plan.mjs';
import { upstreamModel } from './chat-request.mjs';
import { createExecCustomToolBridgeTransform } from './chat-stream.mjs';
import {
  chatToResponsesInput,
  chatToolChoiceToResponses,
  chatToolsToResponses,
  firstInvalidResponsesToolName,
} from './chat-protocol.mjs';
import {
  createRequestDiagnostics,
  createRequestId,
  diagnosticOutcomeForError,
} from './request-diagnostics.mjs';
import {
  isExplicitLongQuota,
  parsedQuotaError,
  retryAtFromMessageText,
} from './model-quota-cooldown.mjs';
import {
  createOfficialIncrementalStore,
  officialPropsFingerprint,
  officialSessionKeyOf,
} from './official-incremental.mjs';

// 上游非 200 时提取错误摘要 + 长期配额耗尽标记（透传层细分「额度耗尽等重置」
// 与「临时限流」）。只透传上游自己声明的字段，不附加本地猜测。
export function summarizeUpstreamError(status, bodyText, headers) {
  const { text, error } = parsedQuotaError(bodyText || '');
  const upstream = {
    status: Number(status) || 502,
    code: typeof error?.code === 'string' ? error.code.slice(0, 120) : '',
    type: typeof error?.type === 'string' ? error.type.slice(0, 120) : '',
    message: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  };
  let quotaExhausted = false;
  let retryAt = null;
  if (isExplicitLongQuota(status, bodyText || '')) {
    quotaExhausted = true;
    const retryAfterHeader = headers?.['retry-after'];
    const seconds = Number(typeof retryAfterHeader === 'string' ? retryAfterHeader : NaN);
    if (Number.isFinite(seconds) && seconds > 0) {
      retryAt = Date.now() + seconds * 1_000;
    } else {
      retryAt = retryAtFromMessageText(bodyText || '', Date.now());
    }
  }
  return { upstream, quotaExhausted, retryAt };
}

const MAX_CATALOG_SNAPSHOT_DEPTH = 64;
const MAX_CATALOG_SNAPSHOT_NODES = 100_000;
const MAX_MODEL_IDENTIFIER_LENGTH = 256;
const MODEL_IDENTIFIER_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const ROUTER_REJECTION_CODES = new Set([
  'context_length_exceeded',
  'cross_protocol_state_unavailable',
  'model_quota_cooldown',
]);
const DIAGNOSTIC_INPUT_KINDS = new Set([
  'user', 'assistant', 'system', 'developer', 'tool',
  'message', 'reasoning',
  'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output',
  'tool_search_call', 'tool_search_output',
  'web_search_call', 'computer_call', 'computer_call_output',
  'local_shell_call', 'local_shell_call_output',
]);

// catalog 可能来自旧调用方直接注入；先复制成不会执行用户代码的严格 JSON 树。
function strictCatalogSnapshot(source) {
  const seen = new WeakSet();
  let nodeCount = 0;

  function snapshot(value, depth) {
    nodeCount += 1;
    if (nodeCount > MAX_CATALOG_SNAPSHOT_NODES || depth > MAX_CATALOG_SNAPSHOT_DEPTH) {
      throw new Error('catalog snapshot budget exceeded');
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('catalog number invalid');
      return value;
    }
    if (typeof value !== 'object' || utilTypes.isProxy(value)) {
      throw new Error('catalog value invalid');
    }
    if (seen.has(value)) throw new Error('catalog is not a tree');
    seen.add(value);

    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length = lengthDescriptor?.value;
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(length)
        || length < 0
      ) {
        throw new Error('catalog array invalid');
      }
      // 只读固定 length 描述符即可提前执行预算，避免构造超量键和描述符集合。
      if (length > MAX_CATALOG_SNAPSHOT_NODES - nodeCount) {
        throw new Error('catalog snapshot budget exceeded');
      }
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1) throw new Error('catalog array invalid');
      for (const key of keys) {
        if (typeof key !== 'string') throw new Error('catalog symbol key invalid');
        if (key === 'length') continue;
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
          throw new Error('catalog array key invalid');
        }
      }
      const result = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
          throw new Error('catalog array descriptor invalid');
        }
        result[index] = snapshot(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype) {
      throw new Error('catalog object invalid');
    }
    // 普通对象无法流式枚举自有键；先取较轻的键数组并按最少子节点数提前拒绝。
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_CATALOG_SNAPSHOT_NODES - nodeCount) {
      throw new Error('catalog snapshot budget exceeded');
    }
    if (keys.some((key) => typeof key !== 'string')) {
      throw new Error('catalog symbol key invalid');
    }
    const result = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw new Error('catalog object descriptor invalid');
      }
      Object.defineProperty(result, key, {
        value: snapshot(descriptor.value, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(result);
  }

  return snapshot(source, 0);
}

// 拼接上游路径：前缀与端点各去/补一个斜杠，空结果回退根路径
function joinUpstreamPath(prefix = '', endpoint = '') {
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${left}${right}` || '/';
}

// 回环来源 + OAuth JWT 形态 bearer = Codex 桌面端登录态（requires_openai_auth）。
// 服务只绑定 127.0.0.1；非回连一律不算，仍走 API Key 鉴权。
function isLoopbackDesktopOauth(clientReq, authHeader, providedKey) {
  if (!authHeader.startsWith('Bearer ')) return false;
  // ChatGPT OAuth access token 是 JWT（ey 开头、至少两个 '.' 分段）；API Key 前缀不同，天然互斥
  if (!providedKey.startsWith('ey') || (providedKey.match(/\./g) || []).length < 2) return false;
  const remote = String(clientReq.socket?.remoteAddress || '');
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

// 上游状态码失败对象（带 code/stage，供诊断与响应映射）
function statusFailure(status, message, stage = 'upstream_headers') {
  const error = new Error(message);
  error.status = status;
  error.code = String(status || 502);
  error.stage = stage;
  return error;
}

// 模型级额度冷却拒绝：携带 retryAt 与剩余秒数
function quotaCooldownFailure(cooldown) {
  const error = new Error('所选模型处于长期额度冷却期，请切换其他模型继续当前任务');
  error.status = 422;
  error.code = 'model_quota_cooldown';
  error.stage = 'provider_cooldown';
  error.retryAt = cooldown.retryAt;
  error.retryAfterSeconds = cooldown.retryAfterSeconds;
  error.retryAfter = String(cooldown.retryAfterSeconds);
  return error;
}

// 模型标识校验：1..256 字符且不含控制字符
function validModelIdentifier(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.length <= MAX_MODEL_IDENTIFIER_LENGTH
    && !MODEL_IDENTIFIER_CONTROL_CHARACTERS.test(value);
}

// 认证失效/额度耗尽时，envKey 可能已被用户轮换（同名变量、新值）：先刷新注册表再重试。
function isAuthOrQuotaFailure(error) {
  const status = Number(error?.status);
  return status === 401 || status === 429;
}

// 响应状态码安全读取（含 statusCode/status 兼容）
function responseStatus(clientRes) {
  const status = Number(clientRes.statusCode ?? clientRes.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

// 提取上游请求 ID（常见头名依次尝试，供诊断关联）
function upstreamRequestId(headers = {}) {
  for (const name of ['x-request-id', 'request-id', 'x-amzn-requestid', 'cf-ray']) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) return value[0];
  }
  return undefined;
}

// 截取上游错误流前 limit 字节（错误摘要用，读后销毁流）
async function readStreamSnippet(stream, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const remaining = limit - size;
    if (remaining <= 0) break;
    chunks.push(chunk.subarray(0, remaining));
    size += Math.min(chunk.length, remaining);
    if (size >= limit) break;
  }
  if (!stream.destroyed) stream.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

export function createRouterHandler(options) {
  const config = options.config || {};
  const targets = options.targets || [];
  const log = options.log || (() => {});
  const flog = options.flog || (() => {});
  const onShutdown = options.onShutdown;
  const readCatalog = options.readModelCatalog || readModelCatalogFile;
  const listModels = options.buildModelList || buildModelList;
  const openStream = options.openStream || openHttpsStream;
  const getKey = options.getKey || (() => undefined);
  const refreshEnvKey = options.refreshEnvKey || (() => Promise.resolve(false));
  const keyPool = options.keyPool || null;
  const apiKeyStore = options.apiKeyStore || null;
  const authManager = options.authManager || null;
  // 官方通道增量续聊（省官方 5h 窗口；config.json officialIncremental.enabled 可关）
  const officialIncrementalStore = options.officialIncremental !== false
    ? createOfficialIncrementalStore({
        enabled: options.officialIncremental !== false,
        ...(options.officialIncremental || {}),
      })
    : null;
  const modelQuotaCooldown = options.modelQuotaCooldown || {
    get: () => null,
    observe: () => null,
  };
  let catalogSnapshot;
  try {
    // 生产入口显式注入启动快照；catalogPath 仅保留给旧调用方，并且同样只读取一次。
    const catalog = Object.hasOwn(options, 'catalog')
      ? options.catalog
      : readCatalog(options.catalogPath);
    const snapshot = strictCatalogSnapshot(catalog);
    const inspection = inspectModelCatalog(snapshot);
    if (inspection.errors.length > 0) throw new Error('catalog invalid');
    catalogSnapshot = snapshot;
  } catch {
    const error = new Error('模型目录启动快照不可用');
    error.code = 'catalog_snapshot_invalid';
    throw error;
  }

  // key 尝试来源跟随返回值走（per-request 持有），避免并发请求共享闭包变量互相覆盖。
  async function authHeadersForTarget(clientReq, target, provider, requestedModel = '', fallbackRequestId = '') {
    const headers = {
      ...forwardRequestHeaders(clientReq.headers, target),
      ...(target.headers || {}),
    };
    if (isChatGptBackend(target)) {
      // ChatGPT 订阅的 Codex 额度池（/backend-api/codex/responses）：
      // 订阅账号优先（多账号轮换、按套餐匹配模型、额度耗尽自动切换、token 自动刷新），
      // 无订阅账号或账号凭据失效时回退 Codex 桌面端 auth.json 登录态（避免桌面端被卡死）。
      // 注意：这是 Codex 额度池，不是网页对话额度池（后者走 /backend-api/conversation）。
      const account = (authManager && typeof authManager.acquireAccount === 'function')
        ? authManager.acquireAccount({ provider: 'openai', model: requestedModel })
        : null;
      if (account) {
        try {
          const creds = await authManager.getValidCredentials(account.id);
          if (creds?.accessToken) {
            const generated = { authorization: `Bearer ${creds.accessToken}` };
            const accountId = account.metadata?.chatgptAccountId;
            if (accountId) generated['chatgpt-account-id'] = accountId;
            return {
              headers: mergeGeneratedHeaders(
                headers,
                generated,
                ['authorization', 'chatgpt-account-id'],
              ),
              keyAttempt: { source: 'account', entryId: account.id },
            };
          }
        } catch (error) {
          // 账号刷新失败：凭据类失败（invalid_grant/4xx）冷却 60 分钟；
          // 网络类瞬时故障（超时/断连/DNS）只冷却 60 秒——代理抖 10 秒不该让池降级一小时。
          const transientRefresh = /timeout|timed? out|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|fetch failed/i.test(String(error?.message || ''));
          flog({
            event: 'account.fallback',
            request_id: fallbackRequestId,
            account: account.id,
            error_code: error?.code || 'account_refresh_failed',
            error_stage: 'account_credentials',
            transient: transientRefresh,
          });
          if (authManager && typeof authManager.markCooldown === 'function') {
            try {
              authManager.markCooldown(account.id, {
                cooldownMs: transientRefresh ? 60_000 : 60 * 60_000,
                reason: transientRefresh
                  ? '账号凭据刷新瞬时失败（网络类），60 秒后自动恢复'
                  : '账号凭据刷新失败，回退桌面端登录态',
              });
            } catch { /* 冷却失败不影响主流程 */ }
          }
        }
      }
      // 同账号守卫：桌面端登录态通常就是池内刚冷却的那个账号——兜底注定 429，
      // 还白付一次全量重发。命中时直接给出可读的 429 而不是重试。
      const desktopIdentity = typeof options.getOpenAiIdentity === 'function'
        ? options.getOpenAiIdentity()
        : null;
      if (desktopIdentity?.accountId && authManager && typeof authManager.findByMetadataField === 'function') {
        const desktopAccount = authManager.findByMetadataField('chatgptAccountId', desktopIdentity.accountId);
        const cooledUntil = Number(desktopAccount?.cooldownUntil || 0);
        if (desktopAccount?.status === 'cooldown' && cooledUntil > Date.now()) {
          const error = new Error(
            `桌面端登录态对应的订阅账号正在冷却（至 ${new Date(cooledUntil).toLocaleString()}）：请等待恢复或稍后重试`,
          );
          error.code = 'official_account_cooldown';
          error.status = 429;
          error.retryAfter = String(Math.max(1, Math.ceil((cooledUntil - Date.now()) / 1000)));
          throw error;
        }
      }
      let auth = null;
      try {
        auth = await options.getOpenAiAuth(target);
      } catch (error) {
        // 登录态不可用（文件缺失/损坏/token 失效/刷新失败）：统一转成 401 登录引导。
        // get() 从不返回 null 而是抛错，不接住会以 502 冒给客户端。
        const missing = new Error(
          `ChatGPT 登录态不可用（${error.message}）：请在 Codex 桌面端重新登录，或在管理页「恢复官方直连」`,
        );
        missing.code = 'official_auth_missing';
        missing.status = 401;
        throw missing;
      }
      if (!auth?.token) {
        // 退出账号/未登录：返回明确的 401 让桌面端回到登录界面。
        const missing = new Error(
          'ChatGPT 登录态缺失（auth.json 不存在，可能是已退出登录）：请在 Codex 桌面端重新登录，或在管理页「恢复官方直连」',
        );
        missing.code = 'official_auth_missing';
        missing.status = 401;
        throw missing;
      }
      const generated = { authorization: `Bearer ${auth.token}` };
      if (auth.accountId) generated['chatgpt-account-id'] = auth.accountId;
      return {
        headers: mergeGeneratedHeaders(
          headers,
          generated,
          ['authorization', 'chatgpt-account-id'],
        ),
        keyAttempt: null,
      };
    }
    // 谷歌订阅通道：鉴权由 openGoogleChatStream 用账号池 OAuth 处理
    // （Bearer access token + 项目 ID），这里不查密钥池/envKey，只回传中性转发头。
    if (provider.platform === 'google') {
      return { headers, keyAttempt: null };
    }
    // 页面密钥池优先（含 env_ref 条目）；池空/全冷却时回退 config 的 envKey 兜底。
    if (keyPool) {
      const acquired = keyPool.acquireKey(target);
      if (!acquired) {
        const missing = new Error(
          `通道 ${target.name} 无可用密钥（密钥池为空且环境变量 ${target.envKey || '(未配置)'} 未设置）`,
        );
        missing.code = 'env_key_missing';
        throw missing;
      }
      return {
        headers: mergeGeneratedHeaders(headers, buildProviderAuthHeaders(provider, acquired.value)),
        keyAttempt: { source: acquired.source, entryId: acquired.entryId || null },
      };
    }
    const key = getKey(target.envKey);
    if (!key) {
      // 标记可重试码：缺密钥属于本地配置问题，切换备用目标比直接 502 更合理。
      const missing = new Error(`环境变量 ${target.envKey} 未设置`);
      missing.code = 'env_key_missing';
      throw missing;
    }
    return {
      headers: mergeGeneratedHeaders(headers, buildProviderAuthHeaders(provider, key)),
      keyAttempt: { source: 'env', entryId: null },
    };
  }

  async function prepareAttemptBody(bodyObj, target, isChat, model, signal, settings = {}) {
    // 浅拷贝即可：顶层字段（model/input/tools 等）本路径内都会整体替换；嵌套结构的
    // 就地改写（视觉中继换图片 part、官方适配删 reasoning content）直接写入 bodyObj
    // 是安全的——bodyObj 解析后无其他读者，且这些改写幂等（故障转移重备时无副作用）。
    // 此前对 60MB 级请求每尝试一次 structuredClone（~86ms + ~240MB 瞬时分配）。
    const attemptBody = bodyObj ? { ...bodyObj } : null;
    if (isChat && attemptBody) {
      const restored = options.responseHistory.restoreRequest(
        attemptBody,
        settings.historyScopeKeys,
      );
      attemptBody.input = restored.input;
      if (restored.restoredCallIds.length) {
        flog({
          event: 'history.restored',
          request_id: settings.requestId,
          model,
          target: target.name,
          wire_api: 'chat',
          restored_calls: restored.restoredCallIds.length,
          history_hit: restored.historyHit,
        });
      }
    }
    if (settings.requireStandalone && !hasStandaloneConversationInput(attemptBody)) {
      const error = new Error('跨供应商或 wire API 切换需要客户端发送完整历史，或提供可恢复的工具调用输出');
      error.code = 'cross_protocol_state_unavailable';
      error.status = 400;
      throw error;
    }
    settings.onValidated?.();
    if (attemptBody && target.vision === false) {
      const stripped = await options.relayNonTextParts(attemptBody, signal);
      if (stripped > 0) {
        log(`${model}: relayed/stripped ${stripped} non-text part(s) for text-only model`);
      }
    }
    return attemptBody;
  }

  // 官方通道额度捕获：Codex 后端把 5h/周额度随响应头返回（无独立查询端点），
  // 挂到订阅账号 metadata 供订阅页展示；非账号来源（auth.json 兜底）跳过。
  const captureCodexRateLimits = (target2, headers2, keyAttempt, authManagerRef) => {
    try {
      if (!isChatGptBackend(target2)) return;
      if (keyAttempt?.source !== 'account' || !keyAttempt.entryId) return;
      const limits = parseCodexRateLimitHeaders(headers2);
      if (!limits) return;
      const acc = authManagerRef.getAccount(keyAttempt.entryId);
      if (!acc) return;
      authManagerRef.updateAccount(acc.id, { metadata: { ...(acc.metadata || {}), rateLimits: { ...limits, updatedAt: Date.now() } } });
    } catch { /* 展示旁路 */ }
  };
  function openTargetStream(target, requestPath, headers, body, signal, timeouts, method = 'POST') {
    return openStream({
      protocol: target.protocol,
      host: target.host,
      port: target.port || (target.protocol === 'http' ? 80 : 443),
      path: requestPath,
      method,
      // 目标级代理优先（可指定协议 http/socks5 与地址）；未配置且 viaProxy=true 时跟随全局代理
      viaProxy: target.viaProxy === true || Boolean(target.proxyUrl),
      proxy: target.proxyUrl || options.proxy,
      headers,
      body,
      signal,
      timeouts,
    });
  }

  return async function routerHandler(clientReq, clientRes) {
    const url = clientReq.url || '/';
    // 路由匹配只用 pathname：Codex 桌面端会给所有请求追加 ?client_version=...，
    // 精确匹配整串会把 GET /v1/models?client_version=... 漏到 404，模型选择器
    // 刷新失败静默回退官方缓存。上游透传仍用原始 url（保留查询串）。
    const pathOnly = url.split('?')[0] || '/';
    // 管理页及其 API 优先匹配；未命中时继续执行既有代理路由。
    if (options.adminHandler && await options.adminHandler(clientReq, clientRes)) return;
    // 关闭能力只在隔离测试显式注入；正常本地实例不暴露任何进程控制端点。
    if (
      typeof onShutdown === 'function'
      && pathOnly === '/_admin/shutdown'
      && clientReq.method === 'POST'
    ) {
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.once('finish', onShutdown);
      clientRes.end(JSON.stringify({ ok: true }));
      return;
    }
    // 未识别的管理方法或路径必须在管理命名空间内结束，不能落入模型转发。
    if (url.startsWith('/_admin/')) {
      clientRes.writeHead(404, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (clientReq.method === 'GET' && (pathOnly === '/healthz' || pathOnly === '/v1/healthz')) {
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ ok: true, targets: targets.map((target) => target.name) }));
      return;
    }

    // ---------- API Key 鉴权（多工具客户端：Codex / Trae / Qoder / OpenCode） ----------
    // 存在任意未吊销 key 时 /v1/*（GET models 与全部 POST 业务端点）强制鉴权；
    // 全部吊销自动回到开放模式（防锁死）。/healthz 保持开放。
    if (apiKeyStore && typeof apiKeyStore.hasKeys === 'function' && apiKeyStore.hasKeys()) {
      const authHeader = String(clientReq.headers['authorization'] || '');
      const xApiKey = String(clientReq.headers['x-api-key'] || '');
      let providedKey = '';
      if (authHeader.startsWith('Bearer ')) {
        providedKey = authHeader.slice(7).trim();
      } else if (xApiKey) {
        providedKey = xApiKey.trim();
      }
      const verified = apiKeyStore.verifyKey(providedKey);
      if (!verified && isLoopbackDesktopOauth(clientReq, authHeader, providedKey)) {
        // Codex 桌面端在 requires_openai_auth=true 下携带的是 ChatGPT OAuth JWT
        // （Bearer ey...），不是路由器 API Key——强制鉴权会把桌面端全部 /v1/* 请求
        // （模型列表刷新 + 对话）误伤成 401，选择器退化成纯官方模型缓存。
        // 服务只绑定 127.0.0.1，回环来源的 JWT 形态 bearer 视为桌面端身份放行；
        // 上游凭据始终由本网关账号池注入，桌面端 token 仅作标识。
        flog({ event: 'auth.desktop_oauth_fallback', path: url });
      } else if (!verified) {
        // 开放模式同源校验（浏览器 CSRF 防线）：任意网页可用 text/plain POST 免预检
        // 打到本地端口，被动消耗订阅额度。本地工具客户端（Codex/CLI）不带浏览器
        // 自动附带的 Origin/Sec-Fetch-Site 头，不受影响。
        const secSite = String(clientReq.headers['sec-fetch-site'] || '');
        const origin = String(clientReq.headers.origin || '');
        const isBrowserCrossSite = (secSite && secSite !== 'same-origin' && secSite !== 'none')
          || (origin && !origin.startsWith(`http://127.0.0.1:${clientReq.socket.localPort}`) && !origin.startsWith('http://localhost:') && !origin.startsWith('http://[::1]:'));
        if (isBrowserCrossSite) {
          clientRes.writeHead(403, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: {
              code: 'cross_origin_forbidden',
              message: '开放模式下拒绝跨站浏览器请求（疑似 CSRF）。请在路由管理面板创建 API Key 配置到客户端，或从本机工具直接调用',
            },
          }));
          return;
        }
        clientRes.writeHead(401, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({
          error: {
            code: 'invalid_api_key',
            message: '未提供有效的 API Key。请在路由管理面板创建 Key 并配置到客户端（Authorization: Bearer <key> 或 x-api-key: <key>）',
          },
        }));
        return;
      }
    }

    if (clientReq.method === 'GET' && (pathOnly === '/models' || pathOnly === '/v1/models')) {
      try {
        const data = listModels(catalogSnapshot, config.supportsResponses);
        // 双格式同发：data = 标准 OpenAI 列表（Trae/Qoder/OpenCode 等客户端）；
        // models = Codex 桌面端原生 ModelInfo 目录。桌面端 models_manager 只认
        // 原生 schema（{models:[...]}，10 个无 serde default 的硬必需字段 +
        // base_instructions），只发 OpenAI 列表会整目录解析失败、静默回退官方
        // 内置模型——选择器里第三方模型全部消失。逐条目过 ensureDesktopModelDefaults
        // 兜底历史残缺条目（如早期谷歌导入缺 shell_type/truncation_policy）。
        const nativeModels = (Array.isArray(catalogSnapshot.models) ? catalogSnapshot.models : [])
          .map((model) => ensureDesktopModelDefaults({ ...model }));
        clientRes.writeHead(200, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ object: 'list', data, models: nativeModels }));
      } catch {
        clientRes.writeHead(500, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ error: '模型目录启动快照不可用' }));
      }
      return;
    }
    if (clientReq.method !== 'POST') {
      clientRes.writeHead(404, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    // 每个代理请求只创建一个诊断上下文；响应 finish/close 负责产生唯一终态。
    const requestDiagnostics = createRequestDiagnostics({
      write: flog,
      requestId: typeof options.createRequestId === 'function'
        ? options.createRequestId()
        : createRequestId(),
      method: clientReq.method,
      path: url,
    });
    let diagnosticResponseFinished = false;
    let lastAttemptTarget = '';
    // model 在请求体解析后由 on('end') 回调赋值；finishDiagnostic 闭包引用的是
    // 这个外层绑定（此前误引用回调内声明，ReferenceError 被 catch 吞掉导致
    // onRequestFinished 用量统计从未触发）。
    let model = '';
    const finishDiagnostic = (clientStatus, disconnected = false) => {
      diagnosticResponseFinished = true;
      if (disconnected) requestDiagnostics.disconnect({ client_status: clientStatus });
      else requestDiagnostics.finish({ client_status: clientStatus });
      // 用量统计钩子：官方通道 usage 帧缺失时由调用方按请求体量估算记入 token_logs，
      // 让「周额度烧在哪」可度量（估算口径：~4 字节/token × 0.75 的 JSON 开销折扣）。
      try {
        options.onRequestFinished?.(requestDiagnostics, {
          bodyBytes: Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : 0,
          clientStatus,
          target: lastAttemptTarget,
          model,
          disconnected,
        });
      } catch { /* 统计旁路不得影响响应 */ }
    };
    clientRes.once('finish', () => finishDiagnostic(responseStatus(clientRes)));
    clientRes.once('close', () => {
      if (!diagnosticResponseFinished) {
        finishDiagnostic(responseStatus(clientRes), true);
      }
    });

    const declaredLength = Number(clientReq.headers['content-length'] || 0);
    requestDiagnostics.received({
      body_bytes: Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : 0,
    });
    if (declaredLength > options.maxRequestBytes) {
      requestDiagnostics.markFailure({
        outcome: 'router_rejected',
        error_code: 'request_body_too_large',
        error_stage: 'request_headers',
      });
      clientReq.resume();
      clientRes.writeHead(413, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'request body too large' }));
      return;
    }
    const requestReservation = options.requestBudget.acquire();
    if (!requestReservation) {
      requestDiagnostics.markFailure({
        outcome: 'router_rejected',
        error_code: 'router_busy',
        error_stage: 'request_admission',
      });
      clientReq.resume();
      clientRes.writeHead(503, {
        'content-type': 'application/json',
        'retry-after': '1',
      });
      clientRes.end(JSON.stringify({
        error: { code: 'router_busy', message: '并发请求数已达到上限' },
      }));
      return;
    }
    const releaseReservation = () => options.requestBudget.release(requestReservation);
    clientRes.once('finish', releaseReservation);
    clientRes.once('close', releaseReservation);
    const chunks = [];
    let receivedBytes = 0;
    let bodyTooLarge = false;
    clientReq.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (
        receivedBytes > options.maxRequestBytes
        || !options.requestBudget.add(requestReservation, chunk.length)
      ) {
        bodyTooLarge = true;
        chunks.length = 0;
        options.requestBudget.discardBytes(requestReservation);
        return;
      }
      if (!bodyTooLarge) chunks.push(chunk);
    });
    clientReq.once('aborted', () => {
      releaseReservation();
      requestDiagnostics.disconnect({ error_stage: 'request_body' });
    });
    clientReq.once('error', (error) => {
      releaseReservation();
      requestDiagnostics.disconnect({
        error_code: error.code || 'request_error',
        error_stage: 'request_body',
      });
    });
    clientReq.on('end', async () => {
      try {
        if (bodyTooLarge) {
          requestDiagnostics.markFailure({
            outcome: 'router_rejected',
            error_code: 'request_body_too_large',
            error_stage: 'request_body',
          });
          clientRes.writeHead(413, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({ error: 'request body too large' }));
          return;
        }
        const originalBody = Buffer.concat(chunks);
        let bodyObj = null;
        try {
          bodyObj = JSON.parse(originalBody.toString());
          model = bodyObj?.model;
        } catch { /* 非 JSON 按默认通道处理 */ }
        if (!validModelIdentifier(model)) {
          requestDiagnostics.markFailure({
            outcome: 'router_rejected',
            error_code: 'invalid_model',
            error_stage: 'request_validation',
          });
          clientRes.writeHead(400, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: {
              code: 'invalid_model',
              message: 'model 必须是 1..256 字符且不含控制字符的字符串',
            },
          }));
          return;
        }
        const roleCounts = {};
        if (Array.isArray(bodyObj?.input)) {
          for (const item of bodyObj.input) {
            // role/type 来自请求体，只允许固定诊断桶，未知值不能成为日志中的动态键。
            const candidate = typeof item?.role === 'string' && item.role
              ? item.role
              : item?.type;
            const key = DIAGNOSTIC_INPUT_KINDS.has(candidate) ? candidate : 'other';
            roleCounts[key] = (roleCounts[key] || 0) + 1;
          }
        }
        requestDiagnostics.parsed({
          model,
          body_bytes: originalBody.length,
          input_items: Array.isArray(bodyObj?.input) ? bodyObj.input.length : 0,
          has_previous_response_id: Boolean(bodyObj?.previous_response_id),
          stream: bodyObj?.stream === true,
          role_counts: roleCounts,
        });
        if (
          bodyObj?.previous_response_id !== undefined
          && typeof bodyObj.previous_response_id !== 'string'
        ) {
          requestDiagnostics.markFailure({
            outcome: 'router_rejected',
            error_code: 'invalid_request',
            error_stage: 'request_validation',
          });
          clientRes.writeHead(400, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: { code: 'invalid_request', message: 'previous_response_id 必须是字符串' },
          }));
          return;
        }

        const affinityKeys = requestAffinityKeys(bodyObj || {}, clientReq.headers, {
          modelAffinity: config.providerPool?.modelAffinity === true,
        });
        const responseAffinityKey = bodyObj?.previous_response_id
          ? `response:${bodyObj.previous_response_id}`
          : null;
        const previousTarget = responseAffinityKey
          ? options.providerPool.getResponseAffinity(responseAffinityKey, affinityKeys)
          : null;
        if (
          responseAffinityKey
          && !previousTarget
          && options.providerPool.isAffinityAmbiguous(responseAffinityKey)
        ) {
          requestDiagnostics.markFailure({
            outcome: 'router_rejected',
            error_code: 'ambiguous_response_id',
            error_stage: 'provider_affinity',
          });
          clientRes.writeHead(400, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: {
              code: 'ambiguous_response_id',
              message: 'response id 在多个任务或供应商间冲突，且缺少可判定的会话作用域',
            },
          }));
          return;
        }
        const candidates = options.providerPool.candidates(model, affinityKeys, previousTarget);
        if (!candidates.length) {
          requestDiagnostics.markFailure({
            outcome: 'router_rejected',
            error_code: 'unknown_model',
            error_stage: 'provider_selection',
          });
          clientRes.writeHead(400, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: {
              code: 'unknown_model',
              message: `没有匹配模型 ${model || '(empty)'} 的目标`,
            },
          }));
          return;
        }
        const preferredWireApi = resolveProvider(candidates[0]).wireApi;
        const compatibleCandidates = candidates.filter((target) => {
          const provider = resolveProvider(target);
          return provider.wireApi === preferredWireApi
            && resolveRequestProtocol(provider, url).allowed;
        });
        if (candidates.length && !compatibleCandidates.length) {
          requestDiagnostics.markFailure({
            outcome: 'router_rejected',
            error_code: 'compact_not_supported',
            error_stage: 'protocol_selection',
          });
          clientRes.writeHead(400, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: {
              code: 'compact_not_supported',
              message: 'Chat 通道不支持 /responses/compact',
            },
          }));
          return;
        }
        const unknownResponseCrossDomain = Boolean(
          responseAffinityKey
          && !previousTarget
          && new Set(candidates.map((target) => (
            upstreamStateDomain(target, resolveProvider(target))
          ))).size > 1,
        );
        const checkpointTaskKey = resolveStrongTaskKey(
          bodyObj || {},
          clientReq.headers,
          options.goalCheckpoints,
        );
        const checkpointRequestSequence = checkpointTaskKey
          ? options.goalCheckpoints.beginTask(checkpointTaskKey)
          : null;
        const abortController = new AbortController();
        let clientClosed = false;
        let stopHeartbeat = () => {};
        let heartbeatStarted = false;
        const ensureHeartbeat = () => {
          if (heartbeatStarted) return;
          heartbeatStarted = true;
          stopHeartbeat = options.startResponsesSse(clientRes);
        };
        clientRes.once('close', () => {
          clientClosed = true;
          stopHeartbeat();
          // abort 会同步触发 transport 的 onAbort（socket.destroy 可能再抛
          // ERR_STREAM_ALREADY_FINISHED 等）；close 处理器不容许把清理异常抛成
          // uncaughtException——那会触发进程级熔断停机（2026-08-28 谷歌通道实测踩中）。
          try {
            abortController.abort();
          } catch { /* 清理路径异常不影响进程存活 */ }
        });

        let lastError = null;
        // 每个 target + envKey 组合最多刷新一次；集合上限由本请求候选数限定。
        const keyRefreshAttempts = new Set();
        // 账号额度耗尽时请求内无缝换号预算：冷却后重选池中下一个账号重试同一 target，
        // 避免任务被 429 打断；「index -= 1; continue」与 for 的 index++ 抵消，等价重跑当前 target。
        let accountSwitchBudget = 3;
        for (let index = 0; index < compatibleCandidates.length; index += 1) {
          const target = compatibleCandidates[index];
          const provider = resolveProvider(target);
          const isChat = provider.wireApi === 'chat';
          const hasFallback = index < compatibleCandidates.length - 1;
          // 本次尝试的 key 来源（pool/env），随循环作用域绑定，并发请求互不干扰
          let attemptKey = null;
          const cooldown = modelQuotaCooldown.get(target.name, upstreamModel(target, model));
          if (cooldown) {
            lastError = quotaCooldownFailure(cooldown);
            if (hasFallback) continue;
            break;
          }
          requestDiagnostics.attempt({
            target: target.name,
            wire_api: provider.wireApi,
            attempt: index + 1,
          });
          lastAttemptTarget = target.name;
          try {
            const previousProvider = previousTarget ? resolveProvider(previousTarget) : null;
            const changesStateDomain = unknownResponseCrossDomain || Boolean(
              previousProvider
              && upstreamStateDomain(previousTarget, previousProvider)
                !== upstreamStateDomain(target, provider),
            );
            const affinityWriteKeys = affinityKeys.filter((key) => (
              !key.startsWith('response:')
              && !(changesStateDomain && key.startsWith('prompt:'))
            ));
            const attemptBody = await prepareAttemptBody(
              bodyObj,
              target,
              isChat,
              model,
              abortController.signal,
              {
                requireStandalone: Boolean(changesStateDomain),
                historyScopeKeys: affinityKeys,
                requestId: requestDiagnostics.requestId,
                // Chat 分支不提前提交客户端 200 SSE：上游响应头确认前必须保留真实 HTTP 状态码的返回能力。
              },
            );
            if (changesStateDomain && attemptBody) {
              delete attemptBody.previous_response_id;
              delete attemptBody.prompt_cache_key;
            }
            if (clientClosed) return;

            const builtAuth = await authHeadersForTarget(clientReq, target, provider, model, requestDiagnostics.requestId);
            const headers = builtAuth.headers;
            attemptKey = builtAuth.keyAttempt;
            const timeouts = resolveTimeouts(options.timeouts, provider.timeouts);
            if (clientClosed) return;

            if (isChat) {
              // OpenAI 标准 Chat Completions 格式（任意工具/智能体接入）：
              // 请求体含 messages 且无 responses 的 input——不做 responses 转换，
              // 原样透传上游 chat 通道，响应（chat SSE / JSON）也原样透传。
              const isChatCompletionsFormat = Array.isArray(bodyObj?.messages)
                && !Array.isArray(bodyObj?.input);
              if (isChatCompletionsFormat) {
                // 流式请求自动补 stream_options.include_usage，让上游返回 usage 帧（token 统计真实数据源）
                // 仅在 stream===true 时补：严格网关（vLLM 等）对"非流式+stream_options"直接 400（审查疑1）
                if (attemptBody && attemptBody.stream === true && !attemptBody.stream_options) {
                  attemptBody.stream_options = { include_usage: true };
                }
                // 透传同样必须应用 upstreamModel 映射（target.upstreamModel 静态映射），
                // 否则带本地别名的 model（如 cursor-grok-4.6）会原样发到上游被拒。
                if (attemptBody && target.upstreamModel) {
                  attemptBody.model = upstreamModel(target, model);
                }
                const upstreamPath = joinUpstreamPath(target.prefix, provider.chatPath);
                flog({
                  event: 'chat.completions.passthrough',
                  request_id: requestDiagnostics.requestId,
                  model,
                  target: target.name,
                  wire_api: provider.wireApi,
                  attempt: index + 1,
                  message_count: bodyObj.messages.length,
                  stream: bodyObj.stream === true,
                });
                // 谷歌订阅目标：chat → Antigravity generateContent（账号池 OAuth），
                // 响应已转回 chat 形态，其余逻辑与普通 chat 透传完全一致。
                const upstream = provider.platform === 'google'
                  ? await openGoogleChatStream({
                    chatBody: attemptBody,
                    target,
                    model,
                    authManager: options.authManager,
                    proxy: options.proxy,
                    openStream,
                    signal: abortController.signal,
                    timeouts,
                    contextSlimMaxBytes: config.googleChannel?.contextSlimMaxBytes,
                    log: flog,
                  })
                  : await openTargetStream(
                    target,
                    upstreamPath,
                    headers,
                    JSON.stringify(attemptBody),
                    abortController.signal,
                    timeouts,
                  );
                if (clientClosed) {
                  upstream.socket?.destroy?.();
                  return;
                }
                requestDiagnostics.upstream({
                  upstream_status: upstream.status || 502,
                  upstream_request_id: upstreamRequestId(upstream.headers),
                });
                captureCodexRateLimits(target, upstream.headers, attemptKey, authManager);
                // 仅非 200 才读错误体；200 即使 content-type 是 JSON 也属正常响应
                // （客户端可能 stream:false 拿非流式 JSON），必须透传而不是当错误吞掉。
                if (upstream.status !== 200) {
                  const errorText = await readStreamSnippet(upstream.stream);
                  const summary = summarizeUpstreamError(upstream.status, errorText, upstream.headers);
                  const failure = statusFailure(
                    upstream.status || 502,
                    summary.quotaExhausted && summary.retryAt
                      ? `chat upstream ${upstream.status || 502} [quota exhausted, retry at ${new Date(summary.retryAt).toISOString()}]`
                      : `chat upstream ${upstream.status || 502}${summary.upstream.message ? `: ${summary.upstream.message}` : ''}`,
                  );
                  failure.quotaObservation = {
                    target: target.name,
                    model: upstreamModel(target, model),
                    status: upstream.status || 502,
                    headers: upstream.headers,
                    bodyText: errorText,
                  };
                  failure.upstreamError = summary.upstream;
                  if (summary.quotaExhausted && summary.retryAt) failure.retryAt = summary.retryAt;
                  const retryAfter = upstream.headers['retry-after'];
                  if (typeof retryAfter === 'string' && retryAfter.trim()) failure.retryAfter = retryAfter.trim();
                  throw failure;
                }
                // 仅上游确认为 SSE 时先提交客户端 200 SSE 头；JSON 非流式响应
                // （客户端 stream:false）保持原样透传，由 pipeChatCompletionsResponse
                // 按上游 content-type 写头，避免 JSON 内容被标成 text/event-stream。
                if (/text\/event-stream/i.test(String(upstream.headers['content-type'] || ''))) {
                  ensureHeartbeat();
                }
                options.providerPool.remember(affinityWriteKeys, target);
                // chat SSE / JSON 原样透传（不经过 responses 转换器；顺带扫描 usage 帧做 token 统计）
                options.pipeChatCompletionsResponse(
                  upstream,
                  clientRes,
                  `${model || '?'} -> ${target.name}`,
                  (response) => {
                    options.responseHistory.recordResponse(response, affinityWriteKeys);
                    if (response?.id) {
                      options.providerPool.remember(
                        affinityWriteKeys,
                        target,
                        [`response:${response.id}`],
                      );
                    }
                  },
                  requestDiagnostics,
                  upstream.status === 429
                    ? (bodyText) => {
                        if (keyPool && attemptKey?.source === 'pool' && attemptKey.entryId) {
                          try {
                            keyPool.markKeyCooldown(attemptKey.entryId, {
                              headers: upstream.headers,
                              bodyText,
                            });
                          } catch { /* 冷却落库失败不影响响应透传 */ }
                          return null;
                        }
                        return modelQuotaCooldown.observe({
                          target: target.name,
                          model: upstreamModel(target, model),
                          status: upstream.status,
                          headers: upstream.headers,
                          bodyText,
                        });
                      }
                    : undefined,
                );
                return;
              }
              const prepared = await options.buildChatRequest(
                attemptBody,
                target,
                provider,
                model,
                {
                  clientHeaders: clientReq.headers,
                  headers,
                  signal: abortController.signal,
                  timeouts,
                  taskKey: checkpointTaskKey,
                  requestSequence: checkpointRequestSequence,
                  requestId: requestDiagnostics.requestId,
                },
              );
              const upstreamPath = joinUpstreamPath(target.prefix, provider.chatPath);
              flog({
                event: 'chat.request.prepared',
                request_id: requestDiagnostics.requestId,
                model,
                target: target.name,
                wire_api: provider.wireApi,
                attempt: index + 1,
                message_count: prepared.request.messages.length,
                tool_count: prepared.toolCount,
                stream: true,
              });
              // 谷歌订阅目标（responses 客户端经桥接转成 chat 后同样适用）：
              // chat → Antigravity generateContent，响应转回 chat 流。
              const upstream = provider.platform === 'google'
                ? await openGoogleChatStream({
                  chatBody: prepared.request,
                  target,
                  model,
                  authManager: options.authManager,
                  proxy: options.proxy,
                  openStream,
                  signal: abortController.signal,
                  timeouts,
                  contextSlimMaxBytes: config.googleChannel?.contextSlimMaxBytes,
                  log: flog,
                })
                : await openTargetStream(
                  target,
                  upstreamPath,
                  headers,
                  JSON.stringify(prepared.request),
                  abortController.signal,
                  timeouts,
                );
              if (clientClosed) {
                upstream.socket?.destroy?.();
                return;
              }
              requestDiagnostics.upstream({
                upstream_status: upstream.status || 502,
                upstream_request_id: upstreamRequestId(upstream.headers),
              });
                            captureCodexRateLimits(target, upstream.headers, attemptKey, authManager);
              const contentType = String(upstream.headers['content-type'] || '');
              if (upstream.status !== 200 || /application\/json/i.test(contentType)) {
                const errorText = await readStreamSnippet(upstream.stream);
                const summary = summarizeUpstreamError(upstream.status, errorText, upstream.headers);
                const failure = statusFailure(
                  upstream.status || 502,
                  summary.quotaExhausted && summary.retryAt
                    ? `chat upstream ${upstream.status || 502} [quota exhausted, retry at ${new Date(summary.retryAt).toISOString()}]`
                    : `chat upstream ${upstream.status || 502}${summary.upstream.message ? `: ${summary.upstream.message}` : ''}`,
                );
                failure.quotaObservation = {
                  target: target.name,
                  model: upstreamModel(target, model),
                  status: upstream.status || 502,
                  headers: upstream.headers,
                  bodyText: errorText,
                };
                failure.upstreamError = summary.upstream;
                if (summary.quotaExhausted && summary.retryAt) failure.retryAt = summary.retryAt;
                // 保留上游限流/服务不可用提示头，供客户端按真实状态码退避重试。
                const retryAfter = upstream.headers['retry-after'];
                if (typeof retryAfter === 'string' && retryAfter.trim()) failure.retryAfter = retryAfter.trim();
                throw failure;
              }
              // 上游 200 且 content-type 合法后，才向客户端提交 Responses SSE（含心跳）。
              ensureHeartbeat();
              options.providerPool.remember(affinityWriteKeys, target);
              options.pipeChatResponse(
                upstream,
                clientRes,
                model,
                target.name,
                stopHeartbeat,
                prepared.toolContext,
                {
                  cumulativeToolCallDeltas: target.cumulativeToolCallDeltas === true,
                  maxAccumulatedBytes: target.maxAccumulatedResponseBytes,
                  maxToolCalls: target.maxToolCalls,
                },
                (response) => {
                  options.responseHistory.recordResponse(response, affinityWriteKeys);
                  options.providerPool.remember(
                    affinityWriteKeys,
                    target,
                    [`response:${response.id}`],
                  );
                  if (prepared.checkpointInfo) {
                    if (prepared.checkpointInfo.persistCheckpoint) {
                      options.goalCheckpoints.remember({
                        ...prepared.checkpointInfo,
                        responseId: response.id,
                      });
                    } else {
                      options.goalCheckpoints.bindResponse(
                        prepared.checkpointInfo.taskKey,
                        response.id,
                      );
                    }
                  }
                },
                requestDiagnostics,
              );
              return;
            }

            // ---------- chat 格式请求打 responses-wire 目标：协议桥接 ----------
            // Trae 等 chat 客户端直连时只发 /v1/chat/completions（messages 数组）。
            // 若目标 wireApi 是 responses（官方 ChatGPT 通道等），不能把 chat body
            // 原样发到上游：上游只认识 /responses 的 input 格式。此前会拼出
            // /backend-api/codex/chat/completions 这类不存在路径，官方后端直接
            // 404 {"detail":"Not Found"}。这里把请求转成 Responses input、固定走
            // /responses 端点，并把上游 Responses SSE 反向转换回 Chat SSE。
            const isChatFormatRequest = Array.isArray(bodyObj?.messages)
              && !Array.isArray(bodyObj?.input)
              && bodyObj?.messages.length > 0;
            if (!isChat && isChatFormatRequest && provider.wireApi === 'responses') {
              const sourceBody = attemptBody || bodyObj;
              // 参数白名单构造（不再全量展开 Chat body）：stream_options/stop/
              // response_format/惩罚项/n/seed/user/logprobs 等 Chat 专属参数
              // 官方 /responses 一律 400（stream_options:{include_usage} 几乎必发）。
              const bridgeBody = { model: upstreamModel(target, model) };
              // 必须用 attemptBody 的消息：视觉中继（relayNonTextParts）改写的是这个
              // 克隆里的 image part；用原始 bodyObj 会把中继结果丢掉，文本目标的
              // 图片会被 chatToResponsesInput 无声丢弃。
              bridgeBody.input = chatToResponsesInput(
                attemptBody && Array.isArray(attemptBody.messages) ? attemptBody.messages : bodyObj.messages,
                {
                  vision: target.vision !== false,
                },
              );
              if (Array.isArray(bodyObj.tools) && bodyObj.tools.length) {
                const convertedTools = chatToolsToResponses(bodyObj.tools);
                if (convertedTools) {
                  const invalidToolName = firstInvalidResponsesToolName(convertedTools);
                  if (invalidToolName !== null) {
                    const invalid = new Error(
                      `工具名 "${invalidToolName}" 不合法（需 1..64 字符且仅含字母数字/_/-），官方通道会拒绝`,
                    );
                    invalid.code = 'invalid_tool_name';
                    invalid.status = 400;
                    throw invalid;
                  }
                  bridgeBody.tools = convertedTools;
                }
              }
              // 两端语义一致的字段才转发；tool_choice 需要 Chat→Responses 形状转换。
              for (const field of ['temperature', 'top_p', 'parallel_tool_calls']) {
                if (sourceBody[field] !== undefined) bridgeBody[field] = sourceBody[field];
              }
              if (sourceBody.tool_choice !== undefined) {
                const convertedChoice = chatToolChoiceToResponses(sourceBody.tool_choice);
                if (convertedChoice !== undefined) bridgeBody.tool_choice = convertedChoice;
              }
              const clientStreams = bodyObj.stream === true;
              bridgeBody.stream = true; // 上游总是走 Responses SSE，客户端非流式在响应侧聚合
              // 官方后端要求与桌面端一致的无状态请求（store:false 等）：复用原生
              // responses 路径的适配逻辑，避免被上游 400 拒绝。
              if (isChatGptBackend(target)) {
                adaptOfficialResponsesBody(bridgeBody, '/responses', {
                  onDiscard: (item) => flog({
                    event: 'official.filtered_item',
                    request_id: requestDiagnostics.requestId,
                    model,
                    item_type: item?.type,
                    id_prefix: item?.id_prefix,
                  }),
                });
              }
              flog({
                event: 'chat.responses.bridge',
                request_id: requestDiagnostics.requestId,
                model,
                target: target.name,
                attempt: index + 1,
                message_count: bodyObj.messages.length,
                tool_count: bridgeBody.tools?.length || 0,
                input_items: bridgeBody.input.length,
                client_stream: clientStreams,
              });
              const upstreamPath = joinUpstreamPath(target.prefix, '/responses');
              const upstream = await openTargetStream(
                target,
                upstreamPath,
                headers,
                JSON.stringify(bridgeBody),
                abortController.signal,
                timeouts,
              );
              if (clientClosed) {
                upstream.socket?.destroy?.();
                return;
              }
              requestDiagnostics.upstream({
                upstream_status: upstream.status || 502,
                upstream_request_id: upstreamRequestId(upstream.headers),
              });
                            captureCodexRateLimits(target, upstream.headers, attemptKey, authManager);
              if (upstream.status < 200 || upstream.status >= 300) {
                const errorText = await readStreamSnippet(upstream.stream);
                const summary = summarizeUpstreamError(upstream.status, errorText, upstream.headers);
                const failure = statusFailure(
                  upstream.status || 502,
                  summary.quotaExhausted && summary.retryAt
                    ? `chat bridge upstream ${upstream.status || 502} [quota exhausted, retry at ${new Date(summary.retryAt).toISOString()}]`
                    : `chat bridge upstream ${upstream.status || 502}${summary.upstream.message ? `: ${summary.upstream.message}` : ''}`,
                );
                failure.quotaObservation = {
                  target: target.name,
                  model: upstreamModel(target, model),
                  status: upstream.status || 502,
                  headers: upstream.headers,
                  bodyText: errorText,
                };
                failure.upstreamError = summary.upstream;
                if (summary.quotaExhausted && summary.retryAt) failure.retryAt = summary.retryAt;
                // 与其他分支同口径：非配额类 429 也保留上游 retry-after 供客户端退避。
                const bridgeRetryAfter = upstream.headers['retry-after'];
                if (typeof bridgeRetryAfter === 'string' && bridgeRetryAfter.trim()) {
                  failure.retryAfter = bridgeRetryAfter.trim();
                }
                requestDiagnostics.markFailure({
                  outcome: 'upstream_error',
                  error_code: String(upstream.status || 502),
                  error_stage: 'upstream_headers',
                });
                throw failure;
              }
              // 桥接流式响应同样需要心跳：官方通道长推理期间可能长时间无帧，SSE 注释行
              // 对 chat 客户端透明，防止客户端空闲超时断连。非流式客户端绝不能启动
              // 心跳——startResponsesSse 会立即写 SSE 头并注入注释行，污染聚合 JSON。
              if (clientStreams) ensureHeartbeat();
              options.providerPool.remember(affinityWriteKeys, target);
              options.pipeResponsesToChatResponse(
                upstream,
                clientRes,
                bridgeBody.model,
                clientStreams,
                `${model || '?'} -> ${target.name}`,
                (response) => {
                  options.responseHistory.recordResponse(response, affinityWriteKeys);
                  if (response?.id) {
                    options.providerPool.remember(
                      affinityWriteKeys,
                      target,
                      [`response:${response.id}`],
                    );
                  }
                },
                requestDiagnostics,
              );
              return;
            }

            if (attemptBody) {
              attemptBody.model = upstreamModel(target, model);
              // 请求体快照取证（仅当 ROUTER_DEBUG_BODY_SNAPSHOT=1 时对大历史请求落盘
              // 归一化前快照，供本地重放排查第三方协议 400；默认关闭不落任何数据）。
              if (
                process.env.ROUTER_DEBUG_BODY_SNAPSHOT === '1'
                && Array.isArray(attemptBody.input)
                && attemptBody.input.length > 50
              ) {
                try {
                  const snapshot = structuredClone(attemptBody);
                  const bodyFile = `tmp-debug-body-${requestDiagnostics.requestId}.json`;
                  fs.promises.writeFile(bodyFile, JSON.stringify(snapshot)).catch(() => {});
                  flog({
                    event: 'debug.body_snapshot',
                    request_id: requestDiagnostics.requestId,
                    target: target.name,
                    model,
                    input_items: snapshot.input?.length,
                    body_file: bodyFile,
                  });
                } catch { /* 快照失败不影响请求 */ }
              }
              // Responses 适配只作用于 /responses 端点；图片等非 Responses 请求原样透传。
              if (isChatGptBackend(target)) {
                // 工具名提前校验：官方对非法名（>64 字符/非法字符，MCP 服务器可能产生）
                // 直接 400 且无路由侧诊断——本地拦截给出清晰报错并省一次上游往返。
                const invalidToolName = firstInvalidResponsesToolName(attemptBody.tools);
                if (invalidToolName !== null) {
                  const invalid = new Error(
                    `工具名 "${invalidToolName}" 不合法（需 1..64 字符且仅含字母数字/_/-），官方通道会拒绝`,
                  );
                  invalid.code = 'invalid_tool_name';
                  invalid.status = 400;
                  throw invalid;
                }
                adaptOfficialResponsesBody(attemptBody, url, {
                  // 脱敏诊断：只记录类型与 ID 前缀，用于定位跨模型切换时官方拒绝的新调用类型。
                  onDiscard: (item) => flog({
                    event: 'official.filtered_item',
                    request_id: requestDiagnostics.requestId,
                    model,
                    item_type: item?.type,
                    id_prefix: item?.id_prefix,
                  }),
                });
              } else if (/\/responses(?:\/|$|\?)/.test(url) && Array.isArray(attemptBody.input)) {
                // 第三方原生 Responses 透传的五层适配（顺序不可互换）：
                // -1) 工具声明白名单：DeepSeek 兼容层只允许 type:'custom' 中
                //     name='apply_patch' 的声明，exec 等实时工具声明直接 400
                //     （2026-09-02 快照重放实锤，见 sanitizeThirdPartyResponsesTools）。
                // 0) call_id 补齐：第三方上游（DeepSeek 等）严格反序列化要求 call 类
                //    item 必须有 call_id（OpenAI 官方历史里部分调用项只有 id）——
                //    input: missing field 'call_id' 400（2026-09-02 跨模型续接实锤）。
                //    必须先于孤儿/相邻判定，否则缺 call_id 的调用会失去配对机会。
                // 1) 孤儿修复：客户端在工具执行中断后重试会留下无 *_output 配对的
                //    调用项，上游直接 400（"No tool output found for tool call …"）；
                //    同时删除无 call_id、永远无法配对的 serde 强约束 output
                //    （function_call_output / custom_tool_call_output）。
                // 2) 相邻归一化：DeepSeek 等上游要求 output 紧跟其 call；历史里
                //    call → assistant message → output 的交错序列触发完全相同的
                //    400（A/B 对照实验证实），必须把 output 上提到紧跟调用之后。
                const toolSanitized = sanitizeThirdPartyResponsesTools(attemptBody.tools);
                if (toolSanitized.removed.length) {
                  attemptBody.tools = toolSanitized.tools;
                  flog({
                    event: 'responses.tools_filtered',
                    request_id: requestDiagnostics.requestId,
                    model,
                    removed_tools: toolSanitized.removed.join(',').slice(0, 200),
                  });
                }
                ensureResponsesCallIds(attemptBody.input, (patched) => flog({
                  event: 'responses.call_id_patched',
                  request_id: requestDiagnostics.requestId,
                  model,
                  item_type: patched?.item_type,
                  id_prefix: patched?.id_prefix,
                }));
                // 官方→第三方续接：清洗历史中官方加密的子代理任务参数（spawn_agent/
                // followup_task/send_message 的 gAAAA message），防第三方模型模仿加密
                // 格式导致子代理收不到任务（2026-09-03 GLM 实锤，同 chat 通道清洗）。
                const sanitizedAgentCalls = sanitizeEncryptedAgentMessages(attemptBody.input);
                if (sanitizedAgentCalls > 0) {
                  flog({
                    event: 'responses.encrypted_agent_message_sanitized',
                    request_id: requestDiagnostics.requestId,
                    model,
                    count: sanitizedAgentCalls,
                  });
                }
                attemptBody.input = repairOrphanToolCalls(attemptBody.input, (item) => flog({
                  event: 'responses.repaired_orphan',
                  request_id: requestDiagnostics.requestId,
                  model,
                  item_type: item?.type,
                  id_prefix: item?.call_id_prefix,
                }));
                attemptBody.input = enforceToolOutputAdjacency(attemptBody.input, (info) => flog({
                  event: 'responses.reordered_tool_outputs',
                  request_id: requestDiagnostics.requestId,
                  model,
                  moved_outputs: info?.moved_outputs,
                }));
              }
            }
            // ---- 官方通道增量续聊（2026-09-02：全量重发 3.7MB/轮烧光 5h 窗口的根治）----
            // 会话基线/增量判定记录（请求与响应两侧都要用，声明在 target 循环作用域）
            let officialInc = null;
            let officialIncBase = null;
            let officialIncSessionKey = null;
            let officialIncProps = null;
            const officialIncUrl = isChatGptBackend(target) ? url : '';
            if (officialIncrementalStore && /\/responses(?:\/|$|\?)/.test(officialIncUrl)
              && Array.isArray(attemptBody?.input)) {
              officialIncSessionKey = officialSessionKeyOf(attemptBody);
              officialIncProps = officialPropsFingerprint(attemptBody);
              officialInc = officialIncrementalStore.incrementalFor(attemptBody);
              if (officialInc) {
                // 增量改写：上游按 previous_response_id 续算，本轮只发新增
                attemptBody.previous_response_id = officialInc.previousResponseId;
                attemptBody.input = officialInc.input;
                attemptBody.store = true;
                flog({
                  event: 'official.incremental',
                  request_id: requestDiagnostics.requestId,
                  model,
                  prev_id_prefix: officialInc.previousResponseId.slice(0, 16),
                  delta_items: officialInc.input.length,
                });
              } else {
                // 记录基线：上游成功后绑定 response.id，下轮同前缀即可增量
                officialIncrementalStore.recordRequest(
                  officialIncSessionKey, officialIncProps, attemptBody.input,
                );
              }
            }
            const upstreamPath = joinUpstreamPath(target.prefix, url.replace(/^\/v1/, ''));
            // 发送循环：增量被上游拒绝（4xx，状态过期/清理）时清除该会话缓存，
            // 恢复全量请求体原样重发一次（保证任务不中断；缓存清空后下次重建基线）。
            // 注意 attemptBody 是 const——回退用属性级恢复（previous_response_id 删除、
            // input/store 从基线副本还原），不得重新赋值。
            let upstream = null;
            for (let officialSendPass = 0; ; officialSendPass += 1) {
              upstream = await openTargetStream(
                target,
                upstreamPath,
                headers,
                attemptBody ? JSON.stringify(attemptBody) : originalBody.toString('utf8'),
                abortController.signal,
                timeouts,
                clientReq.method,
              );
              if (clientClosed) {
                upstream.socket?.destroy?.();
                return;
              }
              if (officialInc && officialSendPass === 0 && upstream.status >= 400 && upstream.status < 500) {
                officialIncrementalStore.clearSession(officialIncSessionKey);
                flog({
                  event: 'official.incremental_rejected',
                  request_id: requestDiagnostics.requestId,
                  upstream_status: upstream.status,
                });
                attemptBody.previous_response_id = officialIncBase?.previous_response_id;
                attemptBody.input = officialIncBase?.input ?? attemptBody.input;
                attemptBody.store = officialIncBase?.store;
                upstream.socket?.destroy?.();
                continue;
              }
              break;
            }
            if (clientClosed) {
              upstream.socket?.destroy?.();
              return;
            }
            requestDiagnostics.upstream({
              upstream_status: upstream.status || 502,
              upstream_request_id: upstreamRequestId(upstream.headers),
            });
            captureCodexRateLimits(target, upstream.headers, attemptKey, authManager);
            if (isRetryableProviderFailure({ status: upstream.status }) && hasFallback) {
              const errorText = await readStreamSnippet(upstream.stream);
              const failure = statusFailure(
                upstream.status,
                `native upstream ${upstream.status}`,
              );
              failure.quotaObservation = {
                target: target.name,
                model: upstreamModel(target, model),
                status: upstream.status || 502,
                headers: upstream.headers,
                bodyText: errorText,
              };
              const retryAfter = upstream.headers['retry-after'];
              if (typeof retryAfter === 'string' && retryAfter.trim()) failure.retryAfter = retryAfter.trim();
              throw failure;
            }
            if (upstream.status < 200 || upstream.status >= 300) {
              requestDiagnostics.markFailure({
                outcome: 'upstream_error',
                error_code: String(upstream.status || 502),
                error_stage: 'upstream_headers',
              });
            }
            // 账号额度 429（单 target 透传路径同样要「请求内无缝换号」）：冷却当前账号，
            // 丢弃上游流后重跑同一 target，acquireAccount 会跳过已冷却账号選下一个；
            // 预算用尽才走下方透传把错误回给客户端（对齐 sub2api 额度池语义）。
            if (upstream.status === 429
              && attemptKey?.source === 'account'
              && attemptKey.entryId
              && accountSwitchBudget > 0) {
              try {
                authManager?.markCooldown?.(attemptKey.entryId, {
                  cooldownMs: 30 * 60_000,
                  reason: '模型额度受限 (429)',
                });
              } catch { /* 冷却失败不影响换号 */ }
              accountSwitchBudget -= 1;
              requestDiagnostics.failover({
                error_code: 'account_quota_switch',
                error_stage: 'account_pool',
              });
              // 丢弃上游流，避免换号重试时旧 socket 残留
              if (upstream.stream) {
                try { upstream.stream.resume(); } catch { /* 已关闭 */ }
                try { upstream.stream.destroy(); } catch { /* 已关闭 */ }
              }
              index -= 1;
              continue;
            }
            options.providerPool.remember(affinityWriteKeys, target);
            stopHeartbeat();
            // 第三方 Responses 上游对 exec 只能走 function 声明（custom 声明被拒/不可
            // 见），模型输出 function_call(exec)；桌面端只认 custom_tool_call——响应流
            // 桥接改写（仅 200 SSE 透传场景，错误流不受影响）。
            let bridgeStream = upstream.stream;
            if (
              upstream.status === 200
              && !isChatGptBackend(target)
              && /text\/event-stream/i.test(String(upstream.headers['content-type'] || ''))
            ) {
              bridgeStream = upstream.stream.pipe(createExecCustomToolBridgeTransform());
            }
            options.pipeNativeResponse(
              { ...upstream, stream: bridgeStream },
              clientRes,
              `${model || '?'} -> ${target.name}`,
              (response) => {
                options.responseHistory.recordResponse(response, affinityWriteKeys);
                if (response?.id) {
                  options.providerPool.remember(
                    affinityWriteKeys,
                    target,
                    [`response:${response.id}`],
                  );
                }
                // 增量续聊：绑定本会话基线的上游 response.id（下轮同前缀可增量）
                if (officialIncSessionKey && response?.id) {
                  officialIncrementalStore.attachResponse(
                    officialIncSessionKey,
                    response.id,
                  );
                }
              },
              requestDiagnostics,
              (bodyText) => {
                    // 非 429 的上游 4xx/5xx：记下真实错误体摘要（此分支此前完全丢失，
                    // 只能靠桌面端截图反推；2026-09-02 复盘补上）。透传不受影响。
                    if (upstream.status !== 429) {
                      const summary = summarizeUpstreamError(upstream.status, bodyText, upstream.headers);
                      if (summary.upstream?.message) {
                        requestDiagnostics.markFailure({
                          outcome: 'upstream_error',
                          error_code: String(upstream.status || 502),
                          error_stage: 'upstream_headers',
                          error_message: summary.upstream.message,
                        });
                        flog({
                          event: 'native.upstream_error_body',
                          request_id: requestDiagnostics.requestId,
                          target: target.name,
                          model,
                          upstream_status: upstream.status || 502,
                          error_message: String(summary.upstream.message).slice(0, 300),
                        });
                      }
                      return null;
                    }
                    // 池 key 命中：只记 key 级冷却（单请求单 key，不重试）；
                    // 模型级冷却仅当走 envKey 兜底（池空/全冷却）时才进入
                    if (keyPool && attemptKey?.source === 'pool' && attemptKey.entryId) {
                      try {
                        keyPool.markKeyCooldown(attemptKey.entryId, {
                          headers: upstream.headers,
                          bodyText,
                        });
                      } catch { /* 冷却落库失败不影响响应透传 */ }
                      return null;
                    }
                    // 订阅账号命中：只冷却该账号（额度耗尽），下一请求自动换到池中
                    // 其他账号；不进入模型级冷却，避免一个账号 429 连锁锁死多账号共享
                    // 的同一模型（sub2api 额度池语义）。
                    if (authManager && attemptKey?.source === 'account' && attemptKey.entryId) {
                      try {
                        authManager.markCooldown(attemptKey.entryId, {
                          // 官方 429 多为「模型级额度条」用尽（如 sol 独立重置）；只做 30 分钟短冷却，
                          // 不锁账号级恢复点，避免同一账号的其它模型被连带锁死。
                          cooldownMs: 30 * 60_000,
                          reason: '模型额度受限 (429)',
                        });
                      } catch { /* 冷却失败不影响响应透传 */ }
                      return null;
                    }
                    // auth.json 桌面登录态兜底（attemptKey 为空）：不记模型级冷却——
                    // 兜底通常是额度已死的同一账号，模型级冷却会在选账号之前拦截请求，
                    // 把池内健康的订阅账号也锁死。只记诊断让面板可见。
                    if (!attemptKey) {
                      flog({
                        event: 'official.fallback_429',
                        request_id: requestDiagnostics.requestId,
                        target: target.name,
                        model,
                      });
                      return null;
                    }
                    return modelQuotaCooldown.observe({
                      target: target.name,
                      model: upstreamModel(target, model),
                      status: upstream.status,
                      headers: upstream.headers,
                      bodyText,
                    });
                  },
            );
            return;
          } catch (error) {
            lastError = error;
            if (clientClosed) return;
            // 订阅账号命中时：401/429 只冷却该账号（额度耗尽/凭据失效），
            // 并在本请求内无缝切换到池中下一个未冷却账号重试（额度池语义）；
            // 全部换无可换后才把错误回给客户端。
            const accountEntryId = attemptKey?.source === 'account' ? attemptKey.entryId : null;
            if (accountEntryId && isAuthOrQuotaFailure(error)) {
              if (error.status === 401) {
                // 401 = 凭据被上游吊销/失效：标记「登录过期」（管理页警示，需重新授权），
                // 而非普通 cooldown——原 60 分钟冷却会让账号静默复活又立刻 401，用户无感知。
                if (authManager && typeof authManager.markAuthExpired === 'function') {
                  try {
                    authManager.markAuthExpired(accountEntryId, `上游请求被拒绝: ${String(error.message || '').slice(0, 140)}`);
                  } catch { /* 标记失败不影响换号重试 */ }
                }
              } else if (authManager && typeof authManager.markCooldown === 'function') {
                try {
                  const bodyText = String(error.quotaObservation?.bodyText || '');
                  const retryAfter = Number(error.retryAfter);
                  // 429 分两类：限速（rate limit / Too Many Requests / 短 retry-after）
                  // 与额度耗尽（额度条 reset 到未来数小时/天）。限速误按额度冷却
                  // 30 分钟会在「面板明明 100%」时把账号锁死（2026-09-02 实锤）：
                  // 限速只短冷却 60 秒，并透传 retry-after 让客户端退避即可。
                  const isRateLimit = /too many requests|rate limit|throttl/i.test(bodyText)
                    || (Number.isFinite(retryAfter) && retryAfter >= 1 && retryAfter <= 120);
                  authManager.markCooldown(accountEntryId, {
                    cooldownMs: isRateLimit ? 60_000 : 30 * 60_000,
                    reason: isRateLimit ? '上游限速 (429 rate limit)' : '账号额度耗尽 (429)',
                  });
                } catch { /* 冷却失败不影响主流程 */ }
              }
              if (accountSwitchBudget > 0) {
                accountSwitchBudget -= 1;
                requestDiagnostics.failover({
                  error_code: error.status === 401 ? 'account_credentials_switch' : 'account_quota_switch',
                  error_stage: 'account_pool',
                });
                index -= 1; // 与 for 的 index++ 抵消：重跑同一 target，重选下一个未冷却账号
                continue;
              }
              break;
            }
            // 池 key 命中时：401/429 只冷却这一把并结束请求（单请求单 key，不做请求内换 key
            // 重试）；调用方重试的下一请求自动换到池中未被冷却的 key。
            // 模型级冷却不在此触发——它是「全部 key + envKey + 备用通道」都失败时的最后一道保护。
            const poolEntryId = attemptKey?.source === 'pool' ? attemptKey.entryId : null;
            if (poolEntryId && isAuthOrQuotaFailure(error)) {
              if (keyPool) {
                try {
                  keyPool.markKeyCooldown(poolEntryId, {
                    headers: error.quotaObservation?.headers,
                    bodyText: error.quotaObservation?.bodyText,
                  });
                } catch {
                  // 冷却落库失败不影响主流程
                }
              }
              // 全部账号耗尽时向调用方附上池内最早恢复时间
              const earliest = keyPool?.earliestRetryAt(target.name) || 0;
              if (earliest > 0 && !error.retryAt) error.retryAt = earliest;
              break;
            }
            // 401/429 可能是 envKey 已轮换（同名变量新值）：刷新注册表，值变化则用新 key 重试同一目标一次。
            const retryKey = target.envKey ? `${target.name}\u0000${target.envKey}` : null;
            if (retryKey && !keyRefreshAttempts.has(retryKey) && isAuthOrQuotaFailure(error)) {
              keyRefreshAttempts.add(retryKey);
              try {
                const rotated = await refreshEnvKey(target.envKey);
                if (rotated) {
                  log(`env key rotated [${target.envKey}], retry same target with new key`);
                  requestDiagnostics.failover({
                    error_code: error.code || 'upstream_error',
                    error_stage: error.stage || 'upstream_headers',
                  });
                  index -= 1;
                  continue;
                }
              } catch {
                // 刷新失败按原逻辑处理，不掩盖原始上游错误。
              }
            }
            if (error.quotaObservation) {
              // 桌面登录态兜底（attemptKey 为空）打官方通道不记模型级冷却：兜底凭据常为
              // 同额度死账号，其 429 进冷却门会锁死池内健康账号（主透传 429 回调已有同款
              // 豁免；chat 桥接与快速失败路径由此处统一收口——2026-09-02 审计残留 #1）。
              // 第三方 chat 通道（envKey/池 key，attemptKey 同为空）不受影响，照常观察。
              if (!attemptKey && isChatGptBackend(target)) {
                flog({
                  event: 'official.fallback_429',
                  request_id: requestDiagnostics.requestId,
                  target: target.name,
                  model,
                });
              } else {
                modelQuotaCooldown.observe(error.quotaObservation);
              }
              delete error.quotaObservation;
            }
            if (hasFallback && isRetryableProviderFailure(error)) {
              log(`provider failover [${target.name}]`, error.message);
              requestDiagnostics.failover({
                error_code: error.code || 'upstream_error',
                error_stage: error.stage || 'upstream_connect',
              });
              continue;
            }
            break;
          }
        }

        stopHeartbeat();
        if (clientClosed) return;
        const error = lastError || new Error('没有可用的上游目标');
        log('route error', error.message);
        if (clientRes.headersSent) {
          requestDiagnostics.markFailure({
            outcome: ROUTER_REJECTION_CODES.has(error.code)
              ? 'router_rejected'
              : diagnosticOutcomeForError(error, 'upstream_error'),
            error_code: error.code || 'upstream_error',
            error_stage: error.stage || 'upstream_request',
            ...(error.upstreamError?.message ? { error_message: error.upstreamError.message } : {}),
          });
          options.emitResponsesErrorSse(
            clientRes,
            `router error: ${error.message}`,
            error.code || 'upstream_error',
            model,
          );
        } else {
          const explicitStatus = Number(error.status);
          // 上游真实状态码（4xx/5xx）透传给客户端，让桌面端按 HTTP 语义退避，不再盲目重试。
          const status = (explicitStatus >= 400 && explicitStatus < 600)
            ? explicitStatus
            : (error.code === 'context_length_exceeded' ? 400 : 502);
          const responseHeaders = { 'content-type': 'application/json' };
          if (typeof error.retryAfter === 'string' && error.retryAfter.trim()) {
            responseHeaders['retry-after'] = error.retryAfter.trim();
          }
          requestDiagnostics.markFailure({
            outcome: ROUTER_REJECTION_CODES.has(error.code)
              ? 'router_rejected'
              : diagnosticOutcomeForError(error, 'upstream_error'),
            error_code: error.code || 'upstream_error',
            error_stage: error.stage || 'upstream_request',
            client_status: status,
            ...(error.upstreamError?.message ? { error_message: error.upstreamError.message } : {}),
          });
          clientRes.writeHead(status, responseHeaders);
          const responseError = {
            code: error.code || 'upstream_error',
            message: `router error: ${error.message}`,
          };
          if (error.code === 'model_quota_cooldown') {
            responseError.retry_at = new Date(error.retryAt).toISOString();
            responseError.retry_after_seconds = error.retryAfterSeconds;
          } else if (error.upstreamError) {
            responseError.upstream = error.upstreamError;
            if (error.retryAt) {
              responseError.retry_at = new Date(error.retryAt).toISOString();
              responseError.retry_after_seconds = Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000));
            }
          }
          clientRes.end(JSON.stringify({ error: responseError }));
        }
      } finally {
        // 字节预算在请求体解析和上游装配后释放，并发名额持续到响应结束。
        options.requestBudget.discardBytes(requestReservation);
      }
    });
  };
}
