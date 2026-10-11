/**
 * Sliding window rate limiter for calls to fleaflicker.
 *
 * Fleaflicker allows 90 calls/min per IP and answers with a 403 when that's exceeded.
 * Calls are also spaced out so the budget isn't spent in one burst at the top of a window.
 */
class SlidingWindowLimiter {
  constructor({ limit, windowMs = 60000, minIntervalMs = 0, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.minIntervalMs = minIntervalMs;
    this.now = now;
    this.calls = [];
    this.pausedUntil = 0;
  }

  prune(time) {
    while (this.calls.length && this.calls[0] <= time - this.windowMs) {
      this.calls.shift();
    }
  }

  msUntilAvailable() {
    const time = this.now();
    this.prune(time);

    let wait = this.pausedUntil - time;
    if (this.calls.length >= this.limit) {
      // Wait for enough of the window to expire to get back under the limit
      wait = Math.max(wait, this.calls[this.calls.length - this.limit] + this.windowMs - time);
    }
    if (this.calls.length) {
      wait = Math.max(wait, this.calls[this.calls.length - 1] + this.minIntervalMs - time);
    }
    return Math.max(0, wait);
  }

  tryTake() {
    if (this.msUntilAvailable() > 0) {
      return false;
    }
    this.calls.push(this.now());
    return true;
  }

  // Stop all calls for a while, used when fleaflicker throttles us anyway
  pause(ms) {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  stats() {
    const time = this.now();
    this.prune(time);
    return {
      limit: this.limit,
      usedInWindow: this.calls.length,
      pausedForMs: Math.max(0, this.pausedUntil - time),
    };
  }
}

module.exports = { SlidingWindowLimiter };
