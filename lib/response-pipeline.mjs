import crypto from 'node:crypto';
import { Transform } from 'node:stream';

import { createChatSseToResponsesTransform } from './chat-stream.mjs';
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
      clientRes.once('close', () => upstream.socket?.destroy());
      if (typeof onBodySnippet !== 'function') {
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
          tokenTracker.recordUsage({
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
      upstream.socket?.destroy();
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
              tokenTracker.recordUsage({
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
        upstream.socket?.destroy();
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
              tokenTracker.recordUsage({ model: payload.model || tag, target: tag, usage: payload.usage });
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
                tokenTracker.recordUsage({ model: payload.model || tag, target: tag, usage: payload.usage });
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
      upstream.socket?.destroy();
    });
    passthrough.pipe(clientRes);
    upstream.stream.pipe(passthrough);
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
          tokenTracker.recordUsage({
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
  };
}
