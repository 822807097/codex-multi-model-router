import { trimToBudget } from './chat-protocol.mjs';

// ---------- 每模型上下文能力与完整输入预算 ----------
// 默认值故意保守；具体模型应在 modelCapabilities 中按正则覆盖。
const DEFAULT_CAPABILITY = Object.freeze({
  contextWindow: 128_000,
  maxOutputTokens: 16_000,
  safetyRatio: 0.85,
  protocolReserveTokens: 512,
  imageTokens: 2_048,
});

const CAPABILITY_FIELDS = Object.keys(DEFAULT_CAPABILITY);

function capabilityFields(source) {
  // 只接受已知数值字段，避免把配置注释或其他 target 属性混入能力对象。
  const result = {};
  for (const field of CAPABILITY_FIELDS) {
    if (source?.[field] !== undefined) result[field] = Number(source[field]);
  }
  return result;
}

function matchesModel(pattern, model) {
  // 单条非法正则仅视为不匹配，不影响其他模型继续路由。
  try { return new RegExp(pattern).test(model); } catch { return false; }
}

// 模型正则配置优先，其次 target，最后才使用全局兼容配置和保守默认值。
export function resolveModelCapability(config = {}, target = {}, model = '') {
  const globalContext = config.modelContext || {};
  const matched = (config.modelCapabilities || []).find((item) => item?.match && matchesModel(item.match, model));
  return {
    ...DEFAULT_CAPABILITY,
    ...capabilityFields(globalContext),
    ...capabilityFields(target),
    ...capabilityFields(matched),
  };
}

function textTokens(text) {
  // UTF-8 字节数/3 对中英文混合代码提示保持偏保守的零依赖估算。
  return Math.ceil(Buffer.byteLength(String(text), 'utf8') / 3);
}

// 零依赖近似估算：文本按 UTF-8 三字节一个 token，图片使用固定视觉预算，避免 data URL 撑爆估算。
export function estimateChatValueTokens(value, capability = DEFAULT_CAPABILITY) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return textTokens(value);
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateChatValueTokens(item, capability), 0);
  }
  if (typeof value === 'object') {
    if (value.type === 'input_image' || value.type === 'image_url') {
      return Number(capability.imageTokens) || DEFAULT_CAPABILITY.imageTokens;
    }
    let tokens = 2;
    for (const [key, child] of Object.entries(value)) {
      tokens += textTokens(key) + estimateChatValueTokens(child, capability);
    }
    return tokens;
  }
  return 0;
}

function estimateMessageTokens(message, capability) {
  // 每条消息增加固定协议开销，覆盖 role 与 Chat 序列化边界。
  return 4 + estimateChatValueTokens(message, capability);
}

function countConversationGroups(messages) {
  // 用户消息开启新轮次，工具调用及其 output 始终留在同一轮内。
  let cursor = 0;
  while (cursor < messages.length && messages[cursor]?.role === 'system') cursor += 1;
  let groups = 0;
  let hasCurrent = false;
  for (const message of messages.slice(cursor)) {
    if (message?.role === 'user') {
      if (hasCurrent) groups += 1;
      hasCurrent = true;
    } else if (!hasCurrent) {
      hasCurrent = true;
    }
  }
  return groups + (hasCurrent ? 1 : 0);
}

export function fitMessagesToContext(messages, tools, capability) {
  // 输入预算 = 安全窗口 - 最大输出 - 协议余量 - 工具定义；只裁完整旧轮次。
  const safeCapability = { ...DEFAULT_CAPABILITY, ...capability };
  const contextBudget = Math.floor(safeCapability.contextWindow * safeCapability.safetyRatio);
  const toolTokens = estimateChatValueTokens(tools || [], safeCapability);
  const messageBudget = Math.max(0,
    contextBudget
      - safeCapability.maxOutputTokens
      - safeCapability.protocolReserveTokens
      - toolTokens);
  const estimate = (message) => estimateMessageTokens(message, safeCapability);
  const beforeGroups = countConversationGroups(messages);
  const fittedMessages = trimToBudget(messages, messageBudget, estimate);
  const messageTokens = fittedMessages.reduce((sum, message) => sum + estimate(message), 0);
  return {
    messages: fittedMessages,
    fits: messageTokens <= messageBudget,
    trimmedGroups: beforeGroups - countConversationGroups(fittedMessages),
    messageTokens,
    toolTokens,
    messageBudget,
    contextBudget,
  };
}
