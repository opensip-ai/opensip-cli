/**
 * @fileoverview Accuracy regression tests for env-var-validation's null-safe
 * recognition — the fix that cleared its false-positive flood on this repo's
 * runtime/CLI edge reads. Idiomatic safe forms must NOT be flagged: truthy `if`
 * guards, `!!` / `Boolean()` coercion, `===`/`!==` comparisons, and
 * capture-then-guard.
 *
 * (The complementary fix — `process.env.X` inside string/template literals and
 * comments is not a real access — lives in the engine's `contentFilter`
 * dispatch, exercised by the engine content-filter tests and the dogfood gate,
 * not here: this harness runs the check's own logic on raw source.)
 */

import { runCheckOnFixture } from '@opensip-tools/fitness/internal';
import { describe, expect, it } from 'vitest';

import { checks } from '../index.js';

function check() {
  const c = checks.find((x) => x.config.slug === 'env-var-validation');
  if (!c) throw new Error('check not found: env-var-validation');
  return c;
}

async function findings(content: string): Promise<number> {
  const run = await runCheckOnFixture(check(), { files: [{ path: 'a.ts', content }] });
  return run.findings.length;
}

describe('env-var-validation · null-safe forms', () => {
  it('still flags a real unguarded access', async () => {
    expect(await findings(`export const secret = process.env.API_SECRET`)).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('recognises a truthy if-guard', async () => {
    expect(
      await findings(`export function f() { if (process.env.NO_COLOR) return false; return true }`),
    ).toBe(0);
  });

  it('recognises a negated if-guard', async () => {
    expect(
      await findings(
        `export function f() { if (!process.env.FORCE_COLOR) return false; return true }`,
      ),
    ).toBe(0);
  });

  it('recognises !! / Boolean() coercion', async () => {
    expect(
      await findings(
        `export const a = !!process.env.NO_COLOR\nexport const b = Boolean(process.env.CI)`,
      ),
    ).toBe(0);
  });

  it('recognises an equality comparison', async () => {
    expect(
      await findings(`export const disabled = process.env.OPENSIP_HEAP_NO_MONITOR === '1'`),
    ).toBe(0);
  });

  it('recognises capture-then-guard across following lines', async () => {
    const src = [
      'export function init() {',
      '  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT',
      '  if (!endpoint) return',
      '  use(endpoint)',
      '}',
    ].join('\n');
    expect(await findings(src)).toBe(0);
  });
});
