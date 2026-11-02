'use strict';

class RateLimiter {
  constructor({ max = 5, windowMs = 10 * 60 * 1000, clock = Date.now, maxKeys = 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.clock = clock;
    this.maxKeys = maxKeys;
    this.store = new Map();
  }

  check(key) {
    const now = this.clock();
    this.purgeExpired(now);

    if (this.store.size >= this.maxKeys && !this.store.has(key)) {
      return { allowed: false, remaining: 0, resetIn: this.windowMs };
    }

    const record = this.store.get(key);
    if (!record) {
      this.store.set(key, { count: 1, start: now });
      return { allowed: true, remaining: this.max - 1, resetIn: this.windowMs };
    }

    if (now - record.start >= this.windowMs) {
      record.count = 1;
      record.start = now;
      return { allowed: true, remaining: this.max - 1, resetIn: this.windowMs };
    }

    if (record.count >= this.max) {
      return { allowed: false, remaining: 0, resetIn: this.windowMs - (now - record.start) };
    }

    record.count += 1;
    return { allowed: true, remaining: this.max - record.count, resetIn: this.windowMs - (now - record.start) };
  }

  purgeExpired(now) {
    for (const [key, record] of this.store) {
      if (now - record.start >= this.windowMs) {
        this.store.delete(key);
      }
    }
  }

  reset(key) {
    this.store.delete(key);
  }
}

module.exports = { RateLimiter };
