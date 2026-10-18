import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { post } from './server.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = fileURLToPath(new URL('../fairly.config.json', import.meta.url));

interface Running {
  child: ChildProcess;
  url: string;
  logs: string[];
  exited: Promise<number | null>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

async function waitUntilHealthy(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {
      // the process is still starting
    }
    if (Date.now() > deadline) throw new Error(`service at ${url} did not become healthy`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function refusesConnections(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/healthz`);
    return false;
  } catch {
    return true;
  }
}

describe.skipIf(process.platform === 'win32')('graceful shutdown of the built service', () => {
  let container: Awaited<ReturnType<GenericContainer['start']>>;
  let redisUrl: string;
  let current: Running | undefined;

  beforeAll(async () => {
    execSync('pnpm build', { cwd: ROOT, stdio: 'pipe' });
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  });

  afterEach(async () => {
    try {
      execFileSync('docker', ['unpause', container.getId()], { stdio: 'ignore' });
    } catch {
      // the container was not paused
    }
    if (current !== undefined && current.child.exitCode === null) {
      current.child.kill('SIGKILL');
      await current.exited;
    }
    current = undefined;
  });

  afterAll(async () => {
    await container.stop();
  });

  async function start(env: Record<string, string>): Promise<Running> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        REDIS_URL: redisUrl,
        FAIRLY_CONFIG: CONFIG,
        FAIRLY_FAILURE_MODE: 'fail-open',
        LOG_LEVEL: 'info',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const logs: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      logs.push(...chunk.toString().split('\n').filter((line) => line !== ''));
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => {
        resolve(code);
      });
    });
    current = { child, url, logs, exited };
    await waitUntilHealthy(url);
    return current;
  }

  const pause = (): void => {
    execFileSync('docker', ['pause', container.getId()]);
  };

  it('exits cleanly and quickly on SIGTERM when idle', async () => {
    const running = await start({});
    const started = Date.now();
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(running.logs.some((line) => line.includes('shutdown complete'))).toBe(true);
    expect(await refusesConnections(running.url)).toBe(true);
  });

  it('lets a request that is in flight when SIGTERM arrives finish before the process exits', async () => {
    const running = await start({ REDIS_COMMAND_TIMEOUT_MS: '2500', FAIRLY_SHUTDOWN_TIMEOUT_MS: '15000' });
    pause();

    let exitedAt = 0;
    void running.exited.then(() => {
      exitedAt = Date.now();
    });
    const inFlight = post(running.url, { key: `shutdown-${Date.now()}`, route: '/login' }).then((response) => ({
      response,
      finishedAt: Date.now(),
    }));

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(exitedAt).toBe(0);
    running.child.kill('SIGTERM');

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await refusesConnections(running.url)).toBe(true);
    expect(exitedAt).toBe(0);

    const { response, finishedAt } = await inFlight;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ allowed: true, degraded: true });

    expect(await running.exited).toBe(0);
    expect(exitedAt).toBeGreaterThanOrEqual(finishedAt);
    expect(running.logs.some((line) => line.includes('shutdown complete'))).toBe(true);
  });

  it('closes the connections and exits with a failure code when requests outlast the shutdown timeout', async () => {
    const running = await start({ REDIS_COMMAND_TIMEOUT_MS: '8000', FAIRLY_SHUTDOWN_TIMEOUT_MS: '600' });
    pause();

    const inFlight = post(running.url, { key: `shutdown-${Date.now()}`, route: '/login' }).then(
      () => 'completed',
      () => 'dropped',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const signalled = Date.now();
    running.child.kill('SIGTERM');

    expect(await running.exited).toBe(1);
    expect(Date.now() - signalled).toBeLessThan(5000);
    expect(await inFlight).toBe('dropped');
    expect(running.logs.some((line) => line.includes('did not finish before the shutdown timeout'))).toBe(true);
  });

  it('exits immediately on a second signal', async () => {
    const running = await start({ REDIS_COMMAND_TIMEOUT_MS: '8000', FAIRLY_SHUTDOWN_TIMEOUT_MS: '30000' });
    pause();

    const inFlight = post(running.url, { key: `shutdown-${Date.now()}`, route: '/login' }).then(
      () => 'completed',
      () => 'dropped',
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    running.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(running.child.exitCode).toBeNull();

    const second = Date.now();
    running.child.kill('SIGTERM');
    expect(await running.exited).toBe(1);
    expect(Date.now() - second).toBeLessThan(3000);
    expect(await inFlight).toBe('dropped');
    expect(running.logs.some((line) => line.includes('second shutdown signal'))).toBe(true);
  });
});
