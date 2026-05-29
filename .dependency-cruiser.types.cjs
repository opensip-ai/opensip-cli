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
 * It is intentionally NOT part of `pnpm lint` (non-gating): known
 * type-only cycles already exist (see the note in the main config re:
 * LoadScenarioConfig), so gating would fail today. This surfaces the
 * type graph for incremental cleanup; promote `no-circular-incl-types`
 * to `error` and add it to `lint` once the existing cycles are paid down.
 */

const base = require('./.dependency-cruiser.cjs');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-incl-types',
      severity: 'warn',
      comment:
        'Circular dependency including type-only edges. Type-only cycles ' +
        'are a structural smell — usually the shared type belongs in a ' +
        'third module. Visibility-only for now (see file header).',
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
