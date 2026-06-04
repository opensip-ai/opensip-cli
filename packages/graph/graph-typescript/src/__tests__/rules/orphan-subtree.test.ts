/**
 * Test the orphan-subtree rule against synthetic fixtures.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildIndexes, orphanSubtreeRule } from '@opensip-tools/graph/internal';
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

describe('orphan-subtree rule — exported recursive renderer (D2 + D3)', () => {
  // End-to-end mirror of cli-ui/render-to-text.ts: an exported recursive
  // function consumed only across a package boundary (so its only resolved
  // in-project caller is its own self-edge), plus a file-local helper it
  // calls. Before D2 the self-edge made `no-callers-exported` miss it, so it
  // and its helper became false orphans. After D2 the renderer seeds as an
  // entry point and the helper is reached transitively; D3 also suppresses
  // the exported renderer directly.
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-orphan-recursive-'));
  afterAll(() => { rmSync(fixtureDir, { recursive: true, force: true }); });

  writeFixture(fixtureDir, {
    'render.ts': [
      'function spansToText(parts: string[]): string {',
      "  return parts.join(' ');",
      '}',
      'export function renderToText(node: { kind: string; parts: string[]; children: { kind: string; parts: string[]; children: never[] }[] }): string {',
      "  if (node.kind === 'group') {",
      "    return node.children.map(renderToText).join(' ');",
      '  }',
      '  return spansToText(node.parts);',
      '}',
      '',
    ].join('\n'),
  });
  const catalog = runFixture(fixtureDir);
  const signals = orphanSubtreeRule.evaluate(catalog, buildIndexes(catalog), {});
  const orphans = signals.map((s) => s.metadata.simpleName);

  it('does not flag the exported recursive renderer', () => {
    expect(orphans).not.toContain('renderToText');
  });

  it('does not flag the file-local helper reached only by the renderer', () => {
    expect(orphans).not.toContain('spansToText');
  });
});
