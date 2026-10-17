# fairly

A distributed rate limiter and API quota service. Answers one question correctly under heavy concurrency: has this key exceeded its quota right now. Supports multiple limiting algorithms, multi-tier limits, and fails predictably when its backing store is unreachable.

## Hard rules

- No emojis anywhere: code, logs, docs, commit messages.
- No comments in code unless they explain a non-obvious why. No banner comments, no commented-out code, no TODOs.
- No placeholder, stubbed, or mocked implementations.
- Do not create files that are not needed. Do not add features that were not asked for.
- TypeScript strict mode, ESM, Node 20+, pnpm workspaces.
- Minimal dependencies. Only add a package when the standard library or already-chosen dependencies genuinely cannot do it well.
- Every limiting decision must be atomic under concurrency. A read-then-write that is not wrapped in a single atomic operation (a Lua script, a Postgres transaction with row locking) is a bug, not an implementation detail to fix later.

## Stack

- API: Fastify + Zod, TypeScript
- Store: Redis via ioredis, atomicity via Lua scripts (EVALSHA), not multi-command round trips
- Metrics: prom-client
- Logging: pino, structured
- Tests: Vitest with Testcontainers (real Redis, never mocked)
- Load testing: a small Node script or k6
- Containers: Docker Compose for the service plus Redis

## Layout

- src/api: Fastify routes (check, admin, healthz)
- src/algorithms: one file per algorithm (fixed-window, sliding-window-log, sliding-window-counter, token-bucket), all implementing a shared interface
- src/store: Redis client, Lua script loading and execution
- src/config: per-key/per-route limit configuration, validation
- src/metrics: Prometheus metric definitions
- scripts: demo and load-test scripts
- docs: design.md, benchmarks.md

## Commands

- pnpm install
- pnpm lint
- pnpm typecheck
- pnpm test
- docker compose up

Run lint, typecheck, and the relevant tests after every meaningful change. Fix failures before moving on.

## Correctness invariants

- Under N concurrent requests against a limit of N, exactly N are allowed and the rest are rejected — never N+1, never fewer than N. This must be proven with a real concurrent test, not assumed from the algorithm's logic.
- A rate-limit check and its corresponding counter update happen as one atomic operation against the store. No algorithm reads a counter, computes in application code, then writes back in a separate round trip.
- When the store is unreachable, the service follows a single, explicitly configured policy (fail open or fail closed) — it never silently defaults to one or the other, and this must be logged every time it happens.
- Every response includes accurate rate-limit headers (remaining count, reset time), computed from the same atomic operation that made the decision, never estimated afterward.

## Code conventions

- Explicit error handling, no swallowed errors, no empty catch blocks.
- Lua scripts are stored as separate .lua files, loaded and cached by SHA, not inlined as strings scattered through TypeScript.
- All limit windows and thresholds are configurable, never hardcoded.
- Structured logs carry the rate-limit key, algorithm, and decision (allowed/rejected) where relevant.
- No `any`. Explicit types on exported functions.

## Testing rules

- Every algorithm tested against a real Redis (Testcontainers), never an in-memory fake standing in for Redis.
- Concurrency correctness is tested with real concurrent requests (Promise.all against a real running server), not simulated sequentially.
- Every bug fix gets a regression test.

## Docs

- Plain technical language, no marketing tone.
- Benchmark numbers in docs come from actual measured runs, never estimated.
