import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';

import { SlidingWindowLimiter } from './flea/limiter.js';
import { FairQueue } from './flea/fairQueue.js';
import { ResponseCache } from './flea/cache.js';
import { createFleaProxy } from './flea/proxy.js';
import { createRulesHandler } from './flea/rulesRoute.js';
import { createStartingGoaliesHandler } from './goalies/startingGoalies.js';

const app = express();

// App Engine sets X-Forwarded-For, needed for req.ip to be the client rather than the load balancer
app.set('trust proxy', true);

/**
 * Setup cors
 */
app.use(cors({ exposedHeaders: ['Retry-After', 'X-Cache', 'Age'] }));

/**
 * Setup proxies
 */
// All users share this server's IP, and fleaflicker allows 90 calls/min per IP.
// Leave some headroom under that. This only works while there's a single instance (see app.yaml).
const fleaLimiter = new SlidingWindowLimiter({
  limit: parseInt(process.env.FLEA_CALLS_PER_MINUTE, 10) || 80,
  windowMs: 60 * 1000,
  minIntervalMs: 250,
});
const fleaQueue = new FairQueue({ limiter: fleaLimiter, maxConcurrent: 4, maxQueuePerClient: 50 });
const fleaCache = new ResponseCache({ maxBytes: 64 * 1024 * 1024 });
const fleaProxy = createFleaProxy({
  upstream: 'https://www.fleaflicker.com/api',
  limiter: fleaLimiter,
  queue: fleaQueue,
  cache: fleaCache,
});
app.use('/proxy/flea', fleaProxy);
// League settings the API doesn't return, from the league's rules page
app.get('/proxy/flea-rules/:sport/:leagueId', createRulesHandler({ queue: fleaQueue, cache: fleaCache }));
// A day's starting goalies from Daily Faceoff, which browsers can't fetch from other sites
app.get('/proxy/starting-goalies/:date', createStartingGoaliesHandler({ cache: new ResponseCache({ maxBytes: 4 * 1024 * 1024 }) }));
app.get('/flea-stats', (req, res) => {
  res.json(fleaProxy.stats());
});
app.use(
  '/proxy/nhlv2',
  createProxyMiddleware({
    target: 'https://api-web.nhle.com/v1',
    changeOrigin: true,
    logger: console
  })
);

/**
 * Healthcheck
 */
app.get('/healthcheck', (req, res) => {
  res.sendStatus(200);
});

const port = process.env.PORT || 8080;
app.listen(port);
console.log(`App listening on port ${port}`)