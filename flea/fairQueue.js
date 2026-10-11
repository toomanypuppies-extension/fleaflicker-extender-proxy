class QueueFullError extends Error {}
class QueueTimeoutError extends Error {}

/**
 * Runs tasks under a shared rate limiter, taking turns between clients (round robin)
 * so that one client paging through a large player listing can't starve the others.
 */
class FairQueue {
  constructor({ limiter, maxConcurrent = 4, maxQueuePerClient = 50 }) {
    this.limiter = limiter;
    this.maxConcurrent = maxConcurrent;
    this.maxQueuePerClient = maxQueuePerClient;
    // clientKey -> jobs, in the order they should run
    this.queues = new Map();
    // Client keys taking turns, the next client to be served is first
    this.turns = [];
    this.active = 0;
    this.timer = null;
  }

  get size() {
    let size = 0;
    this.queues.forEach(queue => { size += queue.length; });
    return size;
  }

  /**
   * @param {string} clientKey
   * @param {() => Promise} task
   * @param {{ maxWaitMs: number, front?: boolean }} options front puts the task ahead of
   *   the client's other tasks and skips the per-client cap, used for retries
   */
  enqueue(clientKey, task, { maxWaitMs, front = false }) {
    let queue = this.queues.get(clientKey);
    if (!front && queue && queue.length >= this.maxQueuePerClient) {
      return Promise.reject(new QueueFullError(`Too many queued requests for ${clientKey}`));
    }
    if (!queue) {
      queue = [];
      this.queues.set(clientKey, queue);
      this.turns.push(clientKey);
    }

    return new Promise((resolve, reject) => {
      const job = { task, resolve, reject };
      job.timeout = setTimeout(() => {
        const index = queue.indexOf(job);
        if (index !== -1) {
          queue.splice(index, 1);
          reject(new QueueTimeoutError(`Request for ${clientKey} waited more than ${maxWaitMs}ms`));
        }
      }, maxWaitMs);

      if (front) {
        queue.unshift(job);
      } else {
        queue.push(job);
      }
      this.pump();
    });
  }

  nextJob() {
    while (this.turns.length) {
      const clientKey = this.turns.shift();
      const queue = this.queues.get(clientKey);
      const job = queue.shift();
      if (queue.length) {
        this.turns.push(clientKey);
      } else {
        this.queues.delete(clientKey);
      }
      // Queues can be emptied by timeouts while waiting for their turn
      if (job) {
        return job;
      }
    }
    return null;
  }

  pump() {
    clearTimeout(this.timer);
    this.timer = null;

    while (this.active < this.maxConcurrent && this.size > 0) {
      const wait = this.limiter.msUntilAvailable();
      if (wait > 0) {
        this.timer = setTimeout(() => this.pump(), wait);
        // Waiting jobs' own timeouts keep the process alive, this shouldn't on its own
        this.timer.unref?.();
        return;
      }

      const job = this.nextJob();
      if (!job) {
        return;
      }
      clearTimeout(job.timeout);
      this.limiter.tryTake();
      this.active++;

      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  stats() {
    return {
      active: this.active,
      queued: this.size,
      clientsWaiting: this.queues.size,
    };
  }
}

module.exports = { FairQueue, QueueFullError, QueueTimeoutError };
