/**
 * @fileoverview Architecture checks barrel.
 *
 * Tool/host SEAM-DISCIPLINE — shipped vs project-local (audit M5):
 *
 * SHIPPED here (generic; fire on any adopter authoring a Tool plugin, keyed on
 * the public command-authoring contract, no host path gating):
 *   - host-tool-runtime-import-boundary — the host loads tool runtimes only
 *     through the admission boundary with an explicit source policy.
 *   - command-handler-host-owned-output — a tool command handler lets the host
 *     own rendering / --json / exit; no direct stdout/console/process.exit inside
 *     a non-raw-stream defineCommand handler (the declared escape hatch is
 *     output:'raw-stream' + rawStreamReason).
 *
 * KEPT PROJECT-LOCAL (opensip-cli/fit/checks/*.mjs) — opensip-internal facts that
 * are inert/meaningless for an adopter, so they would just clutter their `fit
 * list`. Each is path-gated to opensip's own monorepo layout
 * (packages/{fitness,graph,simulation}/engine/src/, packages/cli/src/...) and/or
 * cites an internal decision/spec section:
 *   - only-documented-toolcli-seams, no-direct-stdout-in-tool-engine,
 *     no-local-exit-or-stdout (the *principles* are shipped above in their
 *     contract-keyed, path-independent form; these dogfood the opensip tree).
 *   - restrict-raw-db-access, capability-by-manifest, no-tool-owned-session-timing,
 *     no-module-singleton, etc. — coupled to opensip's own DataStore/registry/
 *     manifest internals.
 * The shipped-checks-must-be-generic project-local gate enforces this split: a
 * check carrying opensip paths / ADR refs / §-sections / internal-engine imports
 * cannot live in a shipped pack.
 */
export * from './circular-import-detection.js';
export * from './command-handler-host-owned-output.js';
export * from './contracts-schema-consistency.js';
export * from './drizzle-orm-migration-guardrails.js';
export * from './host-tool-runtime-import-boundary.js';
export * from './live-view-through-cli-live.js';
export * from './mcp-results-no-rerun.js';
export * from './missing-type-exports.js';
export * from './module-coupling-fan-out.js';
export * from './no-bootstrap-tool-import.js';
export * from './no-run-done-result.js';
export * from './package-json-exports-field.js';
export * from './phantom-dependency-detection.js';
export * from './subprocess-correlation-required.js';
export * from './tsconfig-extends-validation.js';
