# fairly design

fairly answers one question: has this key exceeded its quota right now. Each decision is one atomic Redis operation. This document covers phase 1: four algorithms, one Redis instance, an HTTP API.

## Atomicity

Every algorithm is a single Lua script run with EVALSHA. Redis executes a script to completion before running any other command, so the read of current state, the decision, and the state update cannot interleave with another request. Scripts live in `src/algorithms/lua/`, are hashed (SHA-1) at load time, and are called by SHA. If Redis answers NOSCRIPT (after a restart or SCRIPT FLUSH) the store loads the script once and retries.

The current time used by a script is read from Redis `TIME` inside the script. No client clock is involved, so clock skew between fairly instances cannot change a decision. Tests inject a clock by passing an explicit timestamp argument to the script; production never does.

Keys are `fairly:{<policy name>:<key>}:<suffix>`. The braces form a hash tag, so all keys a script touches for one limit would land in one slot on a clustered Redis.

## Algorithms

`limit` and `windowSeconds` come from the policy. Every `check` returns `allowed`, `remaining`, `resetAtMs` and `retryAfterMs`, all computed inside the script from the same time reading that made the decision.

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

## Policies

A policy is `{ name, route, tier?, algorithm, limit, windowSeconds }`. `POST /v1/check` takes `{ key, route, tier? }` and resolves the policy in memory.

Resolution sorts policies once, whenever the set changes, by: exact route first, then wildcard routes by descending literal length, then tier-bearing before tier-less, then name. A request takes the first policy in that order whose route matches and whose tier is absent or equal to the request tier. Route specificity is ranked above tier so that a broad tier rule (`*` for premium) cannot silently bypass a deliberately strict route rule such as `/login`; a policy that names both route and tier is the way to give a tier its own limit on a route.

Quota state is keyed by `<policy name>:<key>`. All routes matched by one policy share one quota per key. Renaming or recreating a policy therefore starts a fresh quota; editing its limit or window keeps the existing state.

Route patterns are matched with a small iterative wildcard matcher (`globMatch` in `src/policy/resolve.ts`), not a regular expression. A pattern with many `*` turned into a backtracking regular expression takes time polynomial in the route length with a degree equal to the number of stars; a request route of up to 256 characters against a 10-star pattern already took hundreds of milliseconds, so a hostile policy could have stalled the event loop. The matcher is O(pattern length x route length) in the worst case and gives the same answers as the regular expression it replaced (checked against it on thousands of random cases in the tests).

### Limits on values

`limit` is capped at 1,000,000,000 and `windowSeconds` at 31,536,000, and their product in milliseconds must stay within 2^53 - 1. Redis Lua numbers are doubles, so inside that bound every count, product and division the scripts do is exact. Before the bound existed, a policy near the top of the integer range made the sliding window counter script fail with a Redis "not an integer" error (which the service treats as a Redis outage, so fail-open silently allowed everything), and made the token bucket report a `remaining` that did not decrease after a request had been admitted.

### Storage and propagation

Policies are stored in one Redis hash (`fairly:policies`, field = name, value = JSON definition). The config file seeds the hash only if the flag key `fairly:policies:seeded` is unset, using a single script so concurrent instance starts seed once. After seeding, Redis is authoritative.

Create and update go through one script that checks existence and writes (create fails if the name exists, update fails if it does not), so two instances cannot both create the same name. Each instance holds a compiled copy in memory and replaces it from `HGETALL` every `POLICY_REFRESH_MS`; the instance that performs a write also applies it locally at once. Other instances can therefore serve the previous policy for up to one refresh interval after a change. Entries in the hash that are not valid policies are logged and skipped. If a refresh fails the previous copy stays in use and `fairly_redis_failures_total{operation="policy_refresh"}` increases. Pub/sub notification was not used: polling needs no extra connection state and bounds staleness by a setting.

## API

- `POST /v1/check` with `{ "key", "route", "tier"? }`, or with an inline limit `{ "key", "algorithm", "limit", "windowSeconds" }` validated by the same schema as policies. 200 when allowed, 429 when denied, 400 for a malformed body, 404 `no_matching_policy`, 503 in fail-closed mode when Redis is unavailable.
- `GET /v1/admin/policies`, `GET|PUT|DELETE /v1/admin/policies/:name`, `POST /v1/admin/policies`, guarded by the `X-Admin-Token` header. The token is compared as SHA-256 digests with `timingSafeEqual`. The routes are registered only when `FAIRLY_ADMIN_TOKEN` is set.
- `GET /healthz` returns 200 if Redis answers PING within the timeout, 503 otherwise.
- `GET /metrics` exposes `fairly_decisions_total{policy,algorithm,decision}`, `fairly_redis_failures_total{operation,mode}` and `fairly_check_duration_seconds{algorithm}`. The key is never a label.

## Redis failure handling

Every Redis call made through `RedisStore` is raced against a timer (`REDIS_COMMAND_TIMEOUT_MS`) in addition to the client's own command timeout, and the client is configured with no offline queue and a connect timeout, so commands fail immediately while disconnected and after the timeout while connected to a Redis that stopped answering. All of this is asynchronous; a hung Redis holds individual requests for at most the timeout and never blocks the event loop. A late reply to a timed-out call is discarded.

`FAIRLY_FAILURE_MODE` selects what a check does when it cannot complete:

- `fail-open` (default): respond 200 `{ allowed: true, degraded: true }`. There is no count, so `X-RateLimit-Remaining` equals the limit and `X-RateLimit-Reset` is the application clock plus one window. This is the only place the application clock is used for a response.
- `fail-closed`: respond 503 with `Retry-After` set to `FAIRLY_FAIL_CLOSED_RETRY_AFTER_SECONDS`, `X-RateLimit-Remaining: 0`. 503 is used instead of 429 because the client is not over its limit; the service cannot decide.

Both modes log an error for every failed check and add `X-Fairly-Degraded: true`. Fail-open trades enforcement for availability: during an outage nothing is limited. Under fail-open with a Redis that hangs rather than refuses connections, each request still waits up to the timeout before being allowed, so the timeout is also the added latency during such an outage; lower it if that matters more than tolerating slow Redis replies.

## Configuration

The seed file is JSON (`fairly.config.json`, path from `FAIRLY_CONFIG`), validated with Zod at startup:

```json
{
  "policies": [
    { "name": "login", "route": "/login", "algorithm": "sliding-window-log", "limit": 5, "windowSeconds": 300 }
  ]
}
```

JSON was chosen over YAML because Node parses it with no dependency and the structure is flat. An unknown algorithm, a non-positive or non-integer `limit` or `windowSeconds`, a name or tier outside `[A-Za-z0-9_.-]`, an empty route, or duplicate names stop the process with an error naming the offending path. Names exclude `:` and braces so `<name>:<key>` state keys are unambiguous.

The environment variables are listed in the README.

## Tests

Tests use Vitest and a real Redis started by Testcontainers (`test/global-setup.ts`); Docker must be available. Algorithm tests inject a manual clock so window and refill behavior is tested without sleeping. Concurrency tests (`test/api/concurrency.test.ts`) start real Fastify servers, send 500 requests with `Promise.all` over HTTP against a limit of 100 for each algorithm, and assert exactly 100 are allowed. They run both against one server and with requests split across two server instances sharing one Redis. The resilience tests stop and pause their Redis container mid-test, in both failure modes.

`scripts/demo-race.mjs [algorithm|all] [--keep] [--no-compose]` starts the compose stack, fires 1000 concurrent requests from 8 worker threads at a route with limit 1000, then fires 1000 more and reports allowed and rejected counts per algorithm. The demo routes use a 86400 second window so a window boundary cannot fall inside a run in practice.
