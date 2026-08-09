import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateChatValueTokens,
  fitMessagesToContext,
  resolveModelCapability,
} from '../lib/context-budget.mjs';

test('模型能力矩阵优先于 target 和全局默认值', () => {
  const config = {
    modelContext: { contextWindow: 1_000_000, maxOutputTokens: 32_000 },
    modelCapabilities: [
      { match: '^small-', contextWindow: 128_000, maxOutputTokens: 8_000, safetyRatio: 0.8 },
    ],
  };
  assert.deepEqual(resolveModelCapability(config, { contextWindow: 256_000 }, 'small-chat'), {
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    safetyRatio: 0.8,
    protocolReserveTokens: 512,
    imageTokens: 2_048,
  });
});

test('图片按固定视觉预算估算，不按 data URL 体积计算', () => {
  const hugeImage = `data:image/png;base64,${'A'.repeat(2_000_000)}`;
  const tokens = estimateChatValueTokens([
    { type: 'text', text: '看图' },
    { type: 'image_url', image_url: { url: hugeImage } },
  ], { imageTokens: 2_048 });
  assert.ok(tokens >= 2_048);
  assert.ok(tokens < 2_100);
});

test('完整预算扣除工具定义和输出预留后按完整轮次裁剪', () => {
  const messages = [
    { role: 'system', content: '系统规则' },
    { role: 'user', content: '旧请求'.repeat(600) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_old', content: '旧结果'.repeat(600) },
    { role: 'user', content: '最新请求' },
  ];
  const tools = [{ type: 'function', function: { name: 'read', description: 'x'.repeat(900), parameters: { type: 'object' } } }];
  const result = fitMessagesToContext(messages, tools, {
    contextWindow: 2_000,
    maxOutputTokens: 400,
    safetyRatio: 0.9,
    protocolReserveTokens: 100,
    imageTokens: 2_048,
  });
  assert.equal(result.fits, true);
  assert.equal(result.trimmedGroups, 1);
  assert.deepEqual(result.messages, [
    { role: 'system', content: '系统规则' },
    { role: 'user', content: '最新请求' },
  ]);
  assert.deepEqual(result.removedMessages, [
    { role: 'user', content: '旧请求'.repeat(600) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_old', content: '旧结果'.repeat(600) },
  ]);
  assert.ok(result.toolTokens > 250);
});

test('检查点预留空间会从消息预算中精确扣除', () => {
  const messages = [
    { role: 'system', content: '规则' },
    { role: 'user', content: '旧轮次'.repeat(300) },
    { role: 'assistant', content: '旧回复'.repeat(300) },
    { role: 'user', content: '最新请求' },
  ];
  const capability = {
    contextWindow: 2_000,
    maxOutputTokens: 400,
    safetyRatio: 0.9,
    protocolReserveTokens: 100,
    imageTokens: 2_048,
  };
  const baseline = fitMessagesToContext(messages, [], capability);
  const reserved = fitMessagesToContext(messages, [], capability, { reserveTokens: 250 });

  assert.equal(reserved.messageBudget, baseline.messageBudget - 250);
  assert.ok(reserved.trimmedGroups >= baseline.trimmedGroups);
});

test('最新轮次自身超过输入预算时返回 fits=false', () => {
  const result = fitMessagesToContext([
    { role: 'system', content: '规则' },
    { role: 'user', content: '不可删除'.repeat(2_000) },
  ], [], {
    contextWindow: 1_000,
    maxOutputTokens: 200,
    safetyRatio: 0.8,
    protocolReserveTokens: 100,
    imageTokens: 2_048,
  });
  assert.equal(result.fits, false);
  assert.equal(result.trimmedGroups, 0);
  assert.ok(result.messageTokens > result.messageBudget);
});
