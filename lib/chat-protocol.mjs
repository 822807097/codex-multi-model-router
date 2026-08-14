import crypto from 'node:crypto';

// ---------- Responses ↔ Chat 请求协议转换 ----------

// 从 Responses 的 content（字符串或 part 数组）中提取纯文本。
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    return part && (part.text || part.output_text || part.input_text || '');
  }).join('');
}

function toolOutputText(output) {
  // 工具输出可能是字符串、part 数组或结构化对象，最终必须成为 Chat 文本。
  const text = extractText(output);
  if (text) return text;
  if (output === undefined || output === null) return '';
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function toChatContent(content, preserveImages) {
  // 视觉模型保留 image_url part；文本模型只提取文字，图片由主入口先行中继。
  if (!preserveImages || !Array.isArray(content)) return extractText(content);
  const parts = [];
  let hasImage = false;
  for (const part of content) {
    if (!part) continue;
    const text = part.text || part.input_text || part.output_text;
    if (text) {
      parts.push({ type: 'text', text });
      continue;
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      const source = typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url;
      if (source?.url) {
        hasImage = true;
        parts.push({ type: 'image_url', image_url: { ...source } });
      }
    }
  }
  return hasImage ? parts : parts.map((part) => part.text).join('');
}

function chatToolName(item, toolContext = {}) {
  // 将 Responses 原始名称反查为 Chat 合法别名，覆盖 namespace 和超长/非法名称。
  const expectedType = item.type === 'custom_tool_call'
    ? 'custom'
    : (item.type === 'tool_search_call' ? 'tool_search' : 'function');
  for (const [chatName, metadata] of Object.entries(toolContext.byChatName || {})) {
    if (metadata.type !== expectedType) continue;
    if (expectedType === 'function' && (metadata.namespace || null) !== (item.namespace || null)) continue;
    if (expectedType === 'tool_search' || metadata.name === item.name) return chatName;
  }
  return item.name || (expectedType === 'tool_search' ? 'tool_search' : 'custom');
}

// Responses input → Chat messages。系统指令统一放在对话前部，兼容要求 system 必须最先出现的网关。
export function responsesToChatMessages(input, options = {}) {
  const systems = [];
  const dialogue = [];
  let pendingToolCalls = [];
  const flushTools = () => {
    if (!pendingToolCalls.length) return;
    dialogue.push({ role: 'assistant', content: '', tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };

  const items = typeof input === 'string'
    ? [{ role: 'user', content: input }]
    : (Array.isArray(input) ? input : []);
  for (const item of items) {
    if (!item) continue;
    const type = item.type;
    if (item.role === 'developer' || item.role === 'system') {
      flushTools();
      const text = extractText(item.content);
      if (text) systems.push({ role: 'system', content: text });
    } else if (item.role === 'user') {
      flushTools();
      const content = toChatContent(item.content, options.vision === true);
      if (content?.length) dialogue.push({ role: 'user', content });
    } else if (item.role === 'assistant') {
      flushTools();
      const text = extractText(item.content);
      if (text) dialogue.push({ role: 'assistant', content: text });
    } else if (type === 'reasoning') {
      // Chat 历史没有统一的 reasoning 表达，避免把旧推理当成用户可见文本重复发送。
    } else if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      let rawArguments = item.arguments;
      if (type === 'custom_tool_call') rawArguments = { input: item.input ?? '' };
      if (type === 'tool_search_call') {
        rawArguments = { query: item.query || '' };
        if (item.limit !== undefined) rawArguments.limit = item.limit;
      }
      pendingToolCalls.push({
        id: item.call_id,
        type: 'function',
        function: {
          name: chatToolName(item, options.toolContext),
          arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {}),
        },
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'tool_search_output') {
      flushTools();
      const output = type === 'tool_search_output' && item.output === undefined ? item.tools : item.output;
      const content = toChatContent(output, options.vision === true) || toolOutputText(output);
      dialogue.push({ role: 'tool', tool_call_id: item.call_id, content });
    }
  }
  flushTools();

  if (options.autonomy !== false) {
    systems.unshift({
      role: 'system',
      content: '重要：你是自主执行的智能体。任务彻底完成前，每次回复必须调用工具推进执行，禁止中途返回最终答案或总结；只有确认任务目标已达成时才允许给出最终答案。需要信息时直接调用工具获取，不要只描述计划而不调用工具。',
    });
  }
  if (typeof options.instructions === 'string' && options.instructions) {
    const position = options.autonomy !== false ? 1 : 0;
    systems.splice(position, 0, { role: 'system', content: options.instructions });
  }
  return [...systems, ...dialogue];
}

// 粗略估算单条消息 token 数；中文按字符数 * 0.7 留出偏保守余量。
export function estimateMessageTokens(message) {
  let content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content || '');
  if (message.tool_calls) content += JSON.stringify(message.tool_calls);
  return Math.ceil((content || '').length * 0.7);
}

// 按用户轮次裁剪，绝不拆开 assistant tool_calls 与对应 tool 结果，也不删除最新轮次。
export function trimToBudget(messages, budget, estimate = estimateMessageTokens) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const safeBudget = Number.isFinite(budget) && budget > 0 ? budget : Infinity;
  const leadingSystems = [];
  let cursor = 0;
  while (cursor < messages.length && messages[cursor]?.role === 'system') {
    leadingSystems.push(messages[cursor]);
    cursor += 1;
  }

  const groups = [];
  let current = [];
  for (const message of messages.slice(cursor)) {
    if (message?.role === 'user' && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) groups.push(current);

  const groupTokens = (group) => group.reduce((sum, message) => sum + estimate(message), 0);
  let total = groupTokens(leadingSystems) + groups.reduce((sum, group) => sum + groupTokens(group), 0);
  while (total > safeBudget && groups.length > 1) {
    total -= groupTokens(groups.shift());
  }
  return [...leadingSystems, ...groups.flat()];
}

function shortHash(value) {
  // 稳定短哈希只用于工具别名，不承载安全校验用途。
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function safeChatToolName(rawName, usedNames, identity = rawName) {
  // Chat 工具名限制为 64 字符和安全字符集，冲突时追加稳定哈希。
  const rawKey = String(identity || rawName || 'tool');
  const displayKey = String(rawName || 'tool');
  const normalized = displayKey.replace(/[^A-Za-z0-9_-]/g, '_');
  let candidate = normalized.length <= 64
    ? normalized
    : `${normalized.slice(0, 53)}_${shortHash(normalized)}`;
  let collision = 0;
  while (usedNames.has(candidate) && usedNames.get(candidate) !== rawKey) {
    // 哈希别名本身也可能已被真实工具名占用，必须循环查重而不是只尝试一次。
    const suffix = `_${shortHash(collision === 0 ? displayKey : `${rawKey}:${collision}`)}`;
    candidate = `${normalized.slice(0, 64 - suffix.length)}${suffix}`;
    collision += 1;
  }
  usedNames.set(candidate, rawKey);
  return candidate;
}

// Codex 特殊工具统一包装成 Chat function，同时保存可逆上下文供响应状态机还原。
export function convertResponsesTools(tools, input = []) {
  const converted = [];
  const context = { byChatName: {} };
  const usedNames = new Map();
  const addedSourceNames = new Set();

  const addTool = (tool, namespace = null) => {
    if (!tool) return;
    if (tool.type === 'namespace') {
      for (const child of tool.tools || []) addTool(child, tool.name);
      return;
    }
    const source = tool.function || tool;
    const originalName = source.name || (tool.type === 'tool_search' ? 'tool_search' : null);
    if (!originalName) return;
    const sourceName = namespace ? `${namespace}___${originalName}` : originalName;
    const semanticType = tool.type === 'custom'
      ? 'custom'
      : (tool.type === 'tool_search' ? 'tool_search' : 'function');
    // 类型、namespace 和原名共同组成结构键，避免扁平化文本相同的工具互相覆盖。
    const sourceKey = JSON.stringify([semanticType, namespace, originalName]);
    if (addedSourceNames.has(sourceKey)) return;
    addedSourceNames.add(sourceKey);
    const chatName = safeChatToolName(sourceName, usedNames, sourceKey);

    let metadata;
    let parameters = source.parameters || { type: 'object', properties: {} };
    if (tool.type === 'custom') {
      metadata = { type: 'custom', name: originalName };
      parameters = {
        type: 'object',
        properties: { input: { type: 'string', description: '传给自定义工具的原始输入' } },
        required: ['input'],
        additionalProperties: false,
      };
    } else if (tool.type === 'tool_search') {
      metadata = { type: 'tool_search', name: originalName };
      parameters = {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer', minimum: 1 },
        },
        required: ['query'],
        additionalProperties: false,
      };
    } else {
      metadata = { type: 'function', name: originalName };
      if (namespace) metadata.namespace = namespace;
    }
    context.byChatName[chatName] = metadata;
    const functionDefinition = { name: chatName, parameters };
    if (source.description !== undefined) functionDefinition.description = source.description;
    converted.push({ type: 'function', function: functionDefinition });
  };

  for (const tool of Array.isArray(tools) ? tools : []) addTool(tool);
  for (const item of Array.isArray(input) ? input : []) {
    // tool_search 的动态发现结果也属于当前轮可调用工具。
    if (item?.type === 'tool_search_output') {
      for (const discovered of item.tools || []) addTool(discovered);
    }
  }
  for (const item of Array.isArray(input) ? input : []) {
    // previous_response_id 恢复的旧调用可能没有重复工具定义，仍要建立名称还原上下文。
    let metadata;
    if (item?.type === 'custom_tool_call' && item.name) {
      metadata = { type: 'custom', name: item.name };
    } else if (item?.type === 'tool_search_call') {
      metadata = { type: 'tool_search', name: 'tool_search' };
    } else if (item?.type === 'function_call' && item.name) {
      metadata = { type: 'function', name: item.name };
      if (item.namespace) metadata.namespace = item.namespace;
    }
    if (!metadata) continue;
    const sourceName = metadata.namespace ? `${metadata.namespace}___${metadata.name}` : metadata.name;
    const sourceKey = JSON.stringify([metadata.type, metadata.namespace || null, metadata.name]);
    const chatName = safeChatToolName(sourceName, usedNames, sourceKey);
    context.byChatName[chatName] ||= metadata;
  }
  return { tools: converted.length ? converted : undefined, context };
}

// 向后兼容只需要 Chat tools 的调用方。
export function responsesToolsToChat(tools) {
  return convertResponsesTools(tools).tools;
}
