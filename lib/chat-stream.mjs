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
    this.toolContext = toolContext;
    this.knownChatToolNames = Object.keys(toolContext.byChatName || {});
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
