import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptOfficialResponsesBody,
  applyCheckpointProviderOptions,
  applyChatProviderOptions,
  buildProviderAuthHeaders,
  enforceToolOutputAdjacency,
  repairOrphanToolCalls,
  resolveOAuthViaProxy,
  resolveRequestProtocol,
  resolveProvider,
} from '../lib/provider-adapters.mjs';

test('OAuth 刷新默认继承官方目标网络策略并允许显式覆盖', () => {
  assert.equal(resolveOAuthViaProxy({}, { viaProxy: true }), true);
  assert.equal(resolveOAuthViaProxy({}, { viaProxy: false }), false);
  assert.equal(resolveOAuthViaProxy({ viaProxy: false }, { viaProxy: true }), false);
  assert.equal(resolveOAuthViaProxy({ viaProxy: true }, { viaProxy: false }), true);
});

test('供应商协议由显式配置决定并兼容旧 wireApi', () => {
  assert.equal(resolveProvider({ name: 'deepseek', wireApi: 'chat' }).wireApi, 'chat');
  assert.equal(resolveProvider({ name: 'openai' }).wireApi, 'responses');
  assert.equal(resolveProvider({ name: 'custom', apiFormat: 'openai_chat' }).wireApi, 'chat');
});

test('DeepSeek Chat 保留 reasoning_effort 并启用 usage 流', () => {
  const request = applyChatProviderOptions(
    { model: 'deepseek-reasoner', messages: [] },
    { reasoning: { effort: 'high' }, max_output_tokens: 2048, parallel_tool_calls: true },
    resolveProvider({ name: 'deepseek', wireApi: 'chat' }),
  );
  assert.equal(request.stream, true);
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.equal(request.reasoning_effort, 'high');
  assert.equal(request.max_tokens, 2048);
  assert.equal(request.parallel_tool_calls, true);
});

test('思考模型（enable_thinking）注入 thinking_budget 防止思考挤占输出配额', () => {
  const request = applyChatProviderOptions(
    { model: 'qwen3.8-max', messages: [] },
    { reasoning: { effort: 'high' } },
    resolveProvider({ name: 'bailian', wireApi: 'chat' }),
  );
  assert.equal(request.enable_thinking, true);
  assert.equal(request.thinking_budget, 8192);
  // effort=none 时关闭思考且不注入预算
  const off = applyChatProviderOptions(
    { model: 'qwen3.8-max', messages: [] },
    { reasoning: { effort: 'none' } },
    resolveProvider({ name: 'bailian', wireApi: 'chat' }),
  );
  assert.equal(off.enable_thinking, false);
  assert.equal(off.thinking_budget, undefined);
});

test('Responses 强制工具选择转换为 Chat function 结构并使用工具别名', () => {
  const provider = resolveProvider({ name: 'bailian', wireApi: 'chat' });
  const toolContext = {
    byChatName: {
      read_file: { type: 'function', name: 'read file' },
      apply_patch: { type: 'custom', name: 'apply patch' },
      mcp__mail___search: { type: 'function', namespace: 'mcp__mail', name: 'search' },
      tool_search: { type: 'tool_search', name: 'tool_search' },
    },
  };
  const convert = (toolChoice) => applyChatProviderOptions(
    { model: 'qwen', messages: [] },
    { tool_choice: toolChoice },
    provider,
    toolContext,
  ).tool_choice;

  assert.deepEqual(convert({ type: 'function', name: 'read file' }), {
    type: 'function',
    function: { name: 'read_file' },
  });
  assert.deepEqual(convert({ type: 'custom', name: 'apply patch' }), {
    type: 'function',
    function: { name: 'apply_patch' },
  });
  assert.deepEqual(convert({ type: 'function', namespace: 'mcp__mail', name: 'search' }), {
    type: 'function',
    function: { name: 'mcp__mail___search' },
  });
  assert.deepEqual(convert({ type: 'tool_search' }), {
    type: 'function',
    function: { name: 'tool_search' },
  });
  assert.equal(convert('required'), 'required');
});

test('检查点非流式请求按供应商关闭推理以保留正文预算', () => {
  const base = { model: 'checkpoint-model', messages: [], stream: false };
  assert.equal(
    applyCheckpointProviderOptions(base, resolveProvider({ platform: 'deepseek', wireApi: 'chat' })).reasoning_effort,
    'none',
  );
  assert.equal(
    applyCheckpointProviderOptions(base, resolveProvider({ platform: 'dashscope', wireApi: 'chat' })).enable_thinking,
    false,
  );
  assert.deepEqual(
    applyCheckpointProviderOptions(base, resolveProvider({ platform: 'openrouter', wireApi: 'chat' })).reasoning,
    { effort: 'none' },
  );
  assert.equal(
    applyCheckpointProviderOptions(base, resolveProvider({ platform: 'minimax', wireApi: 'chat' })).reasoning_split,
    false,
  );
  assert.equal(applyCheckpointProviderOptions(base, resolveProvider({ platform: 'generic', wireApi: 'chat' })).stream, false);
});

test('OpenRouter 与国内兼容网关使用各自推理字段', () => {
  const body = { reasoning: { effort: 'medium' } };
  assert.deepEqual(
    applyChatProviderOptions({ model: 'x', messages: [] }, body, resolveProvider({ name: 'openrouter', wireApi: 'chat' })).reasoning,
    { effort: 'medium' },
  );
  assert.equal(
    applyChatProviderOptions({ model: 'x', messages: [] }, body, resolveProvider({ name: 'siliconflow', wireApi: 'chat' })).enable_thinking,
    true,
  );
  assert.equal(
    applyChatProviderOptions({ model: 'x', messages: [] }, { reasoning: { effort: 'none' } }, resolveProvider({ name: 'bailian', wireApi: 'chat' })).enable_thinking,
    false,
  );
});

test('认证头支持 Bearer 和可配置 x-api-key', () => {
  assert.deepEqual(buildProviderAuthHeaders({ authType: 'bearer' }, 'secret'), { authorization: 'Bearer secret' });
  assert.deepEqual(buildProviderAuthHeaders({ authType: 'x-api-key', authHeader: 'x-api-key' }, 'secret'), { 'x-api-key': 'secret' });
});

test('官方 Responses 通道适配 chatgpt.com 参数限制（store:false 注入、max_output_tokens 移除）', () => {
  const body = { model: 'gpt-5.6-sol', stream: true, max_output_tokens: 64 };
  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');
  assert.equal(adapted.store, false);
  assert.equal('max_output_tokens' in adapted, false);
  // 已显式声明 store 的请求不被覆盖
  assert.equal(adaptOfficialResponsesBody({ store: true }, '/v1/responses').store, true);
  // 非对象输入原样返回
  assert.equal(adaptOfficialResponsesBody(null, '/v1/responses'), null);
});

test('官方 Responses 通道移除 reasoning content 并保留可无状态回放的加密项', () => {
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      {
        id: 'rs_custom',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '第三方模型的推理摘要' }],
        content: [{ type: 'reasoning_text', text: '第三方模型的推理正文' }],
        encrypted_content: 'encrypted-context',
      },
      {
        id: 'msg_custom',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '第三方模型的回答' }],
      },
      {
        id: 'fc_custom',
        type: 'function_call',
        call_id: 'call_custom',
        name: 'shell_command',
        arguments: '{"command":"Get-Location"}',
      },
    ],
  };

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.equal('content' in adapted.input[1], false);
  assert.equal(adapted.input[1].id, 'rs_custom');
  assert.deepEqual(adapted.input[1].summary, [
    { type: 'summary_text', text: '第三方模型的推理摘要' },
  ]);
  assert.equal(adapted.input[1].encrypted_content, 'encrypted-context');
  assert.deepEqual(adapted.input[0].content, [{ type: 'input_text', text: '继续任务' }]);
  assert.deepEqual(adapted.input[2].content, [{ type: 'output_text', text: '第三方模型的回答' }]);
  // 桌面端本地短 ID（fc_custom）是官方接受的回放格式，保留
  assert.deepEqual(adapted.input[3], {
    id: 'fc_custom',
    type: 'function_call',
    call_id: 'call_custom',
    name: 'shell_command',
    arguments: '{"command":"Get-Location"}',
  });
});

test('官方 Responses 通道丢弃 store:false 下没有加密内容的第三方 reasoning 项', () => {
  const body = {
    store: false,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      {
        id: 'rs_third_party',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '第三方模型的推理摘要' }],
      },
      {
        id: 'msg_custom',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '保留第三方模型的回答' }],
      },
    ],
  };
  const expectedInput = [body.input[0], body.input[2]];

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, expectedInput);
});

test('官方 Responses 通道丢弃第三方遗留的 tool_search 调用对并保留正常工具历史', () => {
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      {
        id: 'fc_third_party_search',
        type: 'tool_search_call',
        call_id: 'call_third_party_search',
        execution: 'client',
        query: '查询第三方模型',
      },
      {
        type: 'tool_search_output',
        call_id: 'call_third_party_search',
        output: [],
      },
      {
        id: 'tsc_official_search',
        type: 'tool_search_call',
        call_id: 'call_official_search',
        execution: 'client',
        query: '查询官方模型',
      },
      {
        type: 'tool_search_output',
        call_id: 'call_official_search',
        output: [],
      },
      {
        id: 'fc_shell',
        type: 'function_call',
        call_id: 'call_shell',
        name: 'shell_command',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'call_shell', output: '完成' },
      {
        id: 'ctc_official_tool',
        type: 'function_call',
        call_id: 'call_official_tool',
        name: 'shell_command',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'call_official_tool', output: '官方工具输出' },
    ],
  };
  const expectedInput = [
    body.input[0],
    body.input[3],
    body.input[4],
    // 桌面端本地短 ID（fc_shell）保留
    body.input[5],
    body.input[6],
    body.input[7],
    body.input[8],
  ];

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, expectedInput);
});

test('官方 Responses 通道保留桌面端本地短 ID 的调用项并删除第三方 UUID 长 ID', () => {
  // 回归：桌面端本地工具调用用 fc_0/fc_1 十六进制递增短 ID，官方接受，必须保留；
  // 路由 Chat 转换生成 fc_<uuid> 长 ID，跨供应商回放被官方拒绝（要求 ctc_），必须删除。
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      { id: 'fc_0', type: 'function_call', call_id: 'call_0', name: 'shell_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_0', output: '本地输出' },
      { id: 'fc_1', type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: {} },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: '本地补丁输出' },
      { id: 'fc_e966528b-e06d-4e7b-b0a6-66e0ca206068', type: 'function_call', call_id: 'call_uuid', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_uuid', output: '第三方输出' },
    ],
  };
  const expectedInput = [body.input[0], body.input[1], body.input[2], body.input[3], body.input[4]];

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, expectedInput);
});

test('官方 Responses 通道丢弃第三方函数调用（fc_ ID）并删除配对输出', () => {
  // 回归：Kimi K3 的 fc_… 函数调用切回官方时，官方要求 ID 以 ctc 开头，必须成对删除。
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      {
        id: 'fc_e966528b-e06d-4e7b-b0a6-66e0ca206068',
        type: 'function_call',
        call_id: 'call_e966528b',
        name: 'read_file',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'call_e966528b', output: '文件内容' },
      { id: 'ctc_keep', type: 'function_call', call_id: 'call_keep', name: 'shell_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_keep', output: '官方输出' },
      { type: 'function_call', name: 'shell_command', arguments: '{}' },
    ],
  };
  const expectedInput = [body.input[0], body.input[3], body.input[4], body.input[5]];

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, expectedInput);
});

test('官方 Responses 通道丢弃第三方 custom_tool_call（fc_ ID）并保留官方 ctc 项', () => {
  // 回归：第三方会话的 Codex 自定义工具调用（shell/apply_patch 等）切回官方时同样要求 ctc 前缀。
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      {
        id: 'fc_e966528b-e06d-4e7b-b0a6-66e0ca206068',
        type: 'custom_tool_call',
        call_id: 'call_e966528b',
        name: 'shell_command',
        input: {},
      },
      { type: 'custom_tool_call_output', call_id: 'call_e966528b', output: '输出' },
      { id: 'ctc_official', type: 'custom_tool_call', call_id: 'call_official', name: 'apply_patch', input: {} },
      { type: 'custom_tool_call_output', call_id: 'call_official', output: '官方输出' },
      { type: 'custom_tool_call', name: 'apply_patch', input: {} },
    ],
  };
  const expectedInput = [body.input[0], body.input[3], body.input[4], body.input[5]];

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, expectedInput);
});

test('官方 Responses 通道即使无法配对输出也丢弃非法 ID 的 tool_search 调用', () => {
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      {
        id: 'fc_incomplete_search',
        type: 'tool_search_call',
        execution: 'client',
        query: '缺少调用 ID 的历史项',
      },
    ],
  };

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, [body.input[0]]);
});

test('官方 Responses 通道用 *_output 通配删除被丢弃调用的任意输出类型', () => {
  // 修根验证：配对删除不限于已知输出类型，未来新增的 *_output 变体引用被删调用时同样删除。
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      { id: 'fc_00000000-0000-4000-8000-000000000001', type: 'function_call', call_id: 'call_foreign', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_foreign', output: 'a' },
      { type: 'agent_search_output', call_id: 'call_foreign', output: 'b' },
      { id: 'ctc_keep', type: 'function_call', call_id: 'call_keep', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_keep', output: 'c' },
    ],
  };
  const expectedInput = [body.input[0], body.input[4], body.input[5]];

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, expectedInput);
});

test('官方 Responses 通道保留合法或未分配 ID 的 tool_search 调用', () => {
  const body = {
    input: [
      { id: 'tsc_official_search', type: 'tool_search_call', execution: 'server', arguments: {} },
      { type: 'tool_search_call', execution: 'server', arguments: {} },
    ],
  };
  const expectedInput = [...body.input];

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, expectedInput);
});

test('官方 Responses 通道丢弃第三方遗留的 web_search_call 并保留官方搜索项', () => {
  const body = {
    input: [
      { role: 'user', content: [{ type: 'input_text', text: '继续任务' }] },
      { id: 'call_00_iqZiDJWSlQwwQQZNieUR0823', type: 'web_search_call', status: 'completed' },
      { id: 'ws_official_search', type: 'web_search_call', status: 'completed' },
    ],
  };
  const expectedInput = [body.input[0], body.input[2]];

  const adapted = adaptOfficialResponsesBody(body, '/v1/responses');

  assert.deepEqual(adapted.input, expectedInput);
});

test('官方适配只作用于 Responses 端点，图片等非 Responses 请求原样透传', () => {
  const imageBody = { model: 'gpt-image-2', prompt: '画一只猫', n: 1 };
  // 传副本：适配器若原地修改会污染原对象，导致比较假阳性
  const result = adaptOfficialResponsesBody({ ...imageBody }, '/v1/images/edits');
  assert.deepEqual(result, imageBody);
  const responsesBody = adaptOfficialResponsesBody({ model: 'gpt-5.6-sol', stream: true }, '/v1/responses');
  assert.equal(responsesBody.store, false);
});

test('compact 仅允许原生 Responses 通道透传', () => {
  assert.deepEqual(resolveRequestProtocol({ wireApi: 'responses' }, '/v1/responses/compact'), {
    isChat: false,
    isCompact: true,
    allowed: true,
  });
  assert.deepEqual(resolveRequestProtocol({ wireApi: 'chat' }, '/v1/responses/compact'), {
    isChat: true,
    isCompact: true,
    allowed: false,
  });
  assert.deepEqual(resolveRequestProtocol({ wireApi: 'chat' }, '/v1/responses/compact/?mode=safe'), {
    isChat: true,
    isCompact: true,
    allowed: false,
  });
});


test('官方 Responses 修复孤儿工具调用：补中断 output、移除孤儿 output', () => {
  const body = {
    model: 'gpt-5.6-sol',
    stream: true,
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'function_call', call_id: 'call_00_abc', name: 'shell_command', arguments: '{"command":"ls"}' },
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      { type: 'custom_tool_call', call_id: 'ctc_01', name: 'apply_patch', input: '*** patch' },
    ],
  };
  const repairs = [];
  adaptOfficialResponsesBody(body, '/v1/responses', { onRepair: (info) => repairs.push(info) });

  const types = body.input.map((i) => i.type);
  // 孤儿 function_call 后紧跟占位 output；custom_tool_call 同理
  assert.deepEqual(types, [
    undefined, // user 消息项
    'function_call',
    'function_call_output',
    undefined, // user 消息项
    'custom_tool_call',
    'custom_tool_call_output',
  ]);
  const placeholder = body.input[2];
  assert.equal(placeholder.call_id, 'call_00_abc');
  assert.match(placeholder.output, /interrupted/i);
  assert.equal(body.input[5].call_id, 'ctc_01');
  assert.equal(repairs.length, 2, '两次修复均产生脱敏诊断');
});

test('官方 Responses 修复孤儿 output（配对调用已被剥离的残留）', () => {
  const body = {
    stream: true,
    input: [
      { type: 'function_call', call_id: 'call_ok', name: 'f', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_ok', output: 'ok' },
      { type: 'function_call_output', call_id: 'call_gone', output: 'stale' },
    ],
  };
  adaptOfficialResponsesBody(body, '/v1/responses');
  const ids = body.input.map((i) => i.call_id);
  assert.deepEqual(ids, ['call_ok', 'call_ok'], '孤儿 output 被移除，正常配对不动');
});

test('配对完好的 input 不被修复逻辑改动', () => {
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'done' },
  ];
  const body = { stream: true, input: JSON.parse(JSON.stringify(input)) };
  adaptOfficialResponsesBody(body, '/v1/responses');
  assert.deepEqual(body.input, input);
});

// ---- 第三方原生 Responses 透传路径直接使用的修复函数 ----
test('repairOrphanToolCalls 直接导出可用：孤儿调用补占位 output 且保持原位', () => {
  const input = [
    { role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
    { type: 'function_call', call_id: 'call_repro', name: 'shell_command', arguments: '{}' },
  ];
  const repairs = [];
  const out = repairOrphanToolCalls(input, (r) => repairs.push(r));
  assert.equal(out.length, 3);
  assert.equal(out[1].type, 'function_call');
  assert.equal(out[2].type, 'function_call_output');
  assert.equal(out[2].call_id, 'call_repro');
  assert.match(out[2].output, /interrupted/i);
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].call_id_prefix, 'call_r');
});

test('repairOrphanToolCalls 不影响配对完好与官方私有类型', () => {
  const input = [
    { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    { type: 'tool_search_call', call_id: 'tsc_x', id: 'tsc_x' },
  ];
  const out = repairOrphanToolCalls(input);
  assert.deepEqual(out, input, '完好配对与非修复集合类型原样保留');
});

// ---- 第三方 Responses 上游的 call→output 相邻归一化 ----
test('enforceToolOutputAdjacency 把交错的 output 上提到紧跟调用之后', () => {
  const msg = { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
  const call = { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' };
  const out1 = { type: 'function_call_output', call_id: 'call_1', output: 'done' };
  const user = { role: 'user', content: [{ type: 'input_text', text: 'go' }] };
  const reorders = [];
  const result = enforceToolOutputAdjacency([call, msg, out1, user], (r) => reorders.push(r));
  assert.deepEqual(result, [call, out1, msg, user], 'output 紧跟 call，message 顺位后移');
  assert.equal(reorders.length, 1);
  assert.equal(reorders[0].moved_outputs, 1);
});

test('enforceToolOutputAdjacency 已相邻时原样返回（幂等零改动）', () => {
  const input = [
    { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ];
  assert.equal(enforceToolOutputAdjacency(input), input, '返回同一数组引用');
});

test('enforceToolOutputAdjacency output 先于 call 时不产生重复条目', () => {
  const out1 = { type: 'function_call_output', call_id: 'call_1', output: 'done' };
  const call = { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' };
  const result = enforceToolOutputAdjacency([out1, call]);
  assert.equal(result.length, 2, '不出现重复 output');
  assert.equal(result.filter((i) => i === out1).length, 1);
});

test('enforceToolOutputAdjacency 多组配对各自归位且保持稳定序', () => {
  const msg = { role: 'assistant', content: [{ type: 'output_text', text: 'mid' }] };
  const callA = { type: 'function_call', call_id: 'call_A', name: 'f', arguments: '{}' };
  const callB = { type: 'function_call', call_id: 'call_B', name: 'g', arguments: '{}' };
  const outA = { type: 'function_call_output', call_id: 'call_A', output: 'a' };
  const outB = { type: 'function_call_output', call_id: 'call_B', output: 'b' };
  const result = enforceToolOutputAdjacency([callA, callB, msg, outA, outB]);
  assert.deepEqual(result, [callA, outA, callB, outB, msg]);
});

test('Cursor 通道默认开启多智能体：保留协作工具并注入收尾总结指令', () => {
  const provider = resolveProvider({ name: 'cursor-grok-4.6-high', wireApi: 'chat' });
  assert.equal(provider.stripAgentTools, false, 'cursor 目标默认关闭剥离 = 支持子代理并行');
  const base = {
    model: 'grok-4.6[effort=high]',
    messages: [
      { role: 'developer', content: '你是编码助手。' },
      { role: 'user', content: '帮我看看这个仓库' },
    ],
    tools: [
      { type: 'function', function: { name: 'collaboration___spawn_agent' } },
      { type: 'function', function: { name: 'collaboration___wait_agent' } },
      { type: 'function', function: { name: 'exec' } },
    ],
  };
  const once = applyChatProviderOptions(base, {}, provider);
  const names = (once.tools || []).map((t) => t.function.name);
  assert.deepEqual(names, ['collaboration___spawn_agent', 'collaboration___wait_agent', 'exec'], '协作工具默认保留');
  assert.match(once.messages[0].content, /完成总结/, 'developer 消息被追加收尾总结指令');
  // 幂等：重复调用不叠加指令
  const twice = applyChatProviderOptions(once, {}, provider);
  assert.equal(
    (twice.messages[0].content.match(/完成总结/g) || []).length,
    1,
    '重复调用不重复追加总结指令',
  );
});

test('Cursor 通道显式 stripAgentTools=true 时剥离协作工具（纯文字逃生）', () => {
  const provider = resolveProvider({ name: 'cursor-grok-4.6-high', wireApi: 'chat', stripAgentTools: true });
  assert.equal(provider.stripAgentTools, true);
  const request = applyChatProviderOptions(
    {
      model: 'grok-4.6[effort=high]',
      messages: [{ role: 'developer', content: '你是编码助手。' }],
      tools: [
        { type: 'function', function: { name: 'exec' } },
        { type: 'function', function: { name: 'collaboration___spawn_agent' } },
        { type: 'function', function: { name: 'collaboration___wait_agent' } },
      ],
    },
    {},
    provider,
  );
  const names = (request.tools || []).map((t) => t.function.name);
  assert.deepEqual(names, ['exec'], '协作工具被剥离，exec 保留');
  assert.equal(request.messages[0].content, '你是编码助手。', '剥离时不注入任何指令');
  // 非 cursor 目标不受影响：cursorChannel=false，绝不追加收尾指令
  const bailian = resolveProvider({ name: 'bailian', wireApi: 'chat' });
  assert.equal(bailian.cursorChannel, false);
  const noInline = applyChatProviderOptions(
    { model: 'qwen', messages: [{ role: 'developer', content: '你是助手。' }] },
    {},
    bailian,
  );
  assert.equal(noInline.messages[0].content, '你是助手。', '非 cursor 通道不注入任何指令');
});

test('非 Cursor 通道保留 collaboration 工具：自定义模型支持 Codex 子代理并行', () => {
  const provider = resolveProvider({ name: 'bailian', wireApi: 'chat' });
  const tools = [
    { type: 'function', function: { name: 'exec' } },
    { type: 'function', function: { name: 'collaboration___spawn_agent' } },
  ];
  const request = applyChatProviderOptions({ model: 'qwen3.8-max', messages: [{ role: 'user', content: 'hi' }], tools }, {}, provider);
  const names = (request.tools || []).map((t) => t.function.name);
  assert.deepEqual(names, ['exec', 'collaboration___spawn_agent'], '协作工具必须原样转发，不剥离不注入');
  assert.equal(request.messages[0].content, 'hi', '非 cursor 通道不注入任何指令');
});
