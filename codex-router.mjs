#!/usr/bin/env node
// ============================================================================
// codex-router.mjs — Codex 本地多模型路由代理（零依赖，Node >= 18）
// ----------------------------------------------------------------------------
// 解决什么问题：
//   Codex 桌面端同一时间只能配置一个 model_provider，且「官方 GPT + 第三方模型」
//   无法在选择器里共存。本路由作为唯一 provider 的 base_url 接管全部请求，
//   按请求体里的 model 字段分流到不同上游，实现：
//     · 官方 GPT 系列  → chatgpt.com（复用桌面端 auth.json 的 ChatGPT 登录态，
//                        可选经 v2rayN 等本地代理的 CONNECT 隧道出海）
//     · DeepSeek 系列  → api.deepseek.com（环境变量 key，直连）
//     · Qwen 系列      → 阿里云 Token Plan 端点（环境变量 key，直连）
//   并附带「视觉中继」：给不支持图片的文本模型发图时，先调一个视觉模型把图片
//
// 配套 config.toml 关键写法（详见 README.md）：
//   model_provider = "router"
//   model_catalog_json = "<你的 models.json>"
//   [model_providers.router]
//   base_url = "http://127.0.0.1:15730/v1"
//   wire_api = "responses"
//   requires_openai_auth = true   # ← 门控钥匙：让桌面端按官方身份放行自定义模型
//   supports_websockets = false
//
// 环境变量：
//   CODEX_HOME          Codex 数据目录（默认 ~/.codex），auth.json/models.json 在此
//   CODEX_AUTH_PATH     覆盖 auth.json 路径
//   CODEX_CATALOG_PATH  覆盖 models.json 路径（/v1/models 端点读取它）
//   ROUTER_CONFIG_PATH  覆盖 config.json 路径（用于隔离测试或多实例）
//   ROUTER_PORT         监听端口（默认 15730）
//   ROUTER_HEARTBEAT_MS 覆盖 Chat SSE 心跳间隔（默认 15000 毫秒）
//   V2RAY_PORT          本地代理混合端口（默认 10808，仅 viaProxy 的通道使用）
//   各通道 key 见下方 TARGETS 的 envKey 字段
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertResponsesTools,
  responsesToChatMessages,
} from './lib/chat-protocol.mjs';
import { createChatSseToResponsesTransform } from './lib/chat-stream.mjs';
import { fitMessagesToContext, resolveModelCapability } from './lib/context-budget.mjs';
import {
  buildCheckpointMessages,
  buildCheckpointSource,
  extractCheckpointText,
  extractGoalAnchor,
  GoalCheckpointStore,
  normalizeCheckpoint,
  resolveStrongTaskKey,
} from './lib/goal-checkpoint.mjs';
import {
  adaptOfficialResponsesBody,
  applyCheckpointProviderOptions,
  applyChatProviderOptions,
  buildProviderAuthHeaders,
  resolveOAuthViaProxy,
  resolveRequestProtocol,
  resolveProvider,
} from './lib/provider-adapters.mjs';
import {
  isRetryableProviderFailure,
  ProviderPool,
  requestAffinityKeys,
} from './lib/provider-pool.mjs';
import { ResponseToolHistoryStore } from './lib/response-history.mjs';
import {
  openHttpsStream,
  rawHttpsRequest,
  resolveTimeouts,
  withTimeout,
} from './lib/transport.mjs';

// ---------- 加载配置 ----------
// config.json 与 codex-router.mjs 同目录，包含所有可修改参数
// 环境变量优先级高于 config.json（PORT/PROXY 等）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = process.env.ROUTER_CONFIG_PATH || path.join(__dirname, 'config.json');
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = Number(process.env.ROUTER_PORT || cfg.port || 15730);
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const AUTH_PATH = process.env.CODEX_AUTH_PATH || cfg.paths?.auth || path.join(CODEX_HOME, 'auth.json');
const CATALOG_PATH = process.env.CODEX_CATALOG_PATH || cfg.paths?.catalog || path.join(CODEX_HOME, 'models.json');
const V2RAY_PROXY = {
  host: process.env.V2RAY_HOST || cfg.proxy?.host || '127.0.0.1',
  port: Number(process.env.V2RAY_PORT || cfg.proxy?.port || 10808)
};
const CLIENT_ID = cfg.oauth?.client_id || 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_SKEW_SECONDS = cfg.oauth?.refresh_skew_seconds || 30;

// 路由规则：按请求体 model 字段收集所有匹配目标，优先使用会话粘性目标；失败时安全切换备用目标
// match: 正则字符串 | host: 上游域名 | prefix: 路径前缀
// viaProxy: true=经本地代理 CONNECT 隧道 | vision: false=文本模型走视觉中继
// envKey: API key 所在环境变量名（官方通道不用，走 auth.json）
// 容错：单条 match 正则非法时跳过该通道并告警，不让整个路由启动即崩
const TARGETS = (cfg.targets || []).flatMap((t) => {
  try { return [{ ...t, match: new RegExp(t.match) }]; }
  catch (e) { console.error(`[config] 忽略非法 match 正则: ${t.match} (${e.message})`); return []; }
});
const providerPool = new ProviderPool(TARGETS, cfg.providerPool);
const responseHistory = new ResponseToolHistoryStore(cfg.responseHistory);
const goalCheckpoints = new GoalCheckpointStore(cfg.goalCheckpoint);
const HEARTBEAT_MS = Math.max(10, Number(process.env.ROUTER_HEARTBEAT_MS || cfg.heartbeatMs) || 15_000);

// ---------- 视觉中继配置 ----------
// 文本模型 (vision:false) 收到 input_image 时，调用这里配置的视觉模型生成描述
// 配置项见 config.json 的 visionRelay 字段
const VISION_RELAY = cfg.visionRelay || { host: 'token-plan.cn-beijing.maas.aliyuncs.com', prefix: '/compatible-mode/v1', model: 'qwen3.8-max', envKey: 'aliyun_video_key' };

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
// 诊断日志（可选）：ROUTER_LOG 指向文件时记录请求形状，用于排查闪跳/上下文问题
// 异步链式追加：同步磁盘 IO 会把事件循环卡在系统调用上（慢盘/文件锁时所有请求一起挂），
// 因此写入全部走 libuv 线程池，并按 promise 链保持顺序；超过上限时轮转保留一份旧日志。
const LOG_FILE = process.env.ROUTER_LOG || null;
const LOG_MAX_BYTES = 50 * 1024 * 1024;
let logChain = Promise.resolve();
const flog = (m) => {
  if (!LOG_FILE) return;
  logChain = logChain.then(async () => {
    try {
      const line = `[${new Date().toISOString()}] ${m}\n`;
      const stat = await fs.promises.stat(LOG_FILE).catch(() => null);
      if (stat && stat.size > LOG_MAX_BYTES) {
        await fs.promises.rename(LOG_FILE, `${LOG_FILE}.1`).catch(() => {});
      }
      await fs.promises.appendFile(LOG_FILE, line);
    } catch { /* 日志失败不影响路由 */ }
  }).catch(() => {});
};

// ---------- 进程级异常兕底（并发安全） ----------
// 多任务并发时，任何漏网的异常/未决拒绝只记日志、不退出进程，避免路由整体崩溃。
// 单个请求出错由桌面端自行重试，不影响其他并发任务。
process.on('uncaughtException', (e) => { log('uncaughtException (kept alive):', e && e.message); });
process.on('unhandledRejection', (e) => { log('unhandledRejection (kept alive):', e && e.message); });

// ---------- 模型上下文窗口配置 ----------
// config.json 的 modelContext 字段：路由启动时把上下文窗口/压缩阈值写回 models.json，
// 让桌面端据此做滑动窗口/压缩，避免第三方模型每轮全量重发历史（卡思考根因）
function applyModelContext() {
  const mc = cfg.modelContext;
  if (!mc || mc.enabled === false) return;
  try {
    const cat = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    let changed = false;
    const slugs = mc.slugs || [];
    for (const m of cat.models || []) {
      if (slugs.length && !slugs.includes(m.slug)) continue;
      if (mc.contextWindow && m.context_window !== mc.contextWindow) { m.context_window = mc.contextWindow; m.max_context_window = mc.contextWindow; changed = true; }
      if (mc.autoCompactTokenLimit !== undefined && m.auto_compact_token_limit !== mc.autoCompactTokenLimit) { m.auto_compact_token_limit = mc.autoCompactTokenLimit; changed = true; }
    }
    if (changed) {
      const tmp = CATALOG_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cat, null, 2));
      fs.renameSync(tmp, CATALOG_PATH);
      log('modelContext: 已写回 models.json');
    }
  } catch (e) { log('modelContext: 应用失败', e.message); }
}
applyModelContext();

// ---------- HTTPS 传输 ----------
// TLS、HTTP/1.1、CONNECT 代理、chunked 解码与分层超时集中在 lib/transport.mjs。
// 一次性 HTTPS 请求并解析 JSON 响应（用于 OAuth refresh 等控制类调用）
function httpsJson(host, reqPath, viaProxy, headers, bodyObj) {
  return rawHttpsRequest({
    host,
    path: reqPath,
    viaProxy,
    proxy: V2RAY_PROXY,
    headers,
    body: JSON.stringify(bodyObj),
    timeouts: resolveTimeouts(cfg.timeouts),
  }).then(({ status, bodyText }) => {
    try { return { status, json: JSON.parse(bodyText) }; } catch { return { status, json: null, raw: bodyText }; }
  });
}

// ---------- 视觉中继实现 ----------
// 图片描述缓存：同一张图（同 url/dataURL）只调一次视觉模型，后续轮次直接复用，
// 避免长会话每轮重复描述历史截图导致“一直思考”
const captionCache = new Map();
const CAPTION_CACHE_MAX = 200;
// 调用视觉模型为单张图片生成文字描述（带缓存，同图只调一次）
async function captionImage(imageUrl, signal) {
  if (captionCache.has(imageUrl)) return captionCache.get(imageUrl);
  const key = process.env[VISION_RELAY.envKey];
  if (!key) throw new Error(`VISION_RELAY 环境变量 ${VISION_RELAY.envKey} 未设置`);
  const body = JSON.stringify({
    model: VISION_RELAY.model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: VISION_RELAY.prompt || 'Describe this image concisely (2-4 sentences) for a coding assistant that cannot see it.' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ] }],
    max_tokens: VISION_RELAY.maxTokens || 300,
  });
  const r = await rawHttpsRequest({
    host: VISION_RELAY.host,
    path: `${VISION_RELAY.prefix}/chat/completions`,
    viaProxy: VISION_RELAY.viaProxy === true,
    proxy: V2RAY_PROXY,
    headers: { authorization: `Bearer ${key}` },
    body,
    signal,
    timeouts: resolveTimeouts(cfg.timeouts, VISION_RELAY.timeouts),
  });
  const j = JSON.parse(r.bodyText);
  if (r.status !== 200 || !j.choices?.[0]?.message?.content) throw new Error(`vision relay HTTP ${r.status}`);
  const desc = j.choices[0].message.content;
  if (captionCache.size >= CAPTION_CACHE_MAX) captionCache.clear(); // 简单淘汰：满了清空
  captionCache.set(imageUrl, desc);
  return desc;
}
// 遍历 Responses API 的 input，对中继目标模型不可见的非文本 part 做替换：
//   1. user 消息的 content（用户直接贴图）
//   2. function_call_output 的 output（浏览器/电脑操作插件回传的截图）
// 注意：assistant 角色的历史消息不修改，避免把描述注入错误的上下文位置
async function relayNonTextParts(body, signal) {
  if (!body || !Array.isArray(body.input)) return 0;
  let stripped = 0;
  const relayParts = async (parts) => {
    if (!Array.isArray(parts)) return parts;
    // 并行中继多图，降低多图会话延迟；只转换 input_image，其余原样保留
    return Promise.all(parts.map(async (p) => {
      if (!(p && p.type === 'input_image')) return p;
      stripped++;
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      try {
        const desc = await captionImage(url, signal);
        log(`vision relay: captioned image (${desc.length} chars)`);
        return { type: 'input_text', text: `[image description: ${desc}]` };
      } catch (e) {
        log('vision relay failed:', e.message);
        return { type: 'input_text', text: '[image omitted: vision relay failed]' }; // 降级：不阻断请求
      }
    }));
  };
  for (const msg of body.input) {
    if (!msg) continue;
    // 用户消息里的贴图
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      msg.content = await relayParts(msg.content);
    }
    // 工具/插件回传的截图（browser、computer-use 等插件的屏幕截图走这里）
    if (Array.isArray(msg.output)) {
      msg.output = await relayParts(msg.output);
    }
  }
  return stripped;
}

// ---------- Responses SSE 生命周期 ----------
function startResponsesSse(clientRes) {
  if (!clientRes.headersSent) {
    clientRes.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    clientRes.flushHeaders();
  }
  let heartbeat = setInterval(() => {
    if (clientRes.destroyed || clientRes.writableEnded) return;
    try { clientRes.write(': keep-alive\n\n'); } catch { /* close 事件统一清理 */ }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return () => {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };
}

// SSE 响应头已经发出后，上游错误也必须用 SSE 结束，不能再切回 JSON 响应
function emitResponsesErrorSse(clientRes, message, code = 'upstream_error') {
  if (!clientRes.headersSent) {
    try { clientRes.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); } catch { return; }
  }
  try {
    clientRes.write('data: ' + JSON.stringify({ type: 'error', error: { type: 'upstream_error', code, message } }) + '\n\n');
    clientRes.write('data: [DONE]\n\n');
    clientRes.end();
  } catch { /* noop */ }
}

// ---------- ChatGPT 登录态：读 auth.json，临期自动 refresh 并原子写回 ----------
// 解析 JWT 的 exp（过期时间戳），用于判断 access_token 是否临期
function jwtExp(token) {
  try {
    let p = token.split('.')[1];
    p += '='.repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(Buffer.from(p, 'base64url').toString()).exp || null;
  } catch { return null; }
}
// 读取 auth.json（桌面端 ChatGPT 登录态）
function readAuth() { return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); }
// single-flight：并发请求同时临期时只真正 refresh 一次，避免 refresh_token 轮换竞态写坏 auth.json
let refreshInFlight = null;
async function getOpenAiAuth(target) {
  const data = readAuth();
  const tokens = data.tokens || {};
  if (!tokens.access_token) throw new Error('auth.json 缺少 access_token，请先在 Codex 桌面端登录 ChatGPT');
  const exp = jwtExp(tokens.access_token);
  if (exp && Date.now() / 1000 < exp - REFRESH_SKEW_SECONDS) {
    return { token: tokens.access_token, accountId: tokens.account_id };
  }
  if (!tokens.refresh_token) throw new Error('access_token 已过期且无 refresh_token，请在桌面端重新登录');
  if (!refreshInFlight) {
    const viaProxy = resolveOAuthViaProxy(cfg.oauth, target);
    refreshInFlight = doRefresh(viaProxy).finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}
// 实际执行 refresh：用 refresh_token 换新 access_token 并原子写回 auth.json
async function doRefresh(viaProxy) {
  const data = readAuth(); // 重新读，拿最新 refresh_token
  const tokens = data.tokens || {};
  log('openai: access_token 临期，执行 refresh');
  const r = await withTimeout(
    httpsJson('auth.openai.com', '/oauth/token', viaProxy, {}, {
      client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
    }),
    // refresh 失败必须让请求快速失败并允许下次重试，不能让所有并发请求无限等待同一挂起的 refresh。
    Number(cfg.oauth?.refresh_timeout_ms) || 30_000,
    'token refresh',
  );
  if (r.status !== 200 || !r.json?.access_token) throw new Error(`token refresh 失败 HTTP ${r.status}`);
  tokens.access_token = r.json.access_token;
  if (r.json.refresh_token) tokens.refresh_token = r.json.refresh_token;
  if (r.json.id_token) tokens.id_token = r.json.id_token;
  data.tokens = tokens;
  data.last_refresh = new Date().toISOString();
  // 原子写：先写 tmp 再 rename，避免桌面端并发读到半写文件
  const tmp = AUTH_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, AUTH_PATH);
  log('openai: refresh 成功并已写回 auth.json');
  return { token: tokens.access_token, accountId: tokens.account_id };
}

function joinUpstreamPath(prefix = '', endpoint = '') {
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${left}${right}` || '/';
}

function copyRequestHeaders(clientReq) {
  const blocked = new Set([
    'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    'authorization', 'x-api-key', 'content-length', 'accept-encoding', 'content-type',
  ]);
  const headers = {};
  for (const [key, value] of Object.entries(clientReq.headers)) {
    if (!blocked.has(key.toLowerCase())) headers[key] = value;
  }
  headers['accept-encoding'] = 'identity';
  return headers;
}

function copyResponseHeaders(headers) {
  const blocked = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
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

function pipeNativeResponse(upstream, clientRes, tag) {
  log(`${tag} -> ${upstream.status}`);
  if (!clientRes.headersSent) clientRes.writeHead(upstream.status || 502, copyResponseHeaders(upstream.headers));
  upstream.stream.once('error', (error) => {
    log(`native stream error [${tag}]`, error.message);
    clientRes.destroy(error);
  });
  upstream.stream.pipe(clientRes);
}

function pipeChatResponse(upstream, clientRes, model, tag, stopHeartbeat, toolContext, onResponse) {
  const transform = createChatSseToResponsesTransform(model, toolContext);
  let failed = false;
  const fail = (error) => {
    if (failed || clientRes.destroyed || clientRes.writableEnded) return;
    failed = true;
    stopHeartbeat();
    upstream.stream.unpipe(transform);
    transform.unpipe(clientRes);
    transform.destroy();
    log(`chat stream error [${tag}]`, error.message);
    emitResponsesErrorSse(clientRes, `chat stream error: ${error.message}`);
  };
  upstream.stream.once('error', fail);
  transform.once('error', fail);
  if (onResponse) transform.once('response', onResponse);
  clientRes.once('finish', stopHeartbeat);
  transform.pipe(clientRes);
  upstream.stream.pipe(transform);
}

function upstreamModel(target, requestedModel) {
  // 同一对外模型可在不同供应商使用不同上游 slug。
  return target.modelMap?.[requestedModel] || target.upstreamModel || target.model || requestedModel;
}

async function authHeadersForTarget(clientReq, target, provider) {
  // 每次 failover 都重新按目标构造认证头，严禁沿用上一供应商的密钥。
  const headers = { ...copyRequestHeaders(clientReq), ...(target.headers || {}) };
  if (target.name === 'openai' || target.useOpenAiAuth === true) {
    const auth = await getOpenAiAuth(target);
    headers.authorization = `Bearer ${auth.token}`;
    if (auth.accountId) headers['ChatGPT-Account-ID'] = auth.accountId;
    return headers;
  }
  const key = process.env[target.envKey];
  if (!key) throw new Error(`环境变量 ${target.envKey} 未设置`);
  return { ...headers, ...buildProviderAuthHeaders(provider, key) };
}

function statusFailure(status, message) {
  // 把 HTTP 状态挂到 Error 上，交给统一重试分类器判定。
  const error = new Error(message);
  error.status = status;
  error.code = String(status || 502);
  return error;
}

// 为单个候选目标复制并准备请求体，防止 failover 之间共享可变状态。
async function prepareAttemptBody(bodyObj, target, isChat, model, signal) {
  const attemptBody = bodyObj ? structuredClone(bodyObj) : null;
  if (isChat && attemptBody) {
    // 只为 Chat 转换通道补工具调用历史；原生 Responses 通道仍由上游维护完整状态。
    const restored = responseHistory.restoreRequest(attemptBody);
    attemptBody.input = restored.input;
    if (restored.restoredCallIds.length) {
      flog(`HISTORY ${model} | restored=${restored.restoredCallIds.join(',')} | hit=${restored.historyHit}`);
    }
  }
  if (attemptBody && target.vision === false) {
    const stripped = await relayNonTextParts(attemptBody, signal);
    if (stripped > 0) log(`${model}: relayed/stripped ${stripped} non-text part(s) for text-only model`);
  }
  return attemptBody;
}

function goalCheckpointConfig(capability) {
  const configured = cfg.goalCheckpoint || {};
  return {
    enabled: configured.enabled !== false,
    maxOutputTokens: Math.max(256, Number(configured.maxOutputTokens) || 2_048),
    requestMs: Math.max(1_000, Number(configured.requestMs) || 120_000),
    sourceTokenBudget: Math.max(128, Math.min(
      Number(configured.sourceTokenBudget) || 128_000,
      Math.floor(capability.contextWindow * (Number(configured.sourceWindowRatio) || 0.2)),
    )),
  };
}

function injectGoalCheckpoint(messages, checkpoint) {
  // 检查点属于低优先级 assistant 历史，必须放在原始 system/developer 指令之后。
  let cursor = 0;
  while (cursor < messages.length && messages[cursor]?.role === 'system') cursor += 1;
  return [
    ...messages.slice(0, cursor),
    { role: 'assistant', content: checkpoint },
    ...messages.slice(cursor),
  ];
}

async function requestGoalCheckpoint(target, provider, model, headers, source, signal, timeouts, options) {
  const request = applyCheckpointProviderOptions({
    model: upstreamModel(target, model),
    messages: buildCheckpointMessages(source),
    stream: false,
    temperature: 0,
    [provider.maxTokensField]: options.maxOutputTokens,
  }, provider);
  const response = await rawHttpsRequest({
    protocol: target.protocol,
    host: target.host,
    port: target.port || (target.protocol === 'http' ? 80 : 443),
    path: joinUpstreamPath(target.prefix, provider.chatPath),
    viaProxy: target.viaProxy,
    proxy: V2RAY_PROXY,
    headers: { ...headers, accept: 'application/json' },
    body: JSON.stringify(request),
    signal,
    timeouts: { ...timeouts, requestMs: options.requestMs },
    // 检查点正文很小；限制异常或恶意兼容网关的非流式响应，避免无界占用内存。
    maxResponseBytes: 256 * 1024,
  });
  if (response.status !== 200) throw statusFailure(response.status || 502, `checkpoint upstream ${response.status || 502}`);
  let parsed;
  try { parsed = JSON.parse(response.bodyText); } catch { throw new Error('checkpoint upstream returned non-JSON body'); }
  const text = extractCheckpointText(parsed);
  if (!text) throw new Error('checkpoint upstream returned empty content');
  return normalizeCheckpoint(text, options.maxOutputTokens);
}

// 把恢复后的 Responses 请求转换成 Chat，并在发往上游前执行完整上下文预算。
async function buildChatRequest(attemptBody, target, provider, model, context) {
  const converted = convertResponsesTools(attemptBody.tools, attemptBody.input);
  const baseRequest = {
    model: upstreamModel(target, model),
    messages: responsesToChatMessages(attemptBody.input, {
      autonomy: cfg.chatConversion?.autonomy,
      instructions: attemptBody.instructions,
      vision: target.vision !== false,
      toolContext: converted.context,
    }),
  };
  if (converted.tools) baseRequest.tools = converted.tools;

  const capability = resolveModelCapability(cfg, target, model);
  const baseline = fitMessagesToContext(baseRequest.messages, converted.tools, capability);
  if (!baseline.fits) {
    const error = new Error(`最新轮次超过模型输入预算 (${baseline.messageTokens} > ${baseline.messageBudget} tokens)`);
    error.code = 'context_length_exceeded';
    throw error;
  }

  let fitted = baseline;
  let checkpointInfo = null;
  const checkpointOptions = goalCheckpointConfig(capability);
  if (checkpointOptions.enabled && baseline.trimmedGroups > 0) {
    const reserved = fitMessagesToContext(baseRequest.messages, converted.tools, capability, {
      reserveTokens: checkpointOptions.maxOutputTokens,
    });
    if (reserved.fits) {
      const taskKey = resolveStrongTaskKey(attemptBody, context.clientHeaders, goalCheckpoints);
      const previousCheckpoint = taskKey ? goalCheckpoints.getTask(taskKey) : null;
      const source = buildCheckpointSource({
        goalAnchor: extractGoalAnchor(attemptBody),
        previousCheckpoint,
        removedMessages: reserved.removedMessages,
        tokenBudget: checkpointOptions.sourceTokenBudget,
      });
      // 精确缓存包含完整上游身份，避免不同 host/prefix 恰好复用同名 target 时串用摘要。
      const exactKey = JSON.stringify([
        target.name,
        target.protocol || 'https',
        `${target.host}:${target.port || (target.protocol === 'http' ? 80 : 443)}`,
        target.prefix || '',
        provider.chatPath,
        upstreamModel(target, model),
        source.hash,
      ]);
      let checkpoint = goalCheckpoints.getExact(exactKey);
      let persistCheckpoint = Boolean(checkpoint);
      if (!checkpoint) {
        try {
          checkpoint = await requestGoalCheckpoint(
            target,
            provider,
            model,
            context.headers,
            source,
            context.signal,
            context.timeouts,
            checkpointOptions,
          );
          persistCheckpoint = true;
          flog(`CHECKPOINT ${model} | provider=${target.name} | source_tokens=${source.estimatedTokens} | chars=${checkpoint.length}`);
        } catch (error) {
          if (context.signal?.aborted || error?.name === 'AbortError') throw error;
          // 摘要失败不能触发供应商 failover；强任务键存在时可用上一份已校验检查点降级。
          checkpoint = previousCheckpoint;
          persistCheckpoint = false;
          flog(`CHECKPOINT_FALLBACK ${model} | provider=${target.name} | ${error.code || error.message}`);
        }
      }
      if (checkpoint) {
        const withCheckpoint = injectGoalCheckpoint(reserved.messages, checkpoint);
        const verified = fitMessagesToContext(withCheckpoint, converted.tools, capability);
        if (verified.fits && verified.messages.some((message) => message.content === checkpoint)) {
          fitted = verified;
          checkpointInfo = { taskKey, exactKey, checkpoint, persistCheckpoint };
        }
      }
    }
  }

  baseRequest.messages = fitted.messages;
  if (fitted.trimmedGroups > 0) {
    flog(`TRIM ${model} | groups=${fitted.trimmedGroups} | tokens=${fitted.messageTokens}/${fitted.messageBudget}`);
  }
  return {
    request: applyChatProviderOptions(baseRequest, attemptBody, provider),
    toolContext: converted.context,
    toolCount: converted.tools?.length || 0,
    checkpointInfo,
  };
}

// Chat 与原生 Responses 共用同一裸 HTTP/1.1 传输入口，避免两处分层超时配置漂移。
function openTargetStream(target, requestPath, headers, body, signal, timeouts, method = 'POST') {
  return openHttpsStream({
    protocol: target.protocol,
    host: target.host,
    port: target.port || (target.protocol === 'http' ? 80 : 443),
    path: requestPath,
    method,
    viaProxy: target.viaProxy,
    proxy: V2RAY_PROXY,
    headers,
    body,
    signal,
    timeouts,
  });
}

// ---------- 主服务 ----------
const server = http.createServer(async (clientReq, clientRes) => {
  const url = clientReq.url || '/';
  // 无感更新控制端点：旧进程释放端口但继续服务完在跑任务，新进程立即接管新请求
  if (url === '/_admin/shutdown' && clientReq.method === 'POST') {
    clientRes.writeHead(200, { 'content-type': 'application/json' });
    // 先把管理响应完整交给调用方，再关闭监听；否则当前连接会阻塞 server.close 回调。
    clientRes.once('finish', gracefulExit);
    clientRes.end(JSON.stringify({ ok: true }));
    return;
  }
  // 健康检查
  if (clientReq.method === 'GET' && (url === '/healthz' || url === '/v1/healthz')) {
    clientRes.writeHead(200, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ ok: true, targets: TARGETS.map((t) => t.name) }));
    return;
  }
  // OpenAI 兼容 /models：供管理工具连通性校验 / 桌面端目录刷新
  if (clientReq.method === 'GET' && (url === '/models' || url === '/v1/models')) {
    try {
      const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
      const data = catalog.models.map((m) => {
        const base = { id: m.slug, object: 'model', created: 0, owned_by: 'local-router' };
        // 有界工具历史不等于完整会话状态，因此只声明可安全使用的流式能力。
        const sr = cfg.supportsResponses?.slugs || [];
        if (sr.includes(m.slug)) {
          base.capabilities = { streaming: true };
        }
        return base;
      });
      clientRes.writeHead(200, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ object: 'list', data }));
    } catch (e) {
      clientRes.writeHead(500, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: String(e.message) }));
    }
    return;
  }
  if (clientReq.method !== 'POST') {
    clientRes.writeHead(404, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  // 收齐请求体 → 按 model 选通道 → 必要时视觉中继 → 换认证头 → 流式转发
  const maxRequestBytes = Number(cfg.maxRequestBytes) || 200 * 1024 * 1024;
  const declaredLength = Number(clientReq.headers['content-length'] || 0);
  if (declaredLength > maxRequestBytes) {
    clientReq.resume();
    clientRes.writeHead(413, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'request body too large' }));
    return;
  }
  const chunks = [];
  let receivedBytes = 0;
  let bodyTooLarge = false;
  clientReq.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > maxRequestBytes) {
      bodyTooLarge = true;
      chunks.length = 0;
      return;
    }
    if (!bodyTooLarge) chunks.push(chunk);
  });
  clientReq.on('end', async () => {
    if (bodyTooLarge) {
      clientRes.writeHead(413, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'request body too large' }));
      return;
    }
    const bodyBuf0 = Buffer.concat(chunks);
    let bodyObj = null;
    let model = '';
    try { bodyObj = JSON.parse(bodyBuf0.toString()); model = bodyObj.model || ''; } catch { /* 非 JSON 按默认通道走 */ }
    // 诊断：记录请求形状（历史条数/各角色计数/是否带 previous_response_id），排查闪跳
    if (bodyObj && Array.isArray(bodyObj.input)) {
      const cnt = {};
      for (const it of bodyObj.input) { const k = it?.role || it?.type || '?'; cnt[k] = (cnt[k] || 0) + 1; }
      const hasPrev = !!bodyObj.previous_response_id;
      const prevIdShort = hasPrev ? bodyObj.previous_response_id.substring(0, 20) + '...' : 'no';
      // 详细日志：记录请求体关键结构（脱敏）
      const sample = {
        model: bodyObj.model,
        stream: bodyObj.stream,
        previous_response_id: hasPrev ? bodyObj.previous_response_id : undefined,
        input_length: bodyObj.input.length,
        input_first: bodyObj.input[0] ? { role: bodyObj.input[0].role, type: bodyObj.input[0].type, content_type: Array.isArray(bodyObj.input[0].content) ? bodyObj.input[0].content.map(c => c.type).join(',') : typeof bodyObj.input[0].content } : null,
        input_last: bodyObj.input[bodyObj.input.length - 1] ? { role: bodyObj.input[bodyObj.input.length - 1].role, type: bodyObj.input[bodyObj.input.length - 1].type } : null,
        role_counts: cnt
      };
      flog(`REQ ${model} | prev=${prevIdShort} | ${JSON.stringify(sample)}`);
    }
    // 同一模型允许配置多条目标；命中过的会话优先使用上轮成功供应商。
    const affinityKeys = requestAffinityKeys(bodyObj || {}, clientReq.headers);
    const candidates = providerPool.candidates(model, affinityKeys);
    const compatibleCandidates = candidates.filter((target) => resolveRequestProtocol(resolveProvider(target), url).allowed);
    if (candidates.length && !compatibleCandidates.length) {
      // Chat compact 无可靠等价语义，不能伪装成功或静默改成普通 responses。
      clientRes.writeHead(400, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { code: 'compact_not_supported', message: 'Chat 通道不支持 /responses/compact' } }));
      return;
    }
    const abortController = new AbortController();
    let clientClosed = false;
    let stopHeartbeat = () => {};
    let heartbeatStarted = false;
    const ensureHeartbeat = () => {
      if (heartbeatStarted) return;
      heartbeatStarted = true;
      stopHeartbeat = startResponsesSse(clientRes);
    };
    clientRes.once('close', () => {
      clientClosed = true;
      stopHeartbeat();
      abortController.abort();
    });

    let lastError = null;
    for (let index = 0; index < compatibleCandidates.length; index += 1) {
      const target = compatibleCandidates[index];
      const provider = resolveProvider(target);
      const isChat = provider.wireApi === 'chat';
      const hasFallback = index < compatibleCandidates.length - 1;
      try {
        if (!['responses', 'chat'].includes(provider.wireApi)) throw new Error(`暂不支持 wireApi=${provider.wireApi}`);
        if (isChat) ensureHeartbeat();

        const attemptBody = await prepareAttemptBody(bodyObj, target, isChat, model, abortController.signal);
        if (clientClosed) return;

        const headers = await authHeadersForTarget(clientReq, target, provider);
        const timeouts = resolveTimeouts(cfg.timeouts, provider.timeouts);
        if (clientClosed) return;

        if (isChat) {
          const prepared = await buildChatRequest(attemptBody, target, provider, model, {
            clientHeaders: clientReq.headers,
            headers,
            signal: abortController.signal,
            timeouts,
          });
          const upstreamPath = joinUpstreamPath(target.prefix, provider.chatPath);
          flog(`CHAT ${model} | provider=${target.name} | messages=${prepared.request.messages.length} | tools=${prepared.toolCount} | stream=true`);
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
          const contentType = String(upstream.headers['content-type'] || '');
          if (upstream.status !== 200 || /application\/json/i.test(contentType)) {
            // 此时尚未输出模型事件；仅当错误属于可重试分类（连接/网络类、408、429、5xx）
            // 且存在备用目标时，才会在同一个 SSE 连接内安全切换备用目标。
            const errorText = await readStreamSnippet(upstream.stream);
            throw statusFailure(upstream.status || 502, `chat upstream ${upstream.status || 502}: ${errorText.slice(0, 300)}`);
          }
          providerPool.remember(affinityKeys, target);
          pipeChatResponse(upstream, clientRes, model, target.name, stopHeartbeat, prepared.toolContext, (response) => {
            responseHistory.recordResponse(response);
            providerPool.remember(affinityKeys, target, [`response:${response.id}`]);
            if (prepared.checkpointInfo) {
              if (prepared.checkpointInfo.persistCheckpoint) {
                goalCheckpoints.remember({ ...prepared.checkpointInfo, responseId: response.id });
              } else {
                // 失败降级只绑定新响应，不得把旧检查点污染到本次失败来源的精确缓存键。
                goalCheckpoints.bindResponse(prepared.checkpointInfo.taskKey, response.id);
              }
            }
          });
          return;
        }

        if (attemptBody) {
          attemptBody.model = upstreamModel(target, model);
          // 官方通道适配 chatgpt.com 参数限制（store:false 注入、max_output_tokens 移除）
          if (provider.platform === 'openai') adaptOfficialResponsesBody(attemptBody);
        }
        const upstreamPath = joinUpstreamPath(target.prefix, url.replace(/^\/v1/, ''));
        const upstream = await openTargetStream(
          target,
          upstreamPath,
          headers,
          attemptBody ? JSON.stringify(attemptBody) : bodyBuf0.toString('utf8'),
          abortController.signal,
          timeouts,
          clientReq.method,
        );
        if (clientClosed) {
          upstream.socket.destroy();
          return;
        }
        if (isRetryableProviderFailure({ status: upstream.status }) && hasFallback) {
          // 原生 Responses 通道只有在响应头阶段判断为可重试时才切换备用目标；开始 pipe 后绝不重放。
          const errorText = await readStreamSnippet(upstream.stream);
          throw statusFailure(upstream.status, `native upstream ${upstream.status}: ${errorText.slice(0, 300)}`);
        }
        providerPool.remember(affinityKeys, target);
        stopHeartbeat();
        pipeNativeResponse(upstream, clientRes, `${model || '?'} -> ${target.name}`);
        return;
      } catch (error) {
        lastError = error;
        if (clientClosed) return;
        if (hasFallback && isRetryableProviderFailure(error)) {
          log(`provider failover [${target.name}]`, error.message);
          flog(`FAILOVER ${model} | provider=${target.name} | ${error.message}`);
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
      emitResponsesErrorSse(clientRes, `router error: ${error.message}`, error.code || 'upstream_error');
    } else {
      const status = error.code === 'context_length_exceeded' ? 400 : 502;
      clientRes.writeHead(status, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { code: error.code || 'upstream_error', message: `router error: ${error.message}` } }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  log(`codex-router listening on 127.0.0.1:${PORT}`);
  log(`  config: ${CONFIG_PATH}`);
  log(`  proxy: ${V2RAY_PROXY.host}:${V2RAY_PROXY.port}`);
  log(`  targets: ${TARGETS.map((t) => t.name).join(', ')}`);
  log(`  vision relay: ${VISION_RELAY.model} @ ${VISION_RELAY.host}`);
});

// ---------- 无感更新：优雅退出 ----------
// server.close() 会立即释放监听端口（新进程可马上接管），但保留已有连接直到结束。
// closeIdleConnections() 关掉空闲 keep-alive 连接，让 close 能完成；在跑的流式任务自然结束。
let shuttingDown = false;
function gracefulExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('graceful shutdown: 释放端口，排空在跑任务');
  try { server.closeIdleConnections(); } catch { /* 旧版 Node 无此方法 */ }
  server.close(() => { log('在跑任务已排空，退出'); process.exit(0); });
  // 安全阀：最多等 10 分钟，避免超长任务挂住旧进程
  setTimeout(() => { log('drain timeout, force exit'); process.exit(0); }, 10 * 60 * 1000).unref();
}
