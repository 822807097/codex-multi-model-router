import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  compactSeenDataImages,
  convertResponsesTools,
  planToolCycleCompaction,
  responsesToChatMessages,
  responsesToolsToChat,
  trimToBudget,
} from '../lib/chat-protocol.mjs';

function chatToolCycle(index, output = `结果 ${index}`) {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: `call_${index}`,
        type: 'function',
        function: { name: 'run_task', arguments: JSON.stringify({ index }) },
      }],
    },
    { role: 'tool', tool_call_id: `call_${index}`, content: output },
  ];
}

test('四个以内完整工具周期保持原样', () => {
  const messages = [
    { role: 'user', content: '执行任务' },
    ...chatToolCycle(1),
    ...chatToolCycle(2),
    ...chatToolCycle(3),
    ...chatToolCycle(4),
  ];

  assert.deepEqual(planToolCycleCompaction(messages), {
    messages,
    removedMessages: [],
    compactedCycles: 0,
  });
});

test('第五个完整工具周期使最早周期进入检查点来源并保留最近四个', () => {
  const messages = [
    { role: 'user', content: '执行任务' },
    ...chatToolCycle(1),
    ...chatToolCycle(2),
    ...chatToolCycle(3),
    ...chatToolCycle(4),
    ...chatToolCycle(5),
  ];

  const result = planToolCycleCompaction(messages);

  assert.equal(result.compactedCycles, 1);
  assert.deepEqual(result.removedMessages, chatToolCycle(1));
  assert.deepEqual(
    result.messages.filter((message) => message.role === 'assistant').map((message) => message.tool_calls[0].id),
    ['call_2', 'call_3', 'call_4', 'call_5'],
  );
  assert.deepEqual(result.messages[0], { role: 'user', content: '执行任务' });
});

test('未配对工具调用不能被周期压缩拆除', () => {
  const incomplete = {
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'pending_call',
      type: 'function',
      function: { name: 'wait_for_result', arguments: '{}' },
    }],
  };
  const messages = [
    { role: 'user', content: '执行任务' },
    incomplete,
    ...chatToolCycle(1),
    ...chatToolCycle(2),
    ...chatToolCycle(3),
    ...chatToolCycle(4),
    ...chatToolCycle(5),
  ];

  const result = planToolCycleCompaction(messages);

  assert.equal(result.messages.includes(incomplete), true);
  assert.equal(result.removedMessages.includes(incomplete), false);
  assert.equal(result.removedMessages.some((message) => message.tool_call_id === 'pending_call'), false);
});

test('重复 call id 的畸形周期不能被单条输出误判为完整', () => {
  const malformed = {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'duplicate', type: 'function', function: { name: 'first', arguments: '{}' } },
      { id: 'duplicate', type: 'function', function: { name: 'second', arguments: '{}' } },
    ],
  };
  const messages = [
    { role: 'user', content: '执行任务' },
    malformed,
    { role: 'tool', tool_call_id: 'duplicate', content: '只有一条输出' },
    ...chatToolCycle(1),
    ...chatToolCycle(2),
    ...chatToolCycle(3),
    ...chatToolCycle(4),
    ...chatToolCycle(5),
  ];

  const result = planToolCycleCompaction(messages);

  assert.equal(result.messages.includes(malformed), true);
  assert.equal(result.removedMessages.includes(malformed), false);
});

test('包含错误或冲突信号的工具周期始终保留', () => {
  const messages = [
    { role: 'user', content: '执行任务' },
    ...chatToolCycle(0, 'Error: save conflict detected'),
    ...chatToolCycle(1),
    ...chatToolCycle(2),
    ...chatToolCycle(3),
    ...chatToolCycle(4),
    ...chatToolCycle(5),
  ];

  const result = planToolCycleCompaction(messages);

  assert.equal(result.messages.some((message) => message.tool_call_id === 'call_0'), true);
  assert.equal(result.removedMessages.some((message) => message.tool_call_id === 'call_0'), false);
  assert.deepEqual(result.removedMessages, chatToolCycle(1));
});

test('当前用户尚未被模型查看的 data image 保持原样', () => {
  const input = [{
    role: 'user',
    content: [
      { type: 'input_text', text: '请查看这张图' },
      { type: 'input_image', image_url: 'data:image/png;base64,current-image' },
    ],
  }];

  assert.deepEqual(compactSeenDataImages(input), input);
});

test('模型已产生后续输出时用安全文本替换较早的 data image', () => {
  const input = [
    {
      type: 'function_call_output',
      call_id: 'image_1',
      output: [{
        type: 'input_image',
        image_url: { url: 'data:image/png;base64,seen-image', detail: 'high' },
      }],
    },
    { type: 'reasoning', summary: [] },
    { type: 'function_call', call_id: 'next_1', name: 'inspect', arguments: '{}' },
  ];

  const compacted = compactSeenDataImages(input);

  assert.equal(compacted[0].output[0].type, 'input_text');
  assert.match(compacted[0].output[0].text, /图片.*已.*查看.*省略/);
  assert.doesNotMatch(JSON.stringify(compacted), /seen-image/);
});

test('较早的远程图片 URL 不被压缩', () => {
  const input = [
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }],
    },
    { role: 'assistant', content: [{ type: 'output_text', text: '已经查看' }] },
  ];

  assert.deepEqual(compactSeenDataImages(input), input);
});

test('压缩已查看图片不修改原始 Responses input', () => {
  const input = [
    {
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/jpeg;base64,immutable' }],
    },
    { role: 'assistant', content: [{ type: 'output_text', text: '已经查看' }] },
  ];
  const snapshot = structuredClone(input);

  compactSeenDataImages(input);

  assert.deepEqual(input, snapshot);
});

test('压缩已查看的 data image 会显著减小后续请求序列化体积', () => {
  const input = [
    {
      type: 'function_call_output',
      call_id: 'image_1',
      output: [{ type: 'input_image', image_url: `data:image/png;base64,${'a'.repeat(500_000)}` }],
    },
    { role: 'assistant', content: [{ type: 'output_text', text: '图像分析完成' }] },
  ];

  const before = Buffer.byteLength(JSON.stringify(input));
  const after = Buffer.byteLength(JSON.stringify(compactSeenDataImages(input)));

  assert.ok(after < before * 0.01, `${after} should be less than 1% of ${before}`);
});

test('Responses 历史转换后保持函数调用与工具结果配对', () => {
  const messages = responsesToChatMessages([
    { role: 'developer', content: [{ type: 'input_text', text: '遵守仓库规范' }] },
    { role: 'user', content: [{ type: 'input_text', text: '读取文件' }] },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'const a = 1;' },
    { role: 'user', content: [{ type: 'input_text', text: '继续分析' }] },
  ], { autonomy: true, instructions: '只修改目标文件' });

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /自主执行的智能体/);
  assert.deepEqual(messages[1], { role: 'system', content: '只修改目标文件' });
  assert.deepEqual(messages[2], { role: 'system', content: '遵守仓库规范' });
  assert.equal(messages[4].tool_calls[0].id, 'call_1');
  assert.deepEqual(messages[5], { role: 'tool', tool_call_id: 'call_1', content: 'const a = 1;' });
  assert.deepEqual(messages.at(-1), { role: 'user', content: '继续分析' });
});

test('上下文裁剪删除完整旧轮次并始终保留最新用户请求', () => {
  const messages = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '旧请求'.repeat(200) },
    { role: 'assistant', content: '', tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'old_tool', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old_call', content: '旧工具结果'.repeat(200) },
    { role: 'assistant', content: '旧回答'.repeat(200) },
    { role: 'user', content: '最新请求必须保留' },
  ];

  const trimmed = trimToBudget(messages, 80);

  assert.deepEqual(trimmed, [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '最新请求必须保留' },
  ]);
  assert.equal(trimmed.some((message) => message.role === 'tool'), false);
});

test('工具定义兼容 Responses 与 Chat 两种函数格式', () => {
  assert.deepEqual(responsesToolsToChat([
    { type: 'function', name: 'shell', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { type: 'function', function: { name: 'read', parameters: { type: 'object' } } },
  ]), [
    { type: 'function', function: { name: 'shell', description: '执行命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
    { type: 'function', function: { name: 'read', parameters: { type: 'object' } } },
  ]);
});

test('字符串形式的 Responses input 转换为用户消息', () => {
  assert.deepEqual(responsesToChatMessages('直接输入', { autonomy: false }), [
    { role: 'user', content: '直接输入' },
  ]);
});

test('视觉 Chat 通道保留 Responses 图片 part', () => {
  const messages = responsesToChatMessages([{
    role: 'user',
    content: [
      { type: 'input_text', text: '看图' },
      { type: 'input_image', image_url: 'data:image/png;base64,abc' },
    ],
  }], { autonomy: false, vision: true });
  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    ],
  }]);
});

test('custom、namespace 和 tool_search 转为 Chat function 并保留还原上下文', () => {
  const converted = convertResponsesTools([
    { type: 'custom', name: 'apply_patch', description: '应用补丁' },
    {
      type: 'namespace',
      name: 'mcp__gmail',
      tools: [
        { type: 'function', name: 'search_emails', description: '搜索邮件', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
      ],
    },
    { type: 'tool_search' },
  ]);
  assert.deepEqual(converted.tools.map((tool) => tool.function.name), [
    'apply_patch',
    'mcp__gmail___search_emails',
    'tool_search',
  ]);
  assert.deepEqual(converted.context.byChatName.apply_patch, { type: 'custom', name: 'apply_patch' });
  assert.deepEqual(converted.context.byChatName.mcp__gmail___search_emails, {
    type: 'function', name: 'search_emails', namespace: 'mcp__gmail',
  });
  assert.deepEqual(converted.context.byChatName.tool_search, { type: 'tool_search', name: 'tool_search' });
  assert.deepEqual(converted.tools[0].function.parameters.required, ['input']);
});

test('tool_search_output 中动态发现的 namespace 工具也会加入 Chat 工具列表', () => {
  const converted = convertResponsesTools([], [{
    type: 'tool_search_output',
    tools: [{
      type: 'namespace',
      name: 'mcp__drive',
      tools: [{ type: 'function', name: 'download', parameters: { type: 'object' } }],
    }],
  }]);
  assert.equal(converted.tools[0].function.name, 'mcp__drive___download');
});

test('超长工具名生成稳定且唯一的合法别名', () => {
  const longPrefix = 'namespace_'.repeat(8);
  const tools = [
    { type: 'function', name: `${longPrefix}a`, parameters: { type: 'object' } },
    { type: 'function', name: `${longPrefix}b`, parameters: { type: 'object' } },
  ];
  const first = convertResponsesTools(tools);
  const second = convertResponsesTools(tools);
  const names = first.tools.map((tool) => tool.function.name);
  assert.ok(names.every((name) => name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name)));
  assert.notEqual(names[0], names[1]);
  assert.deepEqual(names, second.tools.map((tool) => tool.function.name));
});

test('特殊工具历史按转换上下文还原为 Chat 名称和参数', () => {
  const converted = convertResponsesTools([
    { type: 'custom', name: 'apply patch' },
    {
      type: 'namespace',
      name: 'mcp__mail',
      tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
    },
    { type: 'tool_search' },
  ]);
  const messages = responsesToChatMessages([
    { type: 'custom_tool_call', call_id: 'custom_1', name: 'apply patch', input: '*** patch' },
    { type: 'custom_tool_call_output', call_id: 'custom_1', output: 'Done' },
    { type: 'function_call', call_id: 'mail_1', namespace: 'mcp__mail', name: 'search', arguments: '{"query":"x"}' },
    { type: 'function_call_output', call_id: 'mail_1', output: '[]' },
    { type: 'tool_search_call', call_id: 'search_1', query: 'drive', limit: 3 },
    { type: 'tool_search_output', call_id: 'search_1', tools: [{ type: 'function', name: 'download' }] },
  ], { autonomy: false, toolContext: converted.context });

  assert.equal(messages[0].tool_calls[0].function.name, 'apply_patch');
  assert.equal(messages[0].tool_calls[0].function.arguments, '{"input":"*** patch"}');
  assert.equal(messages[2].tool_calls[0].function.name, 'mcp__mail___search');
  assert.equal(messages[4].tool_calls[0].function.name, 'tool_search');
  assert.equal(messages[4].tool_calls[0].function.arguments, '{"query":"drive","limit":3}');
  assert.deepEqual(messages[5], {
    role: 'tool',
    tool_call_id: 'search_1',
    content: '[{"type":"function","name":"download"}]',
  });
});

test('当前请求未重复工具定义时仍从恢复的调用历史建立别名上下文', () => {
  const input = [
    { type: 'custom_tool_call', call_id: 'call_1', name: 'apply patch', input: 'patch' },
    { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Done' },
  ];
  const converted = convertResponsesTools([], input);
  const messages = responsesToChatMessages(input, { autonomy: false, toolContext: converted.context });
  assert.equal(converted.tools, undefined);
  assert.equal(messages[0].tool_calls[0].function.name, 'apply_patch');
});

test('工具别名追加哈希后发生二次碰撞时仍保持唯一', () => {
  const hash = crypto.createHash('sha256').update('a_b').digest('hex').slice(0, 10);
  const preoccupiedAlias = `a_b_${hash}`;
  const converted = convertResponsesTools([
    { type: 'function', name: preoccupiedAlias, parameters: { type: 'object' } },
    { type: 'function', name: 'a b', parameters: { type: 'object' } },
    { type: 'function', name: 'a_b', parameters: { type: 'object' } },
  ]);
  const names = converted.tools.map((tool) => tool.function.name);

  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
  assert.equal(Object.keys(converted.context.byChatName).length, 3);
});

test('顶层工具名与 namespace 结构键相同时不会静默丢弃', () => {
  const converted = convertResponsesTools([
    { type: 'function', name: 'ns___tool', parameters: { type: 'object' } },
    {
      type: 'namespace',
      name: 'ns',
      tools: [{ type: 'function', name: 'tool', parameters: { type: 'object' } }],
    },
  ]);

  assert.equal(converted.tools.length, 2);
  assert.equal(new Set(converted.tools.map((tool) => tool.function.name)).size, 2);
  assert.ok(Object.values(converted.context.byChatName).some((metadata) => metadata.namespace === 'ns' && metadata.name === 'tool'));
});

test('同名 function 与 custom 工具使用不同结构身份', () => {
  const converted = convertResponsesTools([
    { type: 'function', name: 'execute', parameters: { type: 'object' } },
    { type: 'custom', name: 'execute' },
  ]);

  assert.equal(converted.tools.length, 2);
  assert.equal(new Set(converted.tools.map((tool) => tool.function.name)).size, 2);
  assert.deepEqual(
    new Set(Object.values(converted.context.byChatName).map((metadata) => metadata.type)),
    new Set(['function', 'custom']),
  );
});
