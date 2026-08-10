const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;

function decoderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lineEndingLength(buffer, index, final) {
  const byte = buffer[index];
  if (byte === 0x0a) return 1;
  if (byte !== 0x0d) return 0;
  if (index + 1 < buffer.length) return buffer[index + 1] === 0x0a ? 2 : 1;
  return final ? 1 : 0;
}

function findBoundary(buffer, final) {
  let index = 0;
  while (index < buffer.length) {
    const firstLength = lineEndingLength(buffer, index, final);
    if (!firstLength) {
      index += 1;
      continue;
    }
    const secondIndex = index + firstLength;
    const secondLength = lineEndingLength(buffer, secondIndex, final);
    if (secondLength) {
      return {
        contentEnd: index,
        // 最后一条字段的换行属于事件；终止事件的空行不计入上限。
        eventBytes: secondIndex,
        consumedBytes: secondIndex + secondLength,
      };
    }
    index = secondIndex;
  }
  return null;
}

function parseEvent(text) {
  let event = '';
  const dataLines = [];
  let hasData = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') {
      hasData = true;
      dataLines.push(value);
    }
  }
  return hasData ? { event, data: dataLines.join('\n') } : null;
}

export function createSseDecoder(options = {}) {
  const maxEventBytes = Math.max(
    1,
    Number(options.maxEventBytes) || DEFAULT_MAX_EVENT_BYTES,
  );
  let buffered = Buffer.alloc(0);
  let finished = false;

  function decodeEvent(bytes) {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw decoderError('invalid_sse_utf8', 'SSE 包含非法 UTF-8 数据');
    }
    return parseEvent(text);
  }

  function drain(final) {
    const events = [];
    for (;;) {
      const boundary = findBoundary(buffered, final);
      if (!boundary) break;
      if (boundary.eventBytes > maxEventBytes) {
        throw decoderError('sse_event_too_large', `SSE 单事件超过 ${maxEventBytes} 字节`);
      }
      const event = decodeEvent(buffered.subarray(0, boundary.contentEnd));
      if (event) events.push(event);
      buffered = buffered.subarray(boundary.consumedBytes);
    }
    // 最多有两个字节可能属于尚未完整到达的终止空行。
    if (!final && buffered.length > maxEventBytes + 2) {
      throw decoderError('sse_event_too_large', `SSE 单事件超过 ${maxEventBytes} 字节`);
    }
    return events;
  }

  function push(chunk) {
    if (finished) throw decoderError('sse_decoder_finished', 'SSE 解码器已经结束');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length) buffered = Buffer.concat([buffered, bytes]);
    return drain(false);
  }

  function finish() {
    if (finished) return [];
    finished = true;
    const events = drain(true);
    if (buffered.length) {
      if (buffered.length > maxEventBytes) {
        throw decoderError('sse_event_too_large', `SSE 单事件超过 ${maxEventBytes} 字节`);
      }
      const event = decodeEvent(buffered);
      if (event) events.push(event);
      buffered = Buffer.alloc(0);
    }
    return events;
  }

  return { push, finish };
}
