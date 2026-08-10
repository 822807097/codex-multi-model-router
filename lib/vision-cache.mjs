import crypto from 'node:crypto';

// ---------- 视觉描述的有界缓存与并发池 ----------

function hashSource(source) {
  return crypto.createHash('sha256').update(String(source || '')).digest('hex');
}

export class CaptionCache {
  constructor(options = {}) {
    this.maxEntries = Math.max(1, Number(options.maxEntries) || 64);
    this.maxBytes = Math.max(1, Number(options.maxBytes) || 1024 * 1024);
    this.entries = new Map();
    this.inFlight = new Map();
    this.bytes = 0;
  }

  get size() {
    return this.entries.size;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const text = String(value);
    const bytes = Buffer.byteLength(text, 'utf8');
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.bytes;
    this.entries.delete(key);
    if (bytes <= this.maxBytes) {
      this.entries.set(key, { value: text, bytes });
      this.bytes += bytes;
    }
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.bytes -= oldest.bytes;
    }
  }

  getOrCreate(source, factory, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    const key = hashSource(source);
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    let entry = this.inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, promise: null, waiters: 0, settled: false };
      entry.promise = Promise.resolve()
      .then(() => factory(controller.signal))
      .then((value) => {
        const text = String(value);
        // 所有等待者都已取消的旧任务即使忽略 AbortSignal 后返回，也不得污染缓存。
        if (!controller.signal.aborted) this.set(key, text);
        return text;
      });
      this.inFlight.set(key, entry);
      // 同时提供成功与失败处理器，避免最后一个等待者取消后共享 Promise 形成未处理拒绝。
      entry.promise.then(
        () => this.finishInFlight(key, entry),
        () => this.finishInFlight(key, entry),
      );
    }
    return this.waitForInFlight(key, entry, signal);
  }

  finishInFlight(key, entry) {
    entry.settled = true;
    if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
  }

  waitForInFlight(key, entry, signal) {
    entry.waiters += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const settle = (handler, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        entry.waiters = Math.max(0, entry.waiters - 1);
        if (entry.waiters === 0 && !entry.settled) {
          // 最后一个等待者离开时才取消真实上游；后续调用可立即创建新的 single-flight。
          entry.controller.abort();
          if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
        }
        handler(value);
      };
      const onAbort = () => settle(reject, abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      );
      if (signal?.aborted) onAbort();
    });
  }
}

function abortError() {
  const error = new Error('vision task aborted while waiting for concurrency slot');
  error.name = 'AbortError';
  return error;
}

export class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = Math.max(1, Math.floor(Number(limit) || 1));
    this.active = 0;
    this.queue = [];
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  createRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  drain() {
    // FIFO 唤醒保证多个并行 map 公平共享进程级名额；已取消项绝不进入 mapper。
    while (this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift();
      entry.signal?.removeEventListener('abort', entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(abortError());
        continue;
      }
      this.active += 1;
      entry.resolve(this.createRelease());
    }
  }

  async run(task, signal) {
    const release = await this.acquire(signal);
    try {
      // 名额发放和 Promise continuation 之间仍可能取消，必须在执行 mapper 前再检查一次。
      if (signal?.aborted) throw abortError();
      return await task();
    } finally {
      release();
    }
  }
}

export function createConcurrencyLimiter(limit) {
  return new ConcurrencyLimiter(limit);
}

export async function mapWithConcurrency(items, concurrency, mapper, options = {}) {
  const values = Array.from(items || []);
  if (!values.length) return [];
  // 数字参数保持旧用法；共享实例可由路由进程创建一次并跨多个 map 调用复用。
  const limiter = concurrency instanceof ConcurrencyLimiter
    ? concurrency
    : createConcurrencyLimiter(concurrency);
  const workerCount = Math.max(1, Math.min(values.length, limiter.limit));
  const results = new Array(values.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await limiter.run(() => mapper(values[index], index), options.signal);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
