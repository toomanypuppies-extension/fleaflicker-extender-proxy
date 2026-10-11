const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { SlidingWindowLimiter } = require('../flea/limiter');
const { FairQueue, QueueFullError, QueueTimeoutError } = require('../flea/fairQueue');
const { ResponseCache } = require('../flea/cache');
const { createFleaProxy } = require('../flea/proxy');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('limiter stays under the limit within the window', () => {
  let time = 0;
  const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 1000, now: () => time });
  assert.ok(limiter.tryTake());
  time = 100;
  assert.ok(limiter.tryTake());
  time = 200;
  assert.ok(limiter.tryTake());
  assert.ok(!limiter.tryTake());
  assert.strictEqual(limiter.msUntilAvailable(), 800);
  time = 1000;
  assert.ok(limiter.tryTake());
  assert.ok(!limiter.tryTake());
});

test('limiter spaces calls and honours pauses', () => {
  let time = 0;
  const limiter = new SlidingWindowLimiter({ limit: 100, windowMs: 1000, minIntervalMs: 50, now: () => time });
  assert.ok(limiter.tryTake());
  assert.strictEqual(limiter.msUntilAvailable(), 50);
  time = 50;
  limiter.pause(500);
  assert.strictEqual(limiter.msUntilAvailable(), 500);
  time = 550;
  assert.ok(limiter.tryTake());
});

test('queue takes turns between clients', async () => {
  const limiter = new SlidingWindowLimiter({ limit: 1000 });
  const queue = new FairQueue({ limiter, maxConcurrent: 1 });
  const order = [];
  const task = (name) => async () => { order.push(name); await sleep(1); };

  // Hold the queue until everything is queued
  let release;
  const jobs = [queue.enqueue('other', () => new Promise(resolve => { release = resolve; }), { maxWaitMs: 1000 })];
  for (let i = 0; i < 4; i++) jobs.push(queue.enqueue('bulk', task(`bulk${i}`), { maxWaitMs: 1000 }));
  jobs.push(queue.enqueue('small', task('small'), { maxWaitMs: 1000 }));
  await sleep(1);
  release();
  await Promise.all(jobs);

  // small waits for at most one of bulk's calls, not all four
  assert.deepStrictEqual(order, ['bulk0', 'small', 'bulk1', 'bulk2', 'bulk3']);
});

test('queue rejects when a client queues too much or waits too long', async () => {
  const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 10000 });
  const queue = new FairQueue({ limiter, maxQueuePerClient: 2 });

  await queue.enqueue('a', async () => 'first', { maxWaitMs: 100 });
  const waiting = [
    queue.enqueue('a', async () => 'x', { maxWaitMs: 30 }),
    queue.enqueue('a', async () => 'y', { maxWaitMs: 30 }),
  ];
  await assert.rejects(queue.enqueue('a', async () => 'z', { maxWaitMs: 30 }), QueueFullError);
  for (const job of waiting) {
    await assert.rejects(job, QueueTimeoutError);
  }
  assert.strictEqual(queue.size, 0);
});

test('cache evicts least recently used past maxBytes', () => {
  let time = 0;
  const cache = new ResponseCache({ maxBytes: 10, now: () => time });
  const response = (size) => ({ status: 200, body: Buffer.alloc(size) });
  cache.set('a', response(4), 100);
  cache.set('b', response(4), 100);
  cache.get('a');
  cache.set('c', response(4), 100);
  assert.ok(cache.get('a'));
  assert.strictEqual(cache.get('b'), null);
  time = 200;
  assert.strictEqual(cache.get('c').fresh, false);
});

// Starts the proxy in front of a fake fleaflicker. respond(url, callNumber) -> { status, body }
const startProxy = async (t, respond, options = {}) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const { status = 200, body = { url } } = await respond(url, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const limiter = new SlidingWindowLimiter({ limit: options.limit || 1000, windowMs: 1000 });
  const proxy = createFleaProxy({
    upstream: 'https://flea.test/api',
    limiter,
    queue: new FairQueue({ limiter, maxConcurrent: 1 }),
    cache: new ResponseCache({ maxBytes: 1024 * 1024 }),
    fetchImpl,
    maxWaitMs: 500,
    throttlePauseMs: 20,
    ...options,
  });
  const app = express();
  app.set('trust proxy', true);
  app.use('/proxy/flea', proxy);
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/proxy/flea`;
  const get = (path, ip = '1.1.1.1') => fetch(`${base}${path}`, { headers: { 'X-Forwarded-For': ip } });
  return { get, calls, proxy };
};

test('proxy caches and shares identical requests', async (t) => {
  const { get, calls } = await startProxy(t, async () => { await sleep(20); return {}; });
  const path = '/FetchPlayerListing?sport=NHL&league_id=1';

  const [first, second] = await Promise.all([get(path), get(path, '2.2.2.2')]);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
  const third = await get(path);
  assert.strictEqual(third.headers.get('x-cache'), 'HIT');
  assert.deepStrictEqual(await third.json(), { url: 'https://flea.test/api/FetchPlayerListing?sport=NHL&league_id=1' });
  assert.strictEqual(calls.length, 1);
});

test('proxy retries after being throttled', async (t) => {
  const { get, calls, proxy } = await startProxy(t, async (url, n) => (n === 1 ? { status: 403 } : {}));
  const response = await get('/FetchLeagueActivity?league_id=1');
  assert.strictEqual(response.status, 200);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(proxy.stats().throttled, 1);
});

test('proxy sheds load with 429, or serves stale data when it has it', async (t) => {
  let throttled = false;
  let time = 0;
  const cache = new ResponseCache({ maxBytes: 1024 * 1024, now: () => time });
  const { get } = await startProxy(t, async () => (throttled ? { status: 403 } : {}), { cache });

  assert.strictEqual((await get('/FetchLeagueActivity?league_id=1')).status, 200);
  throttled = true;
  time = 60 * 60 * 1000;

  const stale = await get('/FetchLeagueActivity?league_id=1');
  assert.strictEqual(stale.status, 200);
  assert.strictEqual(stale.headers.get('x-cache'), 'STALE');

  const shed = await get('/FetchLeagueActivity?league_id=2');
  assert.strictEqual(shed.status, 429);
  assert.ok(parseInt(shed.headers.get('retry-after'), 10) >= 1);
});

test('proxy passes through errors without caching them', async (t) => {
  const { get, calls } = await startProxy(t, async () => ({ status: 404, body: { message: 'nope' } }));
  assert.strictEqual((await get('/FetchLeagueActivity?league_id=9')).status, 404);
  assert.strictEqual((await get('/FetchLeagueActivity?league_id=9')).status, 404);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual((await get('/notAnEndpoint')).status, 404);
  assert.strictEqual(calls.length, 2);
});

test('proxy serves a waiting client between another client\'s pages', async (t) => {
  const order = [];
  const { get } = await startProxy(t, async (url) => { order.push(url.split('?')[1]); await sleep(5); return {}; });

  const bulk = [0, 30, 60, 90].map(offset => get(`/FetchPlayerListing?league_id=1&result_offset=${offset}`, '1.1.1.1'));
  await sleep(2);
  const small = get('/FetchLeagueActivity?league_id=2', '2.2.2.2');
  await Promise.all([...bulk, small]);

  assert.ok(order.indexOf('league_id=2') <= 2, `small request served at position ${order.indexOf('league_id=2')}`);
});
