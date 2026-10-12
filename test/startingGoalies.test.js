const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { ResponseCache } = require('../flea/cache');
const { parseStartingGoalies, createStartingGoaliesHandler } = require('../goalies/startingGoalies');

// Daily Faceoff's pages, trimmed to two games: a day whose starters were all confirmed, and a morning
// before any news
const CONFIRMED_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'starting-goalies-confirmed.html'), 'utf8');
const UNCONFIRMED_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'starting-goalies-unconfirmed.html'), 'utf8');

test("parses each game's starters, with the news behind them", () => {
  const day = parseStartingGoalies(CONFIRMED_HTML);

  assert.strictEqual(day.date, '2026-10-11');
  assert.strictEqual(day.games.length, 2);
  assert.strictEqual(day.complete, true);
  const [game] = day.games;
  assert.strictEqual(game.start, '2026-10-11T21:00:00.000Z');
  assert.deepStrictEqual(game.home, {
    team: 'Washington Capitals',
    goalie: 'Logan Thompson',
    status: 'Confirmed',
    details: 'Thompson will start Sunday vs. the Kraken.',
    source: 'Sammi Silber',
    sourceUrl: 'https://x.com/sammisilber/status/2109355312360853747',
    updatedAt: '2026-10-11T18:49:23.841Z',
  });
  assert.strictEqual(game.away.goalie, 'Joey Daccord');
});

test('a day without news for every starter is not complete', () => {
  const day = parseStartingGoalies(UNCONFIRMED_HTML);

  assert.strictEqual(day.complete, false);
  assert.ok(day.games.every(game => game.home.goalie && game.home.status === null));
  assert.throws(() => parseStartingGoalies('<html></html>'));
});

// Starts the route in front of a fake Daily Faceoff. respond(url, callNumber) -> { status, html }
const startRoute = (t, respond, ttls = {}) => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const { status = 200, html } = await respond(url, calls.length);
    return new Response(html, { status, headers: { 'content-type': 'text/html' } });
  };
  const app = express();
  app.get('/proxy/starting-goalies/:date', createStartingGoaliesHandler({
    cache: new ResponseCache({ maxBytes: 1024 * 1024 }),
    fetchImpl,
    origin: 'https://dfo.test',
    ...ttls,
  }));
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/proxy/starting-goalies`;
  return { get: (route) => fetch(`${base}${route}`), calls };
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('unsettled days are fetched again after a while, settled ones are kept', async (t) => {
  const { get, calls } = startRoute(t, (url) => ({ html: url.endsWith('2026-10-11') ? CONFIRMED_HTML : UNCONFIRMED_HTML }),
    { unsettledTtlMs: 40, settledTtlMs: 10000 });

  const first = await get('/2026-10-12');
  assert.strictEqual(first.status, 200);
  assert.strictEqual((await first.json()).complete, false);
  assert.strictEqual((await get('/2026-10-12')).headers.get('x-cache'), 'HIT');
  await get('/2026-10-11');
  assert.deepStrictEqual(calls, ['https://dfo.test/starting-goalies/2026-10-12', 'https://dfo.test/starting-goalies/2026-10-11']);

  await wait(60);
  assert.strictEqual((await get('/2026-10-12')).headers.get('x-cache'), 'MISS');
  assert.strictEqual((await get('/2026-10-11')).headers.get('x-cache'), 'HIT');
  assert.strictEqual(calls.length, 3);
});

test('requests for the same day share one fetch', async (t) => {
  const { get, calls } = startRoute(t, async () => {
    await wait(30);
    return { html: UNCONFIRMED_HTML };
  });

  const responses = await Promise.all([get('/2026-10-12'), get('/2026-10-12'), get('/2026-10-12')]);
  assert.ok(responses.every(response => response.status === 200));
  assert.strictEqual(calls.length, 1);
});

test('failures serve what was cached, or an error', async (t) => {
  const { get } = startRoute(t, (url, n) => (n === 1 ? { html: UNCONFIRMED_HTML } : { status: 503, html: '' }), { unsettledTtlMs: 20 });
  await get('/2026-10-12');
  await wait(40);

  const stale = await get('/2026-10-12');
  assert.strictEqual(stale.status, 200);
  assert.strictEqual(stale.headers.get('x-cache'), 'STALE');
  assert.strictEqual((await get('/2026-10-13')).status, 502);
  assert.strictEqual((await get('/tomorrow')).status, 404);
});
