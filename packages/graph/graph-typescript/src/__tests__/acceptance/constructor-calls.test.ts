/**
 * Acceptance fixture: constructor calls.
 *
 * `new MyClass(...)` resolves to the class constructor's catalog entry.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './_fixture-runner.js';

import type { Catalog } from '@opensip-tools/graph';


describe('constructor-calls acceptance fixture', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-ctor-'));
  afterAll(() => { rmSync(fixtureDir, { recursive: true, force: true }); });

  writeFixture(fixtureDir, {
    'klass.ts': `export class MyClass {\n  private value: number;\n  constructor(value: number) {\n    this.value = value + 1;\n  }\n  getValue(): number { return this.value; }\n}\n`,
    'caller.ts': `import { MyClass } from './klass.js';\nexport function makeOne(): MyClass { return new MyClass(42); }\n`,
  });
  let catalog!: Catalog;
  beforeAll(async () => { catalog = await runFixture(fixtureDir); });

  it('records new MyClass(...) as a constructor edge to the catalog entry', () => {
    const callerOcc = findOccurrence(catalog, (o) => o.simpleName === 'makeOne');
    expect(callerOcc).toBeDefined();
    const ctorEdge = callerOcc!.calls.find((e) => e.text.includes('new MyClass'));
    expect(ctorEdge).toBeDefined();
    expect(ctorEdge!.resolution).toBe('constructor');
    expect(ctorEdge!.to.length).toBe(1);

    const ctorOcc = findOccurrence(catalog, (o) => o.kind === 'constructor');
    expect(ctorOcc).toBeDefined();
    expect(ctorEdge!.to[0]).toBe(ctorOcc!.bodyHash);
  });
});
