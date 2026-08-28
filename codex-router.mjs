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
//   转成文字描述再注入请求（vision:false 通道自动启用）。
//   启动时先执行聚合配置预检；错误在绑定端口前退出，警告不影响其他模型通道。
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
//   ROUTER_LOG          核心请求生命周期 JSONL 活动文件
//   ROUTER_CONTEXT_LOG  上下文维护 JSONL 活动文件（默认由 ROUTER_LOG 派生）
//   V2RAY_PORT          本地代理混合端口（默认 10808，仅 viaProxy 的通道使用）
//   各通道 key 见下方 TARGETS 的 envKey 字段
// ============================================================================
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoalCheckpointStore } from './lib/goal-checkpoint.mjs';
import { resolveOAuthViaProxy } from './lib/provider-adapters.mjs';
import { ProviderPool } from './lib/provider-pool.mjs';
import { ResponseToolHistoryStore } from './lib/response-history.mjs';
import { RequestBudget } from './lib/request-budget.mjs';
import { rawHttpsRequest } from './lib/transport.mjs';
import {
  RouterConfigError,
  formatConfigIssues,
  prepareRouterConfig,
} from './lib/router-config.mjs';
import { readModelCatalogFile, applyModelContextToCatalog } from './lib/model-catalog.mjs';
import { createVisionRelay } from './lib/vision-relay.mjs';
import { createResponsePipeline } from './lib/response-pipeline.mjs';
import { createOpenAiAuthManager } from './lib/openai-auth.mjs';
import { createChatRequestBuilder } from './lib/chat-request.mjs';
import { createRouterHandler } from './lib/router-handler.mjs';
import { createEnvKeySource } from './lib/env-key-source.mjs';
import { createAdminHandler } from './lib/admin-api.mjs';
import { createChannelKeyPool } from './lib/channel-key-pool.mjs';
import { readRevisionedJson } from './lib/json-file-store.mjs';
import { inspectModelCatalog } from './lib/model-routing-plan.mjs';
import { recoverModelRoutingTransaction } from './lib/model-routing-transaction.mjs';
import { createDiagnosticLog } from './lib/diagnostic-log.mjs';
import { createModelQuotaCooldownStore } from './lib/model-quota-cooldown.mjs';
import { createTokenTracker } from './lib/token-tracker.mjs';
import { createAuthManager } from './lib/auth/auth-manager.mjs';
import { generateOpenAIImages, generateSubscriptionImages, imageError, normalizeImageRequest, resolveOpenAIImageKey, imagesErrorBody } from './lib/imagebridge.mjs';
import { createCredentialsStore, createCredentialsVault } from './lib/auth/credentials-store.mjs';
import { refreshGoogleTokens } from './lib/auth/google-sub-auth.mjs';
import { refreshOpenAiTokens } from './lib/auth/openai-sub-auth.mjs';
import { refreshClaudeTokens } from './lib/auth/claude-sub-auth.mjs';
import { getDatabase, dbListAccounts, dbSaveAccount, dbRecordTokenLog, dbPruneTokenLogs } from './lib/db.mjs';
import { createApiKeyStore } from './lib/api-keys.mjs';
import {
  computeCheckpointNamespace,
  createCheckpointPersistence,
} from './lib/checkpoint-persistence.mjs';

// ---------- 加载配置 ----------
// config.json 与 codex-router.mjs 同目录，包含所有可修改参数
// 环境变量优先级高于 config.json（PORT/PROXY 等）；绑定端口前聚合报告全部可判定错误。
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.resolve(process.env.ROUTER_CONFIG_PATH || path.join(__dirname, 'config.json'));
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

// 固定 journal 的恢复必须先于配置正文解析；未知状态保持原样并在绑定端口前退出。
try {
  await recoverModelRoutingTransaction({ configPath: CONFIG_PATH });
} catch (error) {
  const code = error?.code === 'transaction_in_doubt'
    ? 'transaction_in_doubt'
    : 'transaction_failed';
  process.stderr.write(`[startup] 模型路由事务恢复失败（${code}）\n`);
  process.exit(1);
}

let rawConfig;
try {
  rawConfig = readRevisionedJson(CONFIG_PATH, { maxBytes: MAX_CONFIG_BYTES }).value;
} catch {
  const issue = {
    severity: 'error',
    code: 'config_json_invalid',
    path: '',
    message: '无法读取或解析路由配置 JSON',
  };
  process.stderr.write(`${formatConfigIssues([issue]).map((line) => `[config] ${line}`).join('\n')}\n`);
  process.exit(1);
}

let preparedConfig;
try {
  preparedConfig = prepareRouterConfig(rawConfig, {
    configPath: CONFIG_PATH,
    baseDir: path.dirname(CONFIG_PATH),
    // CODEX_HOME 优先（Codex 桌面端实际配置目录），回退 ~/.codex
    defaultCodexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    env: process.env,
  });
} catch (error) {
  if (!(error instanceof RouterConfigError)) throw error;
  process.stderr.write(`${formatConfigIssues(error.issues).map((line) => `[config] ${line}`).join('\n')}\n`);
  process.exit(1);
}

for (const line of formatConfigIssues(preparedConfig.warnings)) {
  console.warn(`[config] ${line}`);
}

const cfg = preparedConfig.config;
const {
  port: PORT,
  codexHome: CODEX_HOME,
  authPath: AUTH_PATH,
  catalogPath: CATALOG_PATH,
  proxy: V2RAY_PROXY,
  timeouts: ROUTER_TIMEOUTS,
  heartbeatMs: HEARTBEAT_MS,
  maxRequestBytes: MAX_REQUEST_BYTES,
  requestBudget: REQUEST_BUDGET,
  goalCheckpointPersistence: GOAL_CHECKPOINT_PERSISTENCE,
  oauth: ROUTER_OAUTH,
  visionRelay: VISION_RELAY,
  imageBridge: IMAGE_BRIDGE,
} = preparedConfig.runtime;
const CLIENT_ID = ROUTER_OAUTH.clientId;
const REFRESH_SKEW_SECONDS = ROUTER_OAUTH.refreshSkewSeconds;

// 路由规则：按请求体 model 字段收集所有匹配目标，优先使用会话粘性目标；失败时安全切换备用目标
// match: 正则字符串 | host: 上游域名 | prefix: 路径前缀
// viaProxy: true=经本地代理 CONNECT 隧道 | vision: false=文本模型走视觉中继
// envKey: API key 所在环境变量名（官方通道不用，走 auth.json）
// 所有规则已经过预检并按原顺序编译；非法规则会在服务监听前聚合退出。
const TARGETS = preparedConfig.targets;
const providerPool = new ProviderPool(TARGETS, cfg.providerPool);
const responseHistory = new ResponseToolHistoryStore(cfg.responseHistory);
const memoryGoalCheckpoints = new GoalCheckpointStore(cfg.goalCheckpoint);
const requestBudget = new RequestBudget(REQUEST_BUDGET);
const modelQuotaCooldown = createModelQuotaCooldownStore();
const ROUTER_STARTED_AT = Date.now();

// ---------- 视觉中继配置 ----------
// 文本模型 (vision:false) 收到 input_image 时，调用这里配置的视觉模型生成描述
// 配置项见 config.json 的 visionRelay 字段

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
// 诊断日志（可选）：ROUTER_LOG 指向活动 JSONL 文件；模块负责顺序异步写入、
// UTC 每日轮转、50MB 兜底轮转及超过 72 小时的归档清理。
const LOG_FILE = process.env.ROUTER_LOG || null;
const diagnosticLog = createDiagnosticLog({ filePath: LOG_FILE });
const parsedLogPath = LOG_FILE ? path.parse(LOG_FILE) : null;
const CONTEXT_LOG_FILE = process.env.ROUTER_CONTEXT_LOG || (parsedLogPath
  ? path.join(
      parsedLogPath.dir,
      `${parsedLogPath.name}-context${parsedLogPath.ext || '.log'}`,
    )
  : null);
const contextDiagnosticLog = createDiagnosticLog({ filePath: CONTEXT_LOG_FILE });
const flog = (event) => {
  const eventName = event && typeof event === 'object' ? event.event : '';
  if (typeof eventName === 'string' && /^(?:context|history)\./.test(eventName)) {
    contextDiagnosticLog.write(event);
    return;
  }
  diagnosticLog.write(event);
};

// ---------- envKey 热更新源 ----------
// 进程环境是启动快照；Windows 下 setx 写入注册表后运行中的进程看不到新值。
// 上游返回 401/429（认证失效/额度耗尽）时路由会触发 refreshNow 刷新，
// 同名变量值变化则用新 key 自动重试——换 key 无需重启路由（正常请求零开销）。
const envKeySource = createEnvKeySource({
  log: (name) => flog({ event: 'envkey.reloaded', key_name: name }),
});
const getEnvKey = (name) => envKeySource.getKey(name);

// ---------- 进程级致命异常 ----------
// 未知异常可能已经破坏共享状态，不能记录后假装健康；停止接收新请求并排空已有连接。
let server = null;
function handleFatalProcessError(kind, error) {
  log(`${kind}:`, error?.stack || error?.message || String(error));
  if (!server) {
    process.exitCode = 1;
    return;
  }
  gracefulExit(1);
}
process.on('uncaughtException', (error) => handleFatalProcessError('uncaughtException', error));
process.on('unhandledRejection', (error) => handleFatalProcessError('unhandledRejection', error));

// ---------- 模型上下文窗口配置 ----------
// config.json 的 modelContext 字段：路由启动时把上下文窗口/压缩阈值写回 models.json，
// 让桌面端据此做滑动窗口/压缩，避免第三方模型每轮全量重发历史（卡思考根因）。
// 目录整个启动过程只读一次：内存中应用变更、有变更才写盘，快照复用同一对象。
let activeCatalog;
try {
  const catalog = readModelCatalogFile(CATALOG_PATH, { maxBytes: MAX_CATALOG_BYTES });
  const inspection = inspectModelCatalog(catalog);
  if (inspection.errors.length > 0) throw new Error('catalog invalid');
  const mc = cfg.modelContext;
  if (mc && mc.enabled !== false) {
    const result = applyModelContextToCatalog(catalog, mc);
    if (result.changed) {
      const tmp = `${CATALOG_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(result.catalog, null, 2));
      fs.renameSync(tmp, CATALOG_PATH);
      log('modelContext: 已写回 models.json');
      activeCatalog = result.catalog;
    } else {
      activeCatalog = catalog;
    }
  } else {
    activeCatalog = catalog;
  }
} catch (error) {
  process.stderr.write(`[catalog] 模型目录启动预检失败（catalog_invalid）：${error.message}\n`);
  process.exit(1);
}

// ---------- 视觉中继实现 ----------
// 密钥、网络和日志全部由入口注入；模块本身不读取进程环境或全局配置。
const { relayNonTextParts } = createVisionRelay({
  config: VISION_RELAY,
  proxy: V2RAY_PROXY,
  timeouts: ROUTER_TIMEOUTS,
  getKey: getEnvKey,
  request: rawHttpsRequest,
  log,
});

// ---------- Token 用量追踪器（总量与模型明细监控） ----------
// 每条真实使用记录同时写入 SQLite token_logs，Dashboard 统计从此表读取（真实调用数据）
const tokenTracker = createTokenTracker({
  storagePath: path.join(path.dirname(CONFIG_PATH), 'token-usage.json'),
  onRecord: (record) => {
    try { dbRecordTokenLog(record); } catch { /* 统计旁路不得影响路由请求 */ }
  },
});
// token_logs 只增不缩：启动时清理超过保留期的记录，防止 router.db 无限膨胀
//（Dashboard 统计窗口远小于 90 天，不影响任何展示）。
try {
  dbPruneTokenLogs(90 * 24 * 60 * 60 * 1000);
} catch (error) {
  log('token_logs retention sweep failed:', error.message);
}

// ---------- Sub2API 订阅账号管理器 ----------
// SQLite accounts 表是账号元数据的权威来源；OAuth 凭据存独立 vault 文件。
// 两者启动时合并载入 authManager，授权成功后由 admin API 同步写回。
const credentialsStore = createCredentialsStore({
  persistPath: path.join(path.dirname(CONFIG_PATH), 'accounts.json'),
});
const credentialsVault = createCredentialsVault({
  vaultPath: path.join(path.dirname(CONFIG_PATH), 'credentials-vault.json'),
});
const authManager = createAuthManager({
  // 账号冷却/恢复时间持久化到 SQLite：重启后不复活已用尽账号（额度限制不再反复打断任务）
  onAccountPersist: (acc) => {
    try {
      dbSaveAccount({
        id: acc.id,
        provider: acc.provider,
        email: acc.email,
        alias: acc.alias,
        status: acc.status,
        proxy_enabled: acc.proxy?.enabled === true,
        proxy_url: acc.proxy?.url || '',
        quota_used: acc.quota?.used || 0,
        quota_limit: acc.quota?.limit || 100,
        resets_at: acc.quota?.resetsAt || 0,
        metadata: acc.metadata || {},
        cooldown_until: acc.cooldownUntil || 0,
      });
    } catch { /* 持久化失败不影响主流程 */ }
  },
});
// 恢复顺序：先脱敏 accounts.json（历史遗留），再以 SQLite 为准覆盖合并 vault 凭据。
try {
  for (const acc of credentialsStore.loadAccounts()) authManager.addAccount(acc);
} catch { /* 容错 */ }
try {
  // loadAll 已归一为「accountId -> 凭据」纯 map（含历史损坏文件兼容修复）
  const vaultAll = credentialsVault.loadAll();
  for (const row of dbListAccounts()) {
    let metadata = {};
    try { metadata = row.metadata ? JSON.parse(row.metadata) : {}; } catch { /* 容错 */ }
    authManager.addAccount({
      id: row.id,
      provider: row.provider,
      alias: row.alias,
      email: row.email || '',
      status: row.status || 'active',
      cooldownUntil: row.cooldownUntil || 0,
      credentials: vaultAll[row.id] || {},
      proxy: {
        enabled: row.proxyEnabled ?? true,
        url: row.proxyUrl || '',
      },
      quota: {
        used: row.quotaUsed || 0,
        limit: row.quotaLimit || 100,
        resetsAt: row.resetsAt || 0,
      },
      metadata,
    });
  }
} catch (err) {
  console.warn(`[accounts] 从 SQLite 恢复订阅账号失败: ${err.message}`);
}

// ---------- 订阅账号 Token 自动续期（google / openai / claude） ----------
// 账号级代理优先；未单独配置的账号走全局代理（出海通道）。
function resolveAccountProxy(account) {
  if (account?.proxy?.enabled && account?.proxy?.url) return account.proxy.url;
  return V2RAY_PROXY;
}
authManager.registerRefresher('google', async ({ account }) => {
  const tokens = await refreshGoogleTokens({
    refreshToken: account.credentials.refreshToken,
    proxy: resolveAccountProxy(account),
  });
  return {
    credentials: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    expiresAt: Date.now() + Math.max(60, tokens.expiresIn - 300) * 1000,
  };
});
authManager.registerRefresher('openai', async ({ account }) => {
  const tokens = await refreshOpenAiTokens({
    refreshToken: account.credentials.refreshToken,
    proxy: resolveAccountProxy(account),
  });
  return {
    credentials: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
    },
    expiresAt: Date.now() + Math.max(60, tokens.expiresIn - 300) * 1000,
  };
});
authManager.registerRefresher('claude', async ({ account }) => {
  const tokens = await refreshClaudeTokens({
    refreshToken: account.credentials.refreshToken,
    proxy: resolveAccountProxy(account),
  });
  return {
    credentials: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    expiresAt: Date.now() + Math.max(60, tokens.expiresIn - 300) * 1000,
  };
});
// 刷新得到的新 token 立即写回 vault（重启后凭据不丢）——上游 OAuth 可能轮换 refresh_token，
// 只在内存持有的话重启后旧 refresh_token 失效会导致账号静默不可用。
authManager.onCredentialsRefreshed((accountId, credentials) => {
  try {
    credentialsVault.set(accountId, credentials);
  } catch { /* vault 写入失败不影响本次请求继续使用内存凭据 */ }
});

// ---------- Responses SSE 生命周期 ----------
const {
  startResponsesSse,
  emitResponsesErrorSse,
  pipeNativeResponse,
  pipeChatResponse,
  pipeChatCompletionsResponse,
  pipeResponsesToChatResponse,
} = createResponsePipeline({ heartbeatMs: HEARTBEAT_MS, log, tokenTracker });

// ---------- ChatGPT 登录态：读 auth.json，临期自动 refresh 并原子写回 ----------
const openAiAuth = createOpenAiAuthManager({
  authPath: AUTH_PATH,
  clientId: CLIENT_ID,
  refreshSkewSeconds: REFRESH_SKEW_SECONDS,
  oauthConfig: cfg.oauth,
  timeouts: ROUTER_TIMEOUTS,
  proxy: V2RAY_PROXY,
  resolveViaProxy: resolveOAuthViaProxy,
  request: rawHttpsRequest,
  log,
});
// 每次走 ChatGPT 官方通道的请求都记一次账号额度使用（本地 5 小时窗口统计；
// 上游未提供公开额度接口，此计数是「真实使用量」而非占位假数据）
const getOpenAiAuth = async (target) => {
  const auth = await openAiAuth.get(target);
  if (auth?.accountId) {
    const account = authManager.findByMetadataField?.('chatgptAccountId', auth.accountId);
    if (account) authManager.recordQuotaUsage(account.id, 1);
  }
  return auth;
};

// ---------- 长任务检查点冷重启持久化 ----------
// 默认关闭；启用时只保存已哈希索引和九栏目摘要，不保存请求历史或任何凭据原值。
const checkpointNamespace = GOAL_CHECKPOINT_PERSISTENCE.enabled
  ? computeCheckpointNamespace({
      stateGeneration: GOAL_CHECKPOINT_PERSISTENCE.stateGeneration,
      targets: TARGETS,
      getKey: getEnvKey,
      accountId: openAiAuth.identity().accountId,
    })
  : '';
const checkpointPersistence = createCheckpointPersistence({
  store: memoryGoalCheckpoints,
  config: GOAL_CHECKPOINT_PERSISTENCE,
  namespace: checkpointNamespace,
  log,
});
const goalCheckpoints = checkpointPersistence.store;

const { buildChatRequest } = createChatRequestBuilder({
  config: cfg,
  goalCheckpoints,
  proxy: V2RAY_PROXY,
  request: rawHttpsRequest,
  flog,
});

// ---------- 本地管理页 ----------
// 只绑定在同一个 127.0.0.1 服务上；页面不接收或展示任何密钥，也不负责进程启停。
const apiKeyStore = createApiKeyStore({ db: getDatabase() });
// 通道密钥池：同通道多账号 key（双形态/优先级），key 级冷却持久化；env_ref 经 envKeySource 热更新解析
const keyPool = createChannelKeyPool({ db: getDatabase(), envKeySource, log });

const adminHandler = createAdminHandler({
  configPath: CONFIG_PATH,
  catalogPath: CATALOG_PATH,
  codexHome: CODEX_HOME,
  webRoot: path.join(__dirname, 'web'),
  defaultCodexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  env: process.env,
  runtime: preparedConfig.runtime,
  targets: TARGETS,
  warnings: preparedConfig.warnings,
  startedAt: ROUTER_STARTED_AT,
  checkpointStore: goalCheckpoints,
  persistence: checkpointPersistence,
  tokenTracker,
  authManager,
  credentialsVault,
  apiKeyStore,
  oauthProxy: V2RAY_PROXY,
  // 通道模型列表拉取与路由请求共用 envKey 热更新源（注册表轮换后无需重启即可拉取）
  getKey: getEnvKey,
  // 通道密钥池（管理端点与路由请求共用同一实例）
  keyPool,
  // 官方登录态通道的连通性测试：用已绑定账号的 token（含额度计数）
  getOpenAiAuth,
  // 模型连通性探测经本机回环走完整路由管线，需要知道自身监听端口
  port: PORT,
});

let routerHandler;
try {
  routerHandler = createRouterHandler({
    config: cfg,
    targets: TARGETS,
    catalog: activeCatalog,
    catalogPath: CATALOG_PATH,
    providerPool,
    responseHistory,
    goalCheckpoints,
    requestBudget,
    modelQuotaCooldown,
    apiKeyStore,
    maxRequestBytes: MAX_REQUEST_BYTES,
    proxy: V2RAY_PROXY,
    timeouts: ROUTER_TIMEOUTS,
    getOpenAiAuth,
    // 桌面端登录态身份（只读 account_id）：官方通道兜底前的同账号冷却守卫用。
    getOpenAiIdentity: () => openAiAuth.identity(),
    getKey: getEnvKey,
    refreshEnvKey: (name) => envKeySource.refreshNow(name),
    keyPool,
    authManager,
    // 用量统计兜底：官方通道 usage 帧缺失时按请求体量估算记入 token_logs，
    // 让「周额度烧在哪」可度量（估算口径 ~4 字节/token × 0.75 JSON 开销折扣）
    onRequestFinished: (diag, { bodyBytes, target, model } = {}) => {
      try {
        if (target !== 'openai' || !(Number(bodyBytes) > 0)) return;
        // 管道已记录真实 usage 帧时不再叠加估算，避免官方通道用量双计
        if (diag?.usageRecorded) return;
        const estimatedInput = Math.round((Number(bodyBytes) / 4) * 0.75);
        if (!(estimatedInput > 0)) return;
        tokenTracker.recordUsage({
          model: typeof model === 'string' && model ? model : 'gpt-5.6-sol',
          target: 'openai',
          inputTokens: estimatedInput,
          outputTokens: 0,
        });
      } catch { /* 统计旁路不得影响请求 */ }
    },
    relayNonTextParts,
    buildChatRequest,
    startResponsesSse,
    emitResponsesErrorSse,
    pipeNativeResponse,
    pipeChatResponse,
    pipeChatCompletionsResponse,
    pipeResponsesToChatResponse,
    adminHandler,
    log,
    flog,
    // 仅隔离测试显式开启关闭端点；正常实例的管理页不提供进程控制。
    onShutdown: process.env.ROUTER_TEST_SHUTDOWN === '1' ? gracefulExit : undefined,
  });
} catch {
  process.stderr.write('[catalog] 模型目录启动快照失败（catalog_snapshot_invalid）\n');
  process.exit(1);
}
server = http.createServer((clientReq, clientRes) => {
  const pathname = (clientReq.url || '/').split('?')[0];
  // 外部图像生成桥接（OpenAI 兼容，独立于主路由管线）。
  // 图片端点在主处理器之前分发，必须执行与 /v1/* 相同的 API key 门控：
  // 存在未吊销 key 时强制鉴权，否则任何本地进程都能烧订阅生图额度。
  if (clientReq.method === 'POST' && (pathname === '/v1/images/generations' || pathname === '/images/generations')) {
    if (!imageRequestAuthorized(clientReq, clientRes)) return;
    handleImageRequest(clientReq, clientRes, 'generate');
    return;
  }
  if (clientReq.method === 'POST' && (pathname === '/v1/images/edits' || pathname === '/images/edits')) {
    if (!imageRequestAuthorized(clientReq, clientRes)) return;
    handleImageRequest(clientReq, clientRes, 'edit');
    return;
  }
  routerHandler(clientReq, clientRes);
});

// 与 routerHandler 同一套 API key 门控（多工具客户端：Bearer 或 x-api-key）。
function imageRequestAuthorized(req, res) {
  if (!apiKeyStore || typeof apiKeyStore.hasKeys !== 'function' || !apiKeyStore.hasKeys()) return true;
  const authHeader = String(req.headers.authorization || '');
  const xApiKey = String(req.headers['x-api-key'] || '');
  let providedKey = '';
  if (authHeader.startsWith('Bearer ')) providedKey = authHeader.slice(7).trim();
  else if (xApiKey) providedKey = xApiKey.trim();
  if (apiKeyStore.verifyKey(providedKey)) return true;
  if (!res.headersSent) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        code: 'invalid_api_key',
        message: '未提供有效的 API Key。请在路由管理面板创建 Key 并配置到客户端（Authorization: Bearer <key> 或 x-api-key: <key>）',
      },
    }));
  }
  return false;
}

// 读取小体积 JSON 请求体（图片请求体可能含 base64 编辑图，8MB 上限足够）。
function readSmallJsonBody(req, res, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = (error, value) => {
      clean();
      resolve(error ? { error } : { value });
    };
    const clean = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        req.destroy();
        done(Object.assign(new Error('request body too large'), { status: 413, code: 'request_body_too_large' }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        done(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        done(Object.assign(new Error('invalid JSON body'), { status: 400, code: 'invalid_json' }));
      }
    };
    const onError = () => done(Object.assign(new Error('request read error'), { status: 400, code: 'json_read_failed' }));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

// ---------- ChatGPT 订阅账号生图（对齐 sub2api：Responses + image_generation 工具） ----------
// 订阅 token 打平台 /v1/images/generations 会被上游 401；订阅账号额度只能经
// /v1/responses 使用（Codex CLI 同款官方通道）。因此认证优先序与文本通道一致：
// 订阅账号池 → auth.json 登录态（含额度计数）→ 平台 API key 兜底。
const OPENAI_TARGET = TARGETS.find((target) => target.name === 'openai') || null;

async function resolveSubscriptionImageToken() {
  // 订阅账号优先（多账号轮换、额度耗尽自动切换、token 自动刷新）。
  // 注意：图片模型不在各套餐的 Codex 模型清单里，按模型过滤会选不中任何账号，
  // 生图是订阅套餐能力而非清单模型，因此只按 provider 轮换账号。
  if (authManager && typeof authManager.acquireAccount === 'function') {
    try {
      const account = authManager.acquireAccount({ provider: 'openai' });
      if (account) {
        const creds = await authManager.getValidCredentials(account.id);
        if (creds?.accessToken) return creds.accessToken;
      }
    } catch {
      // 账号刷新失败：回退桌面端登录态，避免生图被卡死
    }
  }
  try {
    const auth = await getOpenAiAuth(OPENAI_TARGET);
    return auth?.token || '';
  } catch {
    return '';
  }
}

function recordImageUsage(payload) {
  try {
    const estimatedInput = Math.round(((typeof payload.prompt === 'string' ? payload.prompt.length : 0) / 4) * 0.75);
    tokenTracker.recordUsage({
      model: typeof payload.model === 'string' && payload.model ? payload.model : 'gpt-image-2',
      target: 'openai',
      inputTokens: estimatedInput > 0 ? estimatedInput : 1,
      outputTokens: 0,
    });
  } catch { /* 统计旁路不得影响请求 */ }
}

// 客户端中断后 res 已销毁：任何写响应的操作都必须跳过，否则
// ERR_STREAM_DESTROYED 会升级成 uncaughtException 触发整进程重启。
function respondImageError(res, status, error) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(imagesErrorBody(error)));
}

// 对外暴露 OpenAI 兼容图像接口；订阅账号优先，未配置时给出可读错误。
async function handleImageRequest(req, res, action) {
  // 客户端取消时中止上游生图（订阅额度按张计费，没人接收的图不能继续烧）。
  const imageAbort = new AbortController();
  req.once('aborted', () => imageAbort.abort());
  req.once('error', () => imageAbort.abort());
  res.once('close', () => {
    if (!res.writableEnded) imageAbort.abort();
  });
  const parsed = await readSmallJsonBody(req, res);
  if (parsed.error) {
    respondImageError(res, parsed.error.status || 400, parsed.error);
    return;
  }
  let payload;
  try {
    payload = normalizeImageRequest(parsed.value, { action });
  } catch (error) {
    respondImageError(res, error.status || 400, error);
    return;
  }
  try {
    // 订阅通道（ChatGPT 账号额度生图）：/v1/responses + image_generation
    if (IMAGE_BRIDGE.enabled !== false) {
      const token = await resolveSubscriptionImageToken();
      if (token) {
        const result = await generateSubscriptionImages({
          token,
          payload,
          config: IMAGE_BRIDGE,
          proxy: V2RAY_PROXY,
          viaProxy: IMAGE_BRIDGE.viaProxy === false ? false : true,
          signal: imageAbort.signal,
        });
        recordImageUsage(payload);
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', created: result.created, data: result.data }));
        return;
      }
    }
    // 平台密钥兜底（OPENAI_IMAGE_API_KEY / OPENAI_API_KEY，官方 /v1/images/generations）
    const keyToken = resolveOpenAIImageKey();
    if (!keyToken) {
      throw imageError(401, 'invalid_request_error', 'image_provider_unconfigured',
        '未配置 ChatGPT 订阅账号登录态（auth.json / 订阅账号）或 OpenAI 图片 API 密钥（OPENAI_IMAGE_API_KEY / OPENAI_API_KEY）');
    }
    const result = await generateOpenAIImages({
      authToken: keyToken,
      payload,
      proxy: V2RAY_PROXY,
      signal: imageAbort.signal,
    });
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', created: result.created, data: result.data }));
  } catch (error) {
    if (imageAbort.signal.aborted || res.destroyed) {
      res.destroy();
      return;
    }
    respondImageError(res, error.status || 502, error);
  }
}

server.listen(PORT, '127.0.0.1', () => {
  log(`codex-router listening on 127.0.0.1:${PORT}`);
  log(`  config: ${CONFIG_PATH}`);
  log(`  proxy: ${V2RAY_PROXY.host}:${V2RAY_PROXY.port}`);
  log(`  targets: ${TARGETS.map((t) => t.name).join(', ')}`);
  log(`  vision relay: ${VISION_RELAY.model} @ ${VISION_RELAY.host}`);
  log(`  image bridge: ${IMAGE_BRIDGE.enabled === false ? 'platform-key only' : `subscription @ ${IMAGE_BRIDGE.host}${IMAGE_BRIDGE.prefix}/responses (${IMAGE_BRIDGE.conversationModel})`}`);
  log(`  checkpoint persistence: ${checkpointPersistence.status().mode}`);
});

// ---------- 无感更新：优雅退出 ----------
// server.close() 会立即释放监听端口（新进程可马上接管），但保留已有连接直到结束。
// closeIdleConnections() 关掉空闲 keep-alive 连接，让 close 能完成；在跑的流式任务自然结束。
let shuttingDown = false;
function gracefulExit(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('graceful shutdown: 释放端口，排空在跑任务');
  try { server.closeIdleConnections(); } catch { /* 旧版 Node 无此方法 */ }
  try {
    server.close(async () => {
      try { await checkpointPersistence.close(); } catch (error) {
        log('checkpoint persistence close failed:', error.message);
      }
      await Promise.all([diagnosticLog.flush(), contextDiagnosticLog.flush()]);
      log('在跑任务已排空，退出');
      process.exit(exitCode);
    });
  } catch {
    // 启动早期尚未 listen：无连接可排空，直接退出（避免 close 抛 ERR_SERVER_NOT_RUNNING 绕过优雅流程）
    process.exit(exitCode);
  }
  // 安全阀：最多等 10 分钟，避免超长任务挂住旧进程
  setTimeout(() => { log('drain timeout, force exit'); process.exit(exitCode); }, 10 * 60 * 1000).unref();
}

// ---------- 运维脚本的优雅停止通道 ----------
// Windows 无 POSIX 信号：scripts 的 stop/restart 通过控制台 Ctrl+C 事件触发 SIGINT；
// Linux/macOS 直接发送 SIGTERM。两者都走同一个排空流程，绝不直接强杀 Node。
process.on('SIGINT', () => gracefulExit(0));
process.on('SIGTERM', () => gracefulExit(0));
