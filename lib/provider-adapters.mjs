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
  // Cursor 通道默认剥离多智能体协作工具（文字优先）：实测（2026-08-19 三轮）cursor-grok 在
  // 真实重上下文会话中，只要 collaboration___* 工具在场就陷入纯工具循环、主对话零文本，
  // 注入收尾总结指令也压不住；剥离后正常输出文字。子代理并行仍可按目标显式选装：
  // target.stripAgentTools=false 保留协作工具（会注入收尾指令），代价是该模型可能不写字。
  const cursorChannel = /^cursor[-_]/i.test(target.name);
  const stripAgentTools = cursorChannel && target.stripAgentTools !== false;
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
    cursorChannel,
    stripAgentTools,
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
// Cursor 多智能体协作工具（namespace 前缀），触发上游 Agent 子任务循环、压迫模型只调用工具不写文本。
const CURSOR_AGENT_TOOL_RE = /collaboration/i;

// 开启多智能体时，在发给 Cursor 网关的最后一条 system/developer 消息里追加「收尾必须给文字总结」的指令。
// grok 在大量工具/子任务轮次后常不写主对话文本，需要显式要求它在结束时给出结论。
// 只作用于 Cursor 通道（stripAgentTools=false 时启用），Codex 端看不到这段文本。
const CURSOR_SUMMARIZE_DIRECTIVE =
  '\n\n[系统要求] 当所有本地工具调用与子任务都完成后，你必须在主对话中，用简体中文一次性给出本次任务的完成总结：说明你做了什么、关键结果是什么、如果还有未完成或不确定的部分也明确写出来。不得在任务收尾时只返回空内容或只返回工具调用。';

export function applyChatProviderOptions(baseRequest, responsesBody, provider, toolContext = {}) {
  const request = { ...baseRequest, stream: true };
  if (provider.includeUsage) request.stream_options = { include_usage: true };

  if (provider.stripAgentTools && Array.isArray(request.tools)) {
    const stripped = new Set();
    request.tools = request.tools.filter((tool) => {
      const name = tool?.function?.name || '';
      if (!CURSOR_AGENT_TOOL_RE.test(name)) return true;
      stripped.add(name);
      return false;
    });
    if (request.tools.length === 0) delete request.tools;
    // 若 tool_choice 强制指向被剥掉的工具，一并移除兜底，避免上游报未知工具。
    if (stripped.size > 0
      && request.tool_choice
      && typeof request.tool_choice.function?.name === 'string'
      && stripped.has(request.tool_choice.function.name)) {
      delete request.tool_choice;
    }
  } else if (provider.cursorChannel === true && provider.stripAgentTools === false && Array.isArray(request.messages)) {
    // 关闭剥离 = 开启多智能体：保留协作工具，并追加收尾总结指令（幂等：避免重复调用时叠加）。
    const directive = CURSOR_SUMMARIZE_DIRECTIVE;
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
      const message = request.messages[index];
      if (message && (message.role === 'system' || message.role === 'developer') && typeof message.content === 'string') {
        if (!message.content.includes(CURSOR_SUMMARIZE_DIRECTIVE)) {
          request.messages[index] = { ...message, content: message.content + directive };
        }
        break;
      }
    }
  }

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
      // 思考模型限制思考 token，防止长思考挤占输出配额导致模型提前收尾或上游超时。
      if (effort !== 'none') request.thinking_budget = provider.thinkingBudget || 8192;
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

// 官方 Responses 的 ID 校验分两类：
// 1. 搜索类调用是服务端私有状态（桌面端不在本地生成），官方固定前缀：动态工具发现 tsc_、网页搜索 ws_；
// 2. 函数/自定义工具调用桌面端会本地生成短 ID（如 fc_0、fc_1 十六进制递增）并回放给官方（官方接受），
//    而路由 Chat 转换生成的 UUID 长 ID（fc_<uuid>）跨供应商回放时被官方拒绝（要求 ctc_）。
// 因此两类规则不同：搜索类按固定前缀过滤，调用类只删除 UUID 长格式，桌面端本地短 ID 一律保留。
const OFFICIAL_SEARCH_ID_PREFIXES = new Map([
  ['tool_search_call', 'tsc_'],
  ['web_search_call', 'ws_'],
]);

const CALL_TYPES_WITH_LOCAL_IDS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

const THIRD_PARTY_UUID_ID = /^[a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 原生 Responses 第三方上游（deepseek 等）回放自有条目 ID 形如 fc_<32 位十六进制>（无连字符）：
// 不匹配 UUID 形状时官方会拒收（ID 前缀/形状校验）。桌面端本地短 ID 远短于此，不受影响。
const THIRD_PARTY_LONG_HEX_ID = /^[a-z]+_[0-9a-f]{16,}$/i;

function removeForeignPrivateCallHistory(input, onDiscard) {
  // 只移除明确带错 ID 的项；ID 未分配（undefined/null）或前缀合法的官方历史一律保留。
  const foreignCalls = new Set(input.filter((item) => {
    if (item?.id === undefined || item?.id === null) return false;
    const searchPrefix = OFFICIAL_SEARCH_ID_PREFIXES.get(item?.type);
    if (searchPrefix) return !String(item.id).startsWith(searchPrefix);
    // 调用类：桌面端本地短 ID 保留；第三方来源的 UUID 形状与长十六进制形状 ID 删除。
    if (CALL_TYPES_WITH_LOCAL_IDS.has(item?.type)) {
      const id = String(item.id);
      return THIRD_PARTY_UUID_ID.test(id) || THIRD_PARTY_LONG_HEX_ID.test(id);
    }
    return false;
  }));
  if (!foreignCalls.size) return input;
  if (typeof onDiscard === 'function') {
    for (const item of foreignCalls) {
      // 脱敏诊断：只报告类型与 ID 前缀，不泄露工具名、参数或正文。
      onDiscard({ type: item?.type, id_prefix: String(item?.id || '').slice(0, 4) });
    }
  }
  const discardedCallIds = new Set([...foreignCalls]
    .map((item) => item.call_id)
    .filter(Boolean));
  return input.filter((item) => (
    !foreignCalls.has(item)
    && !(typeof item?.type === 'string' && item.type.endsWith('_output') && discardedCallIds.has(item.call_id))
  ));
}

// 残缺历史修复：Codex 在上一轮工具执行中断后重试，input 里会留下没有
// *_output 配对的调用项，官方 Responses 直接 400（"No tool output found for
// function call …"）。修复策略：为孤儿调用补一个标记中断的占位 output
// （不删除调用项，避免破坏 reasoning 相邻关系）；孤儿 output（调用方已被
// 上游清理）直接移除。对齐 sub2api apicompat 桥接层的配对归一化语义。
const ORPHAN_REPAIRABLE_CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const CALL_OUTPUT_TYPE_BY_CALL = new Map([
  ['function_call', 'function_call_output'],
  ['custom_tool_call', 'custom_tool_call_output'],
  ['local_shell_call', 'local_shell_call_output'],
]);
// 只认与修复集合一一对应的 output 类型：tool_search_output / local_shell_call_output 等
// 官方私有结构不参与孤儿判定（避免误删合法搜索/本地命令对）。
const ORPHAN_MATCHING_OUTPUT_TYPES = new Set(CALL_OUTPUT_TYPE_BY_CALL.values());
const INTERRUPTED_OUTPUT = ' Tool execution was interrupted before completion.';

export function repairOrphanToolCalls(input, onRepair) {
  const callIds = new Set();
  const outputIds = new Set();
  for (const item of input) {
    if (typeof item?.type !== 'string' || typeof item?.call_id !== 'string' || !item.call_id) continue;
    if (ORPHAN_REPAIRABLE_CALL_TYPES.has(item.type)) callIds.add(item.call_id);
    else if (ORPHAN_MATCHING_OUTPUT_TYPES.has(item.type)) outputIds.add(item.call_id);
  }
  const orphanCalls = [...callIds].filter((id) => !outputIds.has(id));
  const orphanOutputs = [...outputIds].filter((id) => !callIds.has(id));
  if (!orphanCalls.length && !orphanOutputs.length) return input;

  const orphanCallSet = new Set(orphanCalls);
  const orphanOutputSet = new Set(orphanOutputs);
  const out = [];
  for (const item of input) {
    if (typeof item?.type === 'string' && orphanOutputSet.has(item.call_id)) continue; // 孤儿 output 移除
    out.push(item);
    if (typeof item?.type === 'string' && orphanCallSet.has(item.call_id)) {
      const outputType = CALL_OUTPUT_TYPE_BY_CALL.get(item.type) || 'function_call_output';
      out.push({
        type: outputType,
        call_id: item.call_id,
        output: INTERRUPTED_OUTPUT,
      });
      if (typeof onRepair === 'function') {
        // 脱敏诊断：只记录类型与 call_id 前缀
        onRepair({ type: item.type, call_id_prefix: item.call_id.slice(0, 6) });
      }
    }
  }
  return out;
}

// 顺序归一化：DeepSeek 等第三方 Responses 上游要求 function_call_output 必须
// 紧跟其 function_call（官方 OpenAI 容忍交错条目；DeepSeek 实测对交错的
// call → assistant message → output 序列直接 400 "No tool output found for
// tool call …"，已用 A/B 对照实验证实）。修复策略：把每个调用项的 output 上提
// 到紧跟调用之后，其余条目保持稳定序；已经全部相邻时原样返回（幂等零改动）。
// 只处理与修复集合一一对应的调用/output 类型，官方私有结构不参与。
export function enforceToolOutputAdjacency(input, onReorder) {
  const outputsByCallId = new Map();
  for (const item of input) {
    if (
      typeof item?.type === 'string'
      && ORPHAN_MATCHING_OUTPUT_TYPES.has(item.type)
      && typeof item.call_id === 'string'
      && item.call_id
    ) {
      const queue = outputsByCallId.get(item.call_id) || [];
      queue.push(item);
      outputsByCallId.set(item.call_id, queue);
    }
  }
  if (outputsByCallId.size === 0) return input;

  const consumed = new Set();
  const out = [];
  let moved = 0;
  for (const item of input) {
    if (consumed.has(item)) continue;
    out.push(item);
    // output 先于其 call 出现的异常顺序：原地保留并标记已消费，
    // 避免稍后遇到 call 时被二次追加上提成重复条目。
    if (
      typeof item?.type === 'string'
      && ORPHAN_MATCHING_OUTPUT_TYPES.has(item.type)
    ) {
      consumed.add(item);
      continue;
    }
    if (
      typeof item?.type === 'string'
      && ORPHAN_REPAIRABLE_CALL_TYPES.has(item.type)
      && typeof item.call_id === 'string'
    ) {
      const queue = outputsByCallId.get(item.call_id) || [];
      for (const output of queue) {
        if (consumed.has(output)) continue;
        consumed.add(output);
        out.push(output);
        moved += 1;
      }
    }
  }
  // 长度与逐位引用均一致说明没有发生任何上提，返回原数组保持零改动语义。
  if (out.length === input.length && out.every((item, index) => item === input[index])) {
    return input;
  }
  if (typeof onReorder === 'function') onReorder({ moved_outputs: moved });
  return out;
}

// chatgpt.com backend-api 的官方通道参数适配（仅 Responses 协议端点）：
// 1. 客户端未声明 store 时补 false（上游拒绝未声明存储策略的请求）；但客户端显式
//    store:true + previous_response_id 时必须尊重——那是官方「服务端存历史、每轮
//    只发增量」的链式续聊（store:false 会迫使桌面端每轮全量重发 3.7MB/317 条，
//    输入 token 巨大导致 5 小时订阅额度一轮烧光，2026-09-02 实锤）。
// 2. 不接受 max_output_tokens（上游返回 400 Unsupported parameter）
// 3. reasoning 输入不接受非空 content；store:false 只能回放带 encrypted_content 的推理项
// 4. 搜索/函数调用带官方私有 ID；第三方历史不能跨上游伪造回放
// 非 Responses 端点（如 /v1/images/*）协议形状不同，一律原样透传。
// store 只在客户端未声明时补默认值；其余不兼容字段必须在官方请求边界移除。
export function adaptOfficialResponsesBody(body, requestPath = '', hooks = {}) {
  // 兼容 /responses_lite 变体端点（目录条目声明 use_responses_lite 时桌面可能派生）：
  // 路径门漏匹配会静默跳过全部官方适配（store:false 等），上游直接 400。
  if (!/\/responses(?:_lite)?(?:\/|$|\?)/.test(requestPath)) return body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  // 尊重客户端显式存储策略：previous_response_id 链式续聊的前提是上游存了历史。
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
    body.input = removeForeignPrivateCallHistory(body.input, hooks.onDiscard);
    body.input = repairOrphanToolCalls(body.input, hooks.onRepair);
  }
  return body;
}
