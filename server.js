const express = require('express');
const cors = require('cors');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

/**
 * Setup cors
 */
app.use(cors());

/**
 * Setup proxies
 */
app.use(
  '/proxy/flea',
  createProxyMiddleware({
    target: 'https://www.fleaflicker.com/api',
    changeOrigin: true,
    pathRewrite: { '^/proxy/flea': '' },
    logger: console
  })
);
app.use(
  '/proxy/nhl',
  createProxyMiddleware({
    target: 'https://statsapi.web.nhl.com/api/v1',
    changeOrigin: true,
    pathRewrite: { '^/proxy/flea': '' },
    logger: console
  })
);

/**
 * Healthcheck
 */
app.get('/healthcheck', (req, res) => {
  res.sendStatus(200);
});

const port = process.env.PORT || 3000;
app.listen(port);
console.log(`App listening on port ${port}`)