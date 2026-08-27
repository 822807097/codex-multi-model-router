// 外部图像生成桥接（对齐 sub2api 的 OpenAI 生图上游）。
// 两条上游通道：
// 1. 订阅通道（ChatGPT 订阅账号 OAuth token）：把 /v1/images/* 请求翻译成
//    POST {host}/v1/responses + image_generation 工具（stream SSE）。
//    这是 ChatGPT 订阅 token 唯一被官方接受的生图方式（对齐 sub2api
//    buildOpenAIImagesResponsesRequest：tool_choice/image_generation、
//    OpenAI-Beta: responses=experimental、Accept: text/event-stream）。
//    图片资产从 SSE 的 image_generation_call.result 解析：data URL 直出，
//    file-service:// 与 https:// 指针经白名单校验后带 Bearer 下载。
// 2. 平台密钥通道：POST https://api.openai.com/v1/images/generations
//    （仅接受平台 API key；订阅 token 打这里会被上游 401）。
// 密钥只从环境变量或登录态读取（OPENAI_IMAGE_API_KEY 优先，回退 OPENAI_API_KEY；
// 订阅 token 来自 auth.json / 订阅账号凭据），源码与测试不写可用凭据字面量。
import net from 'node:net';
import { rawHttpsRequest, openHttpsStream } from './transport.mjs';
import { createSseDecoder } from './sse-decoder.mjs';

export const OPENAI_IMAGES_UPSTREAM = Object.freeze({
  protocol: 'https',
  host: 'api.openai.com',
  path: '/v1/images/generations',
});

// 订阅通道默认上游：api.openai.com/v1/responses（host/prefix 可经 imageBridge 配置覆盖）
export const IMAGE_RESPONSES_DEFAULTS = Object.freeze({
  host: 'api.openai.com',
  prefix: '/v1',
  conversationModel: 'gpt-5.4-mini',
  timeouts: {
    connectMs: 15_000,
    responseHeaderMs: 120_000,
    streamIdleMs: 600_000,
    requestMs: 600_000,
  },
});

const MAX_RESPONSES_SSE_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;

// 图片资产只允许从 OpenAI 官域下载；拒绝 IP 字面量（覆盖环回/私有/保留地址）与
// localhost 及 .local/.internal/.lan 后缀主机名（Mimosa：发请求前校验 host）。
const ASSET_ALLOW_HOSTS = Object.freeze([
  'chatgpt.com',
  'api.openai.com',
  'openai.com',
  'oaiusercontent.com',
  'oaistatic.com',
]);

/** 公开主机名校验：非空、非 IP 字面量、非 localhost/内网后缀（供配置预检复用）。 */
export function isSafePublicHostname(host = '') {
  const normalized = String(host).trim().toLowerCase();
  if (!normalized || /[\r\n\s]/.test(normalized)) return false;
  if (normalized === 'localhost' || /\.(?:local|internal|lan)$/.test(normalized)) return false;
  if (net.isIP(normalized)) return false;
  return normalized.includes('.');
}

/** 图片资产下载白名单：仅放行 OpenAI 官域（含子域）的 http/https URL。 */
export function assertAllowedImageAssetUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (!isSafePublicHostname(url.hostname)) return false;
  const host = url.hostname.toLowerCase();
  return ASSET_ALLOW_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

export function resolveOpenAIImageKey() {
  return process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY || '';
}

/** 从 ChatGPT 登录态（auth.json OAuth token）解析生图 Bearer 值；未登录返回空串。 */
export async function resolveChatGptImageToken(getOpenAiAuth) {
  try {
    const auth = await getOpenAiAuth();
    return auth?.token || '';
  } catch {
    return '';
  }
}

export function imageError(status, type, code, message) {
  const error = new Error(message);
  error.status = status;
  error.errorType = type;
  error.code = code;
  return error;
}

/**
 * 校验并规范化 /v1/images/generations 与 /v1/images/edits 请求体。
 * 与 OpenAI 官方契约一致：prompt 必填，n ∈ [1,10]，size 默认 1024x1024；
 * edit 必须携带 image（URL 或 data URL），mask 可选。
 * options.action = 'edit' | 'generate'（默认 generate）。
 */
export function normalizeImageRequest(body, options = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw imageError(400, 'invalid_request_error', 'invalid_json', '请求体必须是 JSON 对象');
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw imageError(400, 'invalid_request_error', 'prompt_required', '缺少 prompt 参数');
  const n = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw imageError(400, 'invalid_request_error', 'invalid_n', 'n 必须是 1-10 的整数');
  }
  const action = options.action === 'edit' ? 'edit' : 'generate';
  const payload = {
    action,
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'gpt-image-2',
    prompt,
    n,
  };
  payload.size = typeof body.size === 'string' && body.size.trim() ? body.size.trim() : '1024x1024';
  for (const key of ['quality', 'response_format', 'output_format', 'background', 'moderation', 'style']) {
    if (typeof body[key] === 'string' && body[key].trim()) payload[key] = body[key].trim();
  }
  if (action === 'edit') {
    const image = typeof body.image === 'string' ? body.image.trim() : '';
    if (!image) {
      throw imageError(400, 'invalid_request_error', 'image_required', 'edit 请求缺少 image 参数');
    }
    payload.image = image;
    if (typeof body.mask === 'string' && body.mask.trim()) payload.mask = body.mask.trim();
  } else if (typeof body.image === 'string' && body.image.trim()) {
    // 生图请求带参考图时同样送入 input_image，由上游决定是否采纳。
    payload.image = body.image.trim();
    if (typeof body.mask === 'string' && body.mask.trim()) payload.mask = body.mask.trim();
  }
  if (/^dall-e-3$/i.test(payload.model) && payload.n > 1) {
    throw imageError(400, 'invalid_request_error', 'invalid_n', 'dall-e-3 仅支持 n=1（官方限制，请改用 gpt-image 系列生成多图）');
  }
  return payload;
}

// 订阅通道的图片请求翻译：/v1/images/* → /v1/responses + image_generation 工具。
// 对齐 sub2api buildOpenAIImagesResponsesRequest：主对话模型承载生图工具，
// 工具体携带图片模型与生成参数；编辑图/蒙版以 input_image 形式送入。
export function buildResponsesImageRequest(parsed, options = {}) {
  const conversationModel = options.conversationModel || IMAGE_RESPONSES_DEFAULTS.conversationModel;
  const inputParts = [{ type: 'input_text', text: parsed.prompt }];
  if (parsed.image) inputParts.push({ type: 'input_image', image_url: parsed.image });
  const tool = {
    type: 'image_generation',
    action: parsed.action === 'edit' ? 'edit' : 'generate',
    model: parsed.model,
  };
  if (parsed.n > 1 && !/^dall-e-3$/i.test(parsed.model)) tool.n = parsed.n;
  for (const field of ['size', 'quality', 'background', 'output_format', 'moderation', 'style']) {
    if (typeof parsed[field] === 'string' && parsed[field].trim()) tool[field] = parsed[field].trim();
  }
  if (parsed.mask) {
    tool.input_image_mask = { image_url: parsed.mask };
    // 蒙版图是编辑轮廓，不重复送入消息正文（与 sub2api 一致）。
  }
  return {
    model: conversationModel,
    instructions: '',
    stream: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    store: false,
    tool_choice: { type: 'image_generation' },
    input: [{ type: 'message', role: 'user', content: inputParts }],
    tools: [tool],
  };
}

function imagePointerId(raw, prefix) {
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : '';
}

// SSE 正文中的资产指针扫描（对齐 sub2api openAIImagePointerMatches）：
// 结果可能以 data URL / file-service:// / sediment:// / https:// 任意形态出现。
function collectImagePointers(bodyText) {
  const pointers = [];
  const seen = new Set();
  for (const prefix of ['file-service://', 'sediment://']) {
    let cursor = 0;
    for (;;) {
      const index = bodyText.indexOf(prefix, cursor);
      if (index === -1) break;
      let end = index + prefix.length;
      while (end < bodyText.length && /[A-Za-z0-9_-]/.test(bodyText[end])) end += 1;
      const pointer = bodyText.slice(index, end);
      if (!seen.has(pointer)) {
        seen.add(pointer);
        pointers.push(pointer);
      }
      cursor = end;
    }
  }
  // data URL 资产直出
  const dataRe = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
  for (const match of bodyText.match(dataRe) || []) {
    if (!seen.has(match)) {
      seen.add(match);
      pointers.push(match);
    }
  }
  return pointers;
}

function revisedPromptFromBody(bodyText) {
  const match = /"revised_prompt"\s*:\s*"([^"]*)"/.exec(bodyText);
  return match ? match[1] : '';
}

function base64FromDataUrl(result) {
  const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(result || '');
  return match ? match[1] : '';
}

/**
 * 解析 /v1/responses SSE 正文，提取图片产出。
 * 结果条目：{ result, b64Json?, revisedPrompt?, format?, size?, quality?, background? }。
 * 按 image_generation_call 条目优先；条目缺失时回退正文指针扫描（sub2api 同款兜底）。
 */
export function parseImageResponsesSse(bodyText, options = {}) {
  const sawImages = options.sawImages || (() => false);
  const images = [];
  const seenIds = new Set();
  let createdAt = 0;
  let error = null;
  let finished = false;

  const decoder = createSseDecoder({ maxEventBytes: MAX_RESPONSES_SSE_BYTES });
  let events = [];
  try {
    events = decoder.push(Buffer.from(String(bodyText || ''), 'utf8'));
    events = events.concat(decoder.finish());
  } catch (decodeError) {
    return { images: [], createdAt, finished: false, error: decodeError };
  }

  const addResult = (item, id) => {
    const result = typeof item.result === 'string' ? item.result.trim() : '';
    if (!result) return;
    const key = id || `${result}:${item.revised_prompt || ''}`;
    if (seenIds.has(key)) return;
    seenIds.add(key);
    const entry = {
      result,
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : '',
    };
    for (const field of ['output_format', 'size', 'quality', 'background']) {
      if (typeof item[field] === 'string' && item[field]) entry[field] = item[field];
    }
    const b64 = base64FromDataUrl(result);
    if (b64) entry.b64Json = b64;
    images.push(entry);
  };

  for (const event of events) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    const type = data.type || event.event;
    if (type === 'error') {
      const message = data.message || data.error?.message || '上游返回错误事件';
      error = imageError(502, 'api_error', 'image_upstream_error', `图片上游错误：${message}`);
      continue;
    }
    if (type === 'response.failed') {
      const message = data.response?.error?.message || data.response?.status || '响应失败';
      error = imageError(502, 'api_error', 'image_upstream_error', `图片上游响应失败：${message}`);
      continue;
    }
    if (type === 'response.output_item.done') {
      const item = data.item;
      if (item?.type === 'image_generation_call' || item?.type === 'output_image') {
        addResult(item, item.id);
      }
      continue;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      // incomplete 同样是合法终态（content_filter/max_output_tokens 截断），
      // 已产出的图片照常返回；只把它排除在「截断错误」判定之外。
      finished = true;
      createdAt = Number(data.response?.created_at) || 0;
      if (Array.isArray(data.response?.output)) {
        for (const item of data.response.output) {
          if (item.type === 'image_generation_call' || item.type === 'output_image') {
            addResult(item, item.id);
          }
        }
      }
      if (error) break;
    }
  }

  // output_item.done 未携带 result 的空实现（部分形态只在最终条目带结果）：
  // 回退扫描整段正文的资产指针，避免只靠条目形状漏图。
  if (!images.length && !error) {
    for (const pointer of collectImagePointers(String(bodyText || ''))) {
      addResult({ result: pointer }, pointer);
    }
    const revised = revisedPromptFromBody(String(bodyText || ''));
    if (revised && images.length) {
      for (const entry of images) if (!entry.revisedPrompt) entry.revisedPrompt = revised;
    }
  }

  if (!images.length && !error && sawImages()) {
    error = imageError(502, 'api_error', 'image_no_output', '上游未返回图片输出，请重试');
  }
  return { images, createdAt, finished, error };
}

function pickConversationId(headers = {}) {
  for (const key of ['conversation_id', 'x-conversation-id', 'openai-conversation-id']) {
    if (typeof headers[key] === 'string' && headers[key]) return headers[key];
  }
  return '';
}

// 二进制资产下载（GET，带 Bearer），按字节收集并强制上限。
// 跟随最多 3 次 3xx 重定向（目标仍须过白名单；官方文件端点可能 302 到签名 CDN）。
async function downloadAssetBytes(url, options = {}, redirectDepth = 0) {
  const { token, proxy, viaProxy, requestFn = openHttpsStream, signal, maxBytes = MAX_ASSET_BYTES } = options;
  if (!assertAllowedImageAssetUrl(url)) {
    throw imageError(400, 'invalid_request_error', 'image_asset_host_denied',
      `图片资产域不在白名单：${url.slice(0, 120)}`);
  }
  const parsed = new URL(url);
  const opened = await requestFn({
    protocol: parsed.protocol === 'http:' ? 'http' : 'https',
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method: 'GET',
    viaProxy,
    proxy,
    signal,
    headers: { authorization: `Bearer ${token}` },
    timeouts: IMAGE_RESPONSES_DEFAULTS.timeouts,
  });
  const status = Number(opened.status) || 0;
  if (status >= 300 && status < 400) {
    const rawLocation = opened.headers?.location;
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
    opened.socket?.destroy();
    if (redirectDepth >= 3 || typeof location !== 'string' || !location.trim()) {
      throw imageError(502, 'api_error', 'image_asset_http_error', `图片资产重定向异常（HTTP ${status}）`);
    }
    return downloadAssetBytes(new URL(location.trim(), url).toString(), options, redirectDepth + 1);
  }
  assertAssetHttpOk(opened, '');
  const chunks = [];
  let total = 0;
  for await (const chunk of opened.stream) {
    total += chunk.length;
    if (total > maxBytes) {
      opened.socket?.destroy();
      throw imageError(502, 'api_error', 'image_asset_too_large', `图片资产超过 ${maxBytes} 字节`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 资产请求返回流形状（openHttpsStream）；状态码非 2xx 时销毁连接并抛出可读错误，
// 避免把 403/404 的错误页当图片字节回传给客户端。
function assertAssetHttpOk(opened, what) {
  const status = Number(opened?.status) || 0;
  if (status < 200 || status >= 300) {
    opened?.socket?.destroy();
    throw imageError(502, 'api_error', 'image_asset_http_error', `图片资产${what}下载失败（HTTP ${status}）`);
  }
}

const MAX_METADATA_BYTES = 1024 * 1024;

// 元信息（download_url JSON）读取：同样强制字节上限，防止异常端点拖垮内存。
async function readMetadataJson(opened) {
  const chunks = [];
  let total = 0;
  for await (const chunk of opened.stream) {
    total += chunk.length;
    if (total > MAX_METADATA_BYTES) {
      opened.socket?.destroy();
      throw imageError(502, 'api_error', 'image_asset_metadata_too_large', `图片资产元信息超过 ${MAX_METADATA_BYTES} 字节`);
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// file-service://<id> → backend-api/files 取 {download_url} → 下载
// sediment://<attachmentId> → conversation 附件端点取 {download_url} → 下载
async function resolvePointerBytes(pointer, { token, proxy, viaProxy, requestFn = openHttpsStream, signal, conversationId }) {
  if (pointer.startsWith('file-service://')) {
    const fileId = imagePointerId(pointer, 'file-service://');
    if (!fileId) throw imageError(502, 'api_error', 'image_asset_pointer_invalid', '图片资产指针缺少 file id');
    const opened = await requestFn({
      protocol: 'https',
      host: 'chatgpt.com',
      path: `/backend-api/files/${encodeURIComponent(fileId)}/download`,
      method: 'GET',
      viaProxy,
      proxy,
      signal,
      headers: { authorization: `Bearer ${token}` },
      timeouts: IMAGE_RESPONSES_DEFAULTS.timeouts,
    });
    assertAssetHttpOk(opened, '元信息');
    let meta = {};
    try {
      meta = await readMetadataJson(opened);
    } catch (error) {
      if (error?.status && error?.code) throw error;
      throw imageError(502, 'api_error', 'image_asset_pointer_failed', '图片资产元信息解析失败');
    }
    const downloadUrl = typeof meta.download_url === 'string' ? meta.download_url : '';
    if (!downloadUrl) {
      throw imageError(502, 'api_error', 'image_asset_pointer_failed', '图片资产未返回 download_url');
    }
    return downloadAssetBytes(downloadUrl, { token, proxy, viaProxy, requestFn, signal });
  }
  if (pointer.startsWith('sediment://')) {
    const attachmentId = imagePointerId(pointer, 'sediment://');
    if (!attachmentId || !conversationId) {
      throw imageError(502, 'api_error', 'image_asset_pointer_invalid',
        'sediment 图片资产缺少会话上下文，请重试生成');
    }
    const opened = await requestFn({
      protocol: 'https',
      host: 'chatgpt.com',
      path: `/backend-api/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(attachmentId)}/download`,
      method: 'GET',
      viaProxy,
      proxy,
      signal,
      headers: { authorization: `Bearer ${token}` },
      timeouts: IMAGE_RESPONSES_DEFAULTS.timeouts,
    });
    assertAssetHttpOk(opened, '元信息');
    let meta = {};
    try {
      meta = await readMetadataJson(opened);
    } catch (error) {
      if (error?.status && error?.code) throw error;
      throw imageError(502, 'api_error', 'image_asset_pointer_failed', '图片资产元信息解析失败');
    }
    const downloadUrl = typeof meta.download_url === 'string' ? meta.download_url : '';
    if (!downloadUrl) {
      throw imageError(502, 'api_error', 'image_asset_pointer_failed', '图片资产未返回 download_url');
    }
    return downloadAssetBytes(downloadUrl, { token, proxy, viaProxy, requestFn, signal });
  }
  throw imageError(502, 'api_error', 'image_asset_pointer_invalid', `无法识别的图片资产引用：${pointer.slice(0, 64)}`);
}

/** 把单条图片产出解析为字节：data URL 直解；https/file-service/sediment 指针下载。 */
export async function resolveImageAssetBytes(result, options = {}) {
  const b64 = base64FromDataUrl(result);
  if (b64) return Buffer.from(b64, 'base64');
  if (/^https?:\/\//i.test(result)) return downloadAssetBytes(result, options);
  if (result.startsWith('file-service://') || result.startsWith('sediment://')) {
    return resolvePointerBytes(result, options);
  }
  throw imageError(502, 'api_error', 'image_asset_pointer_invalid', `无法识别的图片资产引用：${String(result).slice(0, 64)}`);
}

function mapUpstreamStatus(status, bodyText, channel) {
  const text = String(bodyText || '');
  switch (status) {
    case 401:
    case 403:
      return imageError(status, 'invalid_request_error', 'image_credentials_invalid',
        channel === 'subscription'
          ? 'ChatGPT 订阅账号生图被上游拒绝（401/403）：请检查账号登录态与订阅套餐是否包含图片模型'
          : 'OpenAI 图片 API 密钥无效（401/403），请检查 OPENAI_IMAGE_API_KEY');
    case 402:
      return imageError(402, 'insufficient_quota', 'image_insufficient_balance',
        '上游生图额度不足（402 Insufficient Balance），请检查订阅额度或平台余额');
    case 429:
      return imageError(429, 'rate_limit_error', 'image_rate_limited',
        '上游生图限流（429），请稍后重试');
    case 400:
      return imageError(400, 'invalid_request_error', 'image_invalid_request', `图片请求被上游拒绝（400）：${text.slice(0, 160)}`);
    default: {
      // 200/0（代理错误页、响应体畸形等）绝不能以 200 状态抛出——调用方
      // error.status || 502 拦不住 truthy 的 200，客户端会收到「装着错误体的成功响应」。
      const mapped = status >= 400 && status < 500 ? status : 502;
      return imageError(mapped, 'api_error', 'image_upstream_error',
        `图片上游错误（HTTP ${status}）：${text.slice(0, 160)}`);
    }
  }
}

/**
 * 订阅通道生图：Responses + image_generation（ChatGPT 订阅 token 的官方通道）。
 * token 为 Bearer 值（订阅账号 access token 或 auth.json 登录态）。
 * 返回 OpenAI 兼容 { created, data: [{ b64_json, revised_prompt? }] }。
 */
export async function generateSubscriptionImages({
  token,
  payload,
  config = {},
  proxy,
  viaProxy = true,
  requestFn = rawHttpsRequest,
  // 资产回源必须用流形状（openHttpsStream）；requestFn 是一次性聚合形状
  // （{status, headers, bodyText}），此前误把它传给资产下载导致指针回源必崩。
  assetRequestFn = openHttpsStream,
  signal,
} = {}) {
  if (!token) {
    throw imageError(401, 'invalid_request_error', 'image_provider_unconfigured',
      '未配置 ChatGPT 订阅账号登录态或订阅账号凭据，无法走订阅生图通道');
  }
  if (payload?.response_format === 'url') {
    throw imageError(400, 'invalid_request_error', 'image_response_format_unsupported',
      '订阅生图通道仅支持 response_format=b64_json（订阅通道不签发公开 URL）');
  }
  const host = config.host || IMAGE_RESPONSES_DEFAULTS.host;
  const prefix = config.prefix || IMAGE_RESPONSES_DEFAULTS.prefix;
  const conversationModel = config.conversationModel || IMAGE_RESPONSES_DEFAULTS.conversationModel;
  const requestBody = buildResponsesImageRequest(payload, { conversationModel });
  const response = await requestFn({
    protocol: 'https',
    host,
    path: `${prefix}/responses`,
    method: 'POST',
    viaProxy,
    proxy,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'openai-beta': 'responses=experimental',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(requestBody),
    signal,
    timeouts: { ...IMAGE_RESPONSES_DEFAULTS.timeouts, ...(config.timeouts || {}) },
    maxResponseBytes: MAX_RESPONSES_SSE_BYTES,
  });
  const status = Number(response.status) || 0;
  if (status !== 200) throw mapUpstreamStatus(status, response.bodyText, 'subscription');

  const bodyText = String(response.bodyText || '');
  const sawImageBytes = () => /image_generation_call|output_image|file-service:\/\/|sediment:\/\/|data:image\//.test(bodyText);
  const parsed = parseImageResponsesSse(bodyText, { sawImages: sawImageBytes });
  if (parsed.error) throw parsed.error;
  // 流被截断（TLS 中断、代理断连）：没有 response.completed 终态时按错误处理，
  // 不能把「n=3 只拿到 1 张」当成功静默返回。
  if (!parsed.finished) {
    throw imageError(502, 'api_error', 'image_stream_truncated',
      '上游生图流在完成前中断（已收图片数可能不足 n），请重试');
  }
  if (!parsed.images.length) {
    throw imageError(502, 'api_error', 'image_no_output', '上游未返回图片输出，请重试');
  }

  const conversationId = pickConversationId(response.headers);
  const data = [];
  for (const image of parsed.images) {
    let bytes;
    if (image.b64Json) {
      bytes = Buffer.from(image.b64Json, 'base64');
    } else {
      bytes = await resolveImageAssetBytes(image.result, {
        token,
        proxy,
        viaProxy,
        requestFn: assetRequestFn,
        signal,
        conversationId,
      });
    }
    const entry = { b64_json: bytes.toString('base64') };
    if (image.revisedPrompt) entry.revised_prompt = image.revisedPrompt;
    data.push(entry);
  }
  return { created: parsed.createdAt || Math.floor(Date.now() / 1000), data };
}

/**
 * 平台密钥通道：调用 OpenAI 平台 /v1/images/generations。
 * authToken 为 Bearer 值（平台 API key；订阅 token 打该端点会被上游 401）。
 * @returns {Promise<{created:number, data:Array<{b64_json?:string, url?:string, revised_prompt?:string}>}>}
 */
export async function generateOpenAIImages({ authToken, payload, proxy, viaProxy = true, requestFn = rawHttpsRequest, signal } = {}) {
  if (!authToken) {
    throw imageError(401, 'invalid_request_error', 'image_provider_unconfigured',
      '未配置 ChatGPT 账号登录态（auth.json）或 OpenAI 图片 API 密钥（OPENAI_IMAGE_API_KEY / OPENAI_API_KEY）');
  }
  const body = JSON.stringify(payload);
  const response = await requestFn({
    ...OPENAI_IMAGES_UPSTREAM,
    method: 'POST',
    viaProxy,
    proxy,
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${authToken}`,
    },
    body,
    timeouts: { connectMs: 15_000, responseHeaderMs: 120_000, requestMs: 300_000 },
    maxResponseBytes: 32 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(response.bodyText || '{}');
  } catch {
    parsed = null;
  }
  const status = Number(response.status) || 0;
  if (status !== 200 || !parsed || !Array.isArray(parsed.data)) {
    throw mapUpstreamStatus(status, response.bodyText);
  }
  return { created: Number(parsed.created) || Math.floor(Date.now() / 1000), data: parsed.data };
}

/** 把桥接错误转成 OpenAI 兼容的响应体。 */
export function imagesErrorBody(error) {
  if (error && error.status && error.code) {
    return {
      error: {
        message: error.message,
        type: error.errorType || 'invalid_request_error',
        code: error.code,
        param: null,
      },
    };
  }
  return { error: { message: error?.message || 'unknown error', type: 'api_error', code: 'image_internal_error', param: null } };
}