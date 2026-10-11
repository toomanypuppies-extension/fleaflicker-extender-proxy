const { QueueFullError, QueueTimeoutError } = require('./fairQueue');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// How long responses can be shared between clients. The site already avoids
// refetching players unless games are being played, so a few minutes is plenty fresh.
const TTL_BY_ENDPOINT = {
  FetchPlayerListing: 5 * MINUTE,
  FetchLeagueActivity: 30 * SECOND,
  FetchLeagueStandings: 60 * MINUTE,
};
const DEFAULT_TTL = MINUTE;

// Real errors from fleaflicker come back as 404s, 403 means we've been throttled
const THROTTLED_STATUSES = [403, 429];

class ThrottledError extends Error {}

/**
 * Express handler proxying GETs to the fleaflicker API through a shared cache and fair queue.
 */
const createFleaProxy = ({
  upstream,
  limiter,
  queue,
  cache,
  fetchImpl = fetch,
  maxWaitMs = 45 * SECOND,
  throttleRetries = 2,
  throttlePauseMs = 20 * SECOND,
}) => {
  // Identical requests already on their way upstream, shared rather than repeated
  const inflight = new Map();
  const counts = { upstream: 0, throttled: 0, shed: 0, stale: 0 };

  const fetchUpstream = async (url) => {
    counts.upstream++;
    const response = await fetchImpl(`${upstream}${url}`);
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: Buffer.from(await response.arrayBuffer()),
    };
  };

  const fetchWithRetries = async (clientKey, url, deadline, attempt = 0) => {
    const response = await queue.enqueue(clientKey, () => fetchUpstream(url), {
      maxWaitMs: Math.max(0, deadline - Date.now()),
      // Retries keep their place rather than going to the back of the line
      front: attempt > 0,
    });

    if (THROTTLED_STATUSES.includes(response.status)) {
      counts.throttled++;
      console.warn(`fleaflicker throttled ${url} (${response.status}), pausing ${throttlePauseMs}ms`);
      limiter.pause(throttlePauseMs);
      if (attempt < throttleRetries) {
        return fetchWithRetries(clientKey, url, deadline, attempt + 1);
      }
      throw new ThrottledError(`Throttled fetching ${url}`);
    }
    return response;
  };

  const fetchShared = (clientKey, url) => {
    if (!inflight.has(url)) {
      const request = fetchWithRetries(clientKey, url, Date.now() + maxWaitMs)
        .finally(() => inflight.delete(url));
      inflight.set(url, request);
    }
    return inflight.get(url);
  };

  const retryAfterSeconds = () => {
    // Rough time for the queue ahead to drain
    const drainMs = (queue.size / limiter.limit) * limiter.windowMs;
    const waitMs = Math.max(limiter.msUntilAvailable(), drainMs);
    return Math.min(60, Math.max(1, Math.ceil(waitMs / SECOND)));
  };

  const send = (res, response, cacheStatus, ageMs = 0) => {
    res.status(response.status);
    res.set('X-Cache', cacheStatus);
    res.set('Age', String(Math.floor(ageMs / SECOND)));
    if (response.contentType) {
      res.set('Content-Type', response.contentType);
    }
    res.send(response.body);
  };

  const handler = async (req, res) => {
    if (req.method !== 'GET') {
      res.sendStatus(405);
      return;
    }
    const endpoint = req.path.slice(1);
    if (!/^Fetch\w+$/.test(endpoint)) {
      res.sendStatus(404);
      return;
    }

    // req.url is relative to the mount point, so it's the upstream path + query
    const url = req.url;
    const cached = cache.get(url);
    if (cached?.fresh) {
      send(res, cached.response, 'HIT', cached.ageMs);
      return;
    }

    try {
      const response = await fetchShared(req.ip, url);
      if (response.status === 200) {
        cache.set(url, response, TTL_BY_ENDPOINT[endpoint] || DEFAULT_TTL);
      }
      send(res, response, 'MISS');
    } catch (err) {
      const busy = err instanceof QueueFullError || err instanceof QueueTimeoutError || err instanceof ThrottledError;
      if (busy && cached) {
        counts.stale++;
        send(res, cached.response, 'STALE', cached.ageMs);
      } else if (busy) {
        counts.shed++;
        res.set('Retry-After', String(retryAfterSeconds()));
        res.status(429).json({ message: 'Too many requests to fleaflicker, try again shortly' });
      } else {
        console.error(err);
        res.status(502).json({ message: 'Failed to reach fleaflicker' });
      }
    }
  };

  handler.stats = () => ({
    ...counts,
    inflight: inflight.size,
    limiter: limiter.stats(),
    queue: queue.stats(),
    cache: cache.stats(),
  });

  return handler;
};

module.exports = { createFleaProxy, TTL_BY_ENDPOINT };
