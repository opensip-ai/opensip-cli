/**
 * Acceptance fixture: module-init synthesis.
 *
 * Top-level statements in a file are owned by a synthesized
 * <module-init> pseudo-occurrence. Calls inside top-level
 * variable initializers and side-effect statements show up
 * as edges on this occurrence.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './_fixture-runner.js';

describe('module-init acceptance fixture', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-modinit-'));
  afterAll(() => { rmSync(fixtureDir, { recursive: true, force: true }); });

  writeFixture(fixtureDir, {
    'lib.ts': `export function helper(): number { return 1; }\n`,
    'init.ts': `import { helper } from './lib.js';\nexport const result = helper();\nhelper();\n`,
  });
  const catalog = runFixture(fixtureDir);

  it('synthesizes a <module-init> occurrence for init.ts', () => {
    const modInit = findOccurrence(
      catalog,
      (o) => o.kind === 'module-init' && o.filePath === 'init.ts',
    );
    expect(modInit).toBeDefined();
    expect(modInit!.simpleName).toBe('<module-init:init.ts>');
  });

  it('records helper() calls on the module-init occurrence', () => {
    const modInit = findOccurrence(
      catalog,
      (o) => o.kind === 'module-init' && o.filePath === 'init.ts',
    );
    expect(modInit).toBeDefined();
    const helperEdges = modInit!.calls.filter((e) => e.text.includes('helper'));
    expect(helperEdges.length).toBeGreaterThanOrEqual(1);
    expect(helperEdges[0].to.length).toBe(1);
  });
});
