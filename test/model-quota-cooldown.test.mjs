import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createModelQuotaCooldownStore,
  isExplicitLongQuota,
  parsedQuotaError,
  retryAtFromMessageText,
} from '../lib/model-quota-cooldown.mjs';

test('任意供应商明确的长期套餐额度 429 建立模型级冷却且不保存上游正文', () => {
  let now = Date.parse('2026-08-13T12:00:00Z');
  const store = createModelQuotaCooldownStore({ now: () => now });
  const bodyText = JSON.stringify({
    error: {
      type: 'GoUsageLimitError',
      message: '5-hour usage limit reached; secret=must-not-be-retained',
    },
  });

  const observed = store.observe({
    target: 'opencode-go',
    model: 'model-a',
    status: 429,
    headers: { 'retry-after': '120' },
    bodyText,
  });

  assert.deepEqual(observed, {
    code: 'model_quota_cooldown',
    retryAt: now + 120_000,
    retryAfterSeconds: 120,
  });
  assert.deepEqual(store.get('opencode-go', 'model-a'), observed);
  assert.equal(JSON.stringify(store).includes('must-not-be-retained'), false);
  assert.equal(store.get('opencode-go', 'gpt-5.6-sol'), null);
  assert.equal(store.get('another-target', 'model-a'), null);

  now += 120_000;
  assert.equal(store.get('opencode-go', 'model-a'), null);
});

test('识别供应商无关的明确配额错误码但排除瞬时 rate limit', () => {
  const store = createModelQuotaCooldownStore({ now: () => 1_000 });

  for (const [index, error] of [
    { code: 'insufficient_quota', message: 'You exceeded your current quota' },
    { type: 'usage_limit_reached', message: 'Account usage limit reached' },
    { code: 'billing_hard_limit_reached', message: 'Monthly spend limit exhausted' },
    { code: 'plan_quota_exhausted', message: 'Plan allowance exhausted' },
  ].entries()) {
    assert.ok(store.observe({
      target: `provider-${index}`,
      model: `model-${index}`,
      status: 429,
      bodyText: JSON.stringify({ error }),
    }));
  }

  assert.equal(store.observe({
    target: 'transient', model: 'busy-model', status: 429,
    headers: { 'retry-after': '30' },
    bodyText: '{"error":{"code":"rate_limit_exceeded","message":"requests per minute exceeded"}}',
  }), null);
});

test('普通瞬时 429 和非 429 不建立长期冷却', () => {
  const store = createModelQuotaCooldownStore({ now: () => 1_000 });

  assert.equal(store.observe({
    target: 'provider', model: 'model', status: 429,
    headers: { 'retry-after': '60' },
    bodyText: '{"error":{"message":"rate limit exceeded"}}',
  }), null);
  assert.equal(store.observe({
    target: 'provider', model: 'model', status: 503,
    bodyText: '{"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached"}}',
  }), null);
  assert.equal(store.get('provider', 'model'), null);
});

test('JSON 非错误字段中的额度字样不能误触发冷却', () => {
  const store = createModelQuotaCooldownStore({ now: () => 1_000 });
  assert.equal(store.observe({
    target: 'provider', model: 'model', status: 429,
    bodyText: JSON.stringify({
      error: { code: 'rate_limit_exceeded', message: 'requests per minute exceeded' },
      echoed_prompt: '请解释 insufficient_quota 和 usage_limit_reached',
    }),
  }), null);
  assert.equal(store.get('provider', 'model'), null);
});

test('Retry-After 支持 HTTP 日期且缺失时使用有界默认冷却', () => {
  let now = Date.parse('2026-08-13T12:00:00Z');
  const store = createModelQuotaCooldownStore({
    now: () => now,
    defaultCooldownMs: 5 * 60_000,
  });
  const quotaBody = '{"error":{"type":"GoUsageLimitError"}}';

  const dated = store.observe({
    target: 'dated', model: 'kimi-k3', status: 429,
    headers: { 'Retry-After': 'Thu, 13 Aug 2026 12:10:00 GMT' },
    bodyText: quotaBody,
  });
  assert.equal(dated.retryAt, Date.parse('2026-08-13T12:10:00Z'));
  assert.equal(dated.retryAfterSeconds, 600);

  const fallback = store.observe({
    target: 'fallback', model: 'kimi-k3', status: 429,
    headers: {}, bodyText: quotaBody,
  });
  assert.equal(fallback.retryAt, now + 5 * 60_000);
  assert.equal(fallback.retryAfterSeconds, 300);
});

test('缺少 Retry-After 时读取结构化错误的通用 reset 字段', () => {
  const now = Date.parse('2026-08-13T12:00:00Z');
  const store = createModelQuotaCooldownStore({ now: () => now });
  const isoReset = '2026-08-13T17:00:00Z';

  const absolute = store.observe({
    target: 'absolute', model: 'model-a', status: 429,
    bodyText: JSON.stringify({ error: {
      code: 'usage_limit_reached',
      reset_at: isoReset,
    } }),
  });
  assert.equal(absolute.retryAt, Date.parse(isoReset));

  const relative = store.observe({
    target: 'relative', model: 'model-b', status: 429,
    bodyText: JSON.stringify({ error: {
      code: 'plan_quota_exhausted',
      retry_after_seconds: 900,
    } }),
  });
  assert.equal(relative.retryAt, now + 900_000);
});

test('冷却存储按最近使用有界淘汰且拒绝无效键', () => {
  let now = 10_000;
  const store = createModelQuotaCooldownStore({ now: () => now, maxEntries: 2 });
  const bodyText = 'GoUsageLimitError: 5-hour usage limit reached';

  assert.equal(store.observe({ target: '', model: 'a', status: 429, bodyText }), null);
  store.observe({ target: 'one', model: 'a', status: 429, bodyText });
  now += 1;
  store.observe({ target: 'two', model: 'b', status: 429, bodyText });
  assert.ok(store.get('one', 'a'));
  now += 1;
  store.observe({ target: 'three', model: 'c', status: 429, bodyText });

  assert.ok(store.get('one', 'a'));
  assert.equal(store.get('two', 'b'), null);
  assert.ok(store.get('three', 'c'));
  assert.equal(store.size, 2);
});


// ---------- 百炼 token-plan 真实报文（2026-08-16 实测捕获） ----------
const BAILIAN_QUOTA_BODY = JSON.stringify({
  error: {
    message: 'Your token-plan 1-week quota has been exhausted. The quota will reset at 08-21 11:36:00 UTC.',
    id: '50264f09-efff-4375-adf9-a2daca2476ff',
    type: 'insufficient_quota',
    code: 'insufficient_quota',
  },
});

test('百炼 insufficient_quota 报文被识别为长期配额冷却（retry-after 头优先）', () => {
  const now = Date.parse('2026-08-16T01:00:00Z');
  const store = createModelQuotaCooldownStore({ now: () => now });
  assert.equal(isExplicitLongQuota(429, BAILIAN_QUOTA_BODY), true);
  assert.equal(parsedQuotaError(BAILIAN_QUOTA_BODY).error.code, 'insufficient_quota');

  const entry = store.observe({
    target: 'bailian', model: 'qwen3.8-max', status: 429,
    headers: { 'retry-after': '467583' },
    bodyText: BAILIAN_QUOTA_BODY,
  });
  assert.ok(entry);
  assert.equal(entry.retryAt, now + 467583_000, 'retry-after 头必须优先于 message 文本');
});

test('百炼缺失 retry-after 头时从 message 文本解析重置时间', () => {
  const now = Date.parse('2026-08-16T01:00:00Z');
  assert.equal(retryAtFromMessageText(BAILIAN_QUOTA_BODY, now), Date.parse('2026-08-21T11:36:00Z'));

  const store = createModelQuotaCooldownStore({ now: () => now });
  const entry = store.observe({
    target: 'bailian', model: 'qwen3.7-max', status: 429,
    headers: {},
    bodyText: BAILIAN_QUOTA_BODY,
  });
  assert.ok(entry);
  assert.equal(entry.retryAt, Date.parse('2026-08-21T11:36:00Z'));
  assert.ok(entry.retryAfterSeconds > 5 * 86400, '一周量级的重置时间不应退化为分钟级默认值');
});

test('瞬时 rate limit 报文仍不建立冷却且文本解析不误报', () => {
  const transient = JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'too many requests, retry in 30s' } });
  assert.equal(isExplicitLongQuota(429, transient), false);
  assert.equal(retryAtFromMessageText(transient, Date.now()), null, '无 reset 时间文本不得解析出值');
});

test('message 文本重置时间不合法时不产生冷却时间（结构化兜底链继续）', () => {
  const now = Date.parse('2026-08-16T01:00:00Z');
  const vague = JSON.stringify({ error: { code: 'insufficient_quota', message: 'quota has been exhausted. The quota will reset soon.' } });
  assert.equal(retryAtFromMessageText(vague, now), null);
  const store = createModelQuotaCooldownStore({ now: () => now, defaultCooldownMs: 300_000 });
  const entry = store.observe({
    target: 'vague', model: 'm', status: 429, headers: {}, bodyText: vague,
  });
  assert.equal(entry.retryAt, now + 300_000, '无可解析时间时回落默认冷却');
});

// ---------- 透传层摘要（router-handler.summarizeUpstreamError） ----------
test('summarizeUpstreamError：百炼配额报文产出重置时间与上游摘要；瞬时限流仅摘要', async () => {
  const { summarizeUpstreamError } = await import('../lib/router-handler.mjs');

  const quota = summarizeUpstreamError(429, BAILIAN_QUOTA_BODY, { 'retry-after': '467583' });
  assert.equal(quota.quotaExhausted, true);
  assert.ok(quota.retryAt > Date.now());
  assert.equal(quota.upstream.code, 'insufficient_quota');
  assert.equal(quota.upstream.status, 429);
  assert.match(quota.upstream.message, /quota has been exhausted/);

  const transient = summarizeUpstreamError(429, JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }), {});
  assert.equal(transient.quotaExhausted, false);
  assert.equal(transient.retryAt, null);
  assert.equal(transient.upstream.code, 'rate_limit_exceeded');
  assert.match(transient.upstream.message, /slow down/);
});
