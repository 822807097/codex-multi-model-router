import { createHash } from 'node:crypto';

// ---------- 路由认证、请求头与跨协议输入策略 ----------

const BASE_FORWARD_HEADERS = new Set(['accept', 'user-agent']);
const CHATGPT_FORWARD_HEADERS = new Set(['openai-beta', 'originator']);
const NEVER_FORWARD_HEADERS = new Set([
  'authorization', 'x-api-key', 'cookie', 'set-cookie', 'host',
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-length', 'content-type', 'content-encoding',
  'chatgpt-account-id', 'x-codex-session-id',
]);

// 名称和 platform 只描述通道，不能隐式授予读取 ChatGPT 登录态的权限。
export function isChatGptBackend(target = {}) {
  return target.useOpenAiAuth === true;
}

export function forwardRequestHeaders(clientHeaders = {}, target = {}) {
  const allowed = new Set(BASE_FORWARD_HEADERS);
  if (isChatGptBackend(target)) {
    for (const name of CHATGPT_FORWARD_HEADERS) allowed.add(name);
  }
  for (const name of Array.isArray(target.forwardHeaders) ? target.forwardHeaders : []) {
    const normalized = String(name).toLowerCase();
    if (!NEVER_FORWARD_HEADERS.has(normalized)) allowed.add(normalized);
  }

  const result = {};
  for (const [name, value] of Object.entries(clientHeaders)) {
    const normalized = name.toLowerCase();
    if (allowed.has(normalized) && value !== undefined) result[normalized] = value;
  }
  result['accept-encoding'] = 'identity';
  return result;
}

export function mergeGeneratedHeaders(baseHeaders = {}, generatedHeaders = {}, protectedNames = null) {
  // HTTP 头名大小写不敏感；先删除所有受保护旧值，再让当前目标生成的凭据唯一写入。
  const protectedSet = new Set((protectedNames || Object.keys(generatedHeaders))
    .map((name) => String(name).toLowerCase()));
  const result = {};
  for (const [name, value] of Object.entries(baseHeaders)) {
    const normalized = name.toLowerCase();
    if (!protectedSet.has(normalized) && value !== undefined) result[normalized] = value;
  }
  for (const [name, value] of Object.entries(generatedHeaders)) {
    if (value !== undefined) result[name.toLowerCase()] = value;
  }
  return result;
}

function staticHeadersStateDigest(target, authHeader) {
  const headers = target.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return '';

  // 路由生成的认证信息会覆盖静态配置，不应让无效旧值拆分状态域。
  const excludedNames = target.useOpenAiAuth === true
    ? new Set(['authorization', 'chatgpt-account-id'])
    : new Set([authHeader]);

  // HTTP 头名大小写不敏感；同名配置按对象遍历顺序由后者覆盖，并在摘要前排序。
  const normalizedHeaders = new Map();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const normalizedName = name.toLowerCase();
    if (excludedNames.has(normalizedName)) continue;
    const normalizedValue = Array.isArray(value)
      ? ['array', value.map((item) => String(item))]
      : ['scalar', String(value)];
    normalizedHeaders.set(normalizedName, normalizedValue);
  }
  if (normalizedHeaders.size === 0) return '';

  const serialized = JSON.stringify([...normalizedHeaders.entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256')
    .update('codex-router:static-headers:v1\0')
    .update(serialized)
    .digest('hex');
}

export function upstreamStateDomain(target = {}, provider = {}) {
  // previous_response_id/cache key 属于具体上游身份；仅显式同域或完整端点+认证身份一致时共享。
  const wireApi = provider.wireApi || target.wireApi || 'responses';
  const explicit = typeof target.stateDomain === 'string' ? target.stateDomain.trim() : '';
  // 显式共享只能跨同一种 wire API；Chat 与 Responses 的私有状态语义永远不能直接互通。
  if (explicit) return `explicit:${JSON.stringify([wireApi, explicit])}`;
  const protocol = target.protocol || 'https';
  const rawPort = target.port || (protocol === 'http' ? 80 : 443);
  const numericPort = Number(rawPort);
  const port = Number.isFinite(numericPort) ? numericPort : String(rawPort);
  const authType = String(provider.authType || target.authType || 'bearer');
  const authHeader = String(
    provider.authHeader
      || target.authHeader
      || (authType === 'x-api-key' ? 'x-api-key' : 'authorization'),
  ).toLowerCase();
  const credential = target.useOpenAiAuth === true
    ? 'openai-auth'
    : `${authType}:${authHeader}:${target.envKey || ''}`;
  // 请求拼接会移除 prefix 尾斜杠；状态域必须采用同一规范，避免等价端点被误判跨域。
  const prefix = String(target.prefix || '').replace(/\/+$/, '');
  const staticHeadersDigest = staticHeadersStateDigest(target, authHeader);
  return JSON.stringify([
    wireApi,
    protocol,
    String(target.host || '').toLowerCase(),
    port,
    prefix,
    credential,
    staticHeadersDigest,
  ]);
}

export function hasStandaloneConversationInput(body = {}) {
  if (!Array.isArray(body.input)) return false;
  const meaningful = body.input.filter(Boolean);
  if (meaningful.length < 2) return false;
  const callTypes = new Set(['function_call', 'custom_tool_call', 'tool_search_call']);
  const outputTypes = new Set(['function_call_output', 'custom_tool_call_output', 'tool_search_output']);
  const callIds = new Set(meaningful
    .filter((item) => callTypes.has(item?.type) && item.call_id)
    .map((item) => item.call_id));
  if (meaningful.some((item) => outputTypes.has(item?.type) && callIds.has(item.call_id))) return true;

  // 完整对话至少要从用户输入开始形成一轮；仅有 assistant + 最新 user 仍是缺失前文的尾段。
  const userIndexes = meaningful
    .map((item, index) => item?.role === 'user' ? index : -1)
    .filter((index) => index >= 0);
  if (userIndexes.length >= 2) return true;
  if (userIndexes.length !== 1) return false;
  return meaningful.some((item, index) => item?.role === 'assistant' && index > userIndexes[0]);
}
