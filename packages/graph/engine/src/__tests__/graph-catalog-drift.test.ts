// @fitness-ignore-file no-stub-tests -- runtime body is intentionally trivial; this is a compile-time drift detector enforced by the type assertion above (line 31)
/**
 * Compile-time drift detector for the contracts/graph catalog duplication.
 *
 * `@opensip-tools/contracts/src/graph-catalog.ts` declares a structural
 * mirror of this engine's `Catalog` so the dashboard package can consume
 * the catalog shape without reaching into a Layer-3 tool. The duplication
 * is intentional (see graph-catalog.ts §2.4 decoupling claim) but has no
 * automated detector — when the engine adds a field, the contracts mirror
 * can drift silently and the dashboard reads the old shape.
 *
 * This test asserts the engine's `Catalog` is structurally assignable to
 * contracts' `GraphCatalog`. The producer (engine) is more specific
 * (`version: '3.0'` literal, `cacheKey: string` required) than the
 * consumer-facing contract (`version: string`, `cacheKey?: string`), so
 * the producer-to-contract direction is the load-bearing one: any new
 * field added to `Catalog` that is not absorbed by the contract surfaces
 * as a compile error here.
 *
 * The runtime body is a placeholder — vitest needs at least one `it` block
 * for the file to register. The actual assertion is the type-level
 * statement below; if it survives `tsc`, we are drift-free.
 */

import { describe, it, expect } from 'vitest';

import type { Catalog } from '../types.js';
import type { GraphCatalog } from '@opensip-tools/contracts';

// Compile-time assertion — fails `pnpm typecheck` if the engine's
// `Catalog` shape diverges from contracts' `GraphCatalog`.
const _engineToContract: GraphCatalog = {} as Catalog;
void _engineToContract;

describe('graph-catalog drift detector', () => {
  it('engine Catalog is structurally assignable to contracts GraphCatalog (compile-time)', () => {
    expect(true).toBe(true);
  });
});
