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

  function emitResponsesErrorSse(clientRes, message, code = 'upstream_error') {
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
      clientRes.write(`data: ${JSON.stringify({
        type: 'error',
        error: { type: 'upstream_error', code, message },
      })}\n\n`);
      clientRes.write('data: [DONE]\n\n');
      clientRes.end();
    } catch { /* 客户端已经关闭时无需再次处理 */ }
  }

  function pipeNativeResponse(upstream, clientRes, tag, onResponse, diagnostics) {
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
      upstream.stream.pipe(clientRes);
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
    if (onResponse) observer.on('response', onResponse);
    clientRes.once('close', () => {
      upstream.stream.destroy();
      observer.destroy();
      upstream.socket?.destroy();
    });
    observer.pipe(clientRes);
    upstream.stream.pipe(observer);
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
      stopHeartbeat();
      upstream.stream.unpipe(transform);
      transform.unpipe(clientRes);
      transform.destroy();
      log(`chat stream error [${tag}]`, error.message);
      diagnostics?.streamError?.({
        ...(diagnosticOutcomeForError(error, null) === 'timeout'
          ? { outcome: 'timeout' }
          : {}),
        error_code: error.code || 'upstream_error',
        error_stage: 'chat_response_stream',
      });
      emitResponsesErrorSse(clientRes, `chat stream error: ${error.message}`);
    };
    upstream.stream.once('error', fail);
    transform.once('error', fail);
    if (onResponse) transform.once('response', onResponse);
    clientRes.once('finish', stopHeartbeat);
    transform.pipe(clientRes);
    upstream.stream.pipe(transform);
  }

  return {
    startResponsesSse,
    emitResponsesErrorSse,
    pipeNativeResponse,
    pipeChatResponse,
  };
}
