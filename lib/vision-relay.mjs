import {
  CaptionCache,
  createConcurrencyLimiter,
  mapWithConcurrency,
} from './vision-cache.mjs';
import { resolveTimeouts } from './transport.mjs';

const DEFAULT_PROMPT = 'Describe this image concisely (2-4 sentences) for a coding assistant that cannot see it.';

export function createVisionRelay(options) {
  const config = options.config;
  const proxy = options.proxy;
  const request = options.request;
  const getKey = options.getKey || (() => undefined);
  const log = options.log || (() => {});
  const concurrency = Math.max(1, Math.min(8, Number(config.concurrency) || 3));
  const maxImages = Math.max(1, Number(config.maxImagesPerRequest) || 8);
  const cache = new CaptionCache({
    maxEntries: config.cacheMaxEntries,
    maxBytes: config.cacheMaxBytes,
  });
  // 所有客户端共享进程级名额，缓存未命中的相同图片再共享一次真实调用。
  const limiter = createConcurrencyLimiter(concurrency);

  async function captionImage(imageUrl, signal) {
    return cache.getOrCreate(imageUrl, (sharedSignal) => limiter.run(async () => {
      const key = getKey(config.envKey);
      if (!key) throw new Error(`VISION_RELAY 环境变量 ${config.envKey} 未设置`);
      const body = JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: config.prompt || DEFAULT_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ] }],
        max_tokens: config.maxTokens || 300,
      });
      const response = await request({
        host: config.host,
        path: `${config.prefix}/chat/completions`,
        viaProxy: config.viaProxy === true,
        proxy,
        headers: { authorization: `Bearer ${key}` },
        body,
        signal: sharedSignal,
        timeouts: resolveTimeouts(options.timeouts, config.timeouts),
      });
      const parsed = JSON.parse(response.bodyText);
      const content = parsed.choices?.[0]?.message?.content;
      if (response.status !== 200 || !content) {
        throw new Error(`vision relay HTTP ${response.status}`);
      }
      return content;
    }, sharedSignal), { signal });
  }

  async function relayNonTextParts(body, signal) {
    if (!body || !Array.isArray(body.input)) return 0;
    let stripped = 0;
    let imageCount = 0;
    const relayParts = async (parts) => {
      if (!Array.isArray(parts)) return parts;
      // 真正的全局并发限制只包围缓存未命中的上游调用。
      return mapWithConcurrency(parts, concurrency, async (part) => {
        if (!(part && part.type === 'input_image')) return part;
        stripped += 1;
        imageCount += 1;
        if (imageCount > maxImages) {
          return { type: 'input_text', text: '[image omitted: per-request vision limit exceeded]' };
        }
        const imageUrl = typeof part.image_url === 'string'
          ? part.image_url
          : part.image_url?.url;
        try {
          const description = await captionImage(imageUrl, signal);
          log(`vision relay: captioned image (${description.length} chars)`);
          return { type: 'input_text', text: `[image description: ${description}]` };
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError') throw error;
          log('vision relay failed:', error.message);
          return { type: 'input_text', text: '[image omitted: vision relay failed]' };
        }
      }, { signal });
    };

    for (const item of body.input) {
      if (!item) continue;
      if (item.role === 'user' && Array.isArray(item.content)) {
        item.content = await relayParts(item.content);
      }
      if (Array.isArray(item.output)) {
        item.output = await relayParts(item.output);
      }
    }
    return stripped;
  }

  return { relayNonTextParts };
}
