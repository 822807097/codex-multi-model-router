// ---------- 国内外模型供应商能力适配 ----------

const API_FORMATS = new Map([
  ['responses', 'responses'],
  ['openai_responses', 'responses'],
  ['chat', 'chat'],
  ['openai_chat', 'chat'],
  ['chat_completions', 'chat'],
]);

function inferPlatform(name = '') {
  // 未显式配置 platform 时只用名称做保守推断，不影响自定义网关覆盖。
  const normalized = name.toLowerCase();
  if (normalized.includes('deepseek')) return 'deepseek';
  if (normalized.includes('openrouter')) return 'openrouter';
  if (normalized.includes('silicon') || normalized.includes('硅基')) return 'siliconflow';
  if (normalized.includes('bailian') || normalized.includes('dashscope') || normalized.includes('qwen')) return 'dashscope';
  if (normalized.includes('minimax')) return 'minimax';
  if (normalized.includes('openai')) return 'openai';
  return 'generic';
}

function inferReasoningMode(platform) {
  if (platform === 'openrouter') return 'openrouter';
  if (platform === 'siliconflow' || platform === 'dashscope') return 'enable_thinking';
  if (platform === 'minimax') return 'reasoning_split';
  if (platform === 'deepseek') return 'reasoning_effort';
  return 'none';
}

export function resolveProvider(target = {}) {
  // 统一兼容历史 wireApi/wire_api 与新的 apiFormat 命名。
  const configuredFormat = target.apiFormat || target.wire_api || target.wireApi || 'responses';
  const wireApi = API_FORMATS.get(String(configuredFormat).toLowerCase()) || configuredFormat;
  const platform = target.platform || inferPlatform(target.name);
  return {
    wireApi,
    platform,
    chatPath: target.chatPath || '/chat/completions',
    authType: target.authType || target.auth?.type || 'bearer',
    authHeader: target.authHeader || target.auth?.header,
    includeUsage: target.includeUsage !== false,
    reasoningMode: target.reasoningMode || inferReasoningMode(platform),
    maxTokensField: target.maxTokensField || 'max_tokens',
    timeouts: target.timeouts || {},
  };
}

export function resolveRequestProtocol(provider, requestPath) {
  // compact 没有可靠的 Responses→Chat 等价转换，只允许原生 Responses 透传。
  const isChat = provider.wireApi === 'chat';
  const isCompact = /\/responses\/compact(?:\?|$)/.test(requestPath);
  return { isChat, isCompact, allowed: !(isChat && isCompact) };
}

function reasoningEffort(body) {
  return body?.reasoning?.effort ?? body?.reasoning_effort;
}

// Responses 顶层参数 → 不同 Chat 网关使用的字段。未知网关只发送 OpenAI 通用字段。
export function applyChatProviderOptions(baseRequest, responsesBody, provider) {
  const request = { ...baseRequest, stream: true };
  if (provider.includeUsage) request.stream_options = { include_usage: true };

  const passthroughFields = ['temperature', 'top_p', 'parallel_tool_calls', 'tool_choice', 'seed', 'stop'];
  for (const field of passthroughFields) {
    if (responsesBody[field] !== undefined) request[field] = responsesBody[field];
  }
  if (responsesBody.max_output_tokens !== undefined) {
    request[provider.maxTokensField] = responsesBody.max_output_tokens;
  }

  const effort = reasoningEffort(responsesBody);
  if (effort !== undefined) {
    if (provider.reasoningMode === 'reasoning_effort') {
      request.reasoning_effort = effort;
    } else if (provider.reasoningMode === 'openrouter') {
      request.reasoning = { effort };
    } else if (provider.reasoningMode === 'enable_thinking') {
      request.enable_thinking = effort !== 'none';
    } else if (provider.reasoningMode === 'reasoning_split') {
      request.reasoning_split = effort !== 'none';
    }
  }
  return request;
}

export function buildProviderAuthHeaders(provider, apiKey) {
  // 覆盖 Bearer、x-api-key 以及供应商自定义头名；调用方负责保证密钥不落日志。
  const header = provider.authHeader || (provider.authType === 'x-api-key' ? 'x-api-key' : 'authorization');
  const value = provider.authType === 'bearer' ? `Bearer ${apiKey}` : apiKey;
  return { [header]: value };
}

// chatgpt.com backend-api 的官方通道参数适配：
// 1. 必须显式携带 store:false（上游拒绝未声明存储策略的请求）
// 2. 不接受 max_output_tokens（上游返回 400 Unsupported parameter）
// 只在请求未显式声明对应字段时生效，绝不覆盖客户端明确意图。
export function adaptOfficialResponsesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (body.store === undefined) body.store = false;
  if (body.max_output_tokens !== undefined) delete body.max_output_tokens;
  return body;
}
