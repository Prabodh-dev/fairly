import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadSettings } from '../src/config/loader.js';

const root = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(root(path), 'utf8');

interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, { steps: { name?: string; uses?: string; run?: string; 'continue-on-error'?: boolean }[] }>;
}

function envVariablesRead(): string[] {
  const names = new Set<string>();
  for (const match of read('src/config/loader.ts').matchAll(/env\['([A-Z_]+)'\]/g)) names.add(match[1] ?? '');
  return [...names];
}

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match !== null) values[match[1] ?? ''] = match[2] ?? '';
  }
  return values;
}

describe('CI workflow', () => {
  const workflow = parse(read('.github/workflows/ci.yml')) as Workflow;
  const commands = (job: string): string[] => (workflow.jobs[job]?.steps ?? []).map((step) => step.run ?? '');

  it('runs on every push and pull request', () => {
    expect(Object.keys(workflow.on)).toEqual(expect.arrayContaining(['push', 'pull_request']));
  });

  it('installs from the lockfile, then lints, typechecks, builds and tests', () => {
    const steps = commands('test');
    const order = ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm typecheck', 'pnpm build', 'pnpm test'];
    const positions = order.map((command) => steps.findIndex((step) => step.trim() === command));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('builds the Docker image and smoke tests the compose stack', () => {
    const steps = commands('docker').join('\n');
    expect(steps).toContain('docker build');
    expect(steps).toContain('docker compose up');
    expect(steps).toContain('/healthz');
  });

  it('does not let any step fail silently', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) expect(step['continue-on-error']).not.toBe(true);
    }
  });
});

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');
  const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));

  it('runs the final image as an unprivileged user', () => {
    const users = [...runtime.matchAll(/^USER\s+(\S+)/gm)].map((match) => match[1]);
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).toBe('node');
  });

  it('defines a health check against /healthz', () => {
    expect(runtime).toMatch(/^HEALTHCHECK\b/m);
    expect(runtime).toContain('/healthz');
  });

  it('installs production dependencies only and copies nothing but built output into the final image', () => {
    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile --prod/);
    expect(runtime).not.toMatch(/pnpm install/);
    expect(runtime).not.toMatch(/COPY\s+(--\S+\s+)*(src|test|docs|scripts)\b/);
    expect(runtime).toMatch(/COPY --from=prod-deps/);
    expect(runtime).toMatch(/COPY --from=build/);
  });
});

describe('environment documentation', () => {
  const variables = envVariablesRead().filter((name) => name !== 'FAIRLY_FAILURE_POLICY');
  const documented = read('docs/configuration.md');
  const example = parseEnvFile(read('.env.example'));

  it('finds the variables the loader reads', () => {
    expect(variables.length).toBeGreaterThanOrEqual(11);
    expect(variables).toEqual(expect.arrayContaining(['FAIRLY_ADMIN_TOKEN', 'FAIRLY_FAILURE_MODE', 'REDIS_COMMAND_TIMEOUT_MS', 'POLICY_REFRESH_MS']));
  });

  it('documents every variable in docs/configuration.md', () => {
    for (const name of variables) expect(documented, name).toContain(`\`${name}\``);
  });

  it('lists every variable in .env.example', () => {
    for (const name of variables) expect(example, name).toHaveProperty(name);
  });

  it('keeps .env.example equal to the built-in defaults', () => {
    expect(loadSettings(example)).toEqual(loadSettings({}));
  });

  it('keeps real .env files out of git', () => {
    expect(read('.gitignore').split('\n')).toContain('.env');
  });
});

describe('repository metadata', () => {
  it('ships an MIT license that package.json agrees with', () => {
    expect(read('LICENSE')).toMatch(/^MIT License/);
    expect((JSON.parse(read('package.json')) as { license: string }).license).toBe('MIT');
  });

  it('pins the package manager', () => {
    expect((JSON.parse(read('package.json')) as { packageManager: string }).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('only links to files that exist from the README', () => {
    const readme = read('README.md');
    const links = [...readme.matchAll(/\]\((?!https?:|#)([^)#\s]+)/g)].map((match) => match[1] ?? '');
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) expect(existsSync(root(link)), link).toBe(true);
  });

  it('points the CI badge at the workflow file that exists', () => {
    const badge = /actions\/workflows\/([^/]+)\/badge\.svg/.exec(read('README.md'));
    expect(badge?.[1]).toBeDefined();
    expect(existsSync(root(`.github/workflows/${badge?.[1] ?? ''}`))).toBe(true);
  });
});
