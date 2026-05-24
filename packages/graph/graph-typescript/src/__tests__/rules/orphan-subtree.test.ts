/**
 * Test the orphan-subtree rule against synthetic fixtures.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndexes, orphanSubtreeRule } from '@opensip-tools/graph';
import { afterAll, describe, expect, it } from 'vitest';


import { runFixture, writeFixture } from '../acceptance/_fixture-runner.js';

describe('orphan-subtree rule', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-orphan-rule-'));
  afterAll(() => { rmSync(fixtureDir, { recursive: true, force: true }); });

  writeFixture(fixtureDir, {
    'index.ts': `function unusedHelper() { return 1; }\nexport function entry(): number {\n  return helper();\n}\nfunction helper(): number { return 42; }\n`,
  });
  const catalog = runFixture(fixtureDir);
  const indexes = buildIndexes(catalog);
  const signals = orphanSubtreeRule.evaluate(catalog, indexes, {});

  it('flags unusedHelper as orphan', () => {
    const orphans = signals.map((s) => s.metadata.simpleName);
    expect(orphans).toContain('unusedHelper');
  });

  it('does not flag helper (called by entry)', () => {
    const orphans = signals.map((s) => s.metadata.simpleName);
    expect(orphans).not.toContain('helper');
  });

  it('does not flag entry (exported with no caller — entry-point)', () => {
    const orphans = signals.map((s) => s.metadata.simpleName);
    expect(orphans).not.toContain('entry');
  });
});
