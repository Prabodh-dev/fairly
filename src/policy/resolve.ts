import type { Policy } from '../config/types.js';

export interface CompiledPolicy {
  policy: Policy;
  matchesRoute(route: string): boolean;
}

function literalLength(pattern: string): number {
  return pattern.replaceAll('*', '').length;
}

export function globMatch(pattern: string, text: string): boolean {
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let starMatchEnd = 0;
  while (textIndex < text.length) {
    if (patternIndex < pattern.length && pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      patternIndex++;
      starMatchEnd = textIndex;
    } else if (patternIndex < pattern.length && pattern[patternIndex] === text[textIndex]) {
      patternIndex++;
      textIndex++;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      starMatchEnd++;
      textIndex = starMatchEnd;
    } else {
      return false;
    }
  }
  while (patternIndex < pattern.length && pattern[patternIndex] === '*') patternIndex++;
  return patternIndex === pattern.length;
}

function compileRoute(pattern: string): (route: string) => boolean {
  if (!pattern.includes('*')) {
    return (route) => route === pattern;
  }
  return (route) => globMatch(pattern, route);
}

function compare(a: Policy, b: Policy): number {
  const aWild = a.route.includes('*');
  const bWild = b.route.includes('*');
  if (aWild !== bWild) return aWild ? 1 : -1;
  if (aWild && bWild) {
    const byLiteral = literalLength(b.route) - literalLength(a.route);
    if (byLiteral !== 0) return byLiteral;
  }
  const aTier = a.tier !== undefined;
  const bTier = b.tier !== undefined;
  if (aTier !== bTier) return aTier ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function compilePolicies(policies: Iterable<Policy>): CompiledPolicy[] {
  return [...policies]
    .sort(compare)
    .map((policy) => ({ policy, matchesRoute: compileRoute(policy.route) }));
}

export function resolvePolicy(compiled: readonly CompiledPolicy[], route: string, tier: string | undefined): Policy | undefined {
  for (const candidate of compiled) {
    if (candidate.policy.tier !== undefined && candidate.policy.tier !== tier) continue;
    if (candidate.matchesRoute(route)) return candidate.policy;
  }
  return undefined;
}
