/**
 * @fileoverview Regression tests for `no-hardcoded-timeouts`' file prefilter
 * and per-occurrence extraction.
 *
 * The prefilter was case-SENSITIVE (`includes('timeout')`) while the detector
 * lowercases the line before searching. A file whose only timeout identifiers
 * are camelCase (`socketTimeout`, `connectTimeout`, `readTimeout`) contains no
 * lowercase `timeout` and no literal `setTimeout`, so it was dropped before
 * being scanned at all — and adding an unrelated lowercase `timeout`
 * identifier anywhere in the SAME file made the SAME line get flagged.
 *
 * The extractors additionally looked at only the first `timeout` / `.timeout`
 * occurrence on a line, so a leading non-literal key hid a real hardcoded value
 * sharing that line.
 */

import { runCheckOnFixture } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { checks } from '../../../index.js';

import type { Signal } from '@opensip-cli/core';

function check() {
  const c = checks.find((x) => x.config.slug === 'no-hardcoded-timeouts');
  if (!c) throw new Error('check not found: no-hardcoded-timeouts');
  return c;
}

async function findings(content: string): Promise<readonly Signal[]> {
  const run = await runCheckOnFixture(check(), {
    files: [{ path: 'src/client.ts', content }],
  });
  return run.findings;
}

describe('no-hardcoded-timeouts · case-insensitive file prefilter', () => {
  it('scans a file whose only timeout identifier is camelCase', async () => {
    const signals = await findings(
      ['export const socketOptions = {', '  socketTimeout: 30000,', '};'].join('\n'),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('30000ms');
  });

  it('flags the same line regardless of an unrelated lowercase identifier', async () => {
    const withoutHint = await findings(
      ['export const socketOptions = {', '  socketTimeout: 30000,', '};'].join('\n'),
    );
    const withHint = await findings(
      [
        'export const timeoutLabel = 1;',
        'export const socketOptions = {',
        '  socketTimeout: 30000,',
        '};',
      ].join('\n'),
    );

    expect(withoutHint).toHaveLength(withHint.length);
  });

  it('still scans a setTimeout-only file', async () => {
    const signals = await findings(
      ['export function schedule(cb: () => void): void {', '  setTimeout(cb, 10000);', '}'].join(
        '\n',
      ),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('10000ms');
  });

  it('still skips a file with no timeout reference at all', async () => {
    expect(await findings('export const x = 30000;')).toHaveLength(0);
  });
});

describe('no-hardcoded-timeouts · every occurrence on a line is inspected', () => {
  it('flags a later hardcoded timeout when the first key on the line is non-literal', async () => {
    const signals = await findings(
      [
        'export const httpConfig = {',
        '  connectTimeout: OPTIONS.connect, readTimeout: 30000,',
        '};',
      ].join('\n'),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('30000ms');
  });

  it('flags a later .timeout(N) when an earlier .timeout call is non-literal', async () => {
    const signals = await findings(
      [
        'export function build(a: any, b: any): void {',
        '  a.timeout(LIMIT); b.timeout(30000);',
        '}',
      ].join('\n'),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.message).toContain('30000ms');
  });
});
