/**
 * Pure static-handler bridge matrix (Phase 7 Task 7.4).
 * Outcome statuses, reviewed cross-package allowance, and overlay
 * must not invent call edges.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STATIC_HANDLER_BRIDGE_LIMITS,
  MAX_STATIC_HANDLER_CACHE_ENTRIES,
  MAX_STATIC_HANDLER_CANDIDATES,
  MAX_STATIC_HANDLER_DESCRIPTORS,
  REVIEWED_CROSS_PACKAGE_HANDLERS,
  dedupeStaticHandlerRefs,
  matchStaticHandlerCandidates,
  overlayStaticHandlerBridge,
  preflightStaticHandlerRef,
  type DeclarationCandidate,
  type StaticHandlerRef,
} from '../static-handler-bridge.js';

import type { RuntimeWiringEdge, RuntimeWiringNode } from '../runtime-wiring-read-port.js';

function ref(over: Partial<StaticHandlerRef> = {}): StaticHandlerRef {
  return {
    package: '@opensip-cli/fitness',
    path: 'packages/fitness/engine/src/cli/fit/fit-command-spec.ts',
    declaration: 'runFitCommand',
    owner: 'tool',
    admittedPackageIdentity: '@opensip-cli/fitness',
    ...over,
  };
}

function candidate(over: Partial<DeclarationCandidate> = {}): DeclarationCandidate {
  return {
    declarationId: 'd1|@opensip-cli/fitness|packages/fitness/engine/src/cli/fit/fit-command-spec.ts|function|runFitCommand|1|0',
    package: '@opensip-cli/fitness',
    filePath: 'packages/fitness/engine/src/cli/fit/fit-command-spec.ts',
    name: 'runFitCommand',
    qualifiedName: 'runFitCommand',
    ...over,
  };
}

describe('static-handler-bridge production constants', () => {
  it('wires literal production descriptor/candidate/cache ceilings', () => {
    expect(MAX_STATIC_HANDLER_DESCRIPTORS).toBe(2_000);
    expect(MAX_STATIC_HANDLER_CANDIDATES).toBe(8);
    expect(MAX_STATIC_HANDLER_CACHE_ENTRIES).toBe(4);
    expect(DEFAULT_STATIC_HANDLER_BRIDGE_LIMITS).toEqual({
      maxDescriptors: 2_000,
      maxCandidates: 8,
    });
  });

  it('exposes only the reviewed contracts/external-adapter shared mappings', () => {
    expect(REVIEWED_CROSS_PACKAGE_HANDLERS).toHaveLength(2);
    expect(REVIEWED_CROSS_PACKAGE_HANDLERS.map((h) => h.package).sort()).toEqual([
      '@opensip-cli/contracts',
      '@opensip-cli/external-tool-adapter',
    ]);
  });
});

describe('dedupeStaticHandlerRefs', () => {
  it('preserves first-seen order and rejects N+1 descriptors at injected limits', () => {
    const a = ref({ path: 'a.ts', declaration: 'a' });
    const b = ref({ path: 'b.ts', declaration: 'b' });
    const unique = dedupeStaticHandlerRefs([a, a, b], { maxDescriptors: 4, maxCandidates: 2 });
    expect(unique).toEqual([a, b]);

    expect(() =>
      dedupeStaticHandlerRefs([a, b, ref({ path: 'c.ts', declaration: 'c' })], {
        maxDescriptors: 2,
        maxCandidates: 2,
      }),
    ).toThrow(/maxDescriptors/);
  });
});

describe('preflightStaticHandlerRef', () => {
  it('rejects third-party tool claims whose package differs from admitted identity', () => {
    const mismatch = preflightStaticHandlerRef(
      ref({
        package: '@evil/other',
        admittedPackageIdentity: '@opensip-cli/fitness',
        owner: 'tool',
      }),
    );
    expect(mismatch?.status).toBe('provenance-mismatch');
  });

  it('allows reviewed first-party shared mappings across packages', () => {
    const shared = REVIEWED_CROSS_PACKAGE_HANDLERS[0]!;
    const allowed = preflightStaticHandlerRef(
      ref({
        package: shared.package,
        path: shared.path,
        declaration: shared.declaration,
        owner: 'tool',
        admittedPackageIdentity: '@opensip-cli/fitness',
      }),
    );
    expect(allowed).toBeUndefined();
  });
});

describe('matchStaticHandlerCandidates', () => {
  it('resolves a unique package+path+name hit with author-declared provenance', () => {
    const outcome = matchStaticHandlerCandidates(ref(), [candidate()]);
    expect(outcome).toMatchObject({
      status: 'resolved',
      declarationId: candidate().declarationId,
      claimProvenance: 'author-declared',
      matchBasis: 'author-declared-exact-declaration',
      confidence: 'medium',
    });
  });

  it('returns not-found, ambiguous, and candidate-cap without inventing IDs', () => {
    expect(matchStaticHandlerCandidates(ref(), []).status).toBe('not-found');

    const amb = matchStaticHandlerCandidates(ref(), [
      candidate({ declarationId: 'd1|a' }),
      candidate({ declarationId: 'd1|b', qualifiedName: 'ns.runFitCommand' }),
    ]);
    expect(amb.status).toBe('ambiguous');
    expect(amb.declarationId).toBeUndefined();

    const caps = matchStaticHandlerCandidates(
      ref(),
      Array.from({ length: 3 }, (_, i) =>
        candidate({ declarationId: `d1|${String(i)}`, name: 'runFitCommand' }),
      ),
      { maxDescriptors: 10, maxCandidates: 2 },
    );
    expect(caps.status).toBe('candidate-cap');
    expect(caps.declarationId).toBeUndefined();
  });
});

describe('overlayStaticHandlerBridge', () => {
  it('labels dispatch edges resolved without adding call-graph edges', () => {
    const nodes: RuntimeWiringNode[] = [
      Object.freeze({
        id: 'handler:fit',
        kind: 'handler' as const,
        label: 'runFitCommand',
        commandPath: 'fit',
        staticHandlerDeclaration: 'runFitCommand',
      }),
    ];
    const edges: RuntimeWiringEdge[] = [
      Object.freeze({
        from: 'command:fit',
        to: 'handler:fit',
        kind: 'command-dispatches-handler' as const,
        source: 'command-spec' as const,
        confidence: 'high' as const,
        staticBridge: 'unresolved' as const,
      }),
    ];
    const outcomes = new Map([['fit', matchStaticHandlerCandidates(ref(), [candidate()])]]);
    const overlay = overlayStaticHandlerBridge(nodes, edges, outcomes);
    expect(overlay.resolvedCount).toBe(1);
    expect(overlay.nodes[0]?.declarationId).toBe(candidate().declarationId);
    expect(overlay.edges).toHaveLength(1);
    expect(overlay.edges[0]?.kind).toBe('command-dispatches-handler');
    expect(overlay.edges[0]?.staticBridge).toBe('resolved');
    // Runtime edge kinds only — no static call/import adjacency invented.
    expect(
      overlay.edges.every((e) =>
        [
          'manifest-admits-tool',
          'registry-owns-command',
          'command-nests-under',
          'host-mounts-command',
          'command-dispatches-handler',
          'external-worker-dispatch',
        ].includes(e.kind),
      ),
    ).toBe(true);
  });
});
