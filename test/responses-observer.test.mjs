import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createResponsesSseObserver } from '../lib/responses-observer.mjs';

async function observe(chunks, options = {}) {
  const observer = createResponsesSseObserver(options);
  const responses = [];
  const output = [];
  observer.on('response', (response) => responses.push(response));
  observer.on('data', (chunk) => output.push(chunk));
  await pipeline(Readable.from(chunks), observer);
  return { responses, output: Buffer.concat(output).toString('utf8') };
}

test('原样透传分片并从无尾部空行的完成事件提取响应', async () => {
  const raw = [
    'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"你"}\r\n\r\n',
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"resp_native","status":"completed","output":[]}}\r\n',
  ].join('');
  const bytes = Buffer.from(raw);
  const split = bytes.indexOf(Buffer.from('你')) + 1;

  const result = await observe([bytes.subarray(0, split), bytes.subarray(split)]);

  assert.equal(result.output, raw);
  assert.deepEqual(result.responses, [{ id: 'resp_native', status: 'completed', output: [] }]);
});

test('没有 event 行时也按 data.type 识别 incomplete 终态', async () => {
  const raw = 'data: {"type":"response.incomplete","response":{"id":"resp_partial","status":"incomplete","output":[]}}\n\n';

  const result = await observe([raw]);

  assert.equal(result.output, raw);
  assert.equal(result.responses[0].id, 'resp_partial');
});

test('终态事件 JSON 畸形时明确失败', async () => {
  const observer = createResponsesSseObserver();

  await assert.rejects(
    pipeline(Readable.from(['event: response.completed\ndata: {bad json}\n\n']), observer),
    (error) => error?.code === 'invalid_responses_sse_json',
  );
});

test('单个未结束 SSE 事件超过上限时明确失败', async () => {
  const observer = createResponsesSseObserver({ maxEventBytes: 64 });

  await assert.rejects(
    pipeline(Readable.from([`data: ${'x'.repeat(65)}`]), observer),
    (error) => error?.code === 'responses_sse_event_too_large',
  );
});

test('原生 SSE 正常关闭前没有终态事件时明确失败', async () => {
  const observer = createResponsesSseObserver();

  await assert.rejects(
    pipeline(Readable.from([
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_partial"}}\n\n',
    ]), observer),
    (error) => error?.code === 'responses_sse_truncated',
  );
});

test('非法 UTF-8 不得绕过 SSE 事件边界检查', async () => {
  const observer = createResponsesSseObserver();
  const invalid = Buffer.concat([
    Buffer.from('data: '),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('\n\n'),
  ]);

  await assert.rejects(
    pipeline(Readable.from([invalid]), observer),
    (error) => error?.code === 'invalid_responses_sse_utf8',
  );
});

test('原生 SSE 只能出现一个终态且终态后不得继续发送模型事件', async () => {
  const observer = createResponsesSseObserver();
  const completed = (id) => `event: response.completed\ndata: {"type":"response.completed","response":{"id":"${id}","status":"completed","output":[]}}\n\n`;

  await assert.rejects(
    pipeline(Readable.from([
      completed('resp_1'),
      'data: [DONE]\n\n',
      completed('resp_2'),
    ]), observer),
    (error) => error?.code === 'invalid_responses_sse_terminal',
  );
});

test('终态事件类型必须与 response.status 一致', async () => {
  const observer = createResponsesSseObserver();

  await assert.rejects(
    pipeline(Readable.from([
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_bad","status":"failed","output":[]}}\n\n',
    ]), observer),
    (error) => error?.code === 'invalid_responses_sse_terminal',
  );
});
