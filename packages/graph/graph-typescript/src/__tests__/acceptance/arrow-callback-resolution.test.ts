/**
 * Acceptance fixture: arrow-callback resolution.
 *
 * Calls inside an anonymous arrow function (passed as a callback) are
 * recorded under the arrow's synthetic <arrow:...> name.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './_fixture-runner.js';

import type { Catalog } from '@opensip-tools/graph';

describe('arrow-callback-resolution acceptance fixture', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-arrow-'));
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  writeFixture(fixtureDir, {
    'lib.ts': `export function helper(): number { return 1; }\n`,
    'caller.ts': `import { helper } from './lib.js';\nexport function caller(): readonly number[] {\n  const xs = [1, 2, 3];\n  return xs.map((n) => n * helper());\n}\n`,
  });
  let catalog!: Catalog;
  beforeAll(async () => {
    catalog = await runFixture(fixtureDir);
  });

  it('synthesizes an <arrow:...> occurrence with calls', () => {
    const arrowOcc = findOccurrence(
      catalog,
      (o) => o.kind === 'arrow' && o.filePath === 'caller.ts' && o.simpleName.startsWith('<arrow:'),
    );
    expect(arrowOcc).toBeDefined();
    const helperEdge = arrowOcc!.calls.find((e) => e.text.includes('helper'));
    expect(helperEdge).toBeDefined();
    expect(helperEdge!.to.length).toBe(1);
  });
});
