# Contributing to fairly

Thanks for taking an interest. fairly is a small codebase with a clear shape, and contributions of any size are welcome: a typo, a failing case you found, a test, a new algorithm. If you are looking for somewhere to start, the [good first issue](https://github.com/Prabodh-dev/fairly/labels/good%20first%20issue) label marks tasks that are self-contained and described well enough to pick up without asking questions.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). To report a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Set up

You need Node 22 (20 or later works), pnpm, and Docker. The repository pins its pnpm version in `package.json`, and pnpm switches to that version by itself, so any recent pnpm will do: `corepack enable` on Node up to 24, or `npm install --global pnpm` on newer Node, which no longer bundles Corepack.

```
git clone https://github.com/Prabodh-dev/fairly.git
cd fairly
pnpm install
```

### The checks

```
pnpm lint         # ESLint with type-aware rules
pnpm typecheck    # tsc --noEmit, strict mode
pnpm test         # Vitest
pnpm build        # compiles to dist/
```

CI runs exactly these, so run them before you push. `pnpm test` starts real Redis containers with Testcontainers: **Docker must be running**, and the first run pulls `redis:7-alpine`. Nothing is mocked; the algorithms, the HTTP API and the failure handling are all tested against a real Redis. To run part of the suite:

```
pnpm vitest run test/policy
pnpm vitest run test/api/concurrency.test.ts
```

The shutdown tests send real signals to the built service and are skipped on Windows, which does not deliver SIGTERM to Node.

### Run the service

From source, with a throwaway Redis:

```
docker run -d --name fairly-redis -p 6379:6379 redis:7-alpine
pnpm build
FAIRLY_ADMIN_TOKEN=$(openssl rand -hex 16) pnpm start
```

### The full Docker loop

Before changing the Dockerfile, the compose file or anything the image depends on, run the whole thing the way CI does:

```
docker compose up --build --detach --wait
curl -s localhost:8080/healthz
curl -s -X POST localhost:8080/v1/check -H 'content-type: application/json' -d '{"key":"me","route":"/login"}'
docker compose logs fairly
docker compose down --volumes
```

`docker compose up --build` builds the multi-stage image (it needs network access to install pnpm and the dependencies), starts Redis, and waits for the service's `HEALTHCHECK`.

## Making a change

### Branches

Branch from `main` and name the branch for what it does, with a prefix:

- `feature/<short-topic>` for new behavior
- `fix/<short-topic>` for bug fixes
- `docs/<short-topic>` for documentation only

Do not push to `main` directly; changes land through pull requests.

### Commits

- The subject is an imperative sentence of at most about 72 characters that says what the commit does: "Close idle keep-alive connections during shutdown", not "fixed stuff".
- When the reason is not obvious, say why in the body, wrapped at about 72 characters. The diff already shows what changed.
- Keep commits focused. A refactor and a behavior change belong in separate commits.
- No emoji, no ticket-number-only subjects.

### Code style

- TypeScript in strict mode, ES modules, no `any`, explicit types on exported functions. ESLint enforces most of this.
- Comments explain why something non-obvious is done, not what the code does. The one expected comment is in each algorithm file, saying what makes its script atomic.
- Every limiting decision must be atomic: one Lua script that reads, decides and writes. A read in application code followed by a write is a bug, however unlikely the race.
- Limits, windows, timeouts and thresholds come from configuration or the policy, never from constants in handlers.
- No dependencies unless the standard library or what is already installed cannot do the job well.

### Tests

- A bug fix comes with a test that fails without the fix.
- New behavior comes with tests against a real Redis. For anything about concurrency, use real concurrent HTTP requests against a running server (see `test/api/concurrency.test.ts`), not sequential calls.
- Time-dependent algorithm tests inject a clock (`ManualClock` in `test/helpers.ts`) instead of sleeping.
- If you change the API, update `openapi.yaml`. `test/openapi.test.ts` fails when the document and the registered routes disagree and checks real responses against its schemas.
- If you add or change an environment variable, update `docs/configuration.md` and `.env.example`; `test/repo.test.ts` fails if they drift from the loader.

### Pull requests

A good pull request:

- is about one thing, and is small enough to review in one sitting;
- says what it changes and why, in the description (the template asks for this);
- has passing `pnpm lint`, `pnpm typecheck` and `pnpm test`;
- includes the tests and documentation changes above;
- says plainly what was not verified. "I could not run this on Windows" is useful; silence is not.

CI must be green before merge: the test job, the Docker build and smoke test, and the dependency audit. If the audit fails on something you did not touch, say so in the PR instead of working around it.

Not sure whether an idea fits? Open an issue first and describe the problem you want to solve.

## Map of the codebase

```
src/
  main.ts               starts everything: settings, Redis, policies, server, shutdown handlers
  shutdown.ts           graceful SIGTERM / SIGINT handling
  api/
    server.ts           builds the Fastify app, wires routes, hooks and /docs
    routes/
      check.ts          POST /v1/check: resolve policy, run the algorithm, headers, failure mode
      admin.ts          /v1/admin/policies CRUD, X-Admin-Token check
      healthz.ts        GET /healthz
      metrics.ts        GET /metrics
  algorithms/
    types.ts            the shared interface every algorithm implements
    fixed-window.ts     one file per algorithm: the TypeScript wrapper ...
    sliding-window-log.ts
    sliding-window-counter.ts
    token-bucket.ts
    index.ts            registry mapping algorithm names to implementations
    lua/                ... and its atomic Lua script, one .lua file per algorithm
  policy/
    resolve.ts          route pattern matching and precedence
    store.ts            policies in Redis, in-memory cache, refresh
    lua/                seeding and create/update scripts
  store/redis.ts        Redis connection, script loading by SHA, per-call timeouts
  config/
    types.ts            Zod schemas for policies and limits, settings type
    loader.ts           reads the seed file and environment variables, validates both
  metrics/index.ts      Prometheus metric definitions
test/                   Vitest suites against real Redis; helpers.ts, server.ts, openapi.ts
scripts/
  demo-race.mjs         fires concurrent requests at each algorithm and counts allowed/denied
  benchmark.mjs         the benchmark suite behind docs/benchmarks.md
  record-demo.sh        regenerates the terminal demo in docs/
  copy-assets.mjs       copies the Lua files into dist/ during the build
docs/                   design.md, benchmarks.md, configuration.md, Grafana dashboard, demo
openapi.yaml            the API contract, also served at /docs
fairly.config.json      seed policies
```

A request flows: `routes/check.ts` validates the body, `policy/store.ts` resolves the policy from the in-memory cache, the chosen algorithm's `check()` runs one Lua script through `store/redis.ts`, and the route turns the result into the response and the rate limit headers. If Redis cannot answer, the configured failure mode decides instead. [docs/design.md](docs/design.md) explains the reasoning behind each piece.

### Adding an algorithm

1. Add its name to `ALGORITHM_NAMES` in `src/config/types.ts` and to the `Algorithm` enum in `openapi.yaml`.
2. Write `src/algorithms/<name>.ts` and `src/algorithms/lua/<name>.lua`. The script must do the check and the state update in one execution, take time from Redis `TIME` unless a test clock is passed, and return `{ allowed, remaining, resetAtMs, retryAfterMs }`.
3. Register it in `src/algorithms/index.ts`.
4. Add `test/algorithms/<name>.test.ts` (limits, remaining count, window or refill with the injected clock, a clock moving backwards). The concurrency, header, extreme-value and OpenAPI tests pick it up from `ALGORITHM_NAMES`.
5. Describe its trade-offs in the README and `docs/design.md`, and run `scripts/benchmark.mjs` if you want it compared in `docs/benchmarks.md`.

## Regenerating the demo

The terminal recording in the README is made by `scripts/record-demo.sh`, which drives a real `docker compose up`, real requests and the real admin API, so it needs Docker and network access. It writes `docs/demo.cast` (an [asciinema](https://asciinema.org) recording) and renders `docs/demo.svg`, which the README embeds. Re-record it whenever the output it shows changes.
