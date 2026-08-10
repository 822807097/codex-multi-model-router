import test from 'node:test';
import assert from 'node:assert/strict';

import { createSseDecoder } from '../lib/sse-decoder.mjs';

test('SSE 解码器支持跨 chunk UTF-8、混合换行、多行 data 和注释', () => {
  const decoder = createSseDecoder();
  const bytes = Buffer.from(': keep-alive\r\nevent: message\rdata: 你\ndata: 好\r\n\r\n');
  const split = bytes.indexOf(Buffer.from('你')) + 1;

  assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
  assert.deepEqual(decoder.push(bytes.subarray(split)), [{
    event: 'message',
    data: '你\n好',
  }]);
  assert.deepEqual(decoder.finish(), []);
});

test('没有尾部空行的最后事件在 finish 时输出且忽略未知字段', () => {
  const decoder = createSseDecoder();
  assert.deepEqual(decoder.push(Buffer.from('id: 1\nunknown: x\ndata: final')), []);
  assert.deepEqual(decoder.finish(), [{ event: '', data: 'final' }]);
});

test('事件字节上限计入字段换行但不计终止空行', () => {
  const exact = createSseDecoder({ maxEventBytes: 8 });
  assert.deepEqual(exact.push(Buffer.from('data: x\n\n')), [{ event: '', data: 'x' }]);

  const tooSmall = createSseDecoder({ maxEventBytes: 7 });
  assert.throws(
    () => tooSmall.push(Buffer.from('data: x\n\n')),
    (error) => error.code === 'sse_event_too_large',
  );
});

test('非法 UTF-8 产生稳定错误而不是替换字符', () => {
  const decoder = createSseDecoder();
  assert.throws(
    () => decoder.push(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28, 0x0a, 0x0a])),
    (error) => error.code === 'invalid_sse_utf8',
  );
});
