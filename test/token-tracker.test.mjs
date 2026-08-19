import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenTracker } from '../lib/token-tracker.mjs';

test('tokenTracker: 记录单个请求并正确累计全局总量', () => {
  const tracker = createTokenTracker();

  tracker.recordUsage({
    model: 'gpt-5.6-sol',
    targetId: 'openai',
    inputTokens: 120,
    outputTokens: 80,
    reasoningTokens: 30,
    cachedTokens: 10,
    durationMs: 1500,
    success: true,
  });

  tracker.recordUsage({
    model: 'claude-3.7-sonnet',
    targetId: 'claude-sub',
    inputTokens: 200,
    outputTokens: 150,
    reasoningTokens: 50,
    cachedTokens: 0,
    durationMs: 2500,
    success: true,
  });

  const summary = tracker.getSummary();

  assert.equal(summary.totalRequests, 2);
  assert.equal(summary.successfulRequests, 2);
  assert.equal(summary.failedRequests, 0);
  assert.equal(summary.inputTokens, 320);
  assert.equal(summary.outputTokens, 230);
  assert.equal(summary.reasoningTokens, 80);
  assert.equal(summary.cachedTokens, 10);
  assert.equal(summary.totalTokens, 550); // input + output (reasoning is subset or added depending on spec, here total = input + output)
});

test('tokenTracker: 详细模型 breakdown 统计准确分离各模型指标', () => {
  const tracker = createTokenTracker();

  // gpt-5.6-sol 成功 2 次
  tracker.recordUsage({
    model: 'gpt-5.6-sol',
    targetId: 'openai',
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 20,
    cachedTokens: 0,
    durationMs: 1000,
    success: true,
  });
  tracker.recordUsage({
    model: 'gpt-5.6-sol',
    targetId: 'openai',
    inputTokens: 150,
    outputTokens: 70,
    reasoningTokens: 30,
    cachedTokens: 20,
    durationMs: 1200,
    success: true,
  });

  // deepseek-v4 失败 1 次
  tracker.recordUsage({
    model: 'deepseek-v4',
    targetId: 'deepseek-chat',
    inputTokens: 300,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    durationMs: 500,
    success: false,
  });

  const models = tracker.getModelBreakdown();
  assert.equal(models.length, 2);

  const gpt = models.find((m) => m.model === 'gpt-5.6-sol');
  assert.ok(gpt);
  assert.equal(gpt.requests, 2);
  assert.equal(gpt.successCount, 2);
  assert.equal(gpt.failCount, 0);
  assert.equal(gpt.inputTokens, 250);
  assert.equal(gpt.outputTokens, 120);
  assert.equal(gpt.reasoningTokens, 50);
  assert.equal(gpt.cachedTokens, 20);
  assert.equal(gpt.totalTokens, 370);
  assert.equal(gpt.avgDurationMs, 1100);

  const deepseek = models.find((m) => m.model === 'deepseek-v4');
  assert.ok(deepseek);
  assert.equal(deepseek.requests, 1);
  assert.equal(deepseek.successCount, 0);
  assert.equal(deepseek.failCount, 1);
  assert.equal(deepseek.inputTokens, 300);
});

test('tokenTracker: 时间线统计按小时聚合', () => {
  let mockTime = 1755216000000; // 某小时整点
  const tracker = createTokenTracker({ now: () => mockTime });

  tracker.recordUsage({
    model: 'qwen3.8-max',
    inputTokens: 50,
    outputTokens: 50,
    durationMs: 800,
    success: true,
  });

  // 推进 30 分钟（同一小时内）
  mockTime += 30 * 60 * 1000;
  tracker.recordUsage({
    model: 'qwen3.8-max',
    inputTokens: 100,
    outputTokens: 100,
    durationMs: 900,
    success: true,
  });

  // 推进到下一个小时
  mockTime += 40 * 60 * 1000;
  tracker.recordUsage({
    model: 'qwen3.8-max',
    inputTokens: 200,
    outputTokens: 200,
    durationMs: 1000,
    success: true,
  });

  const timeline = tracker.getTimeline({ hours: 24 });
  assert.ok(timeline.length >= 2);
  const totalTokensSum = timeline.reduce((acc, point) => acc + point.totalTokens, 0);
  assert.equal(totalTokensSum, 700);
});
