import test from 'node:test';
import assert from 'node:assert/strict';

import {
  convertResponsesTools,
  responsesToChatMessages,
  responsesToolsToChat,
  trimToBudget,
} from '../lib/chat-protocol.mjs';

test('Responses 历史转换后保持函数调用与工具结果配对', () => {
  const messages = responsesToChatMessages([
    { role: 'developer', content: [{ type: 'input_text', text: '遵守仓库规范' }] },
    { role: 'user', content: [{ type: 'input_text', text: '读取文件' }] },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'const a = 1;' },
    { role: 'user', content: [{ type: 'input_text', text: '继续分析' }] },
  ], { autonomy: true, instructions: '只修改目标文件' });

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /自主使用可用工具/);
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
