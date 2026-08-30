import crypto from 'node:crypto';
import { Transform } from 'node:stream';

import { createChatSseToResponsesTransform } from './chat-stream.mjs';
import { createResponsesSseToChatTransform } from './chat-stream.mjs';
import { createResponsesSseObserver } from './responses-observer.mjs';
import { diagnosticOutcomeForError } from './request-diagnostics.mjs';

const BLOCKED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

export function copyResponseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(
    ([key]) => !BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase()),
  ));
}

export function createResponsePipeline(options) {
  const heartbeatMs = options.heartbeatMs;
  const log = options.log || (() => {});
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const tokenTracker = options.tokenTracker || null;

  // 统一用量记录口：真实 usage 帧落账时在诊断对象打标，估算兜底（onRequestFinished）
  // 看到标记即跳过，避免官方通道「真实 + 估算」双计把周额度统计放大近一倍。
  function recordUpstreamUsage(diagnostics, entry) {
    if (!tokenTracker || typeof tokenTracker.recordUsage !== 'function') return;
    if (diagnostics) {
      try { diagnostics.usageRecorded = true; } catch { /* 诊断对象不可写时仅记录 */ }
    }
    tokenTracker.recordUsage(entry);
  }

  function startResponsesSse(clientRes) {
    if (!clientRes.headersSent) {
      clientRes.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      clientRes.flushHeaders();
    }
    let heartbeat = setIntervalFn(() => {
      if (clientRes.destroyed || clientRes.writableEnded) return;
      try { clientRes.write(': keep-alive\n\n'); } catch { /* close 事件统一清理 */ }
    }, heartbeatMs);
    heartbeat.unref?.();
    return () => {
      if (!heartbeat) return;
      clearIntervalFn(heartbeat);
      heartbeat = null;
    };
  }

  function emitResponsesErrorSse(clientRes, message, code = 'upstream_error', model = 'unknown') {
    if (!clientRes.headersSent) {
      try {
        clientRes.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
      } catch { return; }
    }
    try {
      const error = { type: 'upstream_error', code, message };
      const response = {
        id: `resp_${crypto.randomUUID()}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'failed',
        model,
        output: [],
        error,
        incomplete_details: null,
      };
      clientRes.write(`event: response.failed\ndata: ${JSON.stringify({
        type: 'response.failed',
        response,
      })}\n\n`);
      clientRes.write('data: [DONE]\n\n');
      clientRes.end();
    } catch { /* 客户端已经关闭时无需再次处理 */ }
  }

  // 上游连接收尾：正文按帧完整消费（readableEnded）且可回池时归还连接池复用，
  // 否则照旧销毁。错误/截断/客户端取消路径的流未 clean end，自动落入销毁分支。
  function releaseUpstream(upstream) {
    if (typeof upstream?.release === 'function' && upstream.stream?.readableEnded) {
      upstream.release();
      return;
    }
    upstream?.socket?.destroy();
  }

  function pipeNativeResponse(upstream, clientRes, tag, onResponse, diagnostics, onBodySnippet) {
    log(`${tag} -> ${upstream.status}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(upstream.status || 502, copyResponseHeaders(upstream.headers));
    }
    const isEventStream = /text\/event-stream/i.test(String(upstream.headers['content-type'] || ''));
    if (!isEventStream) {
      upstream.stream.once('error', (error) => {
        log(`native stream error [${tag}]`, error.message);
        diagnostics?.streamError?.({
          ...(diagnosticOutcomeForError(error, null) === 'timeout'
            ? { outcome: 'timeout' }
            : {}),
          error_code: error.code || 'upstream_error',
          error_stage: 'native_response_stream',
        });
        clientRes.destroy(error);
      });
      clientRes.once('close', () => releaseUpstream(upstream));
      if (typeof onBodySnippet !== 'function') {
        // error 传播：无监听时上游错误静默丢失，客户端悬挂到自身超时（审查 B5）
        upstream.stream.once('error', () => clientRes.destroy());
        upstream.stream.pipe(clientRes);
        return;
      }
      const chunks = [];
      let size = 0;
      const observer = new Transform({
        transform(chunk, _encoding, callback) {
          const remaining = 64 * 1024 - size;
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            size += Math.min(chunk.length, remaining);
          }
          callback(null, chunk);
        },
        flush(callback) {
          try { onBodySnippet(Buffer.concat(chunks, size).toString('utf8')); } catch { /* 诊断旁路不得影响响应 */ }
          callback();
        },
      });
      observer.once('error', (error) => upstream.stream.destroy(error));
      upstream.stream.pipe(observer).pipe(clientRes);
      return;
    }

    const observer = createResponsesSseObserver();
    let failed = false;
    const fail = (error) => {
      if (failed || clientRes.destroyed || clientRes.writableEnded) return;
      failed = true;
      upstream.stream.unpipe(observer);
      observer.unpipe(clientRes);
      upstream.stream.destroy();
      observer.destroy();
      upstream.socket?.destroy();
      log(`native stream error [${tag}]`, error.message);
      diagnostics?.streamError?.({
        ...(diagnosticOutcomeForError(error, null) === 'timeout'
          ? { outcome: 'timeout' }
          : {}),
        error_code: error.code || 'upstream_error',
        error_stage: 'native_response_stream',
      });
      emitResponsesErrorSse(clientRes, `native stream error: ${error.message}`, error.code || 'upstream_error');
    };
    upstream.stream.once('error', fail);
    observer.once('error', fail);
    observer.on('response', (response) => {
      if (tokenTracker && response?.usage) {
        try {
          recordUpstreamUsage(diagnostics, {
            model: response.model || tag,
            target: tag,
            usage: response.usage,
          });
        } catch { /* token 统计旁路不得影响响应 */ }
      }
      if (typeof onResponse === 'function') onResponse(response);
    });
    clientRes.once('close', () => {
      upstream.stream.destroy();
      observer.destroy();
      releaseUpstream(upstream);
    });
    observer.pipe(clientRes);
    upstream.stream.pipe(observer);
  }

  // Chat Completions 透传（任意工具接入）：SSE/JSON 原样转发，同时扫描 usage 帧做 token 统计。
  // 只读取不修改数据；统计失败绝不影响透传。
  // 参数契约：tag 为「model -> target」显示名；onResponse 在解析出完整 JSON 响应时回调
  // （响应历史/亲和记录用）；diagnostics 供流错误上报。SSE 增量帧无法重组完整 response，
  // 此时不回调 onResponse（与 native 分支的 response 事件语义一致）。
  function pipeChatCompletionsResponse(upstream, clientRes, tag, onResponse, diagnostics, _onBodySnippet) {
    const isEventStream = /text\/event-stream/i.test(String(upstream.headers['content-type'] || ''));
    if (!clientRes.headersSent) {
      clientRes.writeHead(upstream.status || 502, copyResponseHeaders(upstream.headers));
    }
    if (!isEventStream) {
      // 非流式 JSON 响应：原样透传，顺带解析 usage 与完整 response（onResponse 回调）
      const chunks = [];
      let size = 0;
      const jsonObserver = new Transform({
        transform(chunk, _encoding, callback) {
          const remaining = 64 * 1024 - size;
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            size += Math.min(chunk.length, remaining);
          }
          callback(null, chunk);
        },
        flush(callback) {
          try {
            const text = Buffer.concat(chunks, size).toString('utf8');
            const payload = JSON.parse(text);
            if (payload?.usage && typeof payload.usage === 'object' && tokenTracker) {
              recordUpstreamUsage(diagnostics, {
                model: payload.model || tag,
                target: tag,
                usage: payload.usage,
              });
            }
            if (typeof onResponse === 'function' && payload?.id) onResponse(payload);
          } catch { /* 非 JSON 正文或解析失败：统计旁路，透传不受影响 */ }
          callback();
        },
      });
      const fail = (error) => {
        if (clientRes.destroyed || clientRes.writableEnded) return;
        upstream.stream.unpipe(jsonObserver);
        upstream.stream.destroy();
        upstream.socket?.destroy();
        log(`chat completions json error [${tag}]`, error.message);
        diagnostics?.streamError?.({
          ...(diagnosticOutcomeForError(error, null) === 'timeout' ? { outcome: 'timeout' } : {}),
          error_code: error.code || 'upstream_error',
          error_stage: 'chat_completions_json',
        });
        clientRes.destroy(error);
      };
      upstream.stream.once('error', fail);
      clientRes.once('close', () => {
        upstream.stream.destroy();
        jsonObserver.destroy();
        releaseUpstream(upstream);
      });
      jsonObserver.pipe(clientRes);
      upstream.stream.pipe(jsonObserver);
      return;
    }
    if (typeof tokenTracker?.recordUsage !== 'function') {
      upstream.stream.pipe(clientRes);
      return;
    }
    let lineBuffer = '';
    const passthrough = new Transform({
      transform(chunk, _encoding, callback) {
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
          try {
            const payload = JSON.parse(trimmed.slice(6));
            if (payload?.usage && typeof payload.usage === 'object') {
              recordUpstreamUsage(diagnostics, { model: payload.model || tag, target: tag, usage: payload.usage });
            }
          } catch { /* 非 JSON 行忽略，统计旁路 */ }
        }
        callback(null, chunk);
      },
      flush(callback) {
        if (lineBuffer && tokenTracker?.recordUsage) {
          try {
            const trimmed = lineBuffer.trim();
            if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
              const payload = JSON.parse(trimmed.slice(6));
              if (payload?.usage && typeof payload.usage === 'object') {
                recordUpstreamUsage(diagnostics, { model: payload.model || tag, target: tag, usage: payload.usage });
              }
            }
          } catch { /* 统计旁路 */ }
        }
        callback();
      },
    });
    const fail = (error) => {
      if (clientRes.destroyed || clientRes.writableEnded) return;
      upstream.stream.unpipe(passthrough);
      upstream.stream.destroy();
      upstream.socket?.destroy();
      log(`chat completions stream error [${tag}]`, error.message);
      diagnostics?.streamError?.({
        ...(diagnosticOutcomeForError(error, null) === 'timeout' ? { outcome: 'timeout' } : {}),
        error_code: error.code || 'upstream_error',
        error_stage: 'chat_completions_stream',
      });
      clientRes.destroy(error);
    };
    upstream.stream.once('error', fail);
    clientRes.once('close', () => {
      upstream.stream.destroy();
      passthrough.destroy();
      releaseUpstream(upstream);
    });
    passthrough.pipe(clientRes);
    upstream.stream.pipe(passthrough);
  }

  // chat 协议客户端打 responses-wire 目标的桥接：上游 Responses SSE → 客户端 Chat SSE。
  // 请求侧转换见 chat-protocol.mjs（chatToResponsesInput）；此函数只负责响应侧回写。
  // 非流式客户端（stream:false）把增量帧聚合为单个 chat.completion JSON。
  function pipeResponsesToChatResponse(upstream, clientRes, model, stream, tag, onResponse, diagnostics) {
    const transform = createResponsesSseToChatTransform(model, {
      includeUsage: true,
      emitReasoning: true,
    });
    let failed = false;
    const fail = (error) => {
      if (failed || clientRes.destroyed || clientRes.writableEnded) return;
      failed = true;
      upstream.stream.unpipe(transform);
      upstream.stream.destroy();
      upstream.socket?.destroy();
      log(`responses bridge stream error [${tag}]`, error.message);
      diagnostics?.streamError?.({
        ...(diagnosticOutcomeForError(error, null) === 'timeout' ? { outcome: 'timeout' } : {}),
        error_code: error.code || 'upstream_error',
        error_stage: 'chat_bridge_response_stream',
      });
      clientRes.destroy(error);
    };
    upstream.stream.once('error', fail);
    transform.once('error', fail);
    transform.once('response', (response) => {
      // 与 pipeChatResponse 口径一致：桥接请求的 usage 同样记入 token 统计，
      // 否则 chat 客户端打官方通道的用量在面板上不可见。
      if (tokenTracker && response?.usage) {
        try {
          recordUpstreamUsage(diagnostics, {
            model: response.model || model,
            target: tag,
            usage: response.usage,
          });
        } catch { /* token 统计旁路不得影响响应 */ }
      }
      if (typeof onResponse === 'function') onResponse(response);
    });
    if (stream !== false) {
      if (!clientRes.headersSent) {
        clientRes.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        clientRes.flushHeaders();
      }
      transform.pipe(clientRes);
      upstream.stream.pipe(transform);
      clientRes.once('close', () => {
        upstream.stream.destroy();
        transform.destroy();
        releaseUpstream(upstream);
      });
      return;
    }
    // 非流式聚合：只取最后一个 finished chunk 的 finish_reason 与 usage，
    // message.content / tool_calls 按 index 拼接。
    const chunks = [];
    let streamError = null;
    transform.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const frame = JSON.parse(payload);
          // chat 惯例的流内错误帧（choices 为空）：非流式客户端必须拿到 5xx，
          // 不能被聚合成 200 + 空内容的「成功」。
          if (frame?.error && !streamError) streamError = frame.error;
          chunks.push(frame);
        } catch { /* 忽略无法解析的帧 */ }
      }
    });
    transform.once('end', () => {
      if (failed || clientRes.destroyed || clientRes.writableEnded) return;
      if (streamError) {
        clientRes.writeHead(502, { 'content-type': 'application/json' });
        clientRes.end(JSON.stringify({
          error: {
            message: streamError.message || 'upstream error',
            type: streamError.type || 'upstream_error',
            code: streamError.code || 'upstream_error',
            param: null,
          },
        }));
        return;
      }
      const contentParts = [];
      const toolCalls = new Map();
      let finishReason = null;
      let usage = null;
      for (const chunk of chunks) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finishReason = choice.finish_reason;
        }
        if (choice.delta?.content) contentParts.push(choice.delta.content);
        for (const call of choice.delta?.tool_calls || []) {
          const index = call.index ?? 0;
          const current = toolCalls.get(index) || {
            id: call.id || undefined,
            type: 'function',
            function: { name: undefined, arguments: '' },
          };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.function.name = call.function.name;
          if (call.function?.arguments) current.function.arguments += call.function.arguments;
          toolCalls.set(index, current);
        }
        if (chunk.usage) usage = chunk.usage;
      }
      const message = { role: 'assistant', content: contentParts.join('') };
      const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
      if (calls.length) message.tool_calls = calls;
      const response = {
        id: `chatcmpl_${crypto.randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
      };
      if (usage) {
        response.usage = {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
        };
      }
      if (!clientRes.headersSent) {
        clientRes.writeHead(200, { 'content-type': 'application/json' });
      }
      clientRes.end(JSON.stringify(response));
    });
    upstream.stream.pipe(transform);
  }

  function pipeChatResponse(
    upstream,
    clientRes,
    model,
    tag,
    stopHeartbeat,
    toolContext,
    transformOptions,
    onResponse,
    diagnostics,
  ) {
    const transform = createChatSseToResponsesTransform(model, toolContext, transformOptions);
    let failed = false;
    const fail = (error) => {
      if (failed || clientRes.destroyed || clientRes.writableEnded) return;
      failed = true;
      upstream.stream.unpipe(transform);
      upstream.stream.destroy();
      upstream.socket?.destroy();
      log(`chat stream error [${tag}]`, error.message);
      diagnostics?.streamError?.({
        ...(diagnosticOutcomeForError(error, null) === 'timeout'
          ? { outcome: 'timeout' }
          : {}),
        error_code: error.code || 'upstream_error',
        error_stage: 'chat_response_stream',
      });
      // 转换已完成的晚到上游错误：不追加终态、不重复停心跳，finish 事件会统一停一次。
      if (!transform.completed) {
        stopHeartbeat();
        transform.failResponse({
          type: 'upstream_error',
          code: error.code || 'upstream_error',
          message: `chat stream error: ${error.message}`,
        });
      }
      transform.end();
    };
    upstream.stream.once('error', fail);
    transform.once('error', fail);
    transform.once('response', (response) => {
      if (tokenTracker && response?.usage) {
        try {
          recordUpstreamUsage(diagnostics, {
            model: response.model || model,
            target: tag,
            usage: response.usage,
          });
        } catch { /* token 统计旁路不得影响响应 */ }
      }
      if (typeof onResponse === 'function') onResponse(response);
    });
    // 空停响应（成功停流但无正文/工具调用）是完整走完的上游行为，不经过 fail()；
    // 单独标记诊断终态，让 router.log 反映真实故障而不是 completed。
    transform.once('response', (response) => {
      if (response?.status === 'failed' && response.error?.code === 'empty_stop_response') {
        diagnostics?.markFailure?.({
          outcome: 'upstream_error',
          error_code: 'empty_stop_response',
          error_stage: 'chat_response_stream',
        });
      }
    });
    clientRes.once('finish', stopHeartbeat);
    transform.pipe(clientRes);
    upstream.stream.pipe(transform);
  }

  return {
    startResponsesSse,
    emitResponsesErrorSse,
    pipeNativeResponse,
    pipeChatResponse,
    pipeChatCompletionsResponse,
    pipeResponsesToChatResponse,
  };
}
