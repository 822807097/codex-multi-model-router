// ---------- 并发请求体的进程级内存预算 ----------

export class RequestBudget {
  constructor(options = {}) {
    this.maxActive = Math.max(1, Number(options.maxActive) || 8);
    this.maxBytes = Math.max(1, Number(options.maxBytes) || 128 * 1024 * 1024);
    this.active = 0;
    this.bytes = 0;
  }

  acquire() {
    if (this.active >= this.maxActive) return null;
    this.active += 1;
    return { bytes: 0, released: false };
  }

  add(token, size) {
    if (!token || token.released) return false;
    const bytes = Math.max(0, Number(size) || 0);
    if (this.bytes + bytes > this.maxBytes) return false;
    token.bytes += bytes;
    this.bytes += bytes;
    return true;
  }

  discardBytes(token) {
    if (!token || token.released || token.bytes <= 0) return;
    this.bytes = Math.max(0, this.bytes - token.bytes);
    token.bytes = 0;
  }

  release(token) {
    if (!token || token.released) return;
    this.discardBytes(token);
    token.released = true;
    this.active = Math.max(0, this.active - 1);
  }
}
