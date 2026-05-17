/**
 * Test the duplicated-function-body rule.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { duplicatedFunctionBodyRule } from '../../rules/duplicated-function-body.js';
import { runFixture, writeFixture } from '../acceptance/_fixture-runner.js';

describe('duplicated-function-body rule', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-dup-'));
  afterAll(() => { rmSync(fixtureDir, { recursive: true, force: true }); });

  writeFixture(fixtureDir, {
    'a.ts': `export function calculate(a: number, b: number): number {\n  if (a < 0) return 0;\n  if (b < 0) return 0;\n  const sum = a + b;\n  return sum * 2;\n}\n`,
    'b.ts': `export function calculate(a: number, b: number): number {\n  if (a < 0) return 0;\n  if (b < 0) return 0;\n  const sum = a + b;\n  return sum * 2;\n}\n`,
    'c.ts': `export function unique(): number {\n  return 1234;\n}\n`,
  });
  const catalog = runFixture(fixtureDir);
  const indexes = buildIndexes(catalog);
  // The fixture's `calculate` body is small (~100 normalized chars).
  // Disable the wrapper-suppression threshold for this test so we are
  // exercising the rule's core grouping behavior, not its anti-wrapper
  // heuristic.
  const signals = duplicatedFunctionBodyRule.evaluate(catalog, indexes, { minDuplicateBodySize: 0 });

  it('flags duplicated bodies across files', () => {
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals.some((s) => s.message.includes('calculate'))).toBe(true);
  });

  it('does not flag unique', () => {
    expect(signals.some((s) => s.message.includes('unique'))).toBe(false);
  });
});
