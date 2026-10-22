# Benchmarks

Numbers in this file are written by `scripts/benchmark.mjs` from a real run; nothing here is estimated. Re-run it to regenerate them (see "Reproducing").

## Method

Every algorithm gets the same workload against the same Redis instance:

- The same number of requests, the same concurrency, and the same sequence of keys (uniform over a fixed key set, fixed seed).
- Closed loop: each of N lanes sends its next request as soon as the previous one returns, so throughput is what the system sustains at that concurrency, and latency includes queueing at that concurrency.
- Redis is flushed before each run; a warm-up of 5,000 requests precedes each measured run and is discarded.
- Each cell is run several times and the run with the median throughput is reported.
- Limit 100 per key and a 60 second window with 500 keys and 100,000 requests, so each key sees about twice its limit and roughly half the requests are denied.

Two targets are measured:

- **Engine**: `algorithm.check()` called in-process against Redis. This isolates the cost of the Lua script and the Redis round trip, with no HTTP.
- **HTTP**: `POST /v1/check` with an inline limit against the built service (`node dist/main.js`, one process, `LOG_LEVEL=warn`), driven by two load generator threads.

Memory is measured with `MEMORY USAGE key SAMPLES 0` (exact, includes the key name and value overhead, excludes allocator fragmentation) summed over every key in Redis after the run.

### Environment

<!-- bench:engine-env:start -->
- Date: 2026-10-18
- Machine: 4 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GiB RAM, Linux 6.18.44-fc-v139
- Node 22.22.0, Redis 7.4.11 (persistence off), load generator, service and Redis on the same machine
- Per-cell workload: 100,000 requests (20,000 at concurrency 1), 500 keys chosen uniformly with a fixed seed, limit 100, window 60s, median of 5 runs by throughput
<!-- bench:engine-env:end -->

## Engine results

<!-- bench:engine:start -->
| Concurrency | Algorithm | Throughput (req/s) | Range over runs | p50 (ms) | p95 (ms) | p99 (ms) | Redis CPU | Allowed | Errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | fixed-window | 12,812 | 11,767 - 14,450 | 0.07 | 0.11 | 0.19 | 48% | 100.0% | 0 |
| 1 | sliding-window-log | 12,069 | 11,039 - 12,455 | 0.07 | 0.12 | 0.25 | 52% | 100.0% | 0 |
| 1 | sliding-window-counter | 13,199 | 12,631 - 13,853 | 0.07 | 0.11 | 0.17 | 50% | 100.0% | 0 |
| 1 | token-bucket | 12,061 | 10,793 - 13,457 | 0.07 | 0.12 | 0.20 | 51% | 100.0% | 0 |
| 16 | fixed-window | 76,146 | 71,046 - 88,690 | 0.18 | 0.35 | 0.77 | 84% | 50.0% | 0 |
| 16 | sliding-window-log | 57,465 | 55,887 - 64,568 | 0.24 | 0.47 | 0.91 | 91% | 50.0% | 0 |
| 16 | sliding-window-counter | 78,117 | 62,404 - 79,801 | 0.18 | 0.32 | 0.76 | 92% | 50.0% | 0 |
| 16 | token-bucket | 66,048 | 60,062 - 69,525 | 0.22 | 0.33 | 0.82 | 94% | 51.0% | 0 |
| 64 | fixed-window | 87,777 | 75,615 - 90,070 | 0.64 | 1.34 | 1.96 | 80% | 50.0% | 0 |
| 64 | sliding-window-log | 67,700 | 63,975 - 77,708 | 0.86 | 1.63 | 2.19 | 91% | 50.0% | 0 |
| 64 | sliding-window-counter | 82,790 | 75,723 - 89,969 | 0.69 | 1.36 | 1.96 | 89% | 50.0% | 0 |
| 64 | token-bucket | 75,716 | 60,571 - 80,903 | 0.75 | 1.47 | 2.22 | 93% | 51.0% | 0 |
| 256 | fixed-window | 87,923 | 79,674 - 91,758 | 2.77 | 4.45 | 5.45 | 74% | 50.0% | 0 |
| 256 | sliding-window-log | 74,180 | 66,279 - 77,204 | 3.28 | 5.17 | 6.83 | 90% | 50.0% | 0 |
| 256 | sliding-window-counter | 88,681 | 82,698 - 89,299 | 2.62 | 4.30 | 5.70 | 86% | 50.0% | 0 |
| 256 | token-bucket | 74,921 | 66,606 - 86,218 | 3.18 | 5.31 | 6.74 | 88% | 51.0% | 0 |
<!-- bench:engine:end -->

## HTTP results

<!-- bench:http-env:start -->
- Date: 2026-10-18
- Machine: 4 vCPU (Intel(R) Xeon(R) Processor @ 2.10GHz), 16 GiB RAM, Linux 6.18.44-fc-v139
- Node 22.22.0, Redis 7.4.11 (persistence off), load generator, service and Redis on the same machine
- Per-cell workload: 100,000 requests (20,000 at concurrency 1), 500 keys chosen uniformly with a fixed seed, limit 100, window 60s, median of 5 runs by throughput
<!-- bench:http-env:end -->

<!-- bench:http:start -->
| Concurrency | Algorithm | Throughput (req/s) | Range over runs | p50 (ms) | p95 (ms) | p99 (ms) | Redis CPU | Allowed | Errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | fixed-window | 3,921 | 3,610 - 4,259 | 0.39 | 1.05 | 1.61 | 19% | 100.0% | 0 |
| 1 | sliding-window-log | 3,473 | 3,161 - 3,755 | 0.50 | 1.12 | 1.80 | 22% | 100.0% | 0 |
| 1 | sliding-window-counter | 3,968 | 3,535 - 4,029 | 0.39 | 1.06 | 1.64 | 20% | 100.0% | 0 |
| 1 | token-bucket | 3,687 | 3,255 - 4,128 | 0.45 | 1.11 | 1.76 | 21% | 100.0% | 0 |
| 16 | fixed-window | 12,446 | 11,508 - 13,397 | 1.10 | 2.51 | 4.13 | 32% | 50.0% | 0 |
| 16 | sliding-window-log | 12,615 | 11,735 - 13,492 | 1.07 | 2.48 | 3.88 | 38% | 50.0% | 0 |
| 16 | sliding-window-counter | 12,497 | 11,508 - 13,165 | 1.10 | 2.40 | 4.06 | 34% | 50.0% | 0 |
| 16 | token-bucket | 13,322 | 12,135 - 13,416 | 1.02 | 2.37 | 3.85 | 38% | 56.0% | 0 |
| 64 | fixed-window | 14,572 | 13,725 - 15,275 | 4.08 | 7.32 | 10.58 | 33% | 50.0% | 0 |
| 64 | sliding-window-log | 14,841 | 11,962 - 16,377 | 3.93 | 7.30 | 9.51 | 38% | 50.0% | 0 |
| 64 | sliding-window-counter | 14,896 | 14,212 - 15,659 | 3.87 | 7.77 | 10.84 | 36% | 50.0% | 0 |
| 64 | token-bucket | 15,290 | 14,944 - 15,708 | 3.86 | 7.01 | 9.47 | 38% | 55.0% | 0 |
| 256 | fixed-window | 14,187 | 13,820 - 14,986 | 17.01 | 28.35 | 36.50 | 33% | 50.0% | 0 |
| 256 | sliding-window-log | 14,641 | 13,944 - 15,436 | 16.54 | 27.73 | 33.41 | 38% | 50.0% | 0 |
| 256 | sliding-window-counter | 14,357 | 13,834 - 15,614 | 16.65 | 27.51 | 34.88 | 35% | 50.0% | 0 |
| 256 | token-bucket | 16,024 | 14,732 - 17,010 | 15.29 | 24.30 | 32.00 | 38% | 55.0% | 0 |
<!-- bench:http:end -->

## Hot keys

Run the four combinations below to record measured results for both targets. Each command updates only its matching table and environment block; the existing uniform benchmark tables remain unchanged. These results are separate because hot-key runs are not comparable to the default uniform workload.

### Zipf distribution (exponent 1)

<!-- bench:hot-engine-zipf-env:start -->
Not yet recorded. Run the engine command below on the benchmark machine.
<!-- bench:hot-engine-zipf-env:end -->

<!-- bench:hot-engine-zipf:start -->
| Concurrency | Algorithm | Throughput (req/s) | Range over runs | p50 (ms) | p95 (ms) | p99 (ms) | Redis CPU | Allowed | Errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
<!-- bench:hot-engine-zipf:end -->

<!-- bench:hot-http-zipf-env:start -->
Not yet recorded. Run the HTTP command below on the benchmark machine.
<!-- bench:hot-http-zipf-env:end -->

<!-- bench:hot-http-zipf:start -->
| Concurrency | Algorithm | Throughput (req/s) | Range over runs | p50 (ms) | p95 (ms) | p99 (ms) | Redis CPU | Allowed | Errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
<!-- bench:hot-http-zipf:end -->

### Single-key distribution

<!-- bench:hot-engine-single-env:start -->
Not yet recorded. Run the engine command below on the benchmark machine.
<!-- bench:hot-engine-single-env:end -->

<!-- bench:hot-engine-single:start -->
| Concurrency | Algorithm | Throughput (req/s) | Range over runs | p50 (ms) | p95 (ms) | p99 (ms) | Redis CPU | Allowed | Errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
<!-- bench:hot-engine-single:end -->

<!-- bench:hot-http-single-env:start -->
Not yet recorded. Run the HTTP command below on the benchmark machine.
<!-- bench:hot-http-single-env:end -->

<!-- bench:hot-http-single:start -->
| Concurrency | Algorithm | Throughput (req/s) | Range over runs | p50 (ms) | p95 (ms) | p99 (ms) | Redis CPU | Allowed | Errors |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
<!-- bench:hot-http-single:end -->

A Zipf distribution assigns higher probability to lower-numbered keys, with weights proportional to `1 / rank`. In `single` mode every request uses the same key. These workloads increase contention on a small part of the key space, and the allowed percentage can be much lower than in uniform mode because requests compete for the same per-key limit. Compare measured numbers rather than assuming one algorithm wins: the sliding window log maintains request entries, token bucket updates its state on every request, and fixed window only increments its counter.

### Reproducing hot-key runs

Use the same machine, Redis setup, request count, concurrency, and repeat count for all four runs. The commands below record 100,000 requests at concurrency 64 for each algorithm and update only the relevant hot-key table.

```sh
node scripts/benchmark.mjs --target engine --key-distribution zipf --concurrency 64 --write-md docs/benchmarks.md
node scripts/benchmark.mjs --target http --spawn --key-distribution zipf --concurrency 64 --write-md docs/benchmarks.md
node scripts/benchmark.mjs --target engine --key-distribution single --concurrency 64 --write-md docs/benchmarks.md
node scripts/benchmark.mjs --target http --spawn --key-distribution single --concurrency 64 --write-md docs/benchmarks.md
```

The tables above must be regenerated on a real benchmark machine before drawing performance conclusions. The default `uniform` mode continues to write the original benchmark blocks.

## Memory

Memory after the 64-concurrency engine run above (500 keys, each key sent about 200 requests against a limit of 100):

<!-- bench:memory-per-key:start -->
| Algorithm | Redis keys per tracked key | Bytes per tracked key |
| --- | ---: | ---: |
| fixed-window | 1.00 | 80 |
| sliding-window-log | 1.00 | 5,192 |
| sliding-window-counter | 1.00 | 86 |
| token-bucket | 1.00 | 112 |
<!-- bench:memory-per-key:end -->

Bytes per tracked key as the limit grows (20 keys, each filled to its limit, window 3600 s so nothing expires during the run):

<!-- bench:memory-profile:start -->
| Limit | fixed-window | sliding-window-log | sliding-window-counter | token-bucket |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 80 | 584 | 80 | 104 |
| 100 | 80 | 5,192 | 80 | 104 |
| 1,000 | 80 | 118,840 | 80 | 112 |
| 10,000 | 80 | 1,295,334 | 80 | 112 |
<!-- bench:memory-profile:end -->

## What the numbers show

All differences below are from the tables above. Run-to-run spread on this shared 4 vCPU machine is roughly 10 to 15 percent, so gaps smaller than that between two algorithms are not meaningful; the "Range over runs" column shows the spread behind each median.

**Redis is the bottleneck for the engine, and the sliding window log is the most expensive script.** From 16 lanes up, Redis ran at 74 to 94 percent of one core, so engine throughput is the speed of the Redis main thread executing the scripts. Fixed window and sliding window counter were the fastest (about 76,000 to 89,000 req/s), token bucket was in the middle (66,000 to 76,000), and the sliding window log was the slowest at every concurrency from 16 up (57,000 to 74,000), roughly 15 to 25 percent behind fixed window by median. The scripts do different amounts of work per request: fixed window is a GET and an INCR (plus a PEXPIRE for the first request in a window); the counter is two GETs and an INCR; token bucket is an HMGET, an HSET and a PEXPIRE on every request, denied or not; the log is a ZREMRANGEBYSCORE, ZCARD, ZADD, PEXPIRE and ZRANGE on an allowed request, and sorted set operations are O(log n). The ordering matches that command count, but I did not profile the scripts, so treat the explanation as likely rather than measured. The fixed window, counter and token bucket medians overlap within the run-to-run spread at 64 and 256 lanes.

**Latency at low concurrency is one Redis round trip; at high concurrency it is queueing.** With one lane every algorithm had a p50 of 0.07 ms and a p99 of 0.17 to 0.25 ms. At 256 lanes p50 rose to 2.6 to 3.3 ms and p99 to 5.5 to 6.8 ms: the same work, waiting its turn. That follows from throughput being capped by Redis, not from any algorithm getting slower per request.

**Through HTTP the algorithm barely matters.** Throughput plateaus at about 14,000 to 16,000 req/s from 64 lanes up for all four algorithms, and Redis sat at only 33 to 38 percent of a core. The limit there is the single Node process (HTTP parsing, JSON, Fastify) sharing four vCPUs with Redis and the load generator, so the per-algorithm script cost seen in the engine table is hidden. The algorithm's script cost starts to matter when many service instances share one Redis, which is when the Redis main thread becomes the limit, as in the engine run. At 256 lanes the HTTP p99 of 32 to 37 ms is queueing in the one service process.

**Allowed percentage shows the burst and refill behavior.** With 500 keys and 100,000 requests each key receives about 200 requests against a limit of 100. Fixed window, sliding window log and sliding window counter admitted exactly 50.0 percent in every run: the whole run fits inside one window and each holds the line at the limit. Token bucket admitted more: 51 percent in the engine runs (which last about a second) and 55 to 56 percent in the HTTP runs (about 7 seconds). That is the bucket refilling at 100/60 tokens per second per key while the run is going, on top of the initial burst of 100. At one lane, 20,000 requests over 500 keys is 40 per key, under the limit, so everything is allowed. This run does not show fixed window's boundary weakness, because no window boundary fell inside a run; that behavior is demonstrated in the test suite (`permits up to twice the limit across a window boundary`) and described in `design.md`.

**Memory is where the sliding window log pays for its precision.** Per tracked key, fixed window used 80 bytes, the counter 80 to 86 bytes, and token bucket 104 to 112 bytes, all independent of the limit. The log stored one sorted set entry per admitted request: 584 bytes at a limit of 10, 5,192 at 100, 118,840 at 1,000 and 1,295,334 at 10,000. At a limit of 100 that is about 65 times a fixed window counter; at 10,000 it is about 16,000 times. The per-entry cost is not constant: about 52 bytes per entry up to a limit of 100, and about 119 to 130 bytes per entry at 1,000 and 10,000, which fits Redis switching sorted sets from its compact encoding to a skiplist and hash table once they exceed the default threshold of 128 entries. Each entry's member is a 36 character UUID in this implementation, so a shorter member id would lower the log's numbers; the growth with the limit would remain. The counter measured here shows one Redis key per tracked key because each run ended inside a single window; in steady state it keeps a current and a previous bucket, so up to twice the 80 bytes. I did not measure that two-bucket steady state.

### Choosing from these results

- Need the strictest guarantee at a small limit (login attempts, a handful of expensive calls): the sliding window log is exact and, at limits in the tens, costs a few hundred bytes per key. Its Redis CPU cost per check is the highest of the four.
- Large limits or many keys: fixed window or the sliding window counter. Both are the cheapest in memory and CPU. The counter removes fixed window's boundary burst at the price of being an approximation; this benchmark measures cost, not the counter's approximation error, which is not quantified here.
- Clients that need to burst and then be held to a rate: token bucket. It is the only one of the four that admitted more than the limit within one window by design, and it costs a small constant amount of memory per key.

## Limits of this benchmark

- One 4 vCPU virtual machine runs Redis (in a container with host networking), the service and the load generator, so they compete for CPU. Numbers will differ on separate hosts, and absolute values are not a statement about production capacity.
- Closed loop load at fixed concurrency, not a fixed arrival rate. Latency under open-loop overload would look different.
- The default distribution is uniform. The optional `zipf` and `single` modes below cover skewed traffic; they do not model every production access pattern.
- One limit (100) and window (60 s) for the throughput tables; the memory table varies the limit.
- Persistence is off in Redis. Enabling it changes throughput.

## Reproducing

Build, start a Redis with persistence off, and run each target. Each command rewrites the matching tables in this file.

```
pnpm build
docker run -d --name bench-redis --network host redis:7-alpine redis-server --save "" --appendonly no

node scripts/benchmark.mjs --target engine --memory-profile --write-md docs/benchmarks.md
node scripts/benchmark.mjs --target http --spawn --write-md docs/benchmarks.md
```

`--target http --spawn` starts `dist/main.js` itself on port 18080 with `LOG_LEVEL=warn` and fail-closed mode, so a Redis error shows up as an error count rather than as silently allowed requests. Use `--url` instead of `--spawn` to benchmark a service that is already running. Other options: `--requests`, `--concurrency 1,16,64,256`, `--keys`, `--key-distribution uniform|zipf|single`, `--limit`, `--window`, `--repeats`, `--http-threads`, `--redis-url`, `--json <file>` to save raw results.
