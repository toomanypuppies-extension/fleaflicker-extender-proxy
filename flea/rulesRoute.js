const { QueueFullError, QueueTimeoutError } = require('./fairQueue');
const { parseLeagueRules } = require('./rules');

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

// League settings rarely change during a season
const RULES_TTL = 24 * HOUR;
const THROTTLED_STATUSES = [403, 429];

/**
 * Express handler for /:sport/:leagueId, returning the league's settings from its rules page
 * as JSON (see parseLeagueRules). Page fetches share the API's rate limit and fair queue.
 */
const createRulesHandler = ({
  queue,
  cache,
  fetchImpl = fetch,
  origin = 'https://www.fleaflicker.com',
  ttlMs = RULES_TTL,
  maxWaitMs = 45 * SECOND,
}) => async (req, res) => {
  const { sport, leagueId } = req.params;
  if (!/^[a-z]+$/.test(sport) || !/^\d{1,9}$/.test(leagueId)) {
    res.sendStatus(404);
    return;
  }

  const key = `rules/${sport}/${leagueId}`;
  const cached = cache.get(key);
  const send = (entry, cacheStatus, ageMs = 0) => {
    res.set('X-Cache', cacheStatus);
    res.set('Age', String(Math.floor(ageMs / SECOND)));
    res.status(entry.status).type('application/json').send(entry.body);
  };

  if (cached?.fresh) {
    send(cached.response, 'HIT', cached.ageMs);
    return;
  }

  try {
    const page = await queue.enqueue(req.ip, async () => {
      const response = await fetchImpl(`${origin}/${sport}/leagues/${leagueId}/rules`);
      return { status: response.status, html: await response.text() };
    }, { maxWaitMs });

    if (page.status === 404) {
      res.status(404).json({ message: `League ${leagueId} not found` });
      return;
    }
    if (THROTTLED_STATUSES.includes(page.status)) {
      throw new QueueFullError(`Throttled fetching rules for ${leagueId}`);
    }
    if (page.status !== 200) {
      throw new Error(`Rules page for ${leagueId} returned ${page.status}`);
    }

    const entry = {
      status: 200,
      body: Buffer.from(JSON.stringify(parseLeagueRules(page.html))),
    };
    cache.set(key, entry, ttlMs);
    send(entry, 'MISS');
  } catch (err) {
    if (cached) {
      send(cached.response, 'STALE', cached.ageMs);
      return;
    }
    const busy = err instanceof QueueFullError || err instanceof QueueTimeoutError;
    if (busy) {
      res.set('Retry-After', '30');
      res.status(429).json({ message: 'Too many requests to fleaflicker, try again shortly' });
    } else {
      console.error(err);
      res.status(502).json({ message: 'Failed to reach fleaflicker' });
    }
  }
};

module.exports = { createRulesHandler };
