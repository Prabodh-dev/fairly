# Configuration

fairly is configured with environment variables and one JSON file of seed policies. Every variable is read once at startup; invalid values stop the process with a message naming the variable.

The process reads its own environment only. It does not load a `.env` file by itself. Docker Compose reads `.env` for you (copy `.env.example` to `.env`), and outside Compose you can use Node's own loader: `node --env-file=.env dist/main.js` (Node 20.6 or later).

## Environment variables

Integers must be written as plain decimal digits: hexadecimal (`0x1F90`), exponent (`1e3`), signed, padded or non-ASCII forms are rejected. 2147483647 (2^31 - 1) is the largest delay a Node timer accepts; a larger value would make the timer fire after 1 ms, so it is refused instead of being allowed to turn every Redis call into an instant timeout.

| Variable | Default | What it affects |
| --- | --- | --- |
| `PORT` | `8080` | TCP port the HTTP server listens on. Integer from 1 to 65535. Under Compose this is the container port; change the left side of `8080:8080` in `docker-compose.yml` to publish a different host port. |
| `HOST` | `0.0.0.0` | Address the server binds to. Use `127.0.0.1` to accept local connections only. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | The Redis that holds all limiter state and the shared policies. Must be a `redis://` or `rediss://` URL (anything else is rejected at startup rather than treated as a host name); credentials and a database number, for example `redis://:password@host:6379/0`. A single Redis instance; clustering is not supported. |
| `REDIS_COMMAND_TIMEOUT_MS` | `1000` | Upper bound on every Redis call and on the initial connection. A check that cannot get an answer in this time is decided by the failure mode. It is also the longest a request is held when Redis hangs instead of refusing connections, so it is the latency you add during such an outage. Integer from 1 to 2147483647. |
| `FAIRLY_FAILURE_MODE` | `fail-open` | What a check does when Redis cannot answer. `fail-open` allows the request (200, `degraded: true`); `fail-closed` denies it (503 with `Retry-After`). Both log every occurrence and increment `fairly_redis_failures_total`. See "Failure modes" in the README. |
| `FAIRLY_FAIL_CLOSED_RETRY_AFTER_SECONDS` | `1` | The `Retry-After` value sent with a fail-closed 503. No effect in `fail-open`. Integer from 1 to 86400. |
| `FAIRLY_CONFIG` | `fairly.config.json` | Path of the seed policy file, relative to the working directory. It is read and validated on every start, but its policies are written to Redis only the first time that Redis is used; after that Redis is the source of truth. Under Compose the file is baked into the image at `/app/fairly.config.json`. |
| `POLICY_REFRESH_MS` | `2000` | How often each instance re-reads the policies from Redis. It is the upper bound on how long a policy change made on another instance takes to apply, and costs one `HGETALL` per instance per interval. Integer from 1 to 2147483647. |
| `FAIRLY_ADMIN_TOKEN` | unset | Enables the admin API when set to a string of at least 16 characters; clients send it in the `X-Admin-Token` header. Unset or empty leaves the admin routes unregistered (they return 404). Anyone holding the token can change every limit, so treat it as a secret and generate it randomly, for example `openssl rand -hex 32`. |
| `FAIRLY_SHUTDOWN_TIMEOUT_MS` | `10000` | On SIGTERM or SIGINT the server stops accepting connections and waits this long for in-flight requests to finish; after that it closes their connections and exits with code 1. Integer from 1 to 2147483647. Set the orchestrator's stop grace period above this value plus `REDIS_COMMAND_TIMEOUT_MS` (Compose uses 20s). |
| `LOG_LEVEL` | `info` | Log level of the JSON logs: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`; anything else is rejected at startup. Every rate limit decision is an `info` line, so use `warn` for high traffic (the benchmarks ran at `warn`). |

### Retired variable

`FAIRLY_FAILURE_POLICY` (`open` or `closed`, used before `FAIRLY_FAILURE_MODE`) is rejected at startup with an error pointing at its replacement, so a deployment that still sets it cannot silently change behavior.

### Scripts

| Variable | Default | Used by |
| --- | --- | --- |
| `FAIRLY_URL` | `http://127.0.0.1:8080` | `scripts/demo-race.mjs`, the base URL it sends requests to. |

`scripts/benchmark.mjs` takes command line options rather than environment variables; see `docs/benchmarks.md`.

## Seed policy file

`fairly.config.json` is a JSON object with a `policies` array. Each policy has `name`, `route` (default `*`), optional `tier`, `algorithm`, `limit` and `windowSeconds`. The format, precedence rules and how the file relates to the policies stored in Redis are described under "Policies" in the README. Validation errors name the field, for example `policies.0.limit: limit must be positive`. `limit` is at most 1,000,000,000, `windowSeconds` at most 31,536,000 (one year), and `limit` times `windowSeconds` times 1000 must not exceed 9,007,199,254,740,991 (2^53 - 1): the Redis scripts do their arithmetic in doubles, and beyond that bound counts and reset times would no longer be exact. The same bounds apply to policies created through the admin API and to inline limits in check requests.

## What lives in Redis

| Key | Content |
| --- | --- |
| `fairly:policies` | Hash of policy name to its JSON definition. |
| `fairly:policies:seeded` | Flag set when the seed file has been written. Delete it, together with `fairly:policies`, to seed again. |
| `fairly:{<policy>:<key>}:<suffix>` | Limiter state per policy and key. Each key carries a TTL so idle state expires on its own. |
