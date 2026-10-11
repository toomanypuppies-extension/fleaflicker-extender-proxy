# Flea proxy

Used to address CORS concerns for the standalone site.

## Fleaflicker rate limiting

Fleaflicker allows 90 calls/min per IP and answers with a 403 past that. Every user of the
site shares this server's IP, so `/proxy/flea` doesn't pass requests straight through:

- Responses are cached and shared between users (`flea/cache.js`, TTLs in `flea/proxy.js`),
  and identical requests in flight at the same time share one upstream call.
- Upstream calls are held to `FLEA_CALLS_PER_MINUTE` (default 80) and spaced 250ms apart
  (`flea/limiter.js`).
- Waiting requests are served round robin by client IP (`flea/fairQueue.js`), so one user
  paging through every player can't hold up everyone else.
- A 403 from fleaflicker pauses all calls for 20s and the request is retried. Requests that
  can't be served within 45s get stale cached data if there is any, otherwise a 429 with
  `Retry-After`.

`GET /flea-stats` shows the current budget, queue, and cache.

The limiter and cache are in memory, so `app.yaml` pins the app to a single instance.

`yarn test` runs the tests.
