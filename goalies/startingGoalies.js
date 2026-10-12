const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

// Starters are announced through the day, so a day that isn't settled is checked again this often
const UNSETTLED_TTL = 15 * MINUTE;
// Once every starter is confirmed the day won't change
const SETTLED_TTL = 24 * HOUR;
const CONFIRMED = 'Confirmed';

const side = (game, prefix) => ({
  team: game[`${prefix}TeamName`] || null,
  goalie: game[`${prefix}GoalieName`] || null,
  // "Confirmed", or null until Daily Faceoff has news either way
  status: game[`${prefix}NewsStrengthName`] || null,
  details: game[`${prefix}NewsDetails`]?.trim() || null,
  source: game[`${prefix}NewsSourceName`] || null,
  sourceUrl: game[`${prefix}NewsSourceUrl`] || null,
  updatedAt: game[`${prefix}NewsCreatedAt`] || null,
});

/**
 * A day's starting goalies from Daily Faceoff's starting goalies page, which carries them as JSON
 * for its Next.js app: { date, games: [{ start, away, home }], complete }. complete is true once
 * every starter is confirmed. Throws if the page doesn't have the data.
 */
const parseStartingGoalies = (html) => {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('No starting goalie data on the page');
  }
  const pageProps = JSON.parse(match[1])?.props?.pageProps;
  if (!pageProps || !Array.isArray(pageProps.data)) {
    throw new Error('Starting goalie data is missing from the page');
  }
  const games = pageProps.data.map(game => ({
    start: game.dateGmt || null,
    away: side(game, 'away'),
    home: side(game, 'home'),
  }));
  return {
    date: pageProps.date || null,
    games,
    complete: games.length > 0 && games.every(game => game.away.status === CONFIRMED && game.home.status === CONFIRMED),
  };
};

/**
 * Express handler for /:date (YYYY-MM-DD), returning that day's starting goalies from Daily Faceoff
 * as JSON (see parseStartingGoalies). Cached, and fetched once at a time per day however many ask.
 */
const createStartingGoaliesHandler = ({
  cache,
  fetchImpl = fetch,
  origin = 'https://www.dailyfaceoff.com',
  unsettledTtlMs = UNSETTLED_TTL,
  settledTtlMs = SETTLED_TTL,
}) => {
  const inFlight = new Map();

  const fetchDay = async (date) => {
    const response = await fetchImpl(`${origin}/starting-goalies/${date}`, {
      headers: { 'User-Agent': 'fleaflicker-extender (starting goalies, cached)' },
    });
    if (response.status !== 200) {
      throw new Error(`Daily Faceoff returned ${response.status} for ${date}`);
    }
    const goalies = parseStartingGoalies(await response.text());
    const entry = { status: 200, body: Buffer.from(JSON.stringify(goalies)) };
    cache.set(`goalies/${date}`, entry, goalies.complete ? settledTtlMs : unsettledTtlMs);
    return entry;
  };

  return async (req, res) => {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.sendStatus(404);
      return;
    }

    const cached = cache.get(`goalies/${date}`);
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
      if (!inFlight.has(date)) {
        inFlight.set(date, fetchDay(date).finally(() => inFlight.delete(date)));
      }
      send(await inFlight.get(date), 'MISS');
    } catch (err) {
      if (cached) {
        send(cached.response, 'STALE', cached.ageMs);
        return;
      }
      console.error(err);
      res.status(502).json({ message: 'Failed to reach Daily Faceoff' });
    }
  };
};

module.exports = { parseStartingGoalies, createStartingGoaliesHandler, UNSETTLED_TTL, SETTLED_TTL };
