import { types as utilTypes } from 'node:util';

import { resolveStrongTaskKey } from './goal-checkpoint.mjs';
import {
  adaptOfficialResponsesBody,
  buildProviderAuthHeaders,
  resolveRequestProtocol,
  resolveProvider,
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
import { openHttpsStream, resolveTimeouts } from './transport.mjs';
import { buildModelList, readModelCatalogFile } from './model-catalog.mjs';
import { inspectModelCatalog } from './model-routing-plan.mjs';
import { upstreamModel } from './chat-request.mjs';
import {
  createRequestDiagnostics,
  createRequestId,
  diagnosticOutcomeForError,
} from './request-diagnostics.mjs';

const MAX_CATALOG_SNAPSHOT_DEPTH = 64;
const MAX_CATALOG_SNAPSHOT_NODES = 100_000;
const ROUTER_REJECTION_CODES = new Set([
  'context_length_exceeded',
  'cross_protocol_state_unavailable',
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

function joinUpstreamPath(prefix = '', endpoint = '') {
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${left}${right}` || '/';
}

function statusFailure(status, message, stage = 'upstream_headers') {
  const error = new Error(message);
  error.status = status;
  error.code = String(status || 502);
  error.stage = stage;
  return error;
}

// 认证失效/额度耗尽时，envKey 可能已被用户轮换（同名变量、新值）：先刷新注册表再重试。
function isAuthOrQuotaFailure(error) {
  const status = Number(error?.status);
  return status === 401 || status === 429;
}

function responseStatus(clientRes) {
  const status = Number(clientRes.statusCode ?? clientRes.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function upstreamRequestId(headers = {}) {
  for (const name of ['x-request-id', 'request-id', 'x-amzn-requestid', 'cf-ray']) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) return value[0];
  }
  return undefined;
}

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

  async function authHeadersForTarget(clientReq, target, provider) {
    const headers = {
      ...forwardRequestHeaders(clientReq.headers, target),
      ...(target.headers || {}),
    };
    if (isChatGptBackend(target)) {
      const auth = await options.getOpenAiAuth(target);
      const generated = { authorization: `Bearer ${auth.token}` };
      if (auth.accountId) generated['chatgpt-account-id'] = auth.accountId;
      return mergeGeneratedHeaders(
        headers,
        generated,
        ['authorization', 'chatgpt-account-id'],
      );
    }
    const key = getKey(target.envKey);
    if (!key) throw new Error(`环境变量 ${target.envKey} 未设置`);
    return mergeGeneratedHeaders(headers, buildProviderAuthHeaders(provider, key));
  }

  async function prepareAttemptBody(bodyObj, target, isChat, model, signal, settings = {}) {
    const attemptBody = bodyObj ? structuredClone(bodyObj) : null;
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

  function openTargetStream(target, requestPath, headers, body, signal, timeouts, method = 'POST') {
    return openStream({
      protocol: target.protocol,
      host: target.host,
      port: target.port || (target.protocol === 'http' ? 80 : 443),
      path: requestPath,
      method,
      viaProxy: target.viaProxy,
      proxy: options.proxy,
      headers,
      body,
      signal,
      timeouts,
    });
  }

  return async function routerHandler(clientReq, clientRes) {
    const url = clientReq.url || '/';
    // 管理页及其 API 优先匹配；未命中时继续执行既有代理路由。
    if (options.adminHandler && await options.adminHandler(clientReq, clientRes)) return;
    // 关闭能力只在隔离测试显式注入；正常本地实例不暴露任何进程控制端点。
    if (
      typeof onShutdown === 'function'
      && url === '/_admin/shutdown'
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
    if (clientReq.method === 'GET' && (url === '/healthz' || url === '/v1/healthz')) {
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ ok: true, targets: targets.map((target) => target.name) }));
      return;
    }
    if (clientReq.method === 'GET' && (url === '/models' || url === '/v1/models')) {
      try {
        const data = listModels(catalogSnapshot, config.supportsResponses);
        clientRes.writeHead(200, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({ object: 'list', data }));
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
    clientRes.once('finish', () => {
      diagnosticResponseFinished = true;
      requestDiagnostics.finish({ client_status: responseStatus(clientRes) });
    });
    clientRes.once('close', () => {
      if (!diagnosticResponseFinished) {
        requestDiagnostics.disconnect({ client_status: responseStatus(clientRes) });
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
        let model = '';
        try {
          bodyObj = JSON.parse(originalBody.toString());
          model = bodyObj.model || '';
        } catch { /* 非 JSON 按默认通道处理 */ }
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
          abortController.abort();
        });

        let lastError = null;
        let keyRetried = false;
        for (let index = 0; index < compatibleCandidates.length; index += 1) {
          const target = compatibleCandidates[index];
          const provider = resolveProvider(target);
          const isChat = provider.wireApi === 'chat';
          const hasFallback = index < compatibleCandidates.length - 1;
          requestDiagnostics.attempt({
            target: target.name,
            wire_api: provider.wireApi,
            attempt: index + 1,
          });
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
                onValidated: isChat ? ensureHeartbeat : null,
              },
            );
            if (changesStateDomain && attemptBody) {
              delete attemptBody.previous_response_id;
              delete attemptBody.prompt_cache_key;
            }
            if (clientClosed) return;

            const headers = await authHeadersForTarget(clientReq, target, provider);
            const timeouts = resolveTimeouts(options.timeouts, provider.timeouts);
            if (clientClosed) return;

            if (isChat) {
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
              const upstream = await openTargetStream(
                target,
                upstreamPath,
                headers,
                JSON.stringify(prepared.request),
                abortController.signal,
                timeouts,
              );
              if (clientClosed) {
                upstream.socket.destroy();
                return;
              }
              requestDiagnostics.upstream({
                upstream_status: upstream.status || 502,
                upstream_request_id: upstreamRequestId(upstream.headers),
              });
              const contentType = String(upstream.headers['content-type'] || '');
              if (upstream.status !== 200 || /application\/json/i.test(contentType)) {
                const errorText = await readStreamSnippet(upstream.stream);
                throw statusFailure(
                  upstream.status || 502,
                  `chat upstream ${upstream.status || 502}: ${errorText.slice(0, 300)}`,
                );
              }
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

            if (attemptBody) {
              attemptBody.model = upstreamModel(target, model);
              // Responses 适配只作用于 /responses 端点；图片等非 Responses 请求原样透传。
              if (isChatGptBackend(target)) adaptOfficialResponsesBody(attemptBody, url);
            }
            const upstreamPath = joinUpstreamPath(target.prefix, url.replace(/^\/v1/, ''));
            const upstream = await openTargetStream(
              target,
              upstreamPath,
              headers,
              attemptBody ? JSON.stringify(attemptBody) : originalBody.toString('utf8'),
              abortController.signal,
              timeouts,
              clientReq.method,
            );
            if (clientClosed) {
              upstream.socket.destroy();
              return;
            }
            requestDiagnostics.upstream({
              upstream_status: upstream.status || 502,
              upstream_request_id: upstreamRequestId(upstream.headers),
            });
            if (isRetryableProviderFailure({ status: upstream.status }) && hasFallback) {
              const errorText = await readStreamSnippet(upstream.stream);
              throw statusFailure(
                upstream.status,
                `native upstream ${upstream.status}: ${errorText.slice(0, 300)}`,
              );
            }
            if (upstream.status < 200 || upstream.status >= 300) {
              requestDiagnostics.markFailure({
                outcome: 'upstream_error',
                error_code: String(upstream.status || 502),
                error_stage: 'upstream_headers',
              });
            }
            options.providerPool.remember(affinityWriteKeys, target);
            stopHeartbeat();
            options.pipeNativeResponse(
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
            );
            return;
          } catch (error) {
            lastError = error;
            if (clientClosed) return;
            // 401/429 可能是 envKey 已轮换（同名变量新值）：刷新注册表，值变化则用新 key 重试同一目标一次。
            if (!keyRetried && target.envKey && isAuthOrQuotaFailure(error)) {
              keyRetried = true;
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
        requestDiagnostics.markFailure({
          outcome: ROUTER_REJECTION_CODES.has(error.code)
            ? 'router_rejected'
            : diagnosticOutcomeForError(error, 'upstream_error'),
          error_code: error.code || 'upstream_error',
          error_stage: error.stage || 'upstream_request',
        });
        if (clientRes.headersSent) {
          options.emitResponsesErrorSse(
            clientRes,
            `router error: ${error.message}`,
            error.code || 'upstream_error',
          );
        } else {
          const explicitStatus = Number(error.status);
          const status = explicitStatus >= 400 && explicitStatus < 500
            ? explicitStatus
            : (error.code === 'context_length_exceeded' ? 400 : 502);
          clientRes.writeHead(status, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({
            error: {
              code: error.code || 'upstream_error',
              message: `router error: ${error.message}`,
            },
          }));
        }
      } finally {
        // 字节预算在请求体解析和上游装配后释放，并发名额持续到响应结束。
        options.requestBudget.discardBytes(requestReservation);
      }
    });
  };
}
