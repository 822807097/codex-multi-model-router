import test from 'node:test';
import assert from 'node:assert/strict';

import * as requestDiagnosticsModule from '../lib/request-diagnostics.mjs';

const {
  createRequestDiagnostics,
  createRequestId,
} = requestDiagnosticsModule;

test('请求生命周期共享关联 ID、累计耗时并且失败终态幂等', () => {
  const events = [];
  let clock = 1_000;
  const lifecycle = createRequestDiagnostics({
    write: (event) => events.push(event),
    requestId: 'req_test',
    method: 'POST',
    path: '/v1/responses?unsafe=yes',
    now: () => clock,
  });

  lifecycle.received({ body_bytes: 128 });
  clock += 5;
  lifecycle.parsed({
    model: 'gpt-test',
    input_items: 3,
    stream: true,
    has_previous_response_id: false,
  });
  clock += 7;
  lifecycle.attempt({ target: 'official', wire_api: 'responses', attempt: 1 });
  clock += 11;
  lifecycle.upstream({ upstream_status: 503, upstream_request_id: 'up_req' });
  lifecycle.markFailure({
    outcome: 'upstream_error',
    error_code: 'server_overloaded',
    error_stage: 'upstream_headers',
  });
  clock += 13;
  assert.equal(lifecycle.finish(), true);
  assert.equal(lifecycle.finish(), false);
  assert.equal(lifecycle.disconnect(), false);

  assert.deepEqual(events.map((event) => event.event), [
    'request.received',
    'request.parsed',
    'route.attempt',
    'upstream.response',
    'request.failed',
  ]);
  assert.ok(events.every((event) => event.request_id === 'req_test'));
  assert.ok(events.every((event) => event.path === '/v1/responses?unsafe=yes'));
  assert.deepEqual(events.map((event) => event.elapsed_ms), [0, 5, 12, 23, 36]);
  assert.deepEqual(events.at(-1), {
    event: 'request.failed',
    request_id: 'req_test',
    method: 'POST',
    path: '/v1/responses?unsafe=yes',
    elapsed_ms: 36,
    model: 'gpt-test',
    target: 'official',
    wire_api: 'responses',
    attempt: 1,
    failover_count: 0,
    upstream_status: 503,
    upstream_request_id: 'up_req',
    duration_ms: 36,
    outcome: 'upstream_error',
    error_code: 'server_overloaded',
    error_stage: 'upstream_headers',
  });
});

test('failover 保留同一请求上下文并把最终成功写成单一终态', () => {
  const events = [];
  let clock = 2_000;
  const lifecycle = createRequestDiagnostics({
    write: (event) => events.push(event),
    requestId: 'req_failover',
    method: 'POST',
    path: '/v1/responses',
    now: () => clock,
  });

  lifecycle.parsed({ model: 'deepseek-test', input_items: 1 });
  lifecycle.attempt({ target: 'primary', wire_api: 'chat', attempt: 1 });
  clock += 10;
  lifecycle.upstream({ upstream_status: 503 });
  lifecycle.failover({ error_code: 'upstream_503', error_stage: 'upstream_headers' });
  lifecycle.attempt({ target: 'backup', wire_api: 'chat', attempt: 2 });
  clock += 20;
  lifecycle.upstream({ upstream_status: 200, upstream_request_id: 'backup_req' });
  clock += 30;
  assert.equal(lifecycle.finish({ client_status: 200 }), true);

  const failover = events.find((event) => event.event === 'route.failover');
  assert.equal(failover.target, 'primary');
  assert.equal(failover.failover_count, 1);
  const completed = events.at(-1);
  assert.equal(completed.event, 'request.completed');
  assert.equal(completed.target, 'backup');
  assert.equal(completed.attempt, 2);
  assert.equal(completed.failover_count, 1);
  assert.equal(completed.duration_ms, 60);
  assert.equal(completed.outcome, 'completed');
});

test('客户端中断和流错误都不会被后续 finish 覆盖', () => {
  for (const entry of [
    {
      name: '客户端中断',
      terminate(lifecycle) { return lifecycle.disconnect(); },
      expectedEvent: 'request.disconnected',
      expectedOutcome: 'client_disconnected',
    },
    {
      name: '响应流错误',
      terminate(lifecycle) {
        lifecycle.streamError({ error_code: 'ECONNRESET', error_stage: 'response_stream' });
        return lifecycle.finish();
      },
      expectedEvent: 'request.failed',
      expectedOutcome: 'stream_error',
    },
  ]) {
    const events = [];
    const lifecycle = createRequestDiagnostics({
      write: (event) => events.push(event),
      requestId: `req_${entry.name}`,
      method: 'POST',
      path: '/v1/responses',
      now: () => 3_000,
    });
    lifecycle.attempt({ target: 'provider', wire_api: 'responses', attempt: 1 });
    assert.equal(entry.terminate(lifecycle), true);
    assert.equal(lifecycle.finish(), false);
    assert.equal(events.at(-1).event, entry.expectedEvent);
    assert.equal(events.at(-1).outcome, entry.expectedOutcome);
  }
});

test('自动请求 ID 使用固定前缀且不会重复', () => {
  const first = createRequestId();
  const second = createRequestId();
  assert.match(first, /^req_[0-9a-f-]{36}$/);
  assert.match(second, /^req_[0-9a-f-]{36}$/);
  assert.notEqual(first, second);
});

test('已知上游流错误优先于随后触发的连接 close', () => {
  const events = [];
  const lifecycle = createRequestDiagnostics({
    write: (event) => events.push(event),
    requestId: 'req_stream_then_close',
    method: 'POST',
    path: '/v1/responses',
    now: () => 4_000,
  });
  lifecycle.attempt({ target: 'provider', wire_api: 'responses', attempt: 1 });
  lifecycle.streamError({ error_code: 'ECONNRESET', error_stage: 'native_response_stream' });

  assert.equal(lifecycle.disconnect({ client_status: 200 }), true);
  assert.equal(events.at(-1).event, 'request.failed');
  assert.equal(events.at(-1).outcome, 'stream_error');
  assert.equal(events.at(-1).error_code, 'ECONNRESET');
  assert.equal(events.at(-1).error_stage, 'native_response_stream');
  assert.equal(events.at(-1).client_status, 200);
});

test('连接与响应超时使用 timeout 结果，普通错误保留调用方默认分类', () => {
  assert.equal(typeof requestDiagnosticsModule.diagnosticOutcomeForError, 'function');
  const { diagnosticOutcomeForError } = requestDiagnosticsModule;
  assert.equal(diagnosticOutcomeForError({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(
    diagnosticOutcomeForError(new Error('response header timeout for provider')),
    'timeout',
  );
  assert.equal(
    diagnosticOutcomeForError(new Error('socket reset'), 'stream_error'),
    'stream_error',
  );

  const events = [];
  const lifecycle = createRequestDiagnostics({
    write: (event) => events.push(event),
    requestId: 'req_idle_timeout',
    method: 'POST',
    path: '/v1/responses',
    now: () => 5_000,
  });
  lifecycle.streamError({
    outcome: 'timeout',
    error_code: 'ETIMEDOUT',
    error_stage: 'chat_response_stream',
  });
  lifecycle.finish();
  assert.equal(events.at(-1).outcome, 'timeout');
});
