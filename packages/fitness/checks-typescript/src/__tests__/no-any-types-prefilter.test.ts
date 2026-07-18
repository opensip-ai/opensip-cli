/**
 * @fileoverview Pre-filter superset regression for `no-any-types` (plan 09
 * Task 1.1/1.2). The old quick-filter keyword list required punctuation around
 * `any` (`': any'`, `'any)'`, …), so valid TypeScript a formatter would rewrite
 * (`:any`, `,any`, line-final `as any`) returned CLEAN without ever running the
 * AST pass — a silent false-negative on a type-safety guardrail. The filter is
 * now a strict superset (bare substring); these tests would have failed before
 * the fix and pin it.
 */

import { runCheckOnFixture } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { checks } from '../index.js';

function check() {
  const c = checks.find((x) => x.config.slug === 'no-any-types');
  if (!c) throw new Error('check not found: no-any-types');
  return c;
}

async function findingCount(content: string): Promise<number> {
  const run = await runCheckOnFixture(check(), {
    files: [{ path: 'src/subject.ts', content }],
  });
  return run.findings.length;
}

describe('no-any-types — pre-filter superset contract', () => {
  it('flags `:any` with no space (the form the old keyword list green-passed)', async () => {
    expect(await findingCount('export function f(x:any) { return x }\n')).toBe(1);
  });

  it('flags `,any` inside a tuple type', async () => {
    expect(await findingCount('export type Pair = [string,any]\n')).toBe(1);
  });

  it('flags a line-final `as any` assertion', async () => {
    expect(
      await findingCount('export const n = (JSON.parse("1") as unknown) as any\n'),
    ).toBe(1);
  });

  it('reports clean when `any` appears only inside identifiers', async () => {
    expect(
      await findingCount(
        'export interface Company { readonly companyName: string }\n' +
          'export const many = (companies: readonly Company[]): number => companies.length\n',
      ),
    ).toBe(0);
  });
});
