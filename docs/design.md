# fairly design

fairly answers one question: has this key exceeded its quota right now. Each decision is one atomic Redis operation. This document covers phase 1: four algorithms, one Redis instance, an HTTP API.

## Atomicity

Every algorithm is a single Lua script run with EVALSHA. Redis executes a script to completion before running any other command, so the read of current state, the decision, and the state update cannot interleave with another request. Scripts live in `src/algorithms/lua/`, are hashed (SHA-1) at load time, and are called by SHA. If Redis answers NOSCRIPT (after a restart or SCRIPT FLUSH) the store loads the script once and retries.

The current time used by a script is read from Redis `TIME` inside the script. No client clock is involved, so clock skew between fairly instances cannot change a decision. Tests inject a clock by passing an explicit timestamp argument to the script; production never does.

Keys are `fairly:{<route>:<key>}:<suffix>`. The braces form a hash tag, so all keys a script touches for one limit would land in one slot on a clustered Redis.

## Algorithms

`limit` and `windowSeconds` come from the route configuration. Every `check` returns `allowed`, `remaining`, `resetAtMs` and `retryAfterMs`, all computed inside the script from the same time reading that made the decision.

### Fixed window

A counter per (key, window bucket); the bucket is `floor(now / window)`. The counter key expires at the end of its bucket. Cheapest in memory and CPU (one small key per active key).

Known weakness: the limit is enforced per bucket, not per sliding interval. A client can send `limit` requests in the last instant of one bucket and `limit` more in the first instant of the next, so up to 2x the limit can pass within a span as short as one request interval around the boundary. The test `permits up to twice the limit across a window boundary` demonstrates this on purpose.

### Sliding window log

A sorted set per key; score is the request timestamp in ms, member is a unique id. On each check, entries with score <= now - window are removed, the remainder is counted, and a new entry is added only if the count is below the limit. Exact: no request can be admitted if `limit` requests were admitted in the trailing window.

Tradeoff: memory is proportional to the number of admitted requests inside the window, per key (up to `limit` entries each), and each check is O(log n) plus the eviction cost. For large limits and many keys this is the most expensive algorithm.

### Sliding window counter

Two fixed-window counters (current and previous bucket). The estimate is `floor(previous * (window - elapsed) / window) + current`, where `elapsed` is the time into the current bucket. A request is admitted if the estimate is below the limit. It assumes requests in the previous window were evenly spread, so it is an approximation: it can admit slightly more or fewer requests than an exact trailing window would, but it avoids the 2x boundary burst of fixed window and stores two integers per key.

### Token bucket

The bucket holds up to `limit` tokens and refills at `limit / windowSeconds` tokens per second; each request consumes one token. A new or fully refilled bucket allows an immediate burst of `limit` requests. `windowSeconds` is therefore the time to refill an empty bucket from zero to full.

The balance is stored in integer units of 1/windowMs token (refill adds `limit` units per elapsed ms, a request costs `windowMs` units), so there is no floating point drift and no fractional-token rounding. Elapsed time is computed in the script from Redis `TIME`. The key expires when the bucket would be full, which is equivalent to the key being absent.

## Response fields

| Field | Allowed request | Rejected request |
| --- | --- | --- |
| `remaining` | requests still available | 0 |
| `resetAtMs` | fixed window: end of the window. log: when the oldest entry leaves the window. counter: end of the current bucket. token bucket: when the bucket is full again | earliest time a retry can succeed, assuming no other requests for that key arrive first |
| `retryAfterMs` | 0 | `resetAtMs - now` as read in the script |

HTTP: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch seconds, rounded up) are set on every decided response. A rejection returns 429 with `Retry-After` in whole seconds, rounded up, minimum 1.

## API

- `POST /v1/check` with `{ "key": "<api key or user id>", "route": "<configured route>" }`. 200 when allowed, 429 when rejected, 400 for a malformed body, 404 for an unknown route.
- `GET /healthz` returns 200 if Redis answers PING, 503 otherwise.

## Store failure policy

`FAIRLY_FAILURE_POLICY` must be set to `open` or `closed`; the process refuses to start without it. When a check cannot reach Redis (error or `REDIS_COMMAND_TIMEOUT_MS` exceeded), the policy is applied and an error log with the key, route, algorithm, policy and resulting decision is written every time.

- `open`: respond 200 `{ "allowed": true, "degraded": true }`. No rate-limit headers are sent because no count exists.
- `closed`: respond 503 `{ "allowed": false, "degraded": true, "error": "store_unavailable" }`.

## Configuration

Limits are defined in a JSON file (`fairly.config.json`, path from `FAIRLY_CONFIG`):

```json
{
  "routes": {
    "login": { "algorithm": "sliding-window-log", "limit": 5, "windowSeconds": 300 }
  }
}
```

JSON was chosen over YAML because Node parses it with no dependency, and the structure is flat and small. The file is validated with Zod at startup; an unknown algorithm, a non-positive or non-integer `limit` or `windowSeconds`, an empty `routes` object, or a route name outside `[A-Za-z0-9_.-]` stops the process with an error naming the offending path. Route names exclude `:` and braces so that `route:key` composite keys are unambiguous.

Environment variables: `PORT` (8080), `HOST` (0.0.0.0), `REDIS_URL`, `REDIS_COMMAND_TIMEOUT_MS` (1000), `FAIRLY_CONFIG`, `FAIRLY_FAILURE_POLICY` (required), `LOG_LEVEL` (info).

## Tests

Tests use Vitest and a real Redis started by Testcontainers (`test/global-setup.ts`); Docker must be available. Algorithm tests inject a manual clock so window and refill behavior is tested without sleeping. Concurrency tests (`test/api/concurrency.test.ts`) start real Fastify servers, send 500 requests with `Promise.all` over HTTP against a limit of 100 for each algorithm, and assert exactly 100 are allowed. They run both against one server and with requests split across two server instances sharing one Redis. The failure policy test stops its Redis container mid-test.

`scripts/demo-race.mjs [algorithm|all] [--keep] [--no-compose]` starts the compose stack, fires 1000 concurrent requests from 8 worker threads at a route with limit 1000, then fires 1000 more and reports allowed and rejected counts per algorithm. The demo routes use a 86400 second window so a window boundary cannot fall inside a run in practice.
