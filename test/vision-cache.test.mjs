import test from 'node:test';
import assert from 'node:assert/strict';

import * as visionCache from '../lib/vision-cache.mjs';

const { CaptionCache, mapWithConcurrency } = visionCache;

test('同一图片并发描述使用 single-flight 且缓存键不保留 data URL', async () => {
  const cache = new CaptionCache({ maxEntries: 8, maxBytes: 1_024 });
  const image = `data:image/png;base64,${'A'.repeat(4_096)}`;
  let calls = 0;
  const factory = async () => {
    calls += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return '图片描述';
  };

  const [first, second] = await Promise.all([
    cache.getOrCreate(image, factory),
    cache.getOrCreate(image, factory),
  ]);

  assert.equal(first, '图片描述');
  assert.equal(second, '图片描述');
  assert.equal(calls, 1);
  assert.equal(cache.size, 1);
  assert.ok([...cache.entries.keys()].every((key) => !key.includes('data:image')));
});

test('描述缓存同时遵守条目和字节上限', async () => {
  const cache = new CaptionCache({ maxEntries: 2, maxBytes: 8 });
  await cache.getOrCreate('image-a', async () => 'aaaa');
  await cache.getOrCreate('image-b', async () => 'bbbb');
  await cache.getOrCreate('image-c', async () => 'cccc');

  assert.equal(cache.size, 2);
  assert.ok(cache.bytes <= 8);
});

test('视觉任务池限制同时执行的调用数量并保持结果顺序', async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});

test('共享限制器约束多个并行 map 的进程级总体峰值并分别保持顺序', async () => {
  assert.equal(typeof visionCache.createConcurrencyLimiter, 'function');
  const limiter = visionCache.createConcurrencyLimiter(2);
  let active = 0;
  let peak = 0;
  const mapper = async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 10;
  };

  const [first, second] = await Promise.all([
    mapWithConcurrency([1, 2, 3], limiter, mapper),
    mapWithConcurrency([4, 5, 6], limiter, mapper),
  ]);

  assert.equal(peak, 2);
  assert.deepEqual(first, [10, 20, 30]);
  assert.deepEqual(second, [40, 50, 60]);
});

test('等待共享名额的任务在 AbortSignal 取消后立即拒绝且不执行 mapper', async () => {
  assert.equal(typeof visionCache.createConcurrencyLimiter, 'function');
  const limiter = visionCache.createConcurrencyLimiter(1);
  let releaseFirst;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const blocker = new Promise((resolve) => { releaseFirst = resolve; });
  const first = mapWithConcurrency(['first'], limiter, async (value) => {
    markStarted();
    await blocker;
    return value;
  });
  await started;

  const controller = new AbortController();
  let calls = 0;
  const waiting = mapWithConcurrency(['cancelled'], limiter, async () => {
    calls += 1;
    return 'unexpected';
  }, { signal: controller.signal });
  controller.abort();

  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(calls, 0);
  releaseFirst();
  assert.deepEqual(await first, ['first']);
});

test('mapper 失败后共享名额必定释放给后续 map', async () => {
  assert.equal(typeof visionCache.createConcurrencyLimiter, 'function');
  const limiter = visionCache.createConcurrencyLimiter(1);
  await assert.rejects(mapWithConcurrency(['bad'], limiter, async () => {
    throw new Error('caption failed');
  }), /caption failed/);

  assert.deepEqual(await mapWithConcurrency(['next'], limiter, async (value) => `${value}-ok`), ['next-ok']);
});

test('single-flight 等待者独立取消且仍有等待者时不终止共享任务', async () => {
  const cache = new CaptionCache();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let sharedSignal;
  let releaseShared;
  const factory = (signal) => {
    sharedSignal = signal;
    return new Promise((resolve) => { releaseShared = resolve; });
  };

  const first = cache.getOrCreate('same-image', factory, { signal: firstController.signal });
  const second = cache.getOrCreate('same-image', factory, { signal: secondController.signal });
  await new Promise((resolve) => setImmediate(resolve));
  firstController.abort();
  const sharedStayedAlive = sharedSignal instanceof AbortSignal && !sharedSignal.aborted;
  releaseShared('共享描述');

  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(await second, '共享描述');
  assert.equal(sharedStayedAlive, true);
});
