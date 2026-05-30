// @ts-check
/**
 * Type-aware companion to `.dependency-cruiser.cjs` (audit 2026-05-29, M4).
 *
 * The main architecture gate sets `tsPreCompilationDeps: false`, so
 * type-only import edges — and type-only dependency CYCLES — are
 * invisible to it (a deliberate trade-off documented there: it avoids
 * false positives on `import type`). The cost is a blind spot: a tool
 * could grow a type-only dependency on another tool's internals, or a
 * type-only cycle could form, and CI would never notice.
 *
 * This config closes the visibility gap. It flips `tsPreCompilationDeps`
 * on and reports circular dependencies INCLUDING type-only ones. Run it
 * with `pnpm depcruise:types`.
 *
 * GATING (audit 2026-05-30, round-3): the historical type-only cycles
 * (LoadScenarioConfig etc.) are paid down — `pnpm depcruise:types` now
 * reports zero violations — so `no-circular-incl-types` is promoted to
 * `error` and `depcruise:types` is wired into `pnpm lint`. This closes
 * the type-only blind spot while it is empty, so a future type-only
 * cycle cannot land silently. (Type-only LAYER inversions are a deeper
 * blind spot still open; adding type-aware layer rules here is a tracked
 * follow-up.)
 */

const base = require('./.dependency-cruiser.cjs');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-incl-types',
      severity: 'error',
      comment:
        'Circular dependency including type-only edges. Type-only cycles ' +
        'are a structural smell — usually the shared type belongs in a ' +
        'third module. Gating as of round-3 (see file header).',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    ...base.options,
    // The whole point of this companion config: see the type graph.
    tsPreCompilationDeps: true,
  },
};
