import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesToChatMessages, compactSeenDataImages, planToolCycleCompaction } from '../lib/chat-protocol.mjs';
import { adaptOfficialResponsesBody } from '../lib/provider-adapters.mjs';
import { fitMessagesToContext } from '../lib/context-budget.mjs';
import { buildCheckpointMessages, normalizeCheckpoint, CHECKPOINT_HEADINGS } from '../lib/goal-checkpoint.mjs';

test('跨模型无缝切换: 官方模型 Responses 历史 -> 开源 Chat 协议模型无损转换', () => {
  // 模拟在 gpt-5.6-sol 下执行了多轮，包含 reasoning、tool_calls、tool_output、图片
  const responsesInput = [
    { type: 'message', role: 'user', content: '请帮我实现一个跨模型路由' },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'sec_xxx' },
    {
      type: 'function_call',
      id: 'call_1',
      call_id: 'call_1',
      name: 'exec_command',
      arguments: '{"cmd":"ls"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'fileA.js\nfileB.js',
    },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '看下这个截图' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }
      ]
    }
  ];

  // 1. 图片占位压缩
  const compacted = compactSeenDataImages(responsesInput);
  assert.equal(compacted.length, responsesInput.length);

  // 2. 转换到 ChatCompletions (如 DeepSeek / Qwen)
  const chatMessages = responsesToChatMessages(compacted, {
    instructions: 'You are a coding agent.',
    vision: true,
  });

  // 验证: 含有 system、用户输入、assistant 的 tool_calls、tool 响应
  const userMsg = chatMessages.find(m => m.role === 'user');
  const assistantMsg = chatMessages.find(m => m.role === 'assistant');
  const toolMsg = chatMessages.find(m => m.role === 'tool');

  assert.ok(userMsg, '应含有 user 消息');
  assert.ok(assistantMsg, '应含有 assistant 消息');
  assert.equal(assistantMsg.tool_calls?.[0]?.function?.name, 'exec_command');
  assert.ok(toolMsg, '应含有 tool 消息');
  assert.equal(toolMsg.tool_call_id, 'call_1');

  // 验证: 加密 reasoning 在 Chat 协议中被安全剥离，不导致第三方模型报错
  assert.ok(!chatMessages.some(m => m.encrypted_content));
});

test('跨模型无缝切换: 开源模型打断历史 -> 官方通道 Responses 适配与孤儿修复', () => {
  // 模拟在开源模型 (DeepSeek) 下执行时被打断/额度耗尽，留下了未完成的孤儿 call 和 reasoning
  const brokenInput = [
    { type: 'message', role: 'user', content: '继续执行测试' },
    { type: 'reasoning', id: 'rs_2', content: 'thinking process...' }, // 第三方 reasoning 文本
    {
      type: 'function_call',
      id: 'call_broken',
      call_id: 'call_broken',
      name: 'run_tests',
      arguments: '{"suite":"all"}',
    },
    // 缺失 function_call_output (上游超时/额度耗尽导致中断)
  ];

  const body = {
    model: 'gpt-5.6-sol',
    input: brokenInput,
    store: false,
  };

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  // 验证:
  // 1. 第三方非加密 reasoning 被剥离
  assert.ok(!adapted.input.some(item => item.type === 'reasoning'));
  // 2. 孤儿 call 被自动注入 output 占位符，避免上游报 No tool output found
  const callItem = adapted.input.find(item => item.call_id === 'call_broken' && item.type === 'function_call');
  const outputItem = adapted.input.find(item => item.call_id === 'call_broken' && item.type === 'function_call_output');
  assert.ok(callItem, 'function_call 应保留');
  assert.ok(outputItem, '应自动修补 function_call_output 占位符');
  assert.match(outputItem.output, /interrupted|中断/);
});

test('长任务上下文自动压缩与检查点继承 (跨模型上下文预算保护)', () => {
  const capability = {
    contextWindow: 16000,
    maxOutputTokens: 2000,
    sourceTokenBudget: 6000,
  };

  // 构造 10 轮较长工具交互
  const messages = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: '主任务：重构鉴权与路由系统 /goal 实现多模型切换' },
  ];

  for (let i = 1; i <= 10; i++) {
    messages.push({
      role: 'assistant',
      content: `准备执行步骤 ${i}`,
      tool_calls: [{
        id: `call_${i}`,
        type: 'function',
        function: { name: 'exec', arguments: `{"step":${i}}` }
      }]
    });
    messages.push({
      role: 'tool',
      tool_call_id: `call_${i}`,
      content: `步骤 ${i} 执行成功，产出了一大堆日志...\n${'log line '.repeat(100)}`
    });
  }

  // 1. 工具周期压缩计划 (保留最近 4 轮完整工具周期)
  const cyclePlan = planToolCycleCompaction(messages);
  assert.ok(cyclePlan.compactedCycles > 0, '应成功折叠早于 4 轮的旧工具周期');

  // 2. 注入九栏目检查点
  const mockCheckpoint = [
    '目标',
    '重构鉴权与路由系统，支持跨模型无缝切换',
    '硬性约束',
    '不得破坏现有官方通道协议',
    '已完成',
    '步骤 1-6 执行完毕',
    '进行中',
    '步骤 7',
    '待完成',
    '步骤 8-10',
    '关键决定',
    '使用 assistant 注入',
    '当前工作集',
    'lib/chat-protocol.mjs',
    '失败与原因',
    '无',
    '下一步',
    '运行测试',
  ].join('\n\n');

  const normalized = normalizeCheckpoint(mockCheckpoint);
  const withCheckpoint = [
    { role: 'system', content: normalized },
    ...cyclePlan.messages,
  ];
  const fitted = fitMessagesToContext(withCheckpoint, [], capability);

  // 验证: 适配后在目标模型预算内
  assert.ok(fitted.messages.length > 0, '应产出有效消息列表');
  assert.ok(fitted.messages.some(m => typeof m.content === 'string' && m.content.includes('重构鉴权与路由系统')), '检查点应成功保留在上下文中');
  // 最近第 10 轮工具对必须完整保留
  assert.ok(fitted.messages.some(m => m.tool_call_id === 'call_10'), '最新工具对必须完整保留');
});
