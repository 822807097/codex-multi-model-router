import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { createSseDecoder } from './sse-decoder.mjs';

// ---------- Chat SSE → Responses SSE 增量状态机 ----------
// 每个请求独占一个实例，文本、推理和并行工具调用均不共享可变状态。
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_ACCUMULATED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOOL_CALLS = 128;

// 把不同 OpenAI-compatible 网关的 usage 字段收敛到 Responses 结构。
function mapUsage(usage) {
  if (!usage) return undefined;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

function fragmentText(value) {
  // 少数网关会把 content/arguments 作为非字符串返回，统一保留为可拼接文本。
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function appendToolFragment(current, fragment, options = {}) {
  // 标准协议默认按真 delta 拼接；只有目标显式声明时才兼容累计帧。
  if (!fragment) return { value: current, delta: '' };
  if (options.ignoreExactRepeat && fragment === current) return { value: current, delta: '' };
  if (options.cumulative && fragment.length > current.length && fragment.startsWith(current)) {
    return { value: fragment, delta: fragment.slice(current.length) };
  }
  return { value: current + fragment, delta: fragment };
}

function canonicalizeArguments(argumentsText) {
  // 合法 JSON 压缩为稳定文本，非法片段原样交给客户端诊断。
  if (!argumentsText) return '{}';
  try { return JSON.stringify(JSON.parse(argumentsText)); } catch { return argumentsText; }
}

// 状态机只关心协议事件；socket 生命周期、心跳和错误回写由主入口负责。
class ChatSseToResponsesTransform extends Transform {
  constructor(model, toolContext = {}, options = {}) {
    super();
    this.model = model;
    this.responseId = `resp_${crypto.randomUUID()}`;
    this.sseDecoder = createSseDecoder({ maxEventBytes: MAX_SSE_EVENT_BYTES });
    this.created = false;
    this.completed = false;
    this.nextOutputIndex = 0;
    this.output = [];
    this.text = null;
    this.reasoning = null;
    this.contentMode = 'undetermined';
    this.contentBuffer = '';
    this.tools = new Map();
    this.missingIndexKeys = new Map();
    this.usage = undefined;
    this.upstreamId = null;
    this.finishReason = null;
    this.toolContext = toolContext || {};
    this.knownChatToolNames = Object.keys(this.toolContext.byChatName || {});
    this.cumulativeToolCallDeltas = options.cumulativeToolCallDeltas === true;
    this.maxAccumulatedBytes = Math.max(1, Number(options.maxAccumulatedBytes) || DEFAULT_MAX_ACCUMULATED_BYTES);
    this.maxToolCalls = Math.max(1, Number(options.maxToolCalls) || DEFAULT_MAX_TOOL_CALLS);
    this.accumulatedBytes = 0;
  }

  emitEvent(event) {
    this.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  ensureCreated(event = {}) {
    // Responses 生命周期必须从 created/in_progress 开始，哪怕上游首帧只有 usage。
    if (this.created) return;
    this.created = true;
    this.upstreamId = event.id || null;
    this.emitEvent({
      type: 'response.created',
      response: this.responseObject('in_progress', []),
    });
    this.emitEvent({
      type: 'response.in_progress',
      response: this.responseObject('in_progress', []),
    });
  }

  responseObject(status, output = this.output) {
    const response = {
      id: this.responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: this.model,
      output,
      error: null,
      incomplete_details: null,
    };
    if (this.usage) response.usage = this.usage;
    return response;
  }

  reserveAccumulatedBytes(...fragments) {
    const added = fragments.reduce((sum, fragment) => sum + Buffer.byteLength(fragment || '', 'utf8'), 0);
    if (this.accumulatedBytes + added <= this.maxAccumulatedBytes) {
      this.accumulatedBytes += added;
      return true;
    }
    this.failResponse({
      type: 'upstream_error',
      code: 'response_too_large',
      message: `chat accumulated response exceeds ${this.maxAccumulatedBytes} bytes`,
    });
    return false;
  }

  allocateOutput(item) {
    // output_index 按首次出现顺序分配，允许推理、正文和工具调用交错到达。
    const outputIndex = this.nextOutputIndex++;
    item.outputIndex = outputIndex;
    this.emitEvent({
      type: 'response.output_item.added',
      response_id: this.responseId,
      output_index: outputIndex,
      item: item.added,
    });
    return outputIndex;
  }

  appendReasoning(delta) {
    // DeepSeek 等模型的 reasoning_content 映射为 Responses reasoning summary。
    if (!delta) return;
    if (!this.reasoning) {
      const id = `rs_${crypto.randomUUID()}`;
      this.reasoning = {
        id,
        text: '',
        added: { id, type: 'reasoning', status: 'in_progress', summary: [] },
      };
      this.allocateOutput(this.reasoning);
      this.emitEvent({
        type: 'response.reasoning_summary_part.added',
        item_id: id,
        output_index: this.reasoning.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
    this.reasoning.text += delta;
    this.emitEvent({
      type: 'response.reasoning_summary_text.delta',
      item_id: this.reasoning.id,
      output_index: this.reasoning.outputIndex,
      summary_index: 0,
      delta,
    });
  }

  appendText(delta) {
    // 首个正文分片延迟创建 message，避免纯工具响应产生空消息。
    if (!delta) return;
    if (!this.text) {
      const id = `msg_${crypto.randomUUID()}`;
      this.text = {
        id,
        text: '',
        added: { id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      };
      this.allocateOutput(this.text);
      this.emitEvent({
        type: 'response.content_part.added',
        item_id: id,
        output_index: this.text.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    this.text.text += delta;
    this.emitEvent({
      type: 'response.output_text.delta',
      item_id: this.text.id,
      output_index: this.text.outputIndex,
      content_index: 0,
      delta,
      logprobs: [],
    });
  }

  // 部分国内兼容网关把推理塞在 content 的前导 <think> 块中，并可能拆开标签。
  appendContent(delta) {
    if (!delta) return;
    this.contentBuffer += delta;
    while (this.contentBuffer) {
      if (this.contentMode === 'undetermined') {
        const trimmed = this.contentBuffer.trimStart();
        if (trimmed.startsWith('<think>')) {
          this.contentMode = 'reasoning';
          this.contentBuffer = trimmed.slice('<think>'.length);
          continue;
        }
        if (!trimmed || '<think>'.startsWith(trimmed)) return;
        this.contentMode = 'text';
      }
      if (this.contentMode === 'text') {
        this.appendText(this.contentBuffer);
        this.contentBuffer = '';
        return;
      }

      const closeTag = '</think>';
      const closeIndex = this.contentBuffer.indexOf(closeTag);
      if (closeIndex !== -1) {
        this.appendReasoning(this.contentBuffer.slice(0, closeIndex));
        this.contentBuffer = this.contentBuffer.slice(closeIndex + closeTag.length);
        this.contentMode = 'text';
        continue;
      }
      let heldSuffixLength = 0;
      const maxSuffix = Math.min(closeTag.length - 1, this.contentBuffer.length);
      for (let length = maxSuffix; length > 0; length -= 1) {
        if (closeTag.startsWith(this.contentBuffer.slice(-length))) {
          heldSuffixLength = length;
          break;
        }
      }
      const safeLength = this.contentBuffer.length - heldSuffixLength;
      this.appendReasoning(this.contentBuffer.slice(0, safeLength));
      this.contentBuffer = this.contentBuffer.slice(safeLength);
      return;
    }
  }

  flushContent() {
    if (!this.contentBuffer) return;
    if (this.contentMode === 'reasoning') this.appendReasoning(this.contentBuffer);
    else this.appendText(this.contentBuffer);
    this.contentBuffer = '';
  }

  appendToolCall(fragment, fallbackIndex) {
    // 优先用上游 index 聚合同一调用；缺 index 时用 call_id 和帧内位置兜底。
    if (this.completed) return;
    let key;
    if (Number.isInteger(fragment?.index)) {
      key = `index:${fragment.index}`;
      // 某些兼容网关只在首帧给 index；后续无 index/id 时仍应按帧内位置续接。
      this.missingIndexKeys.set(fallbackIndex, key);
    } else if (fragment?.id) {
      const existing = [...this.tools.entries()].find(([, tool]) => tool.callId === fragment.id);
      key = existing?.[0] || `id:${fragment.id}`;
      this.missingIndexKeys.set(fallbackIndex, key);
    } else {
      key = this.missingIndexKeys.get(fallbackIndex) || `missing:${fallbackIndex}`;
      this.missingIndexKeys.set(fallbackIndex, key);
    }
    let tool = this.tools.get(key);
    if (!tool) {
      if (this.tools.size >= this.maxToolCalls) {
        this.failResponse({
          type: 'upstream_error',
          code: 'too_many_tool_calls',
          message: `chat tool calls exceed ${this.maxToolCalls}`,
        });
        return;
      }
      tool = {
        id: `fc_${crypto.randomUUID()}`,
        callId: fragment?.id || `call_${crypto.randomUUID()}`,
        name: '',
        arguments: '',
        emitted: false,
        emittedArgumentsLength: 0,
      };
      this.tools.set(key, tool);
    }
    if (!tool.emitted && fragment?.id) tool.callId = fragment.id;
    const nameUpdate = appendToolFragment(tool.name, fragmentText(fragment?.function?.name), {
      ignoreExactRepeat: this.cumulativeToolCallDeltas,
      cumulative: this.cumulativeToolCallDeltas,
    });
    const argumentsUpdate = appendToolFragment(tool.arguments, fragmentText(fragment?.function?.arguments), {
      ignoreExactRepeat: this.cumulativeToolCallDeltas,
      cumulative: this.cumulativeToolCallDeltas,
    });
    if (!this.reserveAccumulatedBytes(nameUpdate.delta, argumentsUpdate.delta)) return;
    tool.name = nameUpdate.value;
    tool.arguments = argumentsUpdate.value;
    tool.metadata = this.toolContext.byChatName?.[tool.name] || tool.metadata || null;

    const mayBePartialName = tool.name
      && this.knownChatToolNames.some((name) => name !== tool.name && name.startsWith(tool.name));
    if (!tool.emitted && tool.name && !mayBePartialName) {
      this.startToolItem(tool);
    }
    if (tool.emitted && (tool.metadata?.type || 'function') === 'function' && tool.arguments.length > tool.emittedArgumentsLength) {
      const delta = tool.arguments.slice(tool.emittedArgumentsLength);
      tool.emittedArgumentsLength = tool.arguments.length;
      this.emitEvent({
        type: 'response.function_call_arguments.delta',
        item_id: tool.id,
        output_index: tool.outputIndex,
        delta,
      });
    }
  }

  startToolItem(tool) {
    // 普通函数不冻结可能尚未拼完的名称；特殊工具则使用显式转换上下文还原类型。
    if (tool.emitted) return;
    tool.metadata = this.toolContext.byChatName?.[tool.name]
      || tool.metadata
      || { type: 'function' };
    const common = { id: tool.id, status: 'in_progress', call_id: tool.callId };
    if (tool.metadata.type === 'custom') {
      tool.added = { ...common, type: 'custom_tool_call', name: tool.metadata.name, input: '' };
    } else if (tool.metadata.type === 'tool_search') {
      tool.added = { ...common, type: 'tool_search_call', execution: 'client', query: '' };
    } else {
      tool.added = {
        ...common,
        type: 'function_call',
        name: tool.metadata.name || tool.name || 'tool',
        arguments: '',
      };
      if (tool.metadata.namespace) tool.added.namespace = tool.metadata.namespace;
    }
    this.allocateOutput(tool);
    tool.emitted = true;
  }

  processPayload(payload) {
    // 单个 Chat data 帧只读取第一个 choice，符合 Codex 单候选请求语义。
    if (!payload || this.completed) return;
    if (payload === '[DONE]') {
      this.finalize();
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      // Chat SSE 的 data 只能是 JSON 或 [DONE]；心跳必须使用 SSE 注释行。
      this.failResponse({
        type: 'upstream_error',
        code: 'invalid_sse_json',
        message: 'chat upstream returned malformed JSON data',
      });
      return;
    }
    this.ensureCreated(event);
    if (event.error) {
      this.failResponse(event.error);
      return;
    }
    if (event.usage) this.usage = mapUsage(event.usage);
    const choice = event.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    const reasoningDelta = fragmentText(delta.reasoning_content ?? delta.reasoning ?? delta.thinking);
    const contentDelta = fragmentText(delta.content);
    if (!this.reserveAccumulatedBytes(reasoningDelta, contentDelta)) return;
    this.appendReasoning(reasoningDelta);
    this.appendContent(contentDelta);
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    toolCalls.forEach((toolCall, index) => this.appendToolCall(toolCall, index));
    if (delta.function_call) this.appendToolCall({ index: 0, function: delta.function_call }, 0);
  }

  processDecodedEvents(events) {
    for (const event of events) {
      if (event.data) this.processPayload(event.data);
      if (this.completed) break;
    }
  }

  failDecoder(error) {
    this.failResponse({
      type: 'upstream_error',
      code: error.code || 'invalid_sse',
      message: error.message || 'chat upstream returned invalid SSE',
    });
  }

  finalizeReasoning() {
    // done 事件和最终 output item 使用同一份累计文本。
    if (!this.reasoning) return;
    const item = {
      id: this.reasoning.id,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: this.reasoning.text }],
    };
    this.emitEvent({
      type: 'response.reasoning_summary_text.done',
      item_id: this.reasoning.id,
      output_index: this.reasoning.outputIndex,
      summary_index: 0,
      text: this.reasoning.text,
    });
    this.emitEvent({
      type: 'response.reasoning_summary_part.done',
      item_id: this.reasoning.id,
      output_index: this.reasoning.outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: this.reasoning.text },
    });
    this.emitEvent({ type: 'response.output_item.done', output_index: this.reasoning.outputIndex, item });
    this.output.push({ outputIndex: this.reasoning.outputIndex, item });
  }

  finalizeText() {
    // Responses message 的 part 与 item 两级完成事件必须成对出现。
    if (!this.text) return;
    const part = { type: 'output_text', text: this.text.text, annotations: [] };
    const item = { id: this.text.id, type: 'message', status: 'completed', role: 'assistant', content: [part] };
    this.emitEvent({
      type: 'response.output_text.done',
      item_id: this.text.id,
      output_index: this.text.outputIndex,
      content_index: 0,
      text: this.text.text,
      logprobs: [],
    });
    this.emitEvent({
      type: 'response.content_part.done',
      item_id: this.text.id,
      output_index: this.text.outputIndex,
      content_index: 0,
      part,
    });
    this.emitEvent({ type: 'response.output_item.done', output_index: this.text.outputIndex, item });
    this.output.push({ outputIndex: this.text.outputIndex, item });
  }

  finalizeTools() {
    // Chat function 在完成阶段按上下文还原为 Responses 的三类工具调用。
    for (const tool of this.tools.values()) {
      this.startToolItem(tool);
      if (tool.metadata.type === 'custom') {
        let input = tool.arguments;
        try {
          const parsed = JSON.parse(tool.arguments || '{}');
          input = typeof parsed.input === 'string' ? parsed.input : tool.arguments;
        } catch { /* 保留原始输入，交给客户端工具自行校验 */ }
        if (input) {
          this.emitEvent({
            type: 'response.custom_tool_call_input.delta',
            item_id: tool.id,
            output_index: tool.outputIndex,
            delta: input,
          });
        }
        const item = {
          id: tool.id,
          type: 'custom_tool_call',
          status: 'completed',
          call_id: tool.callId,
          name: tool.metadata.name,
          input,
        };
        this.emitEvent({
          type: 'response.custom_tool_call_input.done',
          item_id: tool.id,
          output_index: tool.outputIndex,
          input,
        });
        this.emitEvent({ type: 'response.output_item.done', output_index: tool.outputIndex, item });
        this.output.push({ outputIndex: tool.outputIndex, item });
        continue;
      }
      if (tool.metadata.type === 'tool_search') {
        let query = tool.arguments;
        let limit;
        try {
          const parsed = JSON.parse(tool.arguments || '{}');
          query = parsed.query || '';
          limit = parsed.limit;
        } catch { /* 使用原始参数作为 query */ }
        const item = {
          id: tool.id,
          type: 'tool_search_call',
          status: 'completed',
          call_id: tool.callId,
          execution: 'client',
          query,
        };
        if (limit !== undefined) item.limit = limit;
        this.emitEvent({ type: 'response.output_item.done', output_index: tool.outputIndex, item });
        this.output.push({ outputIndex: tool.outputIndex, item });
        continue;
      }
      const item = {
        id: tool.id,
        type: 'function_call',
        status: 'completed',
        call_id: tool.callId,
        name: tool.metadata.name || tool.name || 'tool',
        arguments: canonicalizeArguments(tool.arguments),
      };
      if (tool.metadata.namespace) item.namespace = tool.metadata.namespace;
      this.emitEvent({
        type: 'response.function_call_arguments.done',
        item_id: tool.id,
        output_index: tool.outputIndex,
        arguments: item.arguments,
      });
      this.emitEvent({ type: 'response.output_item.done', output_index: tool.outputIndex, item });
      this.output.push({ outputIndex: tool.outputIndex, item });
    }
  }

  finalize() {
    // 上游正常断流但未发 DONE 时也给客户端一个完整、可判定的终态。
    if (this.completed) return;
    this.ensureCreated();
    this.flushContent();
    const successfulReasons = new Set(['stop', 'tool_calls', 'function_call']);
    const knownIncomplete = this.finishReason === 'length' || this.finishReason === 'content_filter' || !this.finishReason;
    if (!knownIncomplete && !successfulReasons.has(this.finishReason)) {
      this.failResponse({
        type: 'upstream_error',
        code: 'unknown_finish_reason',
        message: `chat upstream returned unsupported finish_reason: ${this.finishReason}`,
      });
      return;
    }
    this.finalizeReasoning();
    this.finalizeText();
    this.finalizeTools();
    const output = this.output.sort((a, b) => a.outputIndex - b.outputIndex).map(({ item }) => item);
    if (!output.length && !this.finishReason) {
      this.failResponse({ type: 'upstream_error', code: 'stream_truncated', message: 'chat stream ended without output or finish_reason' });
      return;
    }
    // 成功停流却没有任何正文或工具调用（只剩推理）时，completed 会让智能体客户端静默结束本轮；
    // 必须判为失败，让客户端可见并可重试。
    const actionable = output.some((item) => (
      item.type === 'message'
      || item.type === 'function_call'
      || item.type === 'custom_tool_call'
      || item.type === 'tool_search_call'
    ));
    if (!knownIncomplete && !actionable) {
      this.failResponse({
        type: 'upstream_error',
        code: 'empty_stop_response',
        message: `chat upstream finished (${this.finishReason || 'no finish_reason'}) without message or tool calls`,
      });
      return;
    }
    const incomplete = knownIncomplete;
    const response = this.responseObject(incomplete ? 'incomplete' : 'completed', output);
    if (incomplete) {
      response.incomplete_details = {
        reason: this.finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens',
      };
    }
    this.emitEvent({ type: 'response.completed', response });
    this.push('data: [DONE]\n\n');
    this.completed = true;
    this.emit('response', response);
  }

  failResponse(error) {
    // 已开始 SSE 后统一用 response.failed + [DONE] 收口，禁止改写 HTTP 状态。
    if (this.completed) return;
    this.ensureCreated();
    const normalizedError = {
      type: error?.type || 'upstream_error',
      code: error?.code || 'upstream_error',
      message: error?.message || String(error || 'upstream error'),
    };
    const response = this.responseObject('failed', []);
    response.error = normalizedError;
    this.emitEvent({ type: 'response.failed', response });
    this.push('data: [DONE]\n\n');
    this.completed = true;
    this.emit('response', response);
  }

  _transform(chunk, _encoding, callback) {
    if (this.completed) {
      callback();
      return;
    }
    try {
      this.processDecodedEvents(this.sseDecoder.push(chunk));
    } catch (error) {
      this.failDecoder(error);
    }
    callback();
  }

  _flush(callback) {
    try {
      this.processDecodedEvents(this.sseDecoder.finish());
    } catch (error) {
      this.failDecoder(error);
    }
    this.finalize();
    callback();
  }
}

export function createChatSseToResponsesTransform(model, toolContext, options) {
  return new ChatSseToResponsesTransform(model, toolContext, options);
}

// ---------- Responses SSE → Chat SSE 反向状态机 ----------
// 供 chat 协议客户端（Trae 等）请求 responses-wire 目标时使用：上游原生 Responses 事件流
// 被转换为 chat.completion.chunk 增量帧。每个请求独占实例，文本/推理/工具调用互不共享状态。
class ResponsesSseToChatTransform extends Transform {
  constructor(model, options = {}) {
    super();
    this.model = model;
    this.chatId = `chatcmpl_${crypto.randomUUID()}`;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.sseDecoder = createSseDecoder({ maxEventBytes: MAX_SSE_EVENT_BYTES });
    this.created = false;
    this.completed = false;
    this.text = '';
    this.reasoning = '';
    // output_index -> 工具调用状态（并行调用各自持有增量）
    this.tools = new Map();
    this.toolOrder = [];
    // reasoning 多段摘要（summary_index 各自独立）按段记账已输出长度，
    // done 补发时不会把其他段误当增量。
    this.summaryEmitted = new Map();
    this.usage = undefined;
    this.finishReason = null;
    this.upstreamResponseId = null;
    this.includeUsage = options.includeUsage !== false;
    this.emitReasoning = options.emitReasoning !== false;
    this.maxAccumulatedBytes = Math.max(1, Number(options.maxAccumulatedBytes) || DEFAULT_MAX_ACCUMULATED_BYTES);
    this.accumulatedBytes = 0;
    this.toolCallCount = 0;
  }

  chunk(payload) {
    const choice = {
      index: 0,
      delta: payload.delta || {},
      finish_reason: payload.finish_reason ?? null,
    };
    const chunk = {
      id: this.chatId,
      object: 'chat.completion.chunk',
      created: this.createdAt,
      model: this.model,
      choices: [choice],
    };
    if (payload.usage) chunk.usage = payload.usage;
    this.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  ensureCreated() {
    if (this.created) return;
    this.created = true;
    this.chunk({ delta: { role: 'assistant', content: '' }, finish_reason: null });
  }

  reserveAccumulatedBytes(...fragments) {
    const added = fragments.reduce((sum, fragment) => sum + Buffer.byteLength(fragment || '', 'utf8'), 0);
    if (this.accumulatedBytes + added <= this.maxAccumulatedBytes) {
      this.accumulatedBytes += added;
      return true;
    }
    this.failResponse({
      type: 'upstream_error',
      code: 'response_too_large',
      message: `responses accumulated response exceeds ${this.maxAccumulatedBytes} bytes`,
    });
    return false;
  }

  appendReasoning(delta) {
    if (!delta || !this.emitReasoning) return;
    if (!this.reserveAccumulatedBytes(delta)) return;
    const emitted = this.reasoning;
    this.reasoning += delta;
    this.ensureCreated();
    this.chunk({
      delta: { reasoning_content: this.reasoning.slice(emitted.length) },
      finish_reason: null,
    });
  }

  appendText(delta) {
    if (!delta) return;
    if (!this.reserveAccumulatedBytes(delta)) return;
    this.ensureCreated();
    this.chunk({ delta: { content: delta }, finish_reason: null });
    this.text += delta;
  }

  // 工具调用：首次出现时发出带 id/name 的骨架帧，之后只发 arguments 增量。
  appendToolToolCall(tool, delta) {
    this.ensureCreated();
    if (!tool.nameEmitted) {
      tool.nameEmitted = true;
      this.chunk({
        delta: {
          tool_calls: [{
            index: tool.chatIndex,
            id: tool.callId,
            type: 'function',
            function: { name: tool.name, arguments: delta || '' },
          }],
        },
        finish_reason: null,
      });
      return;
    }
    if (delta) {
      this.chunk({
        delta: {
          tool_calls: [{ index: tool.chatIndex, function: { arguments: delta } }],
        },
        finish_reason: null,
      });
    }
  }

  emitUsage(usage) {
    if (!this.includeUsage) return;
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
    const mapped = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: usage?.total_tokens ?? inputTokens + outputTokens,
    };
    if (usage?.input_tokens_details?.cached_tokens !== undefined || usage?.prompt_tokens_details?.cached_tokens !== undefined) {
      mapped.prompt_tokens_details = {
        cached_tokens: usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
      };
    }
    if (usage?.output_tokens_details?.reasoning_tokens !== undefined || usage?.completion_tokens_details?.reasoning_tokens !== undefined) {
      mapped.completion_tokens_details = {
        reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0,
      };
    }
    this.chunk({ delta: {}, finish_reason: null, usage: mapped });
  }

  // 输出工具调用（response.output_item.added / done 统一入口）。
  // Codex 特有的 custom/tool_search 调用对 chat 客户端统一映射为 function 骨架。
  onToolItem(item, outputIndex) {
    const call = item?.item || item;
    const callType = call?.type || '';
    if (!['function_call', 'custom_tool_call', 'tool_search_call'].includes(callType)) return;
    const entry = this.tools.get(outputIndex) || {
      chatIndex: this.toolCallCount++,
      callId: call.call_id || call.id || `call_${crypto.randomUUID()}`,
      name: call.name || (callType === 'tool_search_call' ? 'tool_search' : 'tool'),
      arguments: '',
      nameEmitted: false,
      // finalizeTools 会把 entry 自身再喂回 onToolItem 补发骨架，必须带上类型。
      type: callType,
    };
    this.tools.set(outputIndex, entry);
    if (!entry.nameEmitted) this.appendToolToolCall(entry, '');
  }

  onFunctionCallArgumentsDelta(item) {
    const outputIndex = item.output_index;
    const entry = this.tools.get(outputIndex);
    if (!entry) return;
    if (!this.reserveAccumulatedBytes(item.delta || '')) return;
    entry.arguments += item.delta || '';
    this.appendToolToolCall(entry, item.delta || '');
  }

  finalizeTools() {
    // 未发出骨架帧的工具（如 custom input 只有一次 done）补发累计 arguments。
    for (const [outputIndex, entry] of this.tools.entries()) {
      if (!entry.nameEmitted) this.onToolItem({ item: entry }, outputIndex);
    }
  }

  mapUsageFromResponse(response) {
    this.usage = response?.usage || this.usage;
  }

  // 部分上游只在 output_item.done 携带完整 arguments/input（从不发增量帧）：
  // 按与已累计值的差额补发，客户端才能拿到完整工具参数。
  backfillToolFinalArguments(outputIndex, item) {
    const entry = this.tools.get(outputIndex);
    if (!entry) return;
    let final = '';
    if (item?.type === 'function_call' && typeof item.arguments === 'string') {
      final = item.arguments;
    } else if (item?.type === 'custom_tool_call' && typeof item.input === 'string') {
      final = item.input;
    } else if (item?.type === 'tool_search_call' && typeof item.query === 'string' && item.query) {
      final = JSON.stringify(item.limit !== undefined ? { query: item.query, limit: item.limit } : { query: item.query });
    }
    if (!final || final.length <= entry.arguments.length) return;
    const delta = final.slice(entry.arguments.length);
    if (!this.reserveAccumulatedBytes(delta)) return;
    entry.arguments = final;
    this.appendToolToolCall(entry, delta);
  }

  finish(finishReason) {
    if (this.completed) return;
    this.completed = true;
    this.finalizeTools();
    this.emitUsage(this.usage);
    const finalReason = finishReason || (this.tools.size > 0 ? 'tool_calls' : 'stop');
    this.chunk({ delta: {}, finish_reason: finalReason });
    this.push('data: [DONE]\n\n');
    this.emit('response', {
      id: this.upstreamResponseId || null,
      status: 'completed',
      model: this.model,
      output: [],
      usage: this.usage,
    });
  }

  failResponse(error) {
    if (this.completed) return;
    this.completed = true;
    // chat 惯例：流内错误用独立顶层 error 帧（OpenAI 兼容），然后 [DONE] 收口。
    this.push(`data: ${JSON.stringify({
      id: this.chatId,
      object: 'chat.completion.chunk',
      created: this.createdAt,
      model: this.model,
      choices: [],
      error: {
        type: error?.type || 'upstream_error',
        code: error?.code || 'upstream_error',
        message: error?.message || String(error || 'upstream error'),
      },
    })}\n\n`);
    this.push('data: [DONE]\n\n');
    this.emit('response', { id: this.upstreamResponseId || null, status: 'failed', model: this.model, error });
  }

  processPayload(payload) {
    if (this.completed || !payload) return;
    if (payload === '[DONE]') {
      this.finish(this.finishReason || 'stop');
      return;
    }
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      this.failResponse({ type: 'upstream_error', code: 'invalid_sse_json', message: 'responses upstream returned malformed JSON data' });
      return;
    }
    const type = event.type;
    if (event.error || (event.type === 'error')) {
      this.failResponse(event.error || { type: 'error', code: 'upstream_error', message: event.message || 'upstream error' });
      return;
    }
    if (type === 'response.created') {
      this.upstreamResponseId = event.response?.id || null;
      this.ensureCreated();
      return;
    }
    if (type === 'response.in_progress') {
      this.ensureCreated();
      return;
    }
    if (type === 'response.output_item.added') {
      this.ensureCreated();
      this.onToolItem({ item: event.item }, event.output_index);
      return;
    }
    if (type === 'response.content_part.added') {
      this.ensureCreated();
      return;
    }
    if (type === 'response.output_text.delta') {
      this.appendText(event.delta || '');
      return;
    }
    if (type === 'response.reasoning_summary_text.delta') {
      const delta = event.delta || '';
      if (delta) {
        const index = Number.isInteger(event.summary_index) ? event.summary_index : 0;
        this.summaryEmitted.set(index, (this.summaryEmitted.get(index) || 0) + delta.length);
      }
      this.appendReasoning(delta);
      return;
    }
    if (type === 'response.reasoning_summary_text.done') {
      // 摘要终态：上游可能只发 done 不发增量，按 summary_index 记账补齐该段
      // 未输出部分（多段摘要互不干扰）。
      const doneText = typeof event.text === 'string' ? event.text : '';
      const index = Number.isInteger(event.summary_index) ? event.summary_index : 0;
      const emitted = this.summaryEmitted.get(index) || 0;
      if (doneText && doneText.length > emitted) {
        this.summaryEmitted.set(index, doneText.length);
        this.appendReasoning(doneText.slice(emitted));
      }
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      this.onFunctionCallArgumentsDelta(event);
      return;
    }
    if (type === 'response.custom_tool_call_input.delta') {
      const entry = this.tools.get(event.output_index);
      if (entry) {
        if (!this.reserveAccumulatedBytes(event.delta || '')) return;
        entry.arguments += event.delta || '';
        this.appendToolToolCall(entry, event.delta || '');
      }
      return;
    }
    if (type === 'response.output_item.done') {
      // 工具调用终态：确保骨架帧已发（name 可能极晚才完整），并按 done 携带的
      // 完整参数补发增量未送达的差额。
      const item = event.item;
      if (item?.type === 'function_call' || item?.type === 'custom_tool_call' || item?.type === 'tool_search_call') {
        this.onToolItem({ item }, event.output_index);
        this.backfillToolFinalArguments(event.output_index, item);
      }
      return;
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = event.response || {};
      this.upstreamResponseId = response.id || this.upstreamResponseId;
      this.mapUsageFromResponse(response);
      this.finishReason = response.incomplete_details?.reason === 'max_output_tokens'
        ? 'length'
        : (response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : null);
      this.finish(this.finishReason);
      return;
    }
    if (type === 'response.failed') {
      this.failResponse(event.response?.error || { type: 'upstream_error', code: 'response_failed', message: 'upstream response failed' });
      return;
    }
    if (type === 'response.output_text.done' || type === 'response.content_part.done') {
      return;
    }
  }

  processDecodedEvents(events) {
    for (const event of events) {
      if (event.data) this.processPayload(event.data);
      if (this.completed) break;
    }
  }

  failDecoder(error) {
    this.failResponse({ type: 'upstream_error', code: error.code || 'invalid_sse', message: error.message || 'responses upstream returned invalid SSE' });
  }

  _transform(chunk, _encoding, callback) {
    if (this.completed) {
      callback();
      return;
    }
    try {
      this.processDecodedEvents(this.sseDecoder.push(chunk));
    } catch (error) {
      this.failDecoder(error);
    }
    callback();
  }

  _flush(callback) {
    try {
      this.processDecodedEvents(this.sseDecoder.finish());
    } catch (error) {
      this.failDecoder(error);
    }
    // 上游未发终态事件就断流：按当前内容收口（不强行报错，避免截断可用文本）。
    if (!this.completed) {
      this.finish(this.finishReason || 'stop');
    }
    callback();
  }
}

export function createResponsesSseToChatTransform(model, options) {
  return new ResponsesSseToChatTransform(model, options);
}

// ---------- 第三方 Responses SSE 桥接：function_call(exec) → custom_tool_call ----------
// DeepSeek 等兼容层只放行 function 型声明（custom 声明 400/不可见），模型因此
// 输出 function_call；桌面端只认 custom_tool_call 的 exec。此 Transform 在响应
// 流中把 exec 的调用项与参数增量帧改写回 custom_tool_call 形状（其余帧语义
// 原样重建），使「模型看到工具 → 调用 → 桌面端执行 → 结果回传」闭环成立
// （2026-09-02 探测实锤：function:exec 声明下模型正常输出 function_call(exec)）。
const EXEC_BRIDGE_TOOL_NAMES = new Set(['exec']);

export function createExecCustomToolBridgeTransform(options = {}) {
  return new ExecCustomToolBridgeTransform(options);
}

class ExecCustomToolBridgeTransform extends Transform {
  constructor(options = {}) {
    super();
    this.sseDecoder = createSseDecoder({
      maxEventBytes: Math.max(1, Number(options.maxEventBytes) || 4 * 1024 * 1024),
    });
    this.rewrote = 0;
  }

  rewriteEvent(decodedEvent) {
    if (!decodedEvent?.data) return null;
    let payload;
    try { payload = JSON.parse(decodedEvent.data); } catch { return null; }
    const type = payload?.type;
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = payload.item;
      if (item?.type === 'function_call' && EXEC_BRIDGE_TOOL_NAMES.has(item.name)) {
        const rewritten = { ...item, type: 'custom_tool_call' };
        delete rewritten.arguments;
        rewritten.input = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {});
        payload.item = rewritten;
        this.rewrote += 1;
        return { event: decodedEvent.event, data: JSON.stringify(payload) };
      }
      return null;
    }
    if (type === 'response.function_call_arguments.delta') {
      payload.type = 'response.custom_tool_call_input.delta';
      return { event: decodedEvent.event, data: JSON.stringify(payload) };
    }
    if (type === 'response.function_call_arguments.done') {
      payload.type = 'response.custom_tool_call_input.done';
      return { event: decodedEvent.event, data: JSON.stringify(payload) };
    }
    return null;
  }

  emitDecoded(decodedEvent) {
    const rewritten = this.rewriteEvent(decodedEvent);
    if (rewritten) {
      const part = (rewritten.event ? `event: ${rewritten.event}\n` : '') + `data: ${rewritten.data}\n\n`;
      this.push(Buffer.from(part, 'utf8'));
      return;
    }
    const part = (decodedEvent.event ? `event: ${decodedEvent.event}\n` : '') + `data: ${decodedEvent.data}\n\n`;
    this.push(Buffer.from(part, 'utf8'));
  }

  _transform(chunk, encoding, callback) {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      for (const event of this.sseDecoder.push(bytes)) this.emitDecoded(event);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      for (const event of this.sseDecoder.finish()) this.emitDecoded(event);
      callback();
    } catch (error) {
      callback(error);
    }
  }
}
