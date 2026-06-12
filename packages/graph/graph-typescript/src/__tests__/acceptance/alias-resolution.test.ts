/**
 * Acceptance fixture: alias resolution.
 *
 * `import { foo } from './x'; foo();` resolves to the foo declaration
 * in x.ts (not the import alias).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './_fixture-runner.js';

import type { Catalog } from '@opensip-cli/graph';

describe('alias-resolution acceptance fixture', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-alias-'));
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  writeFixture(fixtureDir, {
    'x.ts': `export function foo(): number { return 42; }\n`,
    'caller.ts': `import { foo } from './x.js';\nexport function caller(): number { return foo(); }\n`,
  });
  let catalog!: Catalog;
  beforeAll(async () => {
    catalog = await runFixture(fixtureDir);
  });

  it('resolves the imported call to the foreign declaration', () => {
    const callerOcc = findOccurrence(catalog, (o) => o.simpleName === 'caller');
    expect(callerOcc).toBeDefined();
    expect(callerOcc!.calls.length).toBeGreaterThan(0);
    const fooEdge = callerOcc!.calls.find((e) => e.text.includes('foo'));
    expect(fooEdge).toBeDefined();
    expect(fooEdge!.to.length).toBe(1);
    expect(fooEdge!.resolution).toBe('static');
    expect(fooEdge!.confidence).toBe('high');

    const fooOcc = findOccurrence(
      catalog,
      (o) => o.simpleName === 'foo' && o.kind === 'function-declaration',
    );
    expect(fooOcc).toBeDefined();
    expect(fooEdge!.to[0]).toBe(fooOcc!.bodyHash);
  });
});
