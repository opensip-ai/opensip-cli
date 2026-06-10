/**
 * Acceptance fixture: JSX element resolution.
 *
 * `<Foo />` resolves to the Foo declaration; `<div />` is ignored.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './_fixture-runner.js';

import type { Catalog } from '@opensip-tools/graph';

describe('jsx-resolution acceptance fixture', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-jsx-'));
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  writeFixture(fixtureDir, {
    'foo.tsx': `export function Foo(): JSX.Element { return <span>foo</span>; }\n`,
    'caller.tsx': `import { Foo } from './foo.js';\nexport function Caller(): JSX.Element {\n  return <div><Foo /></div>;\n}\n`,
  });
  let catalog!: Catalog;
  beforeAll(async () => {
    catalog = await runFixture(fixtureDir);
  });

  it('resolves <Foo /> to the Foo function declaration', () => {
    const callerOcc = findOccurrence(catalog, (o) => o.simpleName === 'Caller');
    expect(callerOcc).toBeDefined();
    const fooEdge = callerOcc!.calls.find((e) => e.text.includes('<Foo'));
    expect(fooEdge).toBeDefined();
    expect(fooEdge!.resolution).toBe('jsx');
    expect(fooEdge!.to.length).toBe(1);

    const fooOcc = findOccurrence(
      catalog,
      (o) => o.simpleName === 'Foo' && o.kind === 'function-declaration',
    );
    expect(fooOcc).toBeDefined();
    expect(fooEdge!.to[0]).toBe(fooOcc!.bodyHash);
  });

  it('does not record <div /> as a JSX edge', () => {
    const callerOcc = findOccurrence(catalog, (o) => o.simpleName === 'Caller');
    expect(callerOcc).toBeDefined();
    const divEdges = callerOcc!.calls.filter((e) => e.text.includes('<div'));
    // <div> is intrinsic; the resolver should return UNRESOLVED but the
    // call site IS recorded as an edge with `to: []`. The acceptance
    // shape is: no resolved entry pointing at any catalog occurrence.
    for (const e of divEdges) expect(e.to.length).toBe(0);
  });
});
