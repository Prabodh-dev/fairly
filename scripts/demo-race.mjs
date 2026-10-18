import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const ALGORITHMS = ['fixed-window', 'sliding-window-log', 'sliding-window-counter', 'token-bucket'];
const LIMIT = 1000;
const WORKERS = 8;
const BASE_URL = process.env.FAIRLY_URL ?? 'http://127.0.0.1:8080';

function sendChecks({ route, key, count }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  const body = JSON.stringify({ route, key });
  const one = () =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `${BASE_URL}/v1/check`,
        { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  return Promise.all(Array.from({ length: count }, one)).finally(() => agent.destroy());
}

if (!isMainThread) {
  parentPort.postMessage({ type: 'ready' });
  parentPort.once('message', async () => {
    const statuses = await sendChecks(workerData);
    parentPort.postMessage({ type: 'done', statuses });
  });
} else {
  await main();
}

function runWave(route, key, total) {
  const base = Math.floor(total / WORKERS);
  const counts = Array.from({ length: WORKERS }, (_, i) => base + (i < total % WORKERS ? 1 : 0));
  const workers = counts.map((count) => new Worker(new URL(import.meta.url), { workerData: { route, key, count } }));
  return new Promise((resolve, reject) => {
    const statuses = [];
    let ready = 0;
    let done = 0;
    for (const worker of workers) {
      worker.on('error', reject);
      worker.on('message', (message) => {
        if (message.type === 'ready' && ++ready === WORKERS) {
          for (const w of workers) w.postMessage('go');
        } else if (message.type === 'done') {
          statuses.push(...message.statuses);
          if (++done === WORKERS) {
            for (const w of workers) void w.terminate();
            resolve(statuses);
          }
        }
      });
    }
  });
}

function summarize(statuses) {
  const allowed = statuses.filter((s) => s === 200).length;
  const rejected = statuses.filter((s) => s === 429).length;
  return { allowed, rejected, other: statuses.length - allowed - rejected };
}

async function runAlgorithm(algorithm) {
  const route = `demo-${algorithm}`;
  const key = `race-${randomUUID()}`;
  const wave1 = summarize(await runWave(route, key, LIMIT));
  const wave2 = summarize(await runWave(route, key, LIMIT));
  const overage = Math.max(0, wave1.allowed + wave2.allowed - LIMIT);
  const pass = wave1.allowed === LIMIT && wave1.rejected === 0 && wave1.other === 0 && wave2.allowed === 0 && wave2.other === 0 && overage === 0;
  console.log(`${algorithm} (limit ${LIMIT}, ${WORKERS} parallel clients)`);
  console.log(`  wave 1: ${LIMIT} concurrent requests -> allowed ${wave1.allowed}, rejected ${wave1.rejected}, errors ${wave1.other}`);
  console.log(`  wave 2: ${LIMIT} more concurrent requests -> allowed ${wave2.allowed}, rejected ${wave2.rejected}, errors ${wave2.other}`);
  console.log(`  total allowed ${wave1.allowed + wave2.allowed}, over limit ${overage}: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

function compose(args) {
  const result = spawnSync('docker', ['compose', ...args], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} exited with status ${result.status}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const keepUp = args.includes('--keep');
  const noCompose = args.includes('--no-compose');
  const selected = args.find((arg) => !arg.startsWith('--')) ?? 'all';
  const algorithms = selected === 'all' ? ALGORITHMS : [selected];
  for (const algorithm of algorithms) {
    if (!ALGORITHMS.includes(algorithm)) {
      console.error(`unknown algorithm "${algorithm}", expected one of: all, ${ALGORITHMS.join(', ')}`);
      process.exit(2);
    }
  }

  if (!noCompose) compose(['up', '--build', '--wait', '--detach']);
  let allPassed = true;
  try {
    for (const algorithm of algorithms) {
      allPassed = (await runAlgorithm(algorithm)) && allPassed;
    }
  } finally {
    if (!noCompose && !keepUp) compose(['down']);
  }
  process.exit(allPassed ? 0 : 1);
}
