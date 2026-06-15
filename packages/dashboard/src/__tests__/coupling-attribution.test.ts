/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Coupling-grid attribution: a callee whose body is duplicated across
 * packages must be attributed to the caller's own package, not the
 * byBodyHash collision winner.
 */

import { describe, expect, it } from 'vitest';

import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';
import { dashboardViewCouplingJs } from '../code-paths/view-coupling.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

interface CouplingEnv {
  buildIndexes: (catalog: GraphCatalog) => {
    occurrencesByHash: Map<string, GraphFunctionOccurrence[]>;
    byBodyHash: Map<string, GraphFunctionOccurrence>;
  };
  resolveCalleeOcc: (
    target: string,
    callerOcc: GraphFunctionOccurrence,
    indexes: unknown,
  ) => GraphFunctionOccurrence | undefined;
}

function loadCouplingEnv(): CouplingEnv {
  // The coupling template runs `views.push(...)` at eval time and references
  // a handful of dashboard globals; stub the ones it touches at load.
  const stubs = `
function el() { return { appendChild() {}, addEventListener() {}, removeChild() {}, firstChild: null }; }
const views = [];
function makeSectionHeading() { return el(); }
function openFunctionCard() {}
function closeFunctionCard() {}
function passesFilter() { return true; }
`;
  const tail = `return { buildIndexes, resolveCalleeOcc };`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted, in-repo emitted source.
  const factory = new Function(
    stubs + dashboardPathUtilsJs() + dashboardIndexesJs() + dashboardViewCouplingJs() + tail,
  );
  return factory() as CouplingEnv;
}

function occ(
  over: Partial<GraphFunctionOccurrence> & {
    bodyHash: string;
    filePath: string;
    qualifiedName: string;
  },
): GraphFunctionOccurrence {
  return {
    simpleName: 'f',
    line: 1,
    column: 0,
    endLine: 2,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

describe('coupling callee attribution', () => {
  it('attributes a duplicated-body callee to the caller’s own package', () => {
    const env = loadCouplingEnv();
    // Same body 'H' in pkg-a and pkg-b; caller is in pkg-a.
    const aF = occ({
      bodyHash: 'H',
      filePath: 'packages/pkg-a/src/f.ts',
      qualifiedName: 'packages/pkg-a/src/f.f',
    });
    const bF = occ({
      bodyHash: 'H',
      filePath: 'packages/pkg-b/src/f.ts',
      qualifiedName: 'packages/pkg-b/src/f.f',
    });
    const caller = occ({
      bodyHash: 'C',
      filePath: 'packages/pkg-a/src/call.ts',
      qualifiedName: 'packages/pkg-a/src/call.caller',
      simpleName: 'caller',
      calls: [
        { to: ['H'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'f()' },
      ],
    });
    const catalog = { functions: { f: [aF, bF], caller: [caller] } } as unknown as GraphCatalog;
    const indexes = env.buildIndexes(catalog);
    const resolved = env.resolveCalleeOcc('H', caller, indexes);
    expect(resolved?.filePath).toBe('packages/pkg-a/src/f.ts'); // caller's package, not the collision winner
  });

  it('falls back deterministically (lowest qualifiedName) when no same-package candidate', () => {
    const env = loadCouplingEnv();
    const aF = occ({
      bodyHash: 'H',
      filePath: 'packages/pkg-a/src/f.ts',
      qualifiedName: 'packages/pkg-a/src/f.f',
    });
    const bF = occ({
      bodyHash: 'H',
      filePath: 'packages/pkg-b/src/f.ts',
      qualifiedName: 'packages/pkg-b/src/f.f',
    });
    const caller = occ({
      bodyHash: 'C',
      filePath: 'packages/pkg-z/src/call.ts',
      qualifiedName: 'packages/pkg-z/src/call.caller',
      simpleName: 'caller',
    });
    const catalog = { functions: { f: [bF, aF], caller: [caller] } } as unknown as GraphCatalog;
    const indexes = env.buildIndexes(catalog);
    const resolved = env.resolveCalleeOcc('H', caller, indexes);
    expect(resolved?.qualifiedName).toBe('packages/pkg-a/src/f.f'); // deterministic lowest
  });
});
