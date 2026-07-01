/**
 * Rust cacheKey implementation.
 *
 * Produces `rs-${cargoLockHash || cargoTomlHash || 'no-config'}-${resolutionMode}`.
 *
 * Prefers Cargo.lock over Cargo.toml when both are present —
 * Cargo.lock holds the resolved dependency graph, so changing a dep
 * version (which can change call-graph topology indirectly through
 * trait-impl changes) reliably flips the key. Cargo.toml is the
 * fallback when Cargo.lock isn't checked in (the typical pattern for
 * library crates). The precedence is encoded in `discover.ts`'s
 * config-candidate list; this module just fingerprints whichever anchor
 * discover picked.
 *
 * Per contract invariant I-6: pure function of `(config content)`.
 * Per I-8: emits `rs-`, distinct from `ts-` and `py-`.
 */

import { makeConfigCacheKey } from '@opensip-cli/graph-adapter-common';

export const cacheKey = makeConfigCacheKey({ prefix: 'rs' });
