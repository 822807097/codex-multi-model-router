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
import { updateModelCatalogFile } from './lib/model-catalog.mjs';
import { createVisionRelay } from './lib/vision-relay.mjs';
import { createResponsePipeline } from './lib/response-pipeline.mjs';
import { createOpenAiAuthManager } from './lib/openai-auth.mjs';
import { createChatRequestBuilder } from './lib/chat-request.mjs';
import { createRouterHandler } from './lib/router-handler.mjs';
import { createEnvKeySource } from './lib/env-key-source.mjs';
import { createAdminHandler } from './lib/admin-api.mjs';
import { readRevisionedJson } from './lib/json-file-store.mjs';
import { inspectModelCatalog } from './lib/model-routing-plan.mjs';
import { recoverModelRoutingTransaction } from './lib/model-routing-transaction.mjs';
import { createDiagnosticLog } from './lib/diagnostic-log.mjs';
import { createModelQuotaCooldownStore } from './lib/model-quota-cooldown.mjs';
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
    defaultCodexHome: path.join(os.homedir(), '.codex'),
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
// 让桌面端据此做滑动窗口/压缩，避免第三方模型每轮全量重发历史（卡思考根因）
function applyModelContext() {
  const mc = cfg.modelContext;
  if (!mc || mc.enabled === false) return;
  try {
    const result = updateModelCatalogFile(CATALOG_PATH, mc);
    if (result.changed) {
      log('modelContext: 已写回 models.json');
    }
  } catch (e) { log('modelContext: 应用失败', e.message); }
}

function readCheckedCatalog() {
  const catalog = readRevisionedJson(CATALOG_PATH, { maxBytes: MAX_CATALOG_BYTES }).value;
  const inspection = inspectModelCatalog(catalog);
  if (inspection.errors.length > 0) throw new Error('catalog invalid');
  return catalog;
}

// 写回前先封住非常规文件和非法结构；写回后再读取一次，后者才是本进程的活动 generation。
try {
  readCheckedCatalog();
} catch {
  process.stderr.write('[catalog] 模型目录启动预检失败（catalog_invalid）\n');
  process.exit(1);
}
applyModelContext();
let activeCatalog;
try {
  activeCatalog = readCheckedCatalog();
} catch {
  process.stderr.write('[catalog] 模型目录启动预检失败（catalog_invalid）\n');
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

// ---------- Responses SSE 生命周期 ----------
const {
  startResponsesSse,
  emitResponsesErrorSse,
  pipeNativeResponse,
  pipeChatResponse,
} = createResponsePipeline({ heartbeatMs: HEARTBEAT_MS, log });

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
const { get: getOpenAiAuth } = openAiAuth;

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
const adminHandler = createAdminHandler({
  configPath: CONFIG_PATH,
  catalogPath: CATALOG_PATH,
  webRoot: path.join(__dirname, 'web'),
  defaultCodexHome: path.join(os.homedir(), '.codex'),
  env: process.env,
  runtime: preparedConfig.runtime,
  targets: TARGETS,
  warnings: preparedConfig.warnings,
  startedAt: ROUTER_STARTED_AT,
  checkpointStore: goalCheckpoints,
  persistence: checkpointPersistence,
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
    maxRequestBytes: MAX_REQUEST_BYTES,
    proxy: V2RAY_PROXY,
    timeouts: ROUTER_TIMEOUTS,
    getOpenAiAuth,
    getKey: getEnvKey,
    refreshEnvKey: (name) => envKeySource.refreshNow(name),
    relayNonTextParts,
    buildChatRequest,
    startResponsesSse,
    emitResponsesErrorSse,
    pipeNativeResponse,
    pipeChatResponse,
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
server = http.createServer(routerHandler);

server.listen(PORT, '127.0.0.1', () => {
  log(`codex-router listening on 127.0.0.1:${PORT}`);
  log(`  config: ${CONFIG_PATH}`);
  log(`  proxy: ${V2RAY_PROXY.host}:${V2RAY_PROXY.port}`);
  log(`  targets: ${TARGETS.map((t) => t.name).join(', ')}`);
  log(`  vision relay: ${VISION_RELAY.model} @ ${VISION_RELAY.host}`);
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
  server.close(async () => {
    try { await checkpointPersistence.close(); } catch (error) {
      log('checkpoint persistence close failed:', error.message);
    }
    await Promise.all([diagnosticLog.flush(), contextDiagnosticLog.flush()]);
    log('在跑任务已排空，退出');
    process.exit(exitCode);
  });
  // 安全阀：最多等 10 分钟，避免超长任务挂住旧进程
  setTimeout(() => { log('drain timeout, force exit'); process.exit(exitCode); }, 10 * 60 * 1000).unref();
}

// ---------- 运维脚本的优雅停止通道 ----------
// Windows 无 POSIX 信号：scripts 的 stop/restart 通过控制台 Ctrl+C 事件触发 SIGINT；
// Linux/macOS 直接发送 SIGTERM。两者都走同一个排空流程，绝不直接强杀 Node。
process.on('SIGINT', () => gracefulExit(0));
process.on('SIGTERM', () => gracefulExit(0));
