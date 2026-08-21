import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeImageRequest,
  resolveOpenAIImageKey,
  generateOpenAIImages,
  imagesErrorBody,
  OPENAI_IMAGES_UPSTREAM,
} from '../lib/imagebridge.mjs';

test('normalizeImageRequest 以 OpenAI 契约为默认值补全', () => {
  const out = normalizeImageRequest({ prompt: '  一只红猫  ' });
  assert.equal(out.model, 'gpt-image-2');
  assert.equal(out.n, 1);
  assert.equal(out.size, '1024x1024');
  assert.equal(out.prompt, '一只红猫');
  const custom = normalizeImageRequest({
    prompt: 'x', model: 'gpt-image-1', n: 4, size: '512x512', quality: 'high', response_format: 'b64_json',
  });
  assert.equal(custom.model, 'gpt-image-1');
  assert.equal(custom.n, 4);
  assert.equal(custom.quality, 'high');
  assert.equal(custom.response_format, 'b64_json');
});

test('normalizeImageRequest 拒绝非法输入', () => {
  assert.throws(() => normalizeImageRequest(null), (e) => e.code === 'invalid_json');
  assert.throws(() => normalizeImageRequest({}), (e) => e.code === 'prompt_required');
  assert.throws(() => normalizeImageRequest({ prompt: '  ' }), (e) => e.code === 'prompt_required');
  assert.throws(() => normalizeImageRequest({ prompt: 'x', n: 0 }), (e) => e.code === 'invalid_n');
  assert.throws(() => normalizeImageRequest({ prompt: 'x', n: 11 }), (e) => e.code === 'invalid_n');
  assert.throws(() => normalizeImageRequest({ prompt: 'x', n: 2.5 }), (e) => e.code === 'invalid_n');
});

test('generateOpenAIImages 无密钥时返回可读 401 桥接错误', async () => {
  await assert.rejects(
    generateOpenAIImages({ apiKey: '', payload: { model: 'gpt-image-2', prompt: 'p', n: 1 } }),
    (e) => e.code === 'image_provider_unconfigured' && e.status === 401,
  );
});

test('generateOpenAIImages 请求组装命中 OpenAI 上游并为 Bearer 鉴权', async () => {
  let captured = null;
  const fake = async (request) => {
    captured = request;
    return { status: 200, bodyText: JSON.stringify({ created: 123, data: [{ b64_json: 'AAAA' }] }) };
  };
  const payload = { model: 'gpt-image-2', prompt: 'p', n: 1, size: '1024x1024' };
  const result = await generateOpenAIImages({ apiKey: 'sk-test', payload, viaProxy: true, requestFn: fake });
  assert.equal(result.created, 123);
  assert.equal(result.data[0].b64_json, 'AAAA');
  assert.equal(captured.protocol, OPENAI_IMAGES_UPSTREAM.protocol);
  assert.equal(captured.host, OPENAI_IMAGES_UPSTREAM.host);
  assert.equal(captured.path, OPENAI_IMAGES_UPSTREAM.path);
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.authorization, 'Bearer sk-test');
  assert.equal(captured.viaProxy, true);
  assert.deepEqual(JSON.parse(captured.body), payload);
});

test('generateOpenAIImages 映射上游 402/429/401 到可读错误', async () => {
  const stub = (status) => async () => ({ status, bodyText: '{}' });
  await assert.rejects(generateOpenAIImages({ apiKey: 'sk', payload: { prompt: 'p' }, requestFn: stub(402) }),
    (e) => e.code === 'image_insufficient_balance' && e.status === 402);
  await assert.rejects(generateOpenAIImages({ apiKey: 'sk', payload: { prompt: 'p' }, requestFn: stub(429) }),
    (e) => e.code === 'image_rate_limited');
  await assert.rejects(generateOpenAIImages({ apiKey: 'sk', payload: { prompt: 'p' }, requestFn: stub(401) }),
    (e) => e.code === 'image_credentials_invalid');
  await assert.rejects(generateOpenAIImages({ apiKey: 'sk', payload: { prompt: 'p' }, requestFn: stub(500) }),
    (e) => e.code === 'image_upstream_error' && e.status === 502);
});

test('imagesErrorBody 输出 OpenAI 兼容错误结构', () => {
  const body = imagesErrorBody({ status: 401, code: 'image_provider_unconfigured', message: '未配置密钥', errorType: 'invalid_request_error' });
  assert.equal(body.error.code, 'image_provider_unconfigured');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.param, null);
  assert.equal(imagesErrorBody(new Error('boom')).error.code, 'image_internal_error');
});

test('resolveOpenAIImageKey 与 env 联动（不依赖真实密钥）', () => {
  const prev1 = process.env.OPENAI_IMAGE_API_KEY;
  const prev2 = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_IMAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(resolveOpenAIImageKey(), '');
  process.env.OPENAI_IMAGE_API_KEY = 'k1';
  assert.equal(resolveOpenAIImageKey(), 'k1');
  delete process.env.OPENAI_IMAGE_API_KEY;
  process.env.OPENAI_API_KEY = 'k2';
  assert.equal(resolveOpenAIImageKey(), 'k2');
  if (prev1 !== undefined) process.env.OPENAI_IMAGE_API_KEY = prev1;
  if (prev2 !== undefined) process.env.OPENAI_API_KEY = prev2;
});
