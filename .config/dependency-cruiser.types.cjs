// @ts-check
/**
 * Type-aware companion to `.dependency-cruiser.cjs` (audit 2026-05-29, M4).
 *
 * The main architecture gate sets `tsPreCompilationDeps: false`, so
 * type-only import edges are invisible to it — a deliberate trade-off
 * documented there: it models "what actually runs", avoiding false
 * positives on `import type` (a type-only cycle is runtime-safe). The
 * cost is a blind spot: a tool could grow a type-only dependency on
 * another tool, or a type-only layer inversion / cycle could form, and
 * the main gate would never notice.
 *
 * This config is the stricter structural lens that closes that gap. It
 * flips `tsPreCompilationDeps` ON and re-runs the SAME architecture
 * ruleset against the type-inclusive graph. Run it with
 * `pnpm depcruise:types` (wired into `pnpm lint`).
 *
 * GATING history:
 *   - Round-3 (2026-05-30): the historical type-only cycles
 *     (LoadScenarioConfig etc.) were paid down, so this config was
 *     promoted from visibility-only to gating (a standalone
 *     `no-circular-incl-types` rule, then in `pnpm lint`).
 *   - Round-3 follow-up (2026-05-30): rather than a single bespoke
 *     cycle rule, this now reuses the FULL `base.forbidden` ruleset.
 *     Because `tsPreCompilationDeps` is on here, base's own `no-circular`
 *     rule already catches type-only cycles, and every directional LAYER
 *     rule now also fires on type-only edges — closing the type-only
 *     layer-inversion blind spot (e.g. a type-only `fitness -> graph`
 *     import). Verified 0 violations (786 modules / 1847 deps).
 *
 * Note for future maintainers: this config inherits `...base.options`, which
 * includes `includeOnly: '^packages/'`. That drops every node_modules edge
 * before rules run, so npm-targeting hygiene rules cannot fire here either —
 * turning on `tsPreCompilationDeps` makes type-only *package-layer* edges
 * visible, but not edges into node_modules. Dev-dependency hygiene is therefore
 * NOT a depcruise concern in either config; it lives in ESLint
 * `import-x/no-extraneous-dependencies` (which sees node_modules). If you add a
 * new base rule that should be scoped out of the type-inclusive run, exclude it
 * by name from the spread below rather than relaxing the whole gate.
 */

const base = require('./dependency-cruiser.cjs');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  // The exact same architecture ruleset as the gating config — but the
  // `tsPreCompilationDeps: true` override below makes every rule (layer
  // rules + no-circular) evaluate against the type-inclusive graph.
  forbidden: base.forbidden,
  options: {
    ...base.options,
    // The whole point of this companion config: see type-only edges.
    tsPreCompilationDeps: true,
  },
};
