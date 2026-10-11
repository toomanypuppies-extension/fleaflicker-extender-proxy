/**
 * LRU cache of upstream responses, bounded by total body size.
 * Expired entries are kept (until evicted) so they can be served if fleaflicker throttles us.
 */
class ResponseCache {
  constructor({ maxBytes, now = Date.now }) {
    this.maxBytes = maxBytes;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  // Returns { response, fresh } or null
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    // Move to most recently used
    this.entries.delete(key);
    this.entries.set(key, entry);

    const fresh = entry.expiresAt > this.now();
    if (fresh) {
      this.hits++;
    } else {
      this.misses++;
    }
    return { response: entry.response, fresh, ageMs: this.now() - entry.storedAt };
  }

  set(key, response, ttlMs) {
    const size = response.body.length;
    if (size > this.maxBytes) {
      return;
    }
    this.delete(key);
    const time = this.now();
    this.entries.set(key, { response, size, storedAt: time, expiresAt: time + ttlMs });
    this.bytes += size;

    for (const oldestKey of this.entries.keys()) {
      if (this.bytes <= this.maxBytes) break;
      this.delete(oldestKey);
    }
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.size;
      this.entries.delete(key);
    }
  }

  stats() {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

module.exports = { ResponseCache };
