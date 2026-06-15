/**
 * Tests for the engine-side mirror of opensip's content-derived
 * symbol-ID / edge-ID hashing.
 *
 * Covers two layers:
 *   1. Golden hex values — locks the algorithm byte-for-byte.
 *      Computed independently via `node:crypto` against the exact
 *      canonicalization string opensip's `computeSymbolId` produces.
 *      A change to either side's algorithm fails these.
 *   2. Invariants — determinism, divergence across each input field,
 *      arity-null vs arity-0 distinction, unresolved-edge differentiation.
 *
 * Cross-repo validation (engine ↔ opensip symbol-id.ts byte-equivalence)
 * belongs in a parity test that can import both implementations. The golden
 * values here are pre-computed against opensip's algorithm and pin the local
 * mirror until such a cross-repo fixture is available.
 *
 * Phase 3 Task 3.2 per DEC-498.
 */

import { describe, expect, it } from 'vitest';

import {
  deriveOpenSipEdgeId,
  deriveOpenSipModulePath,
  deriveOpenSipSymbolId,
} from '../../render/opensip-id-derivation.js';

describe('deriveOpenSipSymbolId — golden hex values', () => {
  it('produces the canonical hash for a typical function symbol', () => {
    expect(
      deriveOpenSipSymbolId({
        repoId: 'REP_acme',
        modulePath: 'packages/foo/src/bar',
        kind: 'function',
        qualifiedName: 'packages/foo/src/bar.greet',
        arity: 1,
      }),
    ).toBe('e2746cfead3b80b415c706ce0b1402259e3c24c4ba860ef7fcab1aedfa6e7a3b');
  });

  it('arity 0 differs from arity null (the empty-string vs "0" distinction)', () => {
    expect(
      deriveOpenSipSymbolId({
        repoId: 'REP_acme',
        modulePath: 'packages/foo/src/bar',
        kind: 'function',
        qualifiedName: 'packages/foo/src/bar.greet',
        arity: 0,
      }),
    ).toBe('bb2797ecd3b90cb7e9d7d7f1e3363c11dcaa7efe9ea379f2883fd74975fe3746');
    expect(
      deriveOpenSipSymbolId({
        repoId: 'REP_acme',
        modulePath: 'packages/foo/src/bar',
        kind: 'function',
        qualifiedName: 'packages/foo/src/bar.greet',
        arity: null,
      }),
    ).toBe('f21ecbb7ce5dc7b3900d7d302ad7d03c946541d54a63c90afa3c1b64c420a0c7');
  });
});

describe('deriveOpenSipSymbolId — invariants', () => {
  it('is deterministic — identical input produces identical hash', () => {
    const input = {
      repoId: 'REP_acme',
      modulePath: 'm/n',
      kind: 'function',
      qualifiedName: 'm.n.greet',
      arity: 1,
    };
    expect(deriveOpenSipSymbolId(input)).toBe(deriveOpenSipSymbolId(input));
  });

  it('produces 64-char hex output', () => {
    expect(
      deriveOpenSipSymbolId({
        repoId: 'r',
        modulePath: 'm',
        kind: 'function',
        qualifiedName: 'q',
        arity: 0,
      }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different repoId produces different hash', () => {
    const base = {
      modulePath: 'm',
      kind: 'function',
      qualifiedName: 'm.f',
      arity: 0,
    };
    expect(deriveOpenSipSymbolId({ ...base, repoId: 'r_a' })).not.toBe(
      deriveOpenSipSymbolId({ ...base, repoId: 'r_b' }),
    );
  });

  it('different qualifiedName produces different hash', () => {
    const base = { repoId: 'r', modulePath: 'm', kind: 'function', arity: 0 };
    expect(deriveOpenSipSymbolId({ ...base, qualifiedName: 'a' })).not.toBe(
      deriveOpenSipSymbolId({ ...base, qualifiedName: 'b' }),
    );
  });

  it('different kind produces different hash', () => {
    const base = { repoId: 'r', modulePath: 'm', qualifiedName: 'q', arity: 0 };
    expect(deriveOpenSipSymbolId({ ...base, kind: 'function' })).not.toBe(
      deriveOpenSipSymbolId({ ...base, kind: 'method' }),
    );
  });
});

describe('deriveOpenSipEdgeId — golden hex values', () => {
  it('resolved edge', () => {
    expect(
      deriveOpenSipEdgeId({
        fromSymbolId: 'hash_A',
        edgeKind: 'calls',
        toSymbolId: 'hash_B',
        toQualifiedNameUnresolved: null,
      }),
    ).toBe('a0189de0e83a866ded1a039ba6a64f9aaf3df50fc0b10227e43339c92f732334');
  });

  it('unresolved edge — qname only', () => {
    expect(
      deriveOpenSipEdgeId({
        fromSymbolId: 'hash_A',
        edgeKind: 'calls',
        toSymbolId: null,
        toQualifiedNameUnresolved: 'externalLib.someFn',
      }),
    ).toBe('fca1ed2df3b1a37ca1a934b9bc04a73742b4d001e4120095e78f056100aaead9');
  });

  it('both targets null — canonicalized as "unresolved:"', () => {
    expect(
      deriveOpenSipEdgeId({
        fromSymbolId: 'hash_A',
        edgeKind: 'calls',
        toSymbolId: null,
        toQualifiedNameUnresolved: null,
      }),
    ).toBe('71187d153a18a0895fdcc33d9dd3309360be01a8e88ccf9d105577f155760523');
  });
});

describe('deriveOpenSipEdgeId — invariants', () => {
  it('two distinct unresolved qnames produce different hashes', () => {
    const a = deriveOpenSipEdgeId({
      fromSymbolId: 'x',
      edgeKind: 'calls',
      toSymbolId: null,
      toQualifiedNameUnresolved: 'fnA',
    });
    const b = deriveOpenSipEdgeId({
      fromSymbolId: 'x',
      edgeKind: 'calls',
      toSymbolId: null,
      toQualifiedNameUnresolved: 'fnB',
    });
    expect(a).not.toBe(b);
  });

  it('resolved vs unresolved with same qname produce different hashes', () => {
    const resolved = deriveOpenSipEdgeId({
      fromSymbolId: 'x',
      edgeKind: 'calls',
      toSymbolId: 'y',
      toQualifiedNameUnresolved: null,
    });
    const unresolved = deriveOpenSipEdgeId({
      fromSymbolId: 'x',
      edgeKind: 'calls',
      toSymbolId: null,
      toQualifiedNameUnresolved: 'y',
    });
    expect(resolved).not.toBe(unresolved);
  });
});

describe('deriveOpenSipModulePath', () => {
  it('strips the extension when the last dot is in the basename', () => {
    expect(deriveOpenSipModulePath('packages/foo/src/bar.ts')).toBe('packages/foo/src/bar');
  });

  it('returns input unchanged when basename has no extension', () => {
    expect(deriveOpenSipModulePath('packages/foo/src/bar')).toBe('packages/foo/src/bar');
  });

  it('normalizes Windows backslashes to POSIX separators', () => {
    expect(deriveOpenSipModulePath(String.raw`packages\foo\src\bar.go`)).toBe(
      'packages/foo/src/bar',
    );
  });

  it('preserves dot in dirname (no extension stripped)', () => {
    expect(deriveOpenSipModulePath('.config/release.notes')).toBe('.config/release');
  });
});
