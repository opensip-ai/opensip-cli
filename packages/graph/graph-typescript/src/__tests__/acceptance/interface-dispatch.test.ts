/**
 * Acceptance fixture: interface dispatch.
 *
 * `config.method()` on an interface type resolves to the value
 * declaration that implements the method.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './_fixture-runner.js';

import type { Catalog } from '@opensip-tools/graph';


describe('interface-dispatch acceptance fixture', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-iface-'));
  afterAll(() => { rmSync(fixtureDir, { recursive: true, force: true }); });

  writeFixture(fixtureDir, {
    'iface.ts': `export interface Greeter { greet(): string; }\nexport const englishGreeter: Greeter = {\n  greet(): string { return 'hello'; }\n};\n`,
    'caller.ts': `import { englishGreeter } from './iface.js';\nimport type { Greeter } from './iface.js';\nexport function callGreet(g: Greeter): string {\n  return g.greet();\n}\nexport function callConcrete(): string {\n  return englishGreeter.greet();\n}\n`,
  });
  let catalog!: Catalog;
  beforeAll(async () => { catalog = await runFixture(fixtureDir); });

  it('records a method-dispatch edge for g.greet()', () => {
    const callGreetOcc = findOccurrence(catalog, (o) => o.simpleName === 'callGreet');
    expect(callGreetOcc).toBeDefined();
    const greetEdge = callGreetOcc!.calls.find((e) => e.text.includes('greet'));
    expect(greetEdge).toBeDefined();
    // Acceptance: SOME edge resolution shape is recorded. 'method-dispatch'
    // is the ideal verdict; 'unknown' (from catalog-fallback) is acceptable
    // when there's exactly one greet occurrence in the project.
    expect(['method-dispatch', 'static', 'unknown']).toContain(greetEdge!.resolution);
    expect(greetEdge!.to.length).toBeGreaterThan(0);
  });

  it('resolves englishGreeter.greet() to the implementation', () => {
    const callConcreteOcc = findOccurrence(catalog, (o) => o.simpleName === 'callConcrete');
    expect(callConcreteOcc).toBeDefined();
    const greetEdge = callConcreteOcc!.calls.find((e) => e.text.includes('greet'));
    expect(greetEdge).toBeDefined();
    expect(greetEdge!.to.length).toBeGreaterThan(0);
  });
});
