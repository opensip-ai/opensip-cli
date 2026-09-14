/**
 * @fileoverview Regression tests for `cache-ttl-validation`'s per-occurrence
 * TTL parsing.
 *
 * The parser used to look at only the FIRST `ttl` substring on a line, and to
 * classify the parsed value from the WHOLE line. That produced two distinct
 * wrong results on a line carrying more than one TTL:
 *
 *  - suppression: a leading key whose value is not a literal
 *    (`defaultTtl: DEFAULT_TTL`) abandoned the line, hiding a real
 *    `sessionTtl: 1` next to it;
 *  - misattribution: `{ userTtl: 300, balanceTtl: 3600 }` reported
 *    "Financial data cached with 300s TTL" — 300 is the NON-financial value,
 *    and the actual financial `balanceTtl: 3600` was never reported at all.
 */

import { runCheckOnFixture } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { checks } from '../../../index.js';

import type { Signal } from '@opensip-cli/core';

function check() {
  const c = checks.find((x) => x.config.slug === 'cache-ttl-validation');
  if (!c) throw new Error('check not found: cache-ttl-validation');
  return c;
}

async function findings(content: string): Promise<readonly Signal[]> {
  const run = await runCheckOnFixture(check(), {
    files: [{ path: 'src/cache.ts', content }],
  });
  return run.findings;
}

describe('cache-ttl-validation · every TTL on a line is parsed', () => {
  it('flags a later TTL even when the first key on the line has no literal value', async () => {
    const signals = await findings(
      ['export const cacheConfig = {', '  defaultTtl: DEFAULT_TTL, sessionTtl: 1,', '};'].join(
        '\n',
      ),
    );

    expect(signals.map((s) => s.metadata?.type)).toContain('ttl-too-short');
  });

  it('does not flag a TTL key whose value is not a literal', async () => {
    const signals = await findings(
      ['export const cacheConfig = {', '  defaultTtl: DEFAULT_TTL,', '};'].join('\n'),
    );

    expect(signals).toHaveLength(0);
  });
});

describe('cache-ttl-validation · classification is per-occurrence', () => {
  it('reports the financial value, not a neighbouring non-financial one', async () => {
    const signals = await findings(
      ['export const cacheConfig = {', '  userTtl: 300, balanceTtl: 3600,', '};'].join('\n'),
    );

    const financial = signals.filter((s) => s.metadata?.type === 'financial-ttl-too-long');
    expect(financial).toHaveLength(1);
    expect(financial[0]?.message).toContain('3600s');
    // The old whole-line classification blamed `userTtl`'s 300 instead.
    expect(financial[0]?.message).not.toContain('300s');
  });

  it('does not treat a neighbouring key as financial for a plain TTL', async () => {
    const signals = await findings(
      ['export const cacheConfig = {', '  userTtl: 300, balanceTtl: 30,', '};'].join('\n'),
    );

    expect(signals).toHaveLength(0);
  });

  it('still classifies from a trailing comment when the line has one TTL', async () => {
    const signals = await findings(
      ['export const cacheConfig = {', '  ttl: 600, // payment balance cache', '};'].join('\n'),
    );

    expect(signals.map((s) => s.metadata?.type)).toContain('financial-ttl-too-long');
  });
});
