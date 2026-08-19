import {
  CaptionCache,
  createConcurrencyLimiter,
  mapWithConcurrency,
} from './vision-cache.mjs';
import { resolveTimeouts } from './transport.mjs';

const DEFAULT_PROMPT = 'Describe this image concisely (2-4 sentences) for a coding assistant that cannot see it.';
// 端点额度冷却：429/额度类错误后冷却该端点，其余端点继续服务
const ENDPOINT_COOLDOWN_MS = 5 * 60_000;

function isQuotaFailure(error) {
  const message = String(error?.message || '');
  return /\b(?:quota|insufficient|limit|429|balance|exhausted)\b/i.test(message)
    || error?.status === 429;
}

/**
 * 视觉中继：支持多端点（多个平台/模型 API），单点额度耗尽自动切换。
 * - 端点 = 独立 host/prefix/model/envKey/代理；轮询起点选择，失败冷却 5 分钟
 * - 429/额度类错误只冷却该端点；网络错误/5xx 同样换下一个（不冷却或短冷却）
 * - 图片描述缓存按图片共享（首个成功结果），失败不污染缓存
 */
export function createVisionRelay(options) {
  const config = options.config;
  const proxy = options.proxy;
  const request = options.request;
  const getKey = options.getKey || (() => undefined);
  const log = options.log || (() => {});
  const now = options.now || Date.now;
  const concurrency = Math.max(1, Math.min(8, Number(config.concurrency) || 3));
  const maxImages = Math.max(1, Number(config.maxImagesPerRequest) || 8);
  const cache = new CaptionCache({
    maxEntries: config.cacheMaxEntries,
    maxBytes: config.cacheMaxBytes,
  });
  const limiter = createConcurrencyLimiter(concurrency);

  // 规范化端点列表：优先 endpoints 数组；兼容历史单条顶层配置
  const endpoints = normalizeEndpoints(config);
  const cooldownUntil = new Map(); // endpoint index -> retryAt
  let rrPointer = 0;

  function normalizeEndpoints(source) {
    if (Array.isArray(source.endpoints) && source.endpoints.length > 0) {
      return source.endpoints.map((endpoint) => ({
        host: endpoint.host,
        prefix: endpoint.prefix || '',
        protocol: endpoint.protocol || 'https',
        port: endpoint.port || undefined,
        model: endpoint.model,
        envKey: endpoint.envKey,
        viaProxy: endpoint.viaProxy === true || Boolean(endpoint.proxyUrl),
        proxyUrl: endpoint.proxyUrl || null,
        prompt: endpoint.prompt || source.prompt || DEFAULT_PROMPT,
        maxTokens: Number(endpoint.maxTokens) || Number(source.maxTokens) || 300,
        timeouts: endpoint.timeouts || source.timeouts,
      }));
    }
    return [{
      host: source.host,
      prefix: source.prefix || '',
      protocol: source.protocol || 'https',
      port: source.port || undefined,
      model: source.model,
      envKey: source.envKey,
      viaProxy: source.viaProxy === true || Boolean(source.proxyUrl),
      proxyUrl: source.proxyUrl || null,
      prompt: source.prompt || DEFAULT_PROMPT,
      maxTokens: Number(source.maxTokens) || 300,
      timeouts: source.timeouts,
    }];
  }

  async function captionWithEndpoint(endpoint, imageUrl, sharedSignal) {
    const key = getKey(endpoint.envKey);
    if (!key) throw new Error(`VISION_RELAY 环境变量 ${endpoint.envKey} 未设置`);
    const body = JSON.stringify({
      model: endpoint.model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: endpoint.prompt || DEFAULT_PROMPT },
        { type: 'image_url', image_url: { url: imageUrl } },
      ] }],
      max_tokens: endpoint.maxTokens || 300,
    });
    const response = await request({
      protocol: endpoint.protocol,
      host: endpoint.host,
      port: endpoint.port,
      path: `${endpoint.prefix}/chat/completions`,
      viaProxy: endpoint.viaProxy,
      proxy: endpoint.proxyUrl || proxy,
      headers: { authorization: `Bearer ${key}` },
      body,
      signal: sharedSignal,
      timeouts: resolveTimeouts(options.timeouts, endpoint.timeouts),
    });
    let parsed;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      parsed = null;
    }
    const content = parsed?.choices?.[0]?.message?.content;
    if (response.status !== 200 || !content) {
      const error = new Error(`vision relay ${endpoint.model} HTTP ${response.status}: ${String(response.bodyText || '').slice(0, 160)}`);
      error.status = response.status;
      throw error;
    }
    return content;
  }

  async function captionImage(imageUrl, signal) {
    return cache.getOrCreate(imageUrl, (sharedSignal) => limiter.run(async () => {
      const currentTime = now();
      // 轮询起点 + 跳过冷却端点；429/额度类失败冷却该端点后换下一个
      const start = endpoints.length > 0 ? (rrPointer % endpoints.length) : 0;
      rrPointer = (rrPointer + 1) % Math.max(1, endpoints.length);
      let lastError = null;
      for (let offset = 0; offset < endpoints.length; offset += 1) {
        const index = (start + offset) % endpoints.length;
        const endpoint = endpoints[index];
        if (endpoint === undefined || (cooldownUntil.get(index) || 0) > currentTime) continue;
        try {
          return await captionWithEndpoint(endpoint, imageUrl, sharedSignal);
        } catch (error) {
          if (sharedSignal?.aborted || error?.name === 'AbortError') throw error;
          lastError = error;
          if (isQuotaFailure(error)) {
            cooldownUntil.set(index, now() + ENDPOINT_COOLDOWN_MS);
            log(`vision relay: endpoint ${endpoint.model}@${endpoint.host} 额度冷却 5 分钟，切换下一端点`);
          } else {
            log(`vision relay: endpoint ${endpoint.model}@${endpoint.host} 失败（${error.message}），切换下一端点`);
          }
        }
      }
      throw lastError || new Error('所有视觉中继端点均不可用');
    }, sharedSignal), { signal });
  }

  async function relayNonTextParts(body, signal) {
    if (!body) return 0;
    let stripped = 0;
    let imageCount = 0;
    const relayParts = async (parts) => {
      if (!Array.isArray(parts)) return parts;
      // 真正的全局并发限制只包围缓存未命中的上游调用。
      return mapWithConcurrency(parts, concurrency, async (part) => {
        // responses 格式图片 = input_image；chat completions 格式图片 = image_url
        const isImage = part && (part.type === 'input_image' || part.type === 'image_url');
        if (!isImage) return part;
        stripped += 1;
        imageCount += 1;
        if (imageCount > maxImages) {
          return { type: part.type === 'image_url' ? 'text' : 'input_text', text: '[image omitted: per-request vision limit exceeded]' };
        }
        const imageUrl = typeof part.image_url === 'string'
          ? part.image_url
          : part.image_url?.url;
        try {
          const description = await captionImage(imageUrl, signal);
          log(`vision relay: captioned image (${description.length} chars)`);
          return { type: part.type === 'image_url' ? 'text' : 'input_text', text: `[image description: ${description}]` };
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          log('vision relay failed:', error.message);
          return { type: part.type === 'image_url' ? 'text' : 'input_text', text: '[image omitted: vision relay failed]' };
        }
      }, { signal });
    };

    // responses 格式：input 条目（user 消息的 content 数组 + 工具输出）
    if (Array.isArray(body.input)) {
      for (const item of body.input) {
        if (!item) continue;
        if (item.role === 'user' && Array.isArray(item.content)) {
          item.content = await relayParts(item.content);
        }
        if (Array.isArray(item.output)) {
          item.output = await relayParts(item.output);
        }
      }
    }
    // chat completions 透传格式：messages 条目（user/assistant 的 content 数组，含多模态）
    if (Array.isArray(body.messages)) {
      for (const item of body.messages) {
        if (!item || !Array.isArray(item.content)) continue;
        item.content = await relayParts(item.content);
      }
    }
    return stripped;
  }

  // 端点状态查询（供管理页展示：冷却中/可用）
  function endpointStatus() {
    const currentTime = now();
    return endpoints.map((endpoint, index) => ({
      model: endpoint.model,
      host: endpoint.host,
      cooldown: (cooldownUntil.get(index) || 0) > currentTime,
      cooldownUntil: cooldownUntil.get(index) || 0,
    }));
  }

  return { relayNonTextParts, endpointStatus };
}
