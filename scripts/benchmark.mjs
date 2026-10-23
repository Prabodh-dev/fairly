import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Redis } from 'ioredis';

const ALGORITHMS = ['fixed-window', 'sliding-window-log', 'sliding-window-counter', 'token-bucket'];
const MEMORY_PROFILE_LIMITS = [10, 100, 1000, 10000];
const MEMORY_PROFILE_KEYS = 20;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createKeyPicker(keys, distribution, random) {
  if (distribution === 'single') return () => 0;
  if (distribution === 'uniform') return () => Math.floor(random() * keys);
  const cumulative = [];
  let totalWeight = 0;
  for (let i = 0; i < keys; i++) {
    totalWeight += 1 / (i + 1);
    cumulative.push(totalWeight);
  }
  return () => {
    const target = random() * totalWeight;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (target < cumulative[middle]) high = middle;
      else low = middle + 1;
    }
    return low;
  };
}

async function drive({ send, concurrency, total, keys, seed, keyDistribution = 'uniform' }) {
  const random = mulberry32(seed);
  const pickKey = createKeyPicker(keys, keyDistribution, random);
  const latencies = new Float64Array(total);
  const counts = { allowed: 0, denied: 0, errors: 0 };
  let issued = 0;
  async function lane() {
    for (;;) {
      const index = issued++;
      if (index >= total) return;
      const key = `bench-${pickKey()}`;
      const started = performance.now();
      try {
        const allowed = await send(key);
        latencies[index] = performance.now() - started;
        if (allowed) counts.allowed++;
        else counts.denied++;
      } catch {
        latencies[index] = performance.now() - started;
        counts.errors++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, lane));
  return { latencies, ...counts };
}

function httpSender({ url, algorithm, limit, windowSeconds, concurrency }) {
  const pool = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const target = new URL('/v1/check', url);
  const send = (key) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ key, algorithm, limit, windowSeconds });
      const req = http.request(
        target,
        { method: 'POST', agent: pool, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          res.on('end', () => {
            if (res.statusCode === 200) resolve(true);
            else if (res.statusCode === 429) resolve(false);
            else reject(new Error(`status ${res.statusCode}`));
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  return { send, close: () => pool.destroy() };
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(parts, wallMs, total) {
  const latencies = new Float64Array(parts.reduce((n, part) => n + part.latencies.length, 0));
  let offset = 0;
  for (const part of parts) {
    latencies.set(part.latencies, offset);
    offset += part.latencies.length;
  }
  latencies.sort();
  return {
    throughput: total / (wallMs / 1000),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    allowed: parts.reduce((n, part) => n + part.allowed, 0),
    denied: parts.reduce((n, part) => n + part.denied, 0),
    errors: parts.reduce((n, part) => n + part.errors, 0),
  };
}

async function redisCpuSeconds(redis) {
  const info = await redis.info('cpu');
  const read = (name) => Number(new RegExp(`${name}:(\\S+)`).exec(info)?.[1] ?? 0);
  return read('used_cpu_sys') + read('used_cpu_user');
}

async function measureMemory(redis) {
  let cursor = '0';
  let bytes = 0;
  let count = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 1000);
    cursor = next;
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.memory('USAGE', key, 'SAMPLES', 0);
    for (const [err, size] of await pipeline.exec()) {
      if (err) throw err;
      bytes += Number(size);
      count++;
    }
  } while (cursor !== '0');
  return { bytes, redisKeys: count };
}

function runHttpLoad(config, total) {
  const threads = config.httpThreads;
  const perThreadTotal = Math.floor(total / threads);
  const workers = Array.from({ length: threads }, (_, index) => {
    const concurrency = Math.max(1, Math.floor(config.concurrency / threads));
    const share = index === threads - 1 ? total - perThreadTotal * (threads - 1) : perThreadTotal;
    return new Worker(new URL(import.meta.url), {
      workerData: { ...config, concurrency, total: share, seed: config.seed + index },
    });
  });
  return new Promise((resolve, reject) => {
    const parts = [];
    let ready = 0;
    let started = 0;
    for (const worker of workers) {
      worker.on('error', reject);
      worker.on('message', (message) => {
        if (message.type === 'ready' && ++ready === threads) {
          started = performance.now();
          for (const w of workers) w.postMessage('go');
        } else if (message.type === 'done') {
          parts.push(message.result);
          if (parts.length === threads) {
            const wall = performance.now() - started;
            for (const w of workers) void w.terminate();
            resolve({ parts, wall });
          }
        }
      });
    }
  });
}

async function runCell(ctx, algorithm, concurrency, total, limit) {
  const { redis, args } = ctx;
  const windowSeconds = args.window;
  const base = { algorithm, limit, windowSeconds, keys: args.keys, seed: 1234, concurrency, keyDistribution: args.keyDistribution };

  const load = async (count, seed) => {
    if (ctx.target === 'engine') {
      const send = (key) => ctx.algorithms[algorithm].check(`bench:${key}`, limit, windowSeconds).then((r) => r.allowed);
      const started = performance.now();
      const part = await drive({ ...base, send, total: count, seed });
      return { parts: [part], wall: performance.now() - started };
    }
    return runHttpLoad({ ...base, url: args.url, httpThreads: args.httpThreads, seed }, count);
  };

  await redis.flushall();
  await load(Math.min(5000, total), 99);
  await redis.flushall();
  const cpuBefore = await redisCpuSeconds(redis);
  const { parts, wall } = await load(total, base.seed);
  const cpuAfter = await redisCpuSeconds(redis);
  const memory = await measureMemory(redis);
  const redisCpuPct = (100 * (cpuAfter - cpuBefore)) / (wall / 1000);
  return { algorithm, concurrency, total, ...summarize(parts, wall, total), ...memory, redisCpuPct, keys: args.keys };
}

async function runMemoryProfile(ctx) {
  const { redis } = ctx;
  const rows = [];
  for (const limit of MEMORY_PROFILE_LIMITS) {
    const row = { limit };
    for (const algorithm of ALGORITHMS) {
      await redis.flushall();
      const keys = Array.from({ length: MEMORY_PROFILE_KEYS }, (_, i) => `profile-${i}`);
      let next = 0;
      const lane = async () => {
        for (;;) {
          const index = next++;
          if (index >= keys.length * limit) return;
          await ctx.algorithms[algorithm].check(`bench:${keys[index % keys.length]}`, limit, 3600);
        }
      };
      await Promise.all(Array.from({ length: 64 }, lane));
      const memory = await measureMemory(redis);
      row[algorithm] = memory.bytes / keys.length;
    }
    rows.push(row);
  }
  return rows;
}

const fmt = (value, digits = 0) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function loadTable(cells, levels) {
  const lines = [
    '| Concurrency | Algorithm | Throughput (req/s) | Range over runs | p50 (ms) | p95 (ms) | p99 (ms) | Redis CPU | Allowed | Errors |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const c of levels) {
    for (const cell of cells.filter((x) => x.concurrency === c)) {
      lines.push(
        `| ${c} | ${cell.algorithm} | ${fmt(cell.throughput)} | ${fmt(cell.minThroughput)} - ${fmt(cell.maxThroughput)} | ${fmt(cell.p50, 2)} | ${fmt(cell.p95, 2)} | ${fmt(cell.p99, 2)} | ${fmt(cell.redisCpuPct)}% | ${fmt((100 * cell.allowed) / cell.total, 1)}% | ${cell.errors} |`,
      );
    }
  }
  return lines.join('\n');
}

function keyMemoryTable(cells, level) {
  const lines = ['| Algorithm | Redis keys per tracked key | Bytes per tracked key |', '| --- | ---: | ---: |'];
  for (const cell of cells.filter((x) => x.concurrency === level)) {
    lines.push(`| ${cell.algorithm} | ${fmt(cell.redisKeys / cell.keys, 2)} | ${fmt(cell.bytes / cell.keys)} |`);
  }
  return lines.join('\n');
}

function profileTable(rows) {
  const lines = [`| Limit | ${ALGORITHMS.join(' | ')} |`, `| ---: | ${ALGORITHMS.map(() => '---:').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${fmt(row.limit)} | ${ALGORITHMS.map((a) => fmt(row[a])).join(' | ')} |`);
  return lines.join('\n');
}

function replaceBlock(text, name, content) {
  const start = `<!-- bench:${name}:start -->`;
  const end = `<!-- bench:${name}:end -->`;
  const i = text.indexOf(start);
  const j = text.indexOf(end);
  if (i === -1 || j === -1) throw new Error(`markers for "${name}" not found`);
  return `${text.slice(0, i + start.length)}\n${content}\n${text.slice(j)}`;
}

async function waitForHealthy(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(new URL('/healthz', url));
      if (res.ok) return;
    } catch {
      // the service is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`service at ${url} did not become healthy`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: 'engine' },
      'redis-url': { type: 'string', default: 'redis://127.0.0.1:6379' },
      url: { type: 'string', default: 'http://127.0.0.1:8080' },
      spawn: { type: 'boolean', default: false },
      requests: { type: 'string', default: '100000' },
      concurrency: { type: 'string', default: '1,16,64,256' },
      keys: { type: 'string', default: '500' },
      limit: { type: 'string', default: '100' },
      window: { type: 'string', default: '60' },
      repeats: { type: 'string', default: '5' },
      'http-threads': { type: 'string', default: '2' },
      'key-distribution': { type: 'string', default: 'uniform' },
      'memory-profile': { type: 'boolean', default: false },
      'write-md': { type: 'string' },
      json: { type: 'string' },
    },
  });
  const args = {
    url: values.url,
    keys: Number(values.keys),
    limit: Number(values.limit),
    window: Number(values.window),
    httpThreads: Number(values['http-threads']),
    keyDistribution: values['key-distribution'],
  };
  if (!['uniform', 'zipf', 'single'].includes(args.keyDistribution)) {
    throw new Error('--key-distribution must be uniform, zipf, or single');
  }
  const target = values.target;
  if (target !== 'engine' && target !== 'http') throw new Error('--target must be engine or http');
  const levels = values.concurrency.split(',').map(Number);
  const requests = Number(values.requests);
  const repeats = Number(values.repeats);

  const redis = new Redis(values['redis-url']);
  const redisVersion = /redis_version:(\S+)/.exec(await redis.info('server'))?.[1] ?? 'unknown';
  const ctx = { redis, args, target, algorithms: undefined };

  let service;
  if (target === 'engine') {
    const { createAlgorithms } = await import('../dist/algorithms/index.js');
    const { createRedis, RedisStore } = await import('../dist/store/redis.js');
    const store = new RedisStore(createRedis({ url: values['redis-url'], commandTimeoutMs: 5000 }), 5000);
    await store.connect();
    ctx.algorithms = createAlgorithms({ store });
    ctx.close = () => store.close();
  } else if (values.spawn) {
    const port = 18080;
    args.url = `http://127.0.0.1:${port}`;
    service = spawn('node', ['dist/main.js'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        PORT: String(port),
        REDIS_URL: values['redis-url'],
        FAIRLY_FAILURE_MODE: 'fail-closed',
        LOG_LEVEL: 'warn',
        FAIRLY_CONFIG: 'fairly.config.json',
      },
    });
    await waitForHealthy(args.url);
  } else {
    await waitForHealthy(args.url);
  }

  const cells = [];
  try {
    for (const concurrency of levels) {
      const total = concurrency === 1 ? Math.min(requests, 20000) : requests;
      for (const algorithm of ALGORITHMS) {
        const runs = [];
        for (let i = 0; i < repeats; i++) runs.push(await runCell(ctx, algorithm, concurrency, total, args.limit));
        runs.sort((a, b) => a.throughput - b.throughput);
        const median = { ...runs[Math.floor(runs.length / 2)], minThroughput: runs[0].throughput, maxThroughput: runs[runs.length - 1].throughput };
        cells.push(median);
        console.error(`${target} c=${concurrency} ${algorithm}: ${fmt(median.throughput)} req/s p99 ${fmt(median.p99, 2)} ms (runs: ${runs.map((r) => fmt(r.throughput)).join(', ')})`);
      }
    }
    const profile = target === 'engine' && values['memory-profile'] ? await runMemoryProfile(ctx) : undefined;

    const memoryLevel = levels.includes(64) ? 64 : levels[levels.length - 1];
    const env = [
      `- Date: ${new Date().toISOString().slice(0, 10)}`,
      `- Machine: ${os.cpus().length} vCPU (${os.cpus()[0]?.model.trim()}), ${Math.round(os.totalmem() / 2 ** 30)} GiB RAM, ${os.type()} ${os.release()}`,
      `- Node ${process.versions.node}, Redis ${redisVersion} (persistence off), load generator, service and Redis on the same machine`,
      `- Per-cell workload: ${fmt(requests)} requests (${fmt(Math.min(requests, 20000))} at concurrency 1), ${fmt(args.keys)} keys, limit ${args.limit}, window ${args.window}s, median of ${repeats} runs by throughput`,
      `- Key distribution: ${args.keyDistribution}${args.keyDistribution === 'zipf' ? ' (Zipf exponent 1)' : ''}; fixed seed`,
    ].join('\n');
    const result = { env, cells, profile, target, memoryLevel };

    if (values.json) fs.writeFileSync(values.json, JSON.stringify(result, null, 2));
    if (values['write-md']) {
      let text = fs.readFileSync(values['write-md'], 'utf8');
      if (args.keyDistribution === 'uniform') {
        text = replaceBlock(text, `${target}`, loadTable(cells, levels));
        text = replaceBlock(text, `${target}-env`, env);
        if (target === 'engine') {
          text = replaceBlock(text, 'memory-per-key', keyMemoryTable(cells, memoryLevel));
          if (profile) text = replaceBlock(text, 'memory-profile', profileTable(profile));
        }
      } else {
        const name = `hot-${target}-${args.keyDistribution}`;
        text = replaceBlock(text, name, loadTable(cells, levels));
        text = replaceBlock(text, `${name}-env`, env);
      }
      fs.writeFileSync(values['write-md'], text);
    } else {
      console.log(env);
      console.log(loadTable(cells, levels));
      console.log(keyMemoryTable(cells, memoryLevel));
      if (profile) console.log(profileTable(profile));
    }
  } finally {
    if (service) service.kill();
    await ctx.close?.();
    redis.disconnect();
  }
}

if (!isMainThread) {
  const sender = httpSender(workerData);
  parentPort.postMessage({ type: 'ready' });
  parentPort.once('message', async () => {
    const result = await drive({ ...workerData, send: sender.send });
    sender.close();
    parentPort.postMessage({ type: 'done', result }, [result.latencies.buffer]);
  });
} else {
  await main();
}
