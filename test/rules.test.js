const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { SlidingWindowLimiter } = require('../flea/limiter');
const { FairQueue } = require('../flea/fairQueue');
const { ResponseCache } = require('../flea/cache');
const { parseLeagueRules } = require('../flea/rules');
const { createRulesHandler } = require('../flea/rulesRoute');

const RULES_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'rules.html'), 'utf8');

test('parses transaction limits and waiver settings', () => {
  const rules = parseLeagueRules(RULES_HTML);

  assert.deepStrictEqual(rules.transactionLimit, { period: 'week', limit: 7 });
  assert.deepStrictEqual(rules.waivers, {
    claimsResolvedBy: 'Waiver Priority',
    placedOnWaivers: 'Dropped players and all free agents after game start (recommended)',
    gameStartWaivers: true,
    hoursAfterDrop: 24,
    gameStartProcessing: 'Every day, locking at 5:00 AM EDT',
    gameStartLockTime: { hour: 5, minute: 0 },
    firstComeFirstServedTime: { hour: 8, minute: 0 },
    alwaysOnDuringPreseason: false,
  });
  assert.strictEqual(rules.settings['Trade Review Period'], '24 Hours');
  assert.strictEqual(rules.settings.Totals, '18: 14 Starters, 4 Bench, +2 IR');
});

test('settings in other formats', () => {
  const page = (settings) => Object.entries(settings).map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`).join('');

  const rules = parseLeagueRules(page({
    'Transaction Limits': 'None',
    'Who is Placed on Waivers': 'Dropped players only',
    'Time on Waivers After Drop': '2 Days',
  }));
  assert.strictEqual(rules.transactionLimit, null);
  assert.strictEqual(rules.waivers.gameStartWaivers, false);
  assert.strictEqual(rules.waivers.hoursAfterDrop, 48);

  const empty = parseLeagueRules('<html></html>');
  assert.strictEqual(empty.transactionLimit, null);
  assert.strictEqual(empty.waivers.gameStartWaivers, null);
  assert.strictEqual(empty.waivers.gameStartLockTime, null);
  assert.deepStrictEqual(empty.settings, {});
});

test('lock times are read in Eastern, in winter too', () => {
  const rules = parseLeagueRules(
    '<dt>Process Game-Start Waivers On</dt><dd>Every day, locking at <local-time datetime="2027-01-11T10:00:00Z">5:00 AM EST</local-time></dd>'
  );
  assert.deepStrictEqual(rules.waivers.gameStartLockTime, { hour: 5, minute: 0 });
});

// Starts the rules route in front of a fake fleaflicker. respond(url, callNumber) -> { status, html }
const startRules = (t, respond) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const { status = 200, html = RULES_HTML } = await respond(url, calls.length);
    return new Response(html, { status, headers: { 'content-type': 'text/html' } });
  };
  const limiter = new SlidingWindowLimiter({ limit: 1000, windowMs: 1000 });
  const cache = new ResponseCache({ maxBytes: 1024 * 1024 });
  const app = express();
  app.set('trust proxy', true);
  app.get('/proxy/flea-rules/:sport/:leagueId', createRulesHandler({
    queue: new FairQueue({ limiter, maxConcurrent: 1 }),
    cache,
    fetchImpl,
    origin: 'https://flea.test',
    ttlMs: 50,
    maxWaitMs: 500,
  }));
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/proxy/flea-rules`;
  return { get: (route) => fetch(`${base}${route}`), calls };
};

test('rules are fetched once and cached', async (t) => {
  const { get, calls } = startRules(t, () => ({}));

  const first = await get('/nhl/12089');
  assert.strictEqual(first.status, 200);
  assert.strictEqual((await first.json()).transactionLimit.limit, 7);
  assert.deepStrictEqual(calls, ['https://flea.test/nhl/leagues/12089/rules']);

  const second = await get('/nhl/12089');
  assert.strictEqual(second.headers.get('x-cache'), 'HIT');
  assert.strictEqual(calls.length, 1);
});

test('stale rules are served when fleaflicker fails', async (t) => {
  const { get } = startRules(t, (url, n) => (n === 1 ? {} : { status: 500, html: 'error' }));
  await get('/nhl/12089');
  await new Promise(resolve => setTimeout(resolve, 60));

  const response = await get('/nhl/12089');
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get('x-cache'), 'STALE');
});

test('missing leagues and bad paths', async (t) => {
  const { get, calls } = startRules(t, () => ({ status: 404, html: 'Not found' }));

  assert.strictEqual((await get('/nhl/1')).status, 404);
  assert.strictEqual((await get('/nhl/abc')).status, 404);
  assert.strictEqual((await get('/NHL/1')).status, 404);
  assert.strictEqual(calls.length, 1);
});

test('throttled with nothing cached asks the client to retry', async (t) => {
  const { get } = startRules(t, () => ({ status: 403, html: '' }));

  const response = await get('/nhl/12089');
  assert.strictEqual(response.status, 429);
  assert.strictEqual(response.headers.get('retry-after'), '30');
});
