# fairly

A distributed rate limiter and API quota service. One question, answered atomically under concurrency: has this key exceeded its quota right now.

Every decision is a single Lua script executed in Redis. The script reads state, decides, and updates state in one step, so concurrent requests cannot interleave between the check and the write. Time comes from Redis `TIME` inside the script, so clock skew between service instances does not affect decisions.

## Algorithms

All four implement the same interface (`src/algorithms/types.ts`):

```ts
check(key: string, limit: number, windowSeconds: number): Promise<{
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  retryAfterMs: number;
}>
```

| | Fixed window | Sliding window log | Sliding window counter | Token bucket |
| --- | --- | --- | --- | --- |
| Redis state per key | 1 small counter per active window | 1 sorted set entry per admitted request in the window | 2 counters | 1 hash (balance, timestamp) |
| Memory | lowest | highest, grows with `limit` | low | low |
| Precision | exact within a bucket, up to 2x `limit` across a boundary | exact | approximate | exact for its own model |
| Bursts | up to `limit` at once, twice around a boundary | up to `limit` in any trailing window | roughly `limit` | up to `limit` (capacity), then the refill rate |
| Cost per check | O(1) | O(log n) plus eviction | O(1) | O(1) |

**Fixed window.** Counts requests in buckets aligned to multiples of the window. Cheapest and easiest to reason about. Its weakness: a client can spend the full limit at the end of one bucket and the full limit again at the start of the next, so up to twice the limit can pass in a very short span. Use it when that is acceptable and cost matters most.

**Sliding window log.** Stores a timestamp for every admitted request and counts those inside the trailing window, evicting expired entries in the same script. It is the most precise: the limit holds for every possible window position. The price is memory proportional to the limit per key, so it suits small limits (login attempts, expensive operations) and not large per-key quotas.

**Sliding window counter.** Keeps the current and previous bucket counts and estimates the trailing window as `floor(previous * overlap) + current`, where `overlap` is the fraction of the previous bucket still inside the window. It removes the fixed-window boundary burst at the cost of two counters per key, but assumes the previous bucket's traffic was evenly spread, so it can be off by some requests when traffic was bursty.

**Token bucket.** A bucket holds up to `limit` tokens and refills at `limit / windowSeconds` per second; each request spends one. It allows a burst up to capacity and then enforces the steady refill rate, which is usually what API quotas want. Balance is stored in integer sub-token units, so there is no floating point drift. `windowSeconds` is the time to refill an empty bucket completely.

Details, including what `resetAtMs` means for each algorithm, are in [docs/design.md](docs/design.md).

## Policies

A policy maps a route pattern and an optional tier to an algorithm, a limit and a window. Clients send `{ key, route, tier? }` and fairly picks the policy; no limit is passed per request.

```json
{
  "policies": [
    { "name": "default", "route": "*", "algorithm": "sliding-window-counter", "limit": 100, "windowSeconds": 60 },
    { "name": "default-premium", "route": "*", "tier": "premium", "algorithm": "sliding-window-counter", "limit": 1000, "windowSeconds": 60 },
    { "name": "login", "route": "/login", "algorithm": "sliding-window-log", "limit": 5, "windowSeconds": 300 },
    { "name": "uploads", "route": "/uploads/*", "algorithm": "token-bucket", "limit": 20, "windowSeconds": 60 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Unique id, letters, digits, `_`, `.`, `-`, up to 64 characters. Quota state is kept per policy name and key, so all routes matched by one policy share one quota per key. |
| `route` | Exact route, or a pattern where `*` matches any run of characters (including `/`). Defaults to `*`. |
| `tier` | Optional. The policy only applies to requests that send the same `tier`. |
| `algorithm` | `fixed-window`, `sliding-window-log`, `sliding-window-counter` or `token-bucket`. |
| `limit`, `windowSeconds` | Positive integers. |

**Precedence.** Among policies that match the request:

1. An exact route beats any pattern.
2. Between patterns, the one with more literal (non-`*`) characters wins, so `/api/v1/*` beats `/api/*` beats `*`.
3. For the same route, a policy with a tier beats one without.
4. Remaining ties go to the alphabetically first name.

A tier policy therefore never overrides a more specific route policy: with `/login` and a premium `*` policy, a premium user on `/login` gets the `/login` policy unless a policy for `/login` with tier `premium` exists. A policy that has a tier is skipped when the request tier differs or is missing. If no policy matches, `/v1/check` returns 404 `no_matching_policy`.

**Where policies live.** The config file (`FAIRLY_CONFIG`, default `fairly.config.json`) seeds Redis the first time a Redis is used. After that Redis is the source of truth: changes made through the admin API are shared by all instances, survive restarts, and edits to the config file no longer apply. To reseed, delete the `fairly:policies` and `fairly:policies:seeded` keys. Each instance keeps policies in memory and re-reads them from Redis every `POLICY_REFRESH_MS` (default 2000), so a change made on one instance reaches the others within that interval; the instance that handled the change applies it immediately. If Redis is unreachable, an instance keeps using its last known policies.

Ad-hoc checks can still bypass policies with an inline limit:

```
{ "key": "user-42", "algorithm": "token-bucket", "limit": 100, "windowSeconds": 60 }
```

Inline checks keep their state under the policy name `inline`.

## Check API

```
POST /v1/check
{ "key": "user-42", "route": "/login", "tier": "premium" }
```

Response body: `{ "allowed": true, "remaining": 4, "resetAtMs": 1700000060000, "policy": "login" }`.

`GET /healthz` returns 200 if Redis answers, 503 otherwise. `GET /metrics` serves Prometheus metrics.

### Header contract

Every `/v1/check` response that reaches a decision carries these headers, whether the request is allowed, denied, or decided by the failure mode:

| Header | Value |
| --- | --- |
| `X-RateLimit-Limit` | The `limit` of the policy that applied. |
| `X-RateLimit-Remaining` | Requests left, computed by the same atomic operation that made the decision. 0 when denied. |
| `X-RateLimit-Reset` | Unix time in seconds, rounded up. Allowed: when the algorithm's counter next resets or frees capacity (see `docs/design.md`). Denied: the earliest time a retry can succeed. |
| `Retry-After` | On denial only: whole seconds until a retry can succeed, at least 1. |

A denied request returns 429. Malformed requests (400) and unmatched routes (404) carry no rate limit headers because no limit applied.

## Failure modes

Every Redis call has a timeout (`REDIS_COMMAND_TIMEOUT_MS`, default 1000), so a dead or hung Redis fails a request after at most that long and never blocks the server. When a check cannot complete, `FAIRLY_FAILURE_MODE` decides the outcome:

| Mode | Response |
| --- | --- |
| `fail-open` (default) | 200, `allowed: true`, `degraded: true`. `X-RateLimit-Limit` is the policy limit, `X-RateLimit-Remaining` equals the limit, and `X-RateLimit-Reset` is now plus the window, because no count is available. |
| `fail-closed` | 503, `allowed: false`, `degraded: true`, `Retry-After` of `FAIRLY_FAIL_CLOSED_RETRY_AFTER_SECONDS` (default 1), `X-RateLimit-Remaining: 0`. |

Both modes set `X-Fairly-Degraded: true`, write an error log for every failed check (with `key`, `policy`, `algorithm`, `failureMode`, `decision`), and increment `fairly_redis_failures_total{operation,mode}`. Operations are `check`, `healthz` and `policy_refresh`. Policy lookups use the in-memory copy, so the policy is still known while Redis is down. Admin writes need Redis and return 503 when it is unreachable. Checks recover on their own once Redis answers again.

## Admin API

Set `FAIRLY_ADMIN_TOKEN` (at least 16 characters) to enable the admin endpoints; without it they are not exposed. Send the token in the `X-Admin-Token` header. A missing or wrong token returns 401.

| Request | Result |
| --- | --- |
| `GET /v1/admin/policies` | 200 `{ "policies": [...] }`, sorted by name |
| `GET /v1/admin/policies/:name` | 200 policy, or 404 |
| `POST /v1/admin/policies` with a full policy including `name` | 201 policy, 409 if the name exists, 400 if invalid |
| `PUT /v1/admin/policies/:name` with `route`, `algorithm`, `limit`, `windowSeconds`, `tier` | 200 policy (replaces the definition), 404 if missing, 400 if invalid |
| `DELETE /v1/admin/policies/:name` | 204, or 404 |

```
curl -X PUT localhost:8080/v1/admin/policies/login \
  -H 'x-admin-token: <token>' -H 'content-type: application/json' \
  -d '{ "route": "/login", "algorithm": "sliding-window-log", "limit": 10, "windowSeconds": 300 }'
```

Changing a policy does not reset existing quota state. Changing a policy's algorithm starts fresh state for that algorithm.

## Configuration

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis to use |
| `FAIRLY_CONFIG` | `fairly.config.json` | Seed policies |
| `FAIRLY_FAILURE_MODE` | `fail-open` | `fail-open` or `fail-closed` |
| `FAIRLY_FAIL_CLOSED_RETRY_AFTER_SECONDS` | `1` | `Retry-After` sent in fail-closed mode |
| `REDIS_COMMAND_TIMEOUT_MS` | `1000` | Timeout for every Redis call |
| `POLICY_REFRESH_MS` | `2000` | How often an instance re-reads policies |
| `FAIRLY_ADMIN_TOKEN` | unset | Enables the admin API |
| `PORT`, `HOST`, `LOG_LEVEL` | `8080`, `0.0.0.0`, `info` | Server |

The config file is JSON and is validated at startup; an unknown algorithm, a non-positive or non-integer limit or window, a bad name, or duplicate names stop the process with an error naming the field. `FAIRLY_FAILURE_POLICY` from earlier versions is rejected with an error pointing at `FAIRLY_FAILURE_MODE`.

## Running

```
pnpm install
pnpm build
pnpm start                                   # needs Redis at REDIS_URL
docker compose up                            # service plus Redis on :8080
```

## Tests

```
pnpm lint
pnpm typecheck
pnpm test
```

Tests start a real Redis with Testcontainers, so Docker must be running. They cover each algorithm (limits, remaining count, window and refill behavior with an injected clock, boundary bursts, clock moving backwards), configuration validation, policy resolution and precedence, the admin API including authentication and propagation between instances, the header contract for allowed and denied responses, Redis failure handling (container stopped and container paused, in both failure modes), and concurrency: 500 concurrent HTTP requests against a limit of 100 must allow exactly 100, for every algorithm, against one server and against two servers sharing a Redis.

## Race demo

```
node scripts/demo-race.mjs [fixed-window|sliding-window-log|sliding-window-counter|token-bucket|all] [--keep] [--no-compose]
```

Starts the compose stack, fires 1000 concurrent requests from 8 worker threads at a route with a limit of 1000, then 1000 more, and prints allowed and rejected counts. Expected: 1000 allowed in the first wave, 0 in the second, 0 over the limit.
