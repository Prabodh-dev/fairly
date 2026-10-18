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

## API

```
POST /v1/check
{ "key": "user-42", "route": "login" }
```

`route` selects an entry in `fairly.config.json`. Alternatively send an inline limit:

```
{ "key": "user-42", "algorithm": "token-bucket", "limit": 100, "windowSeconds": 60 }
```

Response body: `{ "allowed": true, "remaining": 99, "resetAtMs": 1700000060000 }`. Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch seconds). A rejection returns 429 with `Retry-After` (seconds).

`GET /healthz` returns 200 if Redis answers, 503 otherwise. `GET /metrics` serves Prometheus metrics.

## Configuration

`fairly.config.json` maps route names to limits:

```json
{ "routes": { "login": { "algorithm": "sliding-window-log", "limit": 5, "windowSeconds": 300 } } }
```

Environment: `FAIRLY_FAILURE_POLICY` (required, `open` or `closed`: what to do when Redis is unreachable), `REDIS_URL`, `FAIRLY_CONFIG`, `PORT`, `HOST`, `REDIS_COMMAND_TIMEOUT_MS`, `LOG_LEVEL`.

## Running

```
pnpm install
pnpm build
FAIRLY_FAILURE_POLICY=closed pnpm start     # needs Redis at REDIS_URL
docker compose up                            # service plus Redis on :8080
```

## Tests

```
pnpm lint
pnpm typecheck
pnpm test
```

Tests start a real Redis with Testcontainers, so Docker must be running. They cover each algorithm (limits, remaining count, window and refill behavior with an injected clock, boundary bursts, clock moving backwards), configuration validation, the HTTP API, store failure policies, and concurrency: 500 concurrent HTTP requests against a limit of 100 must allow exactly 100, for every algorithm, against one server and against two servers sharing a Redis.

## Race demo

```
node scripts/demo-race.mjs [fixed-window|sliding-window-log|sliding-window-counter|token-bucket|all] [--keep] [--no-compose]
```

Starts the compose stack, fires 1000 concurrent requests from 8 worker threads at a route with a limit of 1000, then 1000 more, and prints allowed and rejected counts. Expected: 1000 allowed in the first wave, 0 in the second, 0 over the limit.
