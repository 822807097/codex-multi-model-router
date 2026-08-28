import crypto from 'node:crypto';

// ---------- Responses ↔ Chat 请求协议转换 ----------

const SEEN_IMAGE_PLACEHOLDER = '[较早图片已由模型查看；为避免重复传输，图片数据已省略]';

function isDataImagePart(part) {
  if (!part || (part.type !== 'input_image' && part.type !== 'image_url')) return false;
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  return typeof url === 'string' && /^data:image\//i.test(url);
}

function hasModelOutput(item) {
  return item?.role === 'assistant'
    || item?.type === 'reasoning'
    || item?.type === 'function_call'
    || item?.type === 'custom_tool_call'
    || item?.type === 'tool_search_call'
    // 官方特殊调用（搜索/本地命令/计算机操作）同样是模型已产出的动作：
    // 不算的话 compactSeenDataImages 会把其之前的图片当「未读」多重传一轮。
    || item?.type === 'web_search_call'
    || item?.type === 'local_shell_call'
    || item?.type === 'computer_call';
}

// 官方特殊调用条目 → 可读注记（切到 chat 协议模型时保留动作语义而不是无声丢弃）。
function summarizeOfficialCallItem(item) {
  const type = item?.type;
  if (type === 'web_search_call') {
    const action = item?.action || {};
    if (action?.type === 'search' && action.query) return `调用 web_search 搜索：${String(action.query).slice(0, 200)}`;
    if (action?.type === 'open_page' && action.url) return `web_search 打开网页：${String(action.url).slice(0, 200)}`;
    return '调用 web_search（详情省略）';
  }
  if (type === 'local_shell_call') {
    const command = item?.action?.command;
    const text = Array.isArray(command) ? command.join(' ') : String(command || '');
    return text ? `执行本地命令：${text.slice(0, 200)}` : '执行本地命令（详情省略）';
  }
  if (type === 'computer_call') {
    const action = item?.action?.type || '';
    return action ? `计算机操作（${action}）` : '计算机操作';
  }
  if (type === 'local_shell_call_output') {
    const output = typeof item?.output === 'string' ? item.output : '';
    return output ? `命令结果：${output.slice(0, 2000)}` : '';
  }
  if (type === 'web_search_call_output' || type === 'computer_call_output') {
    return '';
  }
  return '';
}

function compactImageParts(parts) {
  if (!Array.isArray(parts)) return parts;
  let changed = false;
  const compacted = parts.map((part) => {
    if (!isDataImagePart(part)) return part;
    changed = true;
    return { type: 'input_text', text: SEEN_IMAGE_PLACEHOLDER };
  });
  return changed ? compacted : parts;
}

// 已被模型消费的内联图片在后续请求中只保留语义占位，避免反复重放 MB 级 data URL。
export function compactSeenDataImages(input) {
  if (!Array.isArray(input)) return input;
  let laterModelOutput = false;
  let changed = false;
  const compacted = new Array(input.length);
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    let next = item;
    if (laterModelOutput && item && typeof item === 'object') {
      const content = compactImageParts(item.content);
      const output = compactImageParts(item.output);
      if (content !== item.content || output !== item.output) {
        next = { ...item };
        if (content !== item.content) next.content = content;
        if (output !== item.output) next.output = output;
        changed = true;
      }
    }
    compacted[index] = next;
    if (hasModelOutput(item)) laterModelOutput = true;
  }
  return changed ? compacted : input;
}

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
  // 官方特殊调用（web_search/local_shell/computer）聚合为单条 assistant 注记：
  // chat 协议没有等价工具契约，保住动作语义优于无声丢弃（模型切协议后不失明）。
  let pendingNotes = [];
  const flushNotes = () => {
    if (!pendingNotes.length) return;
    dialogue.push({ role: 'assistant', content: pendingNotes.join('\n') });
    pendingNotes = [];
  };

  const items = typeof input === 'string'
    ? [{ role: 'user', content: input }]
    : (Array.isArray(input) ? input : []);
  for (const item of items) {
    if (!item) continue;
    const type = item.type;
    if (item.role === 'developer' || item.role === 'system') {
      flushTools();
      flushNotes();
      const text = extractText(item.content);
      if (text) systems.push({ role: 'system', content: text });
    } else if (item.role === 'user') {
      flushTools();
      flushNotes();
      const content = toChatContent(item.content, options.vision === true);
      if (content?.length) dialogue.push({ role: 'user', content });
    } else if (item.role === 'assistant') {
      flushTools();
      flushNotes();
      const text = extractText(item.content);
      if (text) dialogue.push({ role: 'assistant', content: text });
    } else if (type === 'reasoning') {
      // Chat 历史没有统一的 reasoning 表达，避免把旧推理当成用户可见文本重复发送。
    } else if (type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call') {
      flushNotes();
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
      flushNotes();
      const output = type === 'tool_search_output' && item.output === undefined ? item.tools : item.output;
      const content = toChatContent(output, options.vision === true) || toolOutputText(output);
      dialogue.push({ role: 'tool', tool_call_id: item.call_id, content });
    } else if (type === 'web_search_call' || type === 'local_shell_call' || type === 'computer_call'
      || type === 'web_search_call_output' || type === 'local_shell_call_output' || type === 'computer_call_output') {
      flushTools();
      const note = summarizeOfficialCallItem(item);
      if (note) pendingNotes.push(note);
    }
  }
  flushTools();
  flushNotes();

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

function protectedToolOutput(message) {
  if (!message || message.role !== 'tool') return false;
  const text = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content ?? '');
  return /(?:^|[\s{[,])(?:error|failed|failure|conflict)\b|"(?:error|isError|failed)"\s*:\s*(?:true|"?[^"}\s]+)|错误|失败|冲突|异常/i.test(text);
}

function completedToolCycles(messages) {
  const cycles = [];
  for (let index = 0; index < messages.length; index += 1) {
    const callMessage = messages[index];
    const calls = Array.isArray(callMessage?.tool_calls) ? callMessage.tool_calls : [];
    const callIds = calls.map((call) => call?.id).filter(Boolean);
    if (callMessage?.role !== 'assistant'
      || !callIds.length
      || callIds.length !== calls.length
      || new Set(callIds).size !== callIds.length) continue;
    const remaining = new Set(callIds);
    const outputIndexes = [];
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor];
      if (candidate?.role === 'user'
        || (candidate?.role === 'assistant' && Array.isArray(candidate.tool_calls) && candidate.tool_calls.length)) {
        break;
      }
      if (candidate?.role === 'tool' && remaining.has(candidate.tool_call_id)) {
        remaining.delete(candidate.tool_call_id);
        outputIndexes.push(cursor);
      }
    }
    if (remaining.size) continue;
    const protectedCycle = outputIndexes.some((outputIndex) => protectedToolOutput(messages[outputIndex]));
    cycles.push({ indexes: [index, ...outputIndexes], protected: protectedCycle });
  }
  return cycles;
}

// 仅规划已完成且无错误的周期；实际删除必须由检查点成功结果兜底。
export function planToolCycleCompaction(messages, keepRecent = 4) {
  if (!Array.isArray(messages) || !messages.length) {
    return { messages: Array.isArray(messages) ? messages : [], removedMessages: [], compactedCycles: 0 };
  }
  const keep = Math.max(0, Math.floor(Number(keepRecent) || 0));
  const candidates = completedToolCycles(messages).filter((cycle) => !cycle.protected);
  const removable = candidates.slice(0, Math.max(0, candidates.length - keep));
  if (!removable.length) return { messages, removedMessages: [], compactedCycles: 0 };
  const removedIndexes = new Set(removable.flatMap((cycle) => cycle.indexes));
  return {
    messages: messages.filter((_, index) => !removedIndexes.has(index)),
    removedMessages: messages.filter((_, index) => removedIndexes.has(index)),
    compactedCycles: removable.length,
  };
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
export function convertResponsesTools(tools, input = [], hooks = {}) {
  const converted = [];
  const context = { byChatName: {} };
  const usedNames = new Map();
  const addedSourceNames = new Set();
  const onDrop = typeof hooks.onDrop === 'function' ? hooks.onDrop : null;

  const addTool = (tool, namespace = null) => {
    if (!tool) return;
    if (tool.type === 'namespace') {
      for (const child of tool.tools || []) addTool(child, tool.name);
      return;
    }
    const source = tool.function || tool;
    const originalName = source.name || (tool.type === 'tool_search' ? 'tool_search' : null);
    if (!originalName) {
      // web_search/computer_use/mcp_read 等特殊工具没有 function 名称，chat 通道无法承载：
      // 丢弃必须可见（此前完全无声，目录声明的能力与实际不符无从发现）。
      if (onDrop && tool?.type) onDrop({ type: tool.type });
      return;
    }
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

// ---------- Chat 请求 → Responses 请求（反向桥接） ----------

function stringifyArguments(argumentsValue) {
  if (typeof argumentsValue === 'string') return argumentsValue;
  if (argumentsValue === undefined || argumentsValue === null) return '{}';
  try { return JSON.stringify(argumentsValue); } catch { return '{}'; }
}

function chatContentItem(content, options = {}) {
  // Chat 正文（字符串或 text/image_url part 数组）→ Responses content part 数组。
  if (typeof content === 'string') return content ? [{ type: 'input_text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text' || part.type === 'input_text') {
      if (part.text) parts.push({ type: 'input_text', text: part.text });
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      if (options.vision === false) continue;
      const source = typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url;
      if (source?.url) parts.push({ type: 'input_image', image_url: source });
    }
  }
  return parts;
}

// Chat messages → Responses input items；工具名经 toolContext（convertResponsesTools 产物）
// 反查回原名与类型，保证别名（哈希后缀）不会以错误的名称发到上游。
export function chatToResponsesInput(messages, options = {}) {
  const byChatName = options.toolContext?.byChatName || {};
  const resolveTool = (chatName) => byChatName[chatName] || { type: 'function', name: chatName };
  const items = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : extractText(message.content);
      if (text) {
        const part = { type: 'input_text', text };
        if (role === 'developer') {
          items.push({ role: 'developer', content: [part] });
        } else {
          items.push({ role: 'system', content: [part] });
        }
      }
    } else if (role === 'user') {
      const content = chatContentItem(message.content, options);
      if (content.length) items.push({ role: 'user', content });
    } else if (role === 'assistant') {
      const content = chatContentItem(message.content, options);
      if (content.length) items.push({ role: 'assistant', content });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const chatName = call?.function?.name;
        const metadata = resolveTool(chatName || '');
        const callId = call.id || `call_${crypto.randomUUID()}`;
        if (metadata.type === 'custom') {
          let input = stringifyArguments(call.function?.arguments);
          try {
            const parsed = JSON.parse(input);
            input = typeof parsed.input === 'string' ? parsed.input : input;
          } catch { /* 保留原始参数 */ }
          items.push({
            type: 'custom_tool_call',
            call_id: callId,
            name: metadata.name || chatName || 'custom',
            input,
          });
        } else if (metadata.type === 'tool_search') {
          let query = '';
          try {
            query = JSON.parse(stringifyArguments(call.function?.arguments))?.query || '';
          } catch { query = stringifyArguments(call.function?.arguments); }
          items.push({ type: 'tool_search_call', call_id: callId, execution: 'client', query });
        } else {
          const item = {
            type: 'function_call',
            call_id: callId,
            name: metadata.name || chatName || 'tool',
            arguments: stringifyArguments(call.function?.arguments),
          };
          if (metadata.namespace) item.namespace = metadata.namespace;
          items.push(item);
        }
      }
    } else if (role === 'tool') {
      const output = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '');
      if (message.tool_call_id) {
        items.push({ type: 'function_call_output', call_id: message.tool_call_id, output });
      }
    }
  }
  return items;
}

// Chat tools（function/custom/tool_search）→ Responses tools；名称与 namespace 经上下文还原。
export function chatToolsToResponses(tools, options = {}) {
  const byChatName = options.toolContext?.byChatName || {};
  const converted = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type !== 'function') continue;
    const fn = tool.function || {};
    const metadata = byChatName[fn.name] || null;
    const entry = {
      type: 'function',
      name: metadata?.name || fn.name || 'tool',
      parameters: fn.parameters || { type: 'object', properties: {} },
    };
    if (fn.description !== undefined) entry.description = fn.description;
    if (metadata?.namespace) entry.namespace = metadata.namespace;
    converted.push(entry);
  }
  return converted.length ? converted : undefined;
}

// Chat tool_choice → Responses 形状：{"type":"function","function":{"name"}} →
// {"type":"function","name"}；auto/none/required 字符串原样（两端语义一致）。
// 其余形状（无法安全转换）返回 undefined（不转发，官方对未知形状 400）。
export function chatToolChoiceToResponses(choice) {
  if (typeof choice === 'string') {
    return choice === 'auto' || choice === 'none' || choice === 'required' ? choice : undefined;
  }
  if (choice?.type === 'function' && choice.function?.name) {
    return { type: 'function', name: choice.function.name };
  }
  return undefined;
}

// Responses 线工具名合法性：非空、≤64 字符、仅 [A-Za-z0-9_-]。
// 官方上游对非法名直接 400；提前校验给出清晰报错并省一次注定失败的上游往返。
// 返回第一个非法名（全部合法返回 null）。
export function firstInvalidResponsesToolName(tools) {
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type !== 'function' && tool.type !== 'custom' && tool.type !== 'tool_search') continue;
    const name = typeof tool.name === 'string' ? tool.name : '';
    if (!name || name.length > 64 || !/^[A-Za-z0-9_-]+$/.test(name)) return name || '(空)';
  }
  return null;
}
