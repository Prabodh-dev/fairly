# fairly

[![CI](https://github.com/Prabodh-dev/fairly/actions/workflows/ci.yml/badge.svg)](https://github.com/Prabodh-dev/fairly/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**fairly is a rate limiting service.** Your backend asks it over HTTP whether a key (a user, an API key, an IP address) may make another request right now, and it answers allow or deny with standard `X-RateLimit-*` and `Retry-After` headers. Limits are named policies that you can change while it runs, state lives in Redis so many instances share it, and every decision is atomic: with 500 concurrent requests against a limit of 100, exactly 100 get through.

![Terminal recording: docker compose up, six requests to a rate-limited route with the X-RateLimit headers counting down to a 429 with Retry-After, then the limit raised live through the admin API](docs/demo.svg)

<sub>Real output, recorded with [`scripts/record-demo.sh`](scripts/record-demo.sh): the stack starting with `docker compose up`, the `X-RateLimit-Remaining` header counting down to a `429` with `Retry-After`, and a policy changed through the admin API with no restart. Replay the raw recording with `asciinema play docs/demo.cast`.</sub>

## Why it exists

Most rate limiters pick one algorithm and hide the trade-offs. fairly implements four behind one interface (fixed window, sliding window log, sliding window counter and token bucket), each as a single atomic Redis script, so you can point the same load at each and see what it costs in throughput, latency and memory (see [Benchmarks](#benchmarks)). Around the algorithms is what a service needs to be run for real: runtime policy changes, a predictable failure mode for when Redis is down, Prometheus metrics, an OpenAPI spec, graceful shutdown and a multi-arch container image.

It is also the admission-control part of a set of three backend projects that follow a request through its lifecycle: **fairly admits** a request, **steadily routes** it, and **durably executes** it. This repository is the first stage, deciding whether a request gets in at all. It does not depend on the other two and is useful on its own.

## Install

### Docker image

Release images for `linux/amd64` and `linux/arm64` are published to GitHub Container Registry for every version tag:

```
docker pull ghcr.io/prabodh-dev/fairly:latest
```

fairly needs a Redis to talk to. To try it with a throwaway one:

```
docker network create fairly
docker run -d --name redis --network fairly redis:7-alpine
docker run -d --name fairly --network fairly -p 8080:8080 \
  -e REDIS_URL=redis://redis:6379 \
  -e FAIRLY_ADMIN_TOKEN=$(openssl rand -hex 16) \
  ghcr.io/prabodh-dev/fairly:latest
```

Every setting is an environment variable; see [docs/configuration.md](docs/configuration.md). Run it behind TLS in production and read [SECURITY.md](SECURITY.md) first.

### Docker Compose

```
git clone https://github.com/Prabodh-dev/fairly.git
cd fairly
docker compose up --build
```

This builds the image and starts the service on port 8080 next to a Redis, with the service waiting for Redis to be healthy first. `docker compose ps` shows the service as healthy once its `HEALTHCHECK` passes. Copy `.env.example` to `.env` to change settings.

### From source

You need Node 22 (20 or later works), pnpm, and a Redis 7. The repository pins its pnpm version in `package.json`, and pnpm switches to that version by itself, so any recent pnpm will do: `corepack enable` on Node up to 24, or `npm install --global pnpm` on newer Node, which no longer bundles Corepack.

```
git clone https://github.com/Prabodh-dev/fairly.git
cd fairly
pnpm install
docker run -d --name fairly-redis -p 6379:6379 redis:7-alpine
pnpm build
pnpm start
```

## Quickstart

The shipped policies limit `/login` to 5 requests per 5 minutes per key. Send six:

```
for i in 1 2 3 4 5 6; do
  curl -s -i -X POST localhost:8080/v1/check \
    -H 'content-type: application/json' \
    -d '{"key":"user-42","route":"/login"}' | grep -iE '^HTTP|^x-ratelimit-remaining|^retry-after|^\{'
done
```

The first five return `200` with a falling `X-RateLimit-Remaining`; the sixth returns `429` with `Retry-After`. Then:

- open <http://localhost:8080/docs> for the interactive API documentation,
- open <http://localhost:8080/metrics> for Prometheus metrics,
- see [Admin API](#admin-api) to change limits while the service runs (set `FAIRLY_ADMIN_TOKEN` first).

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers building and testing locally, branch and commit conventions, what a good pull request looks like, and a map of the code; issues labelled [good first issue](https://github.com/Prabodh-dev/fairly/labels/good%20first%20issue) are a good place to start. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security problems privately as described in [SECURITY.md](SECURITY.md).

## Benchmarks

`scripts/benchmark.mjs` runs all four algorithms under identical load (same requests, concurrency, key sequence and Redis) at 1, 16, 64 and 256 concurrent lanes, in-process against Redis and through the HTTP API, and measures throughput, p50/p95/p99 latency, Redis CPU and bytes of Redis memory per tracked key. Full tables, method, caveats and the analysis are in [`docs/benchmarks.md`](docs/benchmarks.md). On a 4 vCPU machine shared by Redis, the service and the load generator:

| Concurrency 64 | Engine req/s | Engine p99 | HTTP req/s | HTTP p99 | Bytes per key at limit 100 |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixed-window | 87,777 | 1.96 ms | 14,572 | 10.58 ms | 80 |
| sliding-window-log | 67,700 | 2.19 ms | 14,841 | 9.51 ms | 5,192 |
| sliding-window-counter | 82,790 | 1.96 ms | 14,896 | 10.84 ms | 80 |
| token-bucket | 75,716 | 2.22 ms | 15,290 | 9.47 ms | 104 |

Why these numbers matter: all four algorithms enforce the same limit exactly under concurrency, so the choice between them is a choice about cost and behavior, and the numbers say what each costs. The sliding window log is the most precise and the most expensive: about 15 to 25 percent fewer checks per second out of Redis than fixed window, and memory that grows with the limit (5 KB per key at a limit of 100, 1.3 MB at 10,000, against a constant 80 bytes for fixed window). Fixed window and the sliding window counter are the cheapest. Token bucket costs a small constant per key and is the only one that lets a client burst and then refills it at a steady rate (it admitted 55 percent of requests in a test where the others admitted 50). Through HTTP the four are within noise of each other, because the Node process, not Redis, is the limit there; script cost matters once several service instances share one Redis. Treat the absolute figures as one machine's, and the ratios as the finding.

## How it works

```
clients ──> fairly instance(s) ──> Redis
            Fastify + Zod           Lua scripts: one atomic check-and-update per decision
            policy cache            policy hash shared by every instance
```

- **Atomic decisions.** Each check is one Lua script run by Redis: it reads state, decides, and writes in a single step, so concurrent requests cannot interleave between the check and the update. Time comes from Redis, not from the service. Tests fire 500 concurrent HTTP requests at a limit of 100 for every algorithm and assert exactly 100 are allowed. [docs/design.md](docs/design.md) has the details.
- **Policies.** Rules map a route pattern and optional tier to an algorithm, limit and window. They live in Redis, are cached in each instance, and can be changed through the admin API without a restart.
- **Failure behavior.** Every Redis call has a timeout. When Redis cannot answer, a single configured mode decides: fail open (allow) or fail closed (deny), and every occurrence is logged and counted.
- **Shutdown.** On SIGTERM or SIGINT the server stops accepting connections, lets in-flight requests finish within a timeout, closes the Redis connection and exits.

## Documentation

| | |
| --- | --- |
| [docs/benchmarks.md](docs/benchmarks.md) | Method, full results and analysis for all four algorithms |
| [docs/design.md](docs/design.md) | Atomicity, each algorithm's semantics, policies, failure handling |
| [docs/configuration.md](docs/configuration.md) | Every environment variable, with defaults and effects |
| [openapi.yaml](openapi.yaml) | API contract, also served at `/docs` |
| [docs/grafana-dashboard.json](docs/grafana-dashboard.json) | Importable Grafana dashboard for the metrics |
| [SECURITY.md](SECURITY.md) | Threat model, deployment expectations, how to report a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Local setup, conventions, code map |

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
| `limit`, `windowSeconds` | Positive integers. `limit` is at most 1,000,000,000, `windowSeconds` at most 31,536,000 (one year), and `limit` x `windowSeconds` x 1000 at most 2^53 - 1 so that the scripts' arithmetic stays exact. |

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

### API documentation

The full contract is in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.0.3): every endpoint, request and response schemas, the rate limit headers, and the 400, 401, 404, 409, 429 and 503 responses. A running service serves it as an interactive Swagger UI at `/docs`, and as raw `/docs/json` and `/docs/yaml`. Tests validate the document against the OpenAPI schema, check that it documents exactly the routes the service registers, and check real responses (including degraded ones) against its schemas and headers.

### Metrics

`/metrics` exposes, besides Node process metrics prefixed `fairly_`:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `fairly_decisions_total` | `policy`, `algorithm`, `decision` (`allowed` or `rejected`) | Decisions made by Redis |
| `fairly_degraded_decisions_total` | `mode`, `decision` | Decisions made by the failure mode instead |
| `fairly_redis_failures_total` | `operation`, `mode` | Failed or timed out Redis operations |
| `fairly_check_duration_seconds` | `algorithm` | Histogram of the store round trip per check |
| `fairly_http_requests_total` | `method`, `route`, `status` | Requests by route pattern, not by URL |
| `fairly_http_request_duration_seconds` | `method`, `route` | Histogram of request duration |
| `fairly_policies` | none | Policies currently loaded in this instance |

The rate limit key is never used as a label. [`docs/grafana-dashboard.json`](docs/grafana-dashboard.json) is a Grafana dashboard for these series (import it in Grafana and pick the Prometheus data source): decisions by algorithm, policy and outcome, check and HTTP latency percentiles, status codes, Redis failures and degraded decisions, policy count, event loop lag, memory and CPU. The check latency panel is the live counterpart of the latency columns in [`docs/benchmarks.md`](docs/benchmarks.md).

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

Tokens are compared as SHA-256 digests with `crypto.timingSafeEqual`, so neither the content nor the length of a wrong token affects how long the comparison takes. Unauthenticated requests are rejected before any request body is read.

## Configuration

All settings are environment variables, plus one JSON file of seed policies. [docs/configuration.md](docs/configuration.md) lists every variable with its default and what it affects, and [`.env.example`](.env.example) is a template: copy it to `.env` and Docker Compose picks it up. The two you will most likely set are `FAIRLY_FAILURE_MODE` (`fail-open` by default) and `FAIRLY_ADMIN_TOKEN` (admin API disabled until set).

## Running in production

- **Image.** Release images come from `ghcr.io/prabodh-dev/fairly`; `docker build .` produces the same multi-stage image that contains only production dependencies and the compiled output. It runs as the unprivileged `node` user and defines a `HEALTHCHECK` against `/healthz`.
- **Shutdown.** The process handles SIGTERM and SIGINT. In-flight requests get `FAIRLY_SHUTDOWN_TIMEOUT_MS` (10 seconds) to finish; if they do not, or a second signal arrives, connections are closed and the exit code is 1. Give the orchestrator a stop grace period longer than that timeout plus `REDIS_COMMAND_TIMEOUT_MS` (the Compose file uses 20 seconds).
- **Health.** `/healthz` returns 200 only when Redis answers within the timeout. Use it for liveness or readiness according to whether you want instances restarted or only removed from rotation during a Redis outage; in `fail-open` mode an instance keeps serving while `/healthz` is red.
- **Redis.** Use a Redis with persistence appropriate to how much limiter state you can afford to lose; policies are stored there too. One Redis instance is supported.
- **TLS.** fairly does not terminate TLS. Put it behind a proxy or ingress that does, keep the check endpoint on a private network, and restrict `/v1/admin`. [SECURITY.md](SECURITY.md) has the full list.
- **Dependencies.** CI runs `pnpm audit` on every push and pull request and weekly, and fails on any advisory in production dependencies.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

```
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Tests start a real Redis with Testcontainers, so Docker must be running. They cover each algorithm (limits, remaining count, window and refill behavior with an injected clock, boundary bursts, clock moving backwards), configuration validation, policy resolution and precedence, the admin API including authentication and propagation between instances, the header contract for allowed and denied responses, Redis failure handling (container stopped and container paused, in both failure modes), graceful shutdown of the built service with a request in flight, the OpenAPI document against the running service, and concurrency: 500 concurrent HTTP requests against a limit of 100 must allow exactly 100, for every algorithm, against one server and against two servers sharing a Redis. The shutdown tests send real signals, so they are skipped on Windows.

[GitHub Actions](.github/workflows/ci.yml) runs install, lint, typecheck, build and the test suite on every push and pull request; a job that builds the Docker image, starts the Compose stack and calls the service; and a dependency audit, which also runs weekly. Pushing a `v*` tag runs all of them and then publishes the multi-arch image to GHCR with the version tag and `latest`.

## Race demo

```
node scripts/demo-race.mjs [fixed-window|sliding-window-log|sliding-window-counter|token-bucket|all] [--keep] [--no-compose]
```

Starts the compose stack, fires 1000 concurrent requests from 8 worker threads at a route with a limit of 1000, then 1000 more, and prints allowed and rejected counts. Expected: 1000 allowed in the first wave, 0 in the second, 0 over the limit.

## License

[MIT](LICENSE)
