import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptOfficialResponsesBody,
  applyCheckpointProviderOptions,
  applyChatProviderOptions,
  buildProviderAuthHeaders,
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
  const adapted = adaptOfficialResponsesBody(body);
  assert.equal(adapted.store, false);
  assert.equal('max_output_tokens' in adapted, false);
  // 已显式声明 store 的请求不被覆盖
  assert.equal(adaptOfficialResponsesBody({ store: true }).store, true);
  // 非对象输入原样返回
  assert.equal(adaptOfficialResponsesBody(null), null);
});

test('官方 Responses 通道移除跨模型历史中的 reasoning content 并保留其他输入项', () => {
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

  const adapted = adaptOfficialResponsesBody(body);

  assert.equal('content' in adapted.input[1], false);
  assert.deepEqual(adapted.input[1].summary, [
    { type: 'summary_text', text: '第三方模型的推理摘要' },
  ]);
  assert.equal(adapted.input[1].encrypted_content, 'encrypted-context');
  assert.deepEqual(adapted.input[0].content, [{ type: 'input_text', text: '继续任务' }]);
  assert.deepEqual(adapted.input[2].content, [{ type: 'output_text', text: '第三方模型的回答' }]);
  assert.deepEqual(adapted.input[3], {
    id: 'fc_custom',
    type: 'function_call',
    call_id: 'call_custom',
    name: 'shell_command',
    arguments: '{"command":"Get-Location"}',
  });
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
