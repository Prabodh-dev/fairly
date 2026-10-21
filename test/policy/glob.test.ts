import { describe, expect, it } from 'vitest';
import type { Policy } from '../../src/config/types.js';
import { compilePolicies, globMatch, resolvePolicy } from '../../src/policy/resolve.js';

function regexMatch(pattern: string, text: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's').test(text);
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('globMatch', () => {
  it('matches the cases the route patterns rely on', () => {
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('*', '/anything/at/all')).toBe(true);
    expect(globMatch('/api/*', '/api/')).toBe(true);
    expect(globMatch('/api/*', '/api/orders/17')).toBe(true);
    expect(globMatch('/api/*', '/apix')).toBe(false);
    expect(globMatch('/a/*/c', '/a/b/c')).toBe(true);
    expect(globMatch('/a/*/c', '/a/b/d')).toBe(false);
    expect(globMatch('*suffix', 'a-suffix')).toBe(true);
    expect(globMatch('*suffix', 'suffix-a')).toBe(false);
    expect(globMatch('a**b', 'ab')).toBe(true);
    expect(globMatch('', '')).toBe(true);
    expect(globMatch('', 'x')).toBe(false);
    expect(globMatch('x', '')).toBe(false);
  });

  it('treats regex metacharacters literally and a star in the text as an ordinary character', () => {
    expect(globMatch('/v1.0/(x)', '/v1.0/(x)')).toBe(true);
    expect(globMatch('/v1.*', '/v1x0')).toBe(false);
    expect(globMatch('a?b', 'axb')).toBe(false);
    expect(globMatch('a*b', 'a*b')).toBe(true);
    expect(globMatch('/a/*', '/a/*')).toBe(true);
  });

  it('gives the same answer as the regular expression it replaced, on thousands of random cases', () => {
    const random = mulberry32(20261021);
    const alphabet = ['a', 'b', '/', '.'];
    const word = (length: number, extra: string[]): string =>
      Array.from({ length }, () => {
        const pool = [...alphabet, ...extra];
        return pool[Math.floor(random() * pool.length)] ?? 'a';
      }).join('');
    for (let i = 0; i < 5000; i++) {
      const pattern = word(Math.floor(random() * 9), ['*', '*']);
      const text = word(Math.floor(random() * 12), []);
      expect(globMatch(pattern, text), `pattern ${JSON.stringify(pattern)} text ${JSON.stringify(text)}`).toBe(regexMatch(pattern, text));
    }
  });

  it('stays fast on patterns that make a backtracking regular expression run for minutes', () => {
    const pattern = `${'*a'.repeat(100)}b`;
    const text = 'a'.repeat(256);
    const started = performance.now();
    expect(globMatch(pattern, text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('resolves a request against a hostile pattern without stalling', () => {
    const hostile: Policy = {
      name: 'hostile',
      route: `${'*a'.repeat(120)}b`,
      algorithm: 'fixed-window',
      limit: 1,
      windowSeconds: 60,
    };
    const compiled = compilePolicies([hostile]);
    const started = performance.now();
    expect(resolvePolicy(compiled, 'a'.repeat(256), undefined)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(50);
  });
});
