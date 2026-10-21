# Security policy

fairly is a network service that other services call to decide whether a request may proceed. This document says what it protects, what it expects from the deployment around it, and how to report a problem.

## Supported versions

Security fixes go into the latest release and `main`. Older releases are not patched; upgrade to the latest image.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

1. Preferred: use GitHub's private vulnerability reporting. On the repository page open **Security**, then **Report a vulnerability**.
2. If that is not available to you, email **prabodhrajmow@gmail.com** with "fairly security" in the subject.

Include what you found, the version or commit, how to reproduce it, and what you think the impact is. Reports are handled on a best-effort basis by a single maintainer: expect an acknowledgement within about a week, a fix or a clear assessment after that, and credit in the release notes if you want it. Please allow time for a fix before disclosing publicly.

## Threat model

fairly is meant to run on a private network, called by your own services (an API gateway, a backend) and backed by a Redis you control. It is not designed to be exposed directly to the internet or to untrusted callers. The sections below follow from that.

### The check endpoint trusts its callers

`POST /v1/check`, `/healthz`, `/metrics` and `/docs` need no credentials. Anyone who can reach `/v1/check` can consume quota for any key, read how much quota any key has left, and send an inline limit of their own choosing instead of a named policy. The decision is advice to the caller, which enforces it, so this is acceptable between trusted services and not acceptable on a public network. Keep fairly on a private network or behind your own gateway, and do not forward `/metrics` or `/docs` to the public internet. Metric labels never contain keys; they contain policy names, algorithm names and route patterns.

### The admin API is a secret-protected control plane

The admin routes (`/v1/admin/policies`) can change every limit, so whoever holds the token controls the service's behavior.

- Treat `FAIRLY_ADMIN_TOKEN` as a secret: generate it randomly (for example `openssl rand -hex 32`), keep it in your secret store rather than in an image, repository or compose file, and rotate it by changing the variable and restarting. The service refuses a token shorter than 16 characters. With no token set, the admin routes are not registered at all.
- The token travels in an `X-Admin-Token` header on every admin request. **fairly does not terminate TLS.** In production run it behind a reverse proxy, ingress or load balancer that terminates TLS, and send admin traffic only over HTTPS. Better still, expose the admin path only to an operator network at the proxy.
- There is no throttling of failed admin attempts, so a long random token is the defense against guessing; rate limit the admin path at your proxy if it is reachable by anyone untrusted.
- Token comparison is constant time. Both the presented token and the configured one are hashed with SHA-256 and the fixed-size digests are compared with `crypto.timingSafeEqual`, so neither the content nor the length of a wrong token changes how long the check takes. This is not a plain `===` string comparison. It was reviewed again for this document and is covered by tests (`test/api/admin-auth.test.ts`) for wrong, partial, longer, empty, repeated and oversized tokens. The tests check behavior; they do not measure timing statistically.
- Requests without a valid token are rejected before any request body is read. Rejections are logged with the method and path, never with the token. Successful policy changes are logged with the policy name and action.

### Redis is a trust boundary

All limiter state and all policies live in Redis. Anyone who can talk to that Redis can reset or exhaust any key's quota, and can rewrite the `fairly:policies` hash, which changes limits just as the admin API does. An unauthenticated Redis reachable from an untrusted network is therefore equivalent to a fully compromised fairly. Protect it accordingly:

- Put Redis on a private network and require authentication; pass the credentials in `REDIS_URL`.
- Use `rediss://` (TLS) when traffic crosses a network you do not control.
- Do not share the instance with tenants you do not trust.
- If a value is damaged or has the wrong type, the script that touches it fails, the check is treated as a store failure, and the failure mode decides the outcome. fairly does not try to repair state.

### Failure mode is a security setting

When Redis cannot answer, `fail-open` (the default) lets requests through and `fail-closed` denies them. With `fail-open`, anything that can disrupt or slow Redis also switches off rate limiting. For limits that exist to protect against abuse, such as login attempts, run with `fail-closed` and accept the loss of availability during an outage. The mode applies to the whole service, not to individual policies.

### Rate limit keys appear in logs

Each decision is logged at `info` level with its key, and a failed check is logged at `error` level with its key. Keys are stored in Redis too. If your keys are secrets (raw API keys) or personal data (email addresses), hash or otherwise pseudonymize them before calling fairly. Setting `LOG_LEVEL=warn` removes the per-decision lines but not the failure lines.

### Input handling

Review of the request path, the Lua scripts and the configuration code found and fixed three ways bad input could hang or break the service; the rest of what was reviewed held up. Current behavior:

- Request bodies are JSON validated with Zod. Fastify's default body limit (1 MiB) applies. Keys and routes are at most 256 characters.
- `limit` is at most 1,000,000,000, `windowSeconds` at most one year, and their product in milliseconds is kept within 2^53 - 1, so the Lua scripts, whose numbers are doubles, only do exact integer arithmetic. Before this bound, values near the top of the integer range made the sliding window counter script fail with a Redis error and made the token bucket stop decrementing.
- Route patterns are matched by an iterative wildcard matcher that is linear in the product of pattern and route length. Earlier they were compiled to regular expressions, and a pattern with many `*` could take minutes against a 256 character route.
- The Lua scripts have no unbounded loops and are never built from request data; keys and arguments are passed to Redis as `KEYS` and `ARGV`. The only loop, in the seeding script, runs over the seed file.
- Environment variables are validated at startup: plain decimal integers within a range (timers cannot exceed 2^31 - 1, which Node would otherwise silently turn into a 1 ms timer), a `redis://` or `rediss://` URL, a known log level, a known failure mode, and a token of at least 16 characters.
- Stored policies that fail validation are logged and skipped rather than loaded.

### Container and supply chain

- The image runs as the unprivileged `node` user, contains production dependencies and compiled output only, and holds no secrets. Configuration comes from environment variables at run time.
- CI runs `pnpm audit` on every push and pull request and weekly: any advisory in production dependencies fails the build, and high or critical advisories in development dependencies do too. Dependabot proposes updates for npm packages, the Docker base image and GitHub Actions.
- Release images are built by GitHub Actions from a version tag and published to GitHub Container Registry for `linux/amd64` and `linux/arm64`.

## Known limitations

- No TLS termination in the service.
- No authentication on the check, health, metrics and documentation endpoints.
- No throttling of failed admin authentication.
- One failure mode for the whole service.
- Raw keys are logged.
- A single Redis instance; Redis Cluster is not supported.
