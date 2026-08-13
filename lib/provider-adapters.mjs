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

export function resolveOAuthViaProxy(oauth = {}, target = {}) {
  // 默认让 token 刷新和当前官方目标走同一网络；显式布尔值用于网络策略不同的特殊环境。
  if (typeof oauth.viaProxy === 'boolean') return oauth.viaProxy;
  return target.viaProxy === true;
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
  const isCompact = /\/responses\/compact\/?(?:\?|$)/.test(requestPath);
  return { isChat, isCompact, allowed: !(isChat && isCompact) };
}

function reasoningEffort(body) {
  return body?.reasoning?.effort ?? body?.reasoning_effort;
}

function chatToolChoiceName(toolChoice, toolContext = {}) {
  const semanticType = toolChoice.type === 'custom'
    ? 'custom'
    : (toolChoice.type === 'tool_search' ? 'tool_search' : 'function');
  const sourceName = toolChoice.name || (semanticType === 'tool_search' ? 'tool_search' : null);
  if (!sourceName) return null;
  const namespace = toolChoice.namespace || null;
  for (const [chatName, metadata] of Object.entries(toolContext.byChatName || {})) {
    if (metadata.type !== semanticType || metadata.name !== sourceName) continue;
    if (semanticType === 'function' && (metadata.namespace || null) !== namespace) continue;
    return chatName;
  }
  // 正常路由一定携带转换上下文；回退只为没有工具定义的兼容请求保留原名称。
  return namespace ? `${namespace}___${sourceName}` : sourceName;
}

function responsesToolChoiceToChat(toolChoice, toolContext) {
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return toolChoice;
  // 已经是 Chat Completions 结构时保持原样，兼容直接调用适配器的自定义代码。
  if (toolChoice.type === 'function' && toolChoice.function?.name) return toolChoice;
  if (!['function', 'custom', 'tool_search'].includes(toolChoice.type)) return toolChoice;
  const name = chatToolChoiceName(toolChoice, toolContext);
  return name ? { type: 'function', function: { name } } : toolChoice;
}

// Responses 顶层参数 → 不同 Chat 网关使用的字段。未知网关只发送 OpenAI 通用字段。
export function applyChatProviderOptions(baseRequest, responsesBody, provider, toolContext = {}) {
  const request = { ...baseRequest, stream: true };
  if (provider.includeUsage) request.stream_options = { include_usage: true };

  const passthroughFields = ['temperature', 'top_p', 'parallel_tool_calls', 'seed', 'stop'];
  for (const field of passthroughFields) {
    if (responsesBody[field] !== undefined) request[field] = responsesBody[field];
  }
  if (responsesBody.tool_choice !== undefined) {
    // Responses 的对象型强制工具选择与 Chat 结构不同，且必须跟随工具名安全别名。
    request.tool_choice = responsesToolChoiceToChat(responsesBody.tool_choice, toolContext);
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

export function applyCheckpointProviderOptions(baseRequest, provider) {
  // 检查点需要结构化正文，不需要昂贵的隐藏推理；按各兼容网关语义显式关闭。
  const request = { ...baseRequest };
  if (provider.reasoningMode === 'reasoning_effort') request.reasoning_effort = 'none';
  else if (provider.reasoningMode === 'openrouter') request.reasoning = { effort: 'none' };
  else if (provider.reasoningMode === 'enable_thinking') request.enable_thinking = false;
  else if (provider.reasoningMode === 'reasoning_split') request.reasoning_split = false;
  return request;
}

export function buildProviderAuthHeaders(provider, apiKey) {
  // 覆盖 Bearer、x-api-key 以及供应商自定义头名；调用方负责保证密钥不落日志。
  const header = provider.authHeader || (provider.authType === 'x-api-key' ? 'x-api-key' : 'authorization');
  const value = provider.authType === 'bearer' ? `Bearer ${apiKey}` : apiKey;
  return { [header]: value };
}

function removeForeignPrivateSearchHistory(input) {
  // 官方 Responses 为不同调用项分配不同私有 ID 前缀：动态工具发现 tsc_、网页搜索 ws_、自定义函数调用 ctc_。
  // 第三方 Chat 转换出的 call_…/fc_… 不能伪造回放；只移除明确带错 ID 的项，保留合法或尚未分配 ID 的官方历史。
  const expectedPrefixes = new Map([
    ['tool_search_call', 'tsc_'],
    ['web_search_call', 'ws_'],
    ['function_call', 'ctc'],
  ]);
  const foreignCalls = new Set(input.filter((item) => {
    const prefix = expectedPrefixes.get(item?.type);
    if (!prefix || item.id === undefined || item.id === null) return false;
    return !String(item.id).startsWith(prefix);
  }));
  if (!foreignCalls.size) return input;
  const discardedCallIds = new Set([...foreignCalls]
    .map((item) => item.call_id)
    .filter(Boolean));
  return input.filter((item) => (
    !foreignCalls.has(item)
    && !(item?.type === 'tool_search_output' && discardedCallIds.has(item.call_id))
    && !(item?.type === 'function_call_output' && discardedCallIds.has(item.call_id))
  ));
}

// chatgpt.com backend-api 的官方通道参数适配（仅 Responses 协议端点）：
// 1. 必须显式携带 store:false（上游拒绝未声明存储策略的请求）
// 2. 不接受 max_output_tokens（上游返回 400 Unsupported parameter）
// 3. reasoning 输入不接受非空 content；store:false 只能回放带 encrypted_content 的推理项
// 4. 搜索/函数调用带官方私有 ID；第三方历史不能跨上游伪造回放
// 非 Responses 端点（如 /v1/images/*）协议形状不同，一律原样透传。
// store 只在客户端未声明时补默认值；其余不兼容字段必须在官方请求边界移除。
export function adaptOfficialResponsesBody(body, requestPath = '') {
  if (!/\/responses(?:\/|$|\?)/.test(requestPath)) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (body.store === undefined) body.store = false;
  if (body.max_output_tokens !== undefined) delete body.max_output_tokens;
  if (Array.isArray(body.input)) {
    body.input = body.input.filter((item) => {
      if (item?.type !== 'reasoning') return true;
      if (item.content !== undefined) delete item.content;
      // Chat 通道合成的 rs_… 只有摘要，没有可供官方模型无状态续接的加密推理内容。
      if (body.store === false && !item.encrypted_content) return false;
      return true;
    });
    body.input = removeForeignPrivateSearchHistory(body.input);
  }
  return body;
}
