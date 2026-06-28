/**
 * Catalog freshness mapping (Task 6.1 — Persistence/freshness).
 *
 * Maps the graph engine's `CatalogVerdict` to the agent-facing `Freshness` DTO,
 * and recovers the working-tree `ValidationContext` from a catalog's recorded
 * `filesFingerprint`. Pure verdict→DTO logic — no engine re-entry.
 */

import { describe, expect, it } from 'vitest';

import {
  freshnessFromVerdict,
  missingFreshness,
  unverifiedFreshness,
  workingTreeContextFromCatalog,
} from '../freshness.js';

import type { Catalog } from '@opensip-cli/graph';
import type { CatalogVerdict } from '@opensip-cli/graph/internal';

const BUILT_AT = '2026-05-22T00:00:00.000Z';

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: BUILT_AT,
    cacheKey: 'ts-5.7.3-test',
    filesFingerprint: '0\n',
    functions: {},
    ...over,
  };
}

describe('missingFreshness', () => {
  it('is fresh:false with reason "missing" and no builtAt', () => {
    expect(missingFreshness()).toEqual({ fresh: false, reason: 'missing' });
  });
});

describe('unverifiedFreshness', () => {
  it('reports fresh:true with the builtAt (matches graph lookup serving the persisted catalog)', () => {
    expect(unverifiedFreshness(BUILT_AT)).toEqual({ fresh: true, builtAt: BUILT_AT });
  });
});

describe('freshnessFromVerdict', () => {
  it('maps a valid verdict to fresh:true', () => {
    const verdict: CatalogVerdict = { kind: 'valid' };
    expect(freshnessFromVerdict(verdict, BUILT_AT)).toEqual({ fresh: true, builtAt: BUILT_AT });
  });

  it('maps an incremental verdict to fresh:false with a changed-file reason', () => {
    const verdict: CatalogVerdict = {
      kind: 'incremental',
      changedFiles: ['a.ts', 'b.ts'],
    };
    const fresh = freshnessFromVerdict(verdict, BUILT_AT);
    expect(fresh.fresh).toBe(false);
    expect(fresh.builtAt).toBe(BUILT_AT);
    expect(fresh.reason).toContain('2 file(s) changed');
  });

  it('maps an invalid verdict to fresh:false with its reason', () => {
    const verdict: CatalogVerdict = {
      kind: 'invalid',
      reason: 'version-mismatch',
    };
    const fresh = freshnessFromVerdict(verdict, BUILT_AT);
    expect(fresh.fresh).toBe(false);
    expect(fresh.reason).toContain('version-mismatch');
  });
});

describe('workingTreeContextFromCatalog', () => {
  it('recovers the tracked file set (in order) from the persisted fingerprint', () => {
    const catalog = makeCatalog({
      filesFingerprint: '2\nsrc/a.ts|111|10\nsrc/b.ts|222|20\n',
    });
    const ctx = workingTreeContextFromCatalog(catalog);
    expect(ctx).toBeDefined();
    expect(ctx?.currentFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(ctx?.currentLanguage).toBe('typescript');
    expect(ctx?.currentCacheKey).toBe('ts-5.7.3-test');
  });

  it('returns undefined for a pre-fingerprint catalog (older build)', () => {
    const { filesFingerprint, ...withoutFp } = makeCatalog();
    void filesFingerprint;
    expect(workingTreeContextFromCatalog(withoutFp as Catalog)).toBeUndefined();
  });

  it('returns undefined when the fingerprint records zero files', () => {
    expect(workingTreeContextFromCatalog(makeCatalog({ filesFingerprint: '0\n' }))).toBeUndefined();
  });
});
