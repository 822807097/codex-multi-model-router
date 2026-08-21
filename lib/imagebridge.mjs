// 外部图像生成桥接（对齐 sub2api 的 OpenAI 生图上游）。
// 对外暴露 OpenAI 兼容的 POST /v1/images/generations，上游走
// https://api.openai.com/v1/images/generations（模型 gpt-image-2，按张计费）。
// 密钥只从环境变量读取（OPENAI_IMAGE_API_KEY 优先，回退 OPENAI_API_KEY）；
// 未配置时返回可读错误，配置后即可出图（后续可扩展 Gemini/Grok 账号额度路径）。
import { rawHttpsRequest } from './transport.mjs';

export const OPENAI_IMAGES_UPSTREAM = Object.freeze({
  protocol: 'https',
  host: 'api.openai.com',
  path: '/v1/images/generations',
});

export function resolveOpenAIImageKey() {
  return process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY || '';
}

export function imageError(status, type, code, message) {
  const error = new Error(message);
  error.status = status;
  error.errorType = type;
  error.code = code;
  return error;
}

/**
 * 校验并规范化 /v1/images/generations 请求体为上游 payload。
 * 与 OpenAI 官方契约一致：prompt 必填，n ∈ [1,10]，size 默认 1024x1024。
 */
export function normalizeImageRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw imageError(400, 'invalid_request_error', 'invalid_json', '请求体必须是 JSON 对象');
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw imageError(400, 'invalid_request_error', 'prompt_required', '缺少 prompt 参数');
  const n = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw imageError(400, 'invalid_request_error', 'invalid_n', 'n 必须是 1-10 的整数');
  }
  const payload = {
    model: typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'gpt-image-2',
    prompt,
    n,
  };
  payload.size = typeof body.size === 'string' && body.size.trim() ? body.size.trim() : '1024x1024';
  for (const key of ['quality', 'response_format']) {
    if (typeof body[key] === 'string' && body[key].trim()) payload[key] = body[key].trim();
  }
  return payload;
}

function mapUpstreamStatus(status, bodyText) {
  const text = String(bodyText || '');
  switch (status) {
    case 401:
    case 403:
      return imageError(status, 'invalid_request_error', 'image_credentials_invalid',
        'OpenAI 图片 API 密钥无效（401/403），请检查 OPENAI_IMAGE_API_KEY');
    case 402:
      return imageError(402, 'insufficient_quota', 'image_insufficient_balance',
        'OpenAI 图片 API 余额不足（402 Insufficient Balance），请充值后再试');
    case 429:
      return imageError(429, 'rate_limit_error', 'image_rate_limited',
        'OpenAI 图片 API 限流（429），请稍后重试');
    case 400:
      return imageError(400, 'invalid_request_error', 'image_invalid_request', `图片请求被上游拒绝（400）：${text.slice(0, 160)}`);
    default:
      return imageError(status >= 500 ? 502 : status, 'api_error', 'image_upstream_error',
        `图片上游错误（HTTP ${status}）：${text.slice(0, 160)}`);
  }
}

/**
 * 调用 OpenAI 平台 /v1/images/generations。
 * @returns {Promise<{created:number, data:Array<{b64_json?:string, url?:string, revised_prompt?:string}>}>}
 */
export async function generateOpenAIImages({ apiKey, payload, proxy, viaProxy = true, requestFn = rawHttpsRequest } = {}) {
  if (!apiKey) {
    throw imageError(401, 'invalid_request_error', 'image_provider_unconfigured',
      '未配置 OpenAI 图片 API 密钥（环境变量 OPENAI_IMAGE_API_KEY 或 OPENAI_API_KEY）');
  }
  const body = JSON.stringify(payload);
  const response = await requestFn({
    ...OPENAI_IMAGES_UPSTREAM,
    method: 'POST',
    viaProxy,
    proxy,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
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
