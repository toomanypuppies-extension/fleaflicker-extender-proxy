const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const { SlidingWindowLimiter } = require('./flea/limiter');
const { FairQueue } = require('./flea/fairQueue');
const { ResponseCache } = require('./flea/cache');
const { createFleaProxy } = require('./flea/proxy');

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
const fleaProxy = createFleaProxy({
  upstream: 'https://www.fleaflicker.com/api',
  limiter: fleaLimiter,
  queue: new FairQueue({ limiter: fleaLimiter, maxConcurrent: 4, maxQueuePerClient: 50 }),
  cache: new ResponseCache({ maxBytes: 64 * 1024 * 1024 }),
});
app.use('/proxy/flea', fleaProxy);
app.get('/flea-stats', (req, res) => {
  res.json(fleaProxy.stats());
});
app.use(
  '/proxy/nhl',
  createProxyMiddleware({
    target: 'https://statsapi.web.nhl.com/api/v1',
    changeOrigin: true,
    pathRewrite: { '^/proxy/nhl': '' },
    logger: console
  })
);
app.use(
  '/proxy/nhlv2',
  createProxyMiddleware({
    target: 'https://api-web.nhle.com/v1',
    changeOrigin: true,
    pathRewrite: { '^/proxy/nhlv2': '' },
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