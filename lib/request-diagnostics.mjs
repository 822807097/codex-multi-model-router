import { randomUUID } from 'node:crypto';

export function createRequestId() {
  return `req_${randomUUID()}`;
}

// 只用稳定错误码和“是否为超时”的文本特征做分类，异常正文不会进入日志。
export function diagnosticOutcomeForError(error, fallback = 'upstream_error') {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  if (code === 'ETIMEDOUT' || code.includes('TIMEOUT')) return 'timeout';
  const message = typeof error?.message === 'string' ? error.message : '';
  return /\b(?:timeout|timed out)\b/i.test(message) ? 'timeout' : fallback;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createRequestDiagnostics(options = {}) {
  const write = typeof options.write === 'function' ? options.write : () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const requestId = typeof options.requestId === 'string' && options.requestId
    ? options.requestId
    : createRequestId();
  const startedAt = now();
  const common = {
    request_id: requestId,
    method: options.method,
    path: options.path,
  };
  let lastElapsedMs = 0;
  let model;
  let target;
  let wireApi;
  let attempt;
  let failoverCount = 0;
  let upstreamStatus;
  let upstreamRequestId;
  let pendingFailure = null;
  let terminal = false;

  function elapsedMs() {
    const current = Math.max(0, now() - startedAt);
    lastElapsedMs = Math.max(lastElapsedMs, current);
    return lastElapsedMs;
  }

  function routeFields() {
    if (!target) return {};
    return {
      target,
      wire_api: wireApi,
      attempt,
      failover_count: failoverCount,
      ...(upstreamStatus !== undefined ? { upstream_status: upstreamStatus } : {}),
      ...(upstreamRequestId ? { upstream_request_id: upstreamRequestId } : {}),
    };
  }

  function emit(event, fields = {}) {
    const record = {
      event,
      ...common,
      elapsed_ms: elapsedMs(),
      ...(model ? { model } : {}),
      ...routeFields(),
      ...fields,
    };
    try { write(record); } catch { /* 诊断日志失败不能影响请求 */ }
    return record;
  }

  function finish(fields = {}) {
    // finish 与 close/流错误可能接连触发，终态必须保证只写一次。
    if (terminal) return false;
    terminal = true;
    const durationMs = elapsedMs();
    if (pendingFailure) {
      emit('request.failed', {
        duration_ms: durationMs,
        ...pendingFailure,
        ...fields,
      });
    } else {
      emit('request.completed', {
        duration_ms: durationMs,
        outcome: 'completed',
        ...fields,
      });
    }
    return true;
  }

  function markFailure(fields = {}) {
    pendingFailure = {
      outcome: fields.outcome || 'upstream_error',
      ...(fields.error_code ? { error_code: fields.error_code } : {}),
      ...(fields.error_stage ? { error_stage: fields.error_stage } : {}),
      ...(finiteNumber(fields.client_status) !== undefined
        ? { client_status: fields.client_status }
        : {}),
    };
  }

  function streamError(fields = {}) {
    pendingFailure = {
      outcome: fields.outcome === 'timeout' ? 'timeout' : 'stream_error',
      ...(fields.error_code ? { error_code: fields.error_code } : {}),
      error_stage: fields.error_stage || 'response_stream',
    };
  }

  return {
    requestId,
    received(fields = {}) {
      emit('request.received', fields);
    },
    parsed(fields = {}) {
      if (typeof fields.model === 'string') model = fields.model;
      emit('request.parsed', fields);
    },
    attempt(fields = {}) {
      if (typeof fields.target === 'string') target = fields.target;
      if (typeof fields.wire_api === 'string') wireApi = fields.wire_api;
      attempt = finiteNumber(fields.attempt) ?? ((attempt || 0) + 1);
      upstreamStatus = undefined;
      upstreamRequestId = undefined;
      emit('route.attempt', { ...fields, attempt, failover_count: failoverCount });
    },
    upstream(fields = {}) {
      upstreamStatus = finiteNumber(fields.upstream_status);
      upstreamRequestId = typeof fields.upstream_request_id === 'string'
        ? fields.upstream_request_id
        : undefined;
      emit('upstream.response', {
        first_byte_ms: finiteNumber(fields.first_byte_ms) ?? elapsedMs(),
        ...fields,
      });
    },
    failover(fields = {}) {
      failoverCount += 1;
      emit('route.failover', { ...fields, failover_count: failoverCount });
    },
    markFailure,
    streamError,
    fail(fields = {}) {
      markFailure(fields);
      return finish();
    },
    finish,
    disconnect(fields = {}) {
      if (terminal) return false;
      // 上游/转换流已经先报错时，close 只是该错误的后果，不能覆盖成客户端主动中断。
      if (pendingFailure) return finish(fields);
      terminal = true;
      emit('request.disconnected', {
        duration_ms: elapsedMs(),
        outcome: 'client_disconnected',
        ...fields,
      });
      return true;
    },
  };
}
