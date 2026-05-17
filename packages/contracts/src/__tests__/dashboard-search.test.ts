/**
 * Fuzzy search algorithm — substring-with-character-skip with scoring.
 */

import { describe, expect, it } from 'vitest';

import { dashboardSearchJs } from '../persistence/dashboard/code-paths/search.js';

interface Match { name: string; score: number }

function loadFuzzyMatch(): (q: string, names: string[]) => Match[] {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const fn = new Function(dashboardSearchJs() + '\nreturn fuzzyMatch;')() as (q: string, n: string[]) => Match[];
  return fn;
}

describe('fuzzyMatch', () => {
  it('matches a prefix with a high score', () => {
    const fn = loadFuzzyMatch();
    const out = fn('log', ['logger', 'formatLog', 'unrelated']);
    const top = out[0];
    expect(top.name).toBe('logger');
    // The prefix bonus (50) makes it dominant.
    expect(top.score).toBeGreaterThan(out[1].score);
  });

  it('matches mid-word when the chars appear in order', () => {
    const fn = loadFuzzyMatch();
    const out = fn('ger', ['logger', 'unrelated']);
    expect(out.map(m => m.name)).toContain('logger');
  });

  it('returns empty for queries with no characters in order', () => {
    const fn = loadFuzzyMatch();
    const out = fn('xyz', ['logger', 'helper', 'format']);
    expect(out).toEqual([]);
  });

  it('is case-insensitive but rewards exact case', () => {
    const fn = loadFuzzyMatch();
    const a = fn('Log', ['Logger', 'logger']);
    expect(a[0].name).toBe('Logger');
    expect(a[0].score).toBeGreaterThan(a[1].score);
  });

  it('returns empty for an empty query', () => {
    const fn = loadFuzzyMatch();
    expect(fn('', ['logger'])).toEqual([]);
  });

  it('matches non-contiguous chars (lgr → logger)', () => {
    const fn = loadFuzzyMatch();
    const out = fn('lgr', ['logger', 'unrelated']);
    expect(out.map(m => m.name)).toContain('logger');
  });
});
