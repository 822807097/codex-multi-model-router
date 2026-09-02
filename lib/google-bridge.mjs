// ---------- OpenAI Chat ⇄ Google Antigravity (Gemini generateContent) 桥接 ----------
// 谷歌 AI Pro 订阅经 Antigravity 官方客户端协议调用：
//   POST https://cloudcode-pa.googleapis.com/v1internal:generateContent（非流）
//   POST https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse（SSE）
// 外层封装 {project, model, request, userAgent:'antigravity', requestId:'agent-<uuid>'}，
// request 内核 = 标准 Gemini generateContent 格式（contents/parts/systemInstruction/tools）。
// 转换语义逐行对齐开源参考（lockieluke/antigravity-openai converter.ts）并补齐其缺失的
// 流式 functionCall 与思考增量。
// 消息角色映射：system→systemInstruction；assistant→role:'model'；user/tool→role:'user'
// （Gemini 只有 user/model 两种角色，工具结果用 functionResponse part 表达）。

import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// ---------- Gemini 工具参数 schema 净化 ----------
// 智能体客户端（ZCode 等）发送的工具参数是完整 JSON Schema，含大量 Gemini
// function declarations 不支持的关键字（$schema、propertyNames、additionalProperties、
// default、oneOf 层级…）——原样透传会被谷歌 400 "Unknown name ... Cannot find field"。
// 这里按 Gemini 支持的 OpenAPI 子集做**允许清单**递归净化，并尽力解析 $ref。

const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength',
  'maxLength', 'pattern', 'anyOf', 'oneOf', 'allOf', 'title',
]);

function sanitizeGeminiSchema(schema, defs = null, seenRefs = new Set()) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  // $ref：解析 JSON 指针（#/$defs/Name、#/definitions/Name、#/properties/X），带环检测
  if (typeof schema.$ref === 'string') {
    const pointer = schema.$ref.startsWith('#/') ? schema.$ref.slice(2) : null;
    if (pointer && defs && !seenRefs.has(schema.$ref)) {
      const target = pointer.split('/').reduce((node, seg) => {
        const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
        return node && typeof node === 'object' ? node[key] : undefined;
      }, defs);
      if (target && typeof target === 'object') {
        const nextSeen = new Set(seenRefs);
        nextSeen.add(schema.$ref);
        const resolved = sanitizeGeminiSchema(target, defs, nextSeen);
        // $ref 节点上除 $ref 外的其他键（如 description）合并保留
        const merged = { ...resolved };
        for (const [key, value] of Object.entries(schema)) {
          if (key !== '$ref' && merged[key] === undefined) merged[key] = value;
        }
        return merged;
      }
    }
    return { type: 'object', description: schema.description || '' }; // 无法解析的引用退化为通用对象
  }
  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue; // $schema/propertyNames/additionalProperties/default… 一律剥离
    if (key === 'type' && Array.isArray(value)) {
      // JSON Schema 的 ['string','null'] → Gemini 的 type:'string' + nullable:true
      const nonNull = value.filter((item) => item !== 'null');
      output.type = nonNull[0] || 'string';
      if (nonNull.length !== value.length) output.nullable = true;
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const sanitized = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        sanitized[propName] = sanitizeGeminiSchema(propSchema, defs, seenRefs);
      }
      output.properties = sanitized;
      continue;
    }
    if ((key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf') && value) {
      if (Array.isArray(value)) {
        output[key] = value.map((item) => sanitizeGeminiSchema(item, defs, seenRefs));
      } else if (typeof value === 'object') {
        output[key] = sanitizeGeminiSchema(value, defs, seenRefs);
      }
      continue;
    }
    output[key] = value;
  }
  // 净化后一无所有时至少声明对象类型，避免谷歌解析报错
  if (Object.keys(output).length === 0) return { type: 'object', properties: {} };
  return output;
}

/** chat 请求体 → Gemini generateContent 的 request 内核（不含外层封装）。
 * options.thinkingLevel：档位变体 slug（-low/-medium/-high 后缀）解析出的思考档位，
 * 设置 generationConfig.thinkingConfig（上游载体是 -tiered 后缀的真实模型）。
 * options.isClaude：谷歌订阅里的 Claude 系模型走专属语义——工具强制 VALIDATED 模式、
 * thinking 用 snake_case thinking_budget（对齐开源参考 converter 的 resolveModel 分支）。 */
export function chatToGenerateRequest(chatBody = {}, options = {}) {
  const isClaude = options.isClaude === true;
  const messages = Array.isArray(chatBody.messages) ? chatBody.messages : [];
  const systemParts = [];
  const contents = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) systemParts.push({ text });
      continue;
    }
    const parts = [];
    // 工具结果消息：{role:'tool', tool_call_id, content} → functionResponse part
    //（Gemini 的 response 必须是 Struct 对象——合法 JSON 标量也要包 {result}）
    if (role === 'tool') {
      let response;
      if (typeof message.content === 'string') {
        try {
          response = JSON.parse(message.content);
        } catch { response = { result: message.content }; }
        if (response === null || typeof response !== 'object') {
          response = { result: response };
        }
      } else if (message.content === null || message.content === undefined) {
        response = { result: '' };
      } else if (Array.isArray(message.content)) {
        // 数组形态的 content 是多模态消息体，不是结构化结果——包 {result} 保住 Struct 语义
        response = { result: message.content };
      } else {
        response = message.content;
      }
      parts.push({
        functionResponse: { name: message.name || message.tool_call_id || 'tool', response },
      });
    } else {
      // user / assistant 的内容（字符串或多模态数组）
      const content = message.content;
      if (typeof content === 'string') {
        if (content) parts.push({ text: content });
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item?.type === 'text' && item.text) {
            parts.push({ text: item.text });
          } else if (item?.type === 'image_url' && typeof item.image_url?.url === 'string') {
            const dataUrl = item.image_url.url;
            const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
            if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
      }
      // assistant 工具调用 → functionCall part（参数是 JSON 字符串，需解析为对象）
      if (role === 'assistant' && Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call?.function?.name) continue;
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 保持空对象 */ }
          parts.push({ functionCall: { name: call.function.name, args } });
        }
      }
    }
    if (parts.length === 0) continue;
    contents.push({ role: role === 'assistant' ? 'model' : 'user', parts });
  }

  const request = { contents };
  if (systemParts.length > 0) request.systemInstruction = { parts: systemParts };

  const generationConfig = {};
  if (Number.isFinite(chatBody.temperature)) generationConfig.temperature = chatBody.temperature;
  if (Number.isFinite(chatBody.top_p)) generationConfig.topP = chatBody.top_p;
  // 输出预算钳制：智能体客户端常发 max_tokens=128000（或新参数 max_completion_tokens），
  // 谷歌按「输入+输出预留」做分钟配额预检——预留过大直接秒 429 RESOURCE_EXHAUSTED
  // （2026-08-30 ZCode 实测捕获定位）。32768 对智能体单轮输出绰绰有余，且思考 token
  // 另行计算不受此值影响。
  const requestedMax = Number.isFinite(chatBody.max_tokens)
    ? chatBody.max_tokens
    : (Number.isFinite(chatBody.max_completion_tokens) ? chatBody.max_completion_tokens : 0);
  if (requestedMax > 0) {
    generationConfig.maxOutputTokens = Math.min(requestedMax, 32768);
  }
  // 档位变体：Antigravity Tools 式合成名（-high/-medium/-low）→ thinkingLevel
  if (options.thinkingLevel) {
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: options.thinkingLevel };
  }
  // Claude 系思考模型：snake_case thinking_budget（Gemini 用 camelCase thinkingLevel）。
  // 客户端未显式给输出预算时补 32768 兜底（思考吃掉预算会导致正文为空）；
  // 客户端显式给过则尊重其钳制值，不再抬升（抬升=预检 429 复发，审查 B1）。
  if (isClaude && (options.thinkingLevel || /-thinking$/i.test(String(chatBody.model || '')))) {
    generationConfig.thinkingConfig = { include_thoughts: true, thinking_budget: 16384 };
    if (!generationConfig.maxOutputTokens) generationConfig.maxOutputTokens = 32768;
  }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

  // chat tools（function）→ Gemini functionDeclarations
  const tools = Array.isArray(chatBody.tools) ? chatBody.tools : [];
  // 客户端本地 MCP 工具（mcp__*，如 Codex 桌面端 Apps 目录的 343 个 mcp__codex_apps__*
  // 定义，实测单份 366KB）：这些工具由客户端本机执行，谷歌上游既不认识也执行不了，
  // 白白吃掉输入 token 配额（每轮全量重发时尤甚）。剥离不影响可用性——模型调不了
  // 本地 MCP，反而避免它幻觉调用不存在的工具名（2026-09-02 实测 557KB 请求中
  // 工具定义占 2/3，剥离后输入配额消耗立降约 66%）。
  const mcpToolPattern = /^mcp__/;
  let droppedMcpTools = 0;
  const declarations = tools
    .filter((tool) => tool?.type === 'function' && tool.function?.name)
    .filter((tool) => {
      if (mcpToolPattern.test(tool.function.name)) { droppedMcpTools += 1; return false; }
      return true;
    })
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description || '',
      // $ref 指针以 parameters 文档自身为根（#/$defs/...），把 schema 同时作为 defs 传入
      parameters: (() => {
        const params = tool.function.parameters || { type: 'object', properties: {} };
        return sanitizeGeminiSchema(params, params);
      })(),
    }));
  if (droppedMcpTools > 0 && options.log) {
    options.log({ event: 'google.bridge.dropped_mcp_tools', count: droppedMcpTools });
  }
  if (declarations.length > 0) {
    request.tools = [{ functionDeclarations: declarations }];
  }
  // tool_choice → toolConfig（NONE/ANY/AUTO/ANY+allowedFunctionNames）。
  // Claude 系模型最终统一收口为 VALIDATED（对齐参考实现）：AUTO 语义在 Claude 上
  // 不可靠，NONE/指定函数的显式约束保留原样，其余一律 VALIDATED。
  if (request.tools) {
    let config = null;
    if (chatBody.tool_choice === 'none') config = { functionCallingConfig: { mode: 'NONE' } };
    else if (chatBody.tool_choice === 'required') config = { functionCallingConfig: { mode: 'ANY' } };
    else if (typeof chatBody.tool_choice === 'object' && chatBody.tool_choice?.type === 'function' && chatBody.tool_choice.function?.name) {
      config = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [chatBody.tool_choice.function.name] } };
    }
    if (config) request.toolConfig = config;
    else if (isClaude) request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
    else if (chatBody.tool_choice !== undefined) request.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }
  return request;
}

function genUsageToChat(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== 'object') return null;
  const prompt = Number(usageMetadata.promptTokenCount) || 0;
  const completion = Number(usageMetadata.candidatesTokenCount) || 0;
  const total = Number(usageMetadata.totalTokenCount) || (prompt + completion);
  if (!prompt && !completion && !total) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function chatFinishReason(finishReason, hasToolCalls) {
  if (hasToolCalls) return 'tool_calls';
  if (finishReason === 'MAX_TOKENS') return 'length';
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT' || finishReason === 'BLOCKLIST') return 'content_filter';
  return 'stop';
}

/** Gemini 非流式响应 → chat completion JSON。 */
export function generateResponseToChatCompletion(geminiResponse, model, id = `chatcmpl-${randomUUID().slice(0, 12)}`) {
  const candidate = Array.isArray(geminiResponse?.candidates) ? geminiResponse.candidates[0] : null;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let callIndex = 0;
  for (const part of parts) {
    if (part?.thought === true) { reasoning += part.text || ''; continue; }
    if (typeof part?.text === 'string' && part.text) content += part.text;
    if (part?.functionCall?.name) {
      toolCalls.push({
        id: `call_${randomUUID().slice(0, 12)}`,
        type: 'function',
        function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
      });
      callIndex += 1;
    }
  }
  const choice = {
    index: 0,
    message: {
      role: 'assistant',
      content: content || null,
      ...(callIndex > 0 ? { tool_calls: toolCalls } : {}),
    },
    finish_reason: chatFinishReason(candidate?.finishReason, callIndex > 0),
  };
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
    ...(genUsageToChat(geminiResponse?.usageMetadata) ? { usage: genUsageToChat(geminiResponse?.usageMetadata) } : {}),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
  };
}

/**
 * Antigravity SSE（data: {response:{candidates,usageMetadata}}）→ chat SSE。
 * 与 createResponsesSseToChatTransform 相同的输出契约：role 首帧、content/reasoning_content
 * 增量、tool_calls 增量帧（functionCall 一次到位：id+name+完整参数）、finish/usage 帧、[DONE]。
 * 上游断流未发 STOP 时按现有内容收口（与 chat 流桥一致的行为）。
 */
export function createGeminiSseToChatTransform(model, options = {}) {
  const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
  let sentRole = false;
  let toolCallCount = 0;
  let finishSent = false;
  // SSE 行缓冲用 Buffer 累积 + TextDecoder 流式解码：多字节 UTF-8（中文/emoji）
  // 跨 TCP 分包时按字符串拼接会产生 U+FFFD 乱码（审查中4），StringDecoder 按字节边界切分。
  const lineDecoder = new StringDecoder('utf8');
  let buffer = '';
  const emitUsage = options.emitUsage !== false;

  const chunkOf = (delta, finishReason = null, usage = null) => JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });

  // 路由管线（readStreamSnippet / pipeChatCompletionsResponse）按 Buffer 聚合上游块，
  // 本转换器输出统一为 Buffer。
  const pushData = (stream, text) => stream.push(Buffer.from(`data: ${text}\n\n`, 'utf8'));

  const ensureRole = (stream) => {
    if (sentRole) return;
    pushData(stream, chunkOf({ role: 'assistant', content: '' }));
    sentRole = true;
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffer += lineDecoder.write(chunk);
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let parsed;
          try { parsed = JSON.parse(payload); } catch { continue; }
          // Antigravity 流帧把 Gemini 响应包在 response 字段里；兼容裸 candidates 形态。
          const response = parsed?.response && typeof parsed.response === 'object' ? parsed.response : parsed;
          const candidate = Array.isArray(response?.candidates) ? response.candidates[0] : null;
          const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
          for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            if (part.thought === true) {
              ensureRole(this);
              if (part.text) pushData(this, chunkOf({ reasoning_content: part.text }));
              continue;
            }
            if (typeof part.text === 'string' && part.text) {
              ensureRole(this);
              pushData(this, chunkOf({ content: part.text }));
            }
            if (part.functionCall?.name) {
              ensureRole(this);
              pushData(this, chunkOf({
                tool_calls: [{
                  index: toolCallCount,
                  id: `call_${randomUUID().slice(0, 12)}`,
                  type: 'function',
                  function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) },
                }],
              }));
              toolCallCount += 1;
            }
          }
          const usage = emitUsage ? genUsageToChat(response?.usageMetadata) : null;
          if (candidate?.finishReason && !finishSent) {
            pushData(this, chunkOf({}, chatFinishReason(candidate.finishReason, toolCallCount > 0), usage));
            finishSent = true;
          }
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      if (!finishSent) {
        pushData(this, chunkOf({}, chatFinishReason(null, toolCallCount > 0)));
      }
      this.push(Buffer.from('data: [DONE]\n\n', 'utf8'));
      callback();
    },
  });
}
