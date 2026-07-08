/**
 * @fileoverview Architecture checks barrel (checks-typescript).
 *
 * These are GENERIC, shippable TS-AST architecture checks — they fire on any
 * adopter's TypeScript codebase, keyed on public/structural facts (import cycles,
 * contract-schema drift, drizzle migration guardrails, missing type exports,
 * module fan-out, package.json exports, phantom deps, tsconfig extends). None is
 * gated to opensip-cli's own monorepo layout.
 *
 * opensip-cli-INTERNAL architecture checks (keyed on @opensip-cli package
 * internals — ToolCliContext seams, cli-live, bootstrap tool admission, MCP
 * replay) do NOT live here: they were relocated to the private, never-published
 * `@opensip-cli/checks-dogfood` pack, which loads only for opensip-cli's own
 * `fit:ci` dogfood gate. Shipping an opensip-internal check in this pack would
 * just clutter an adopter's `fit list` with inert rules.
 */
export * from './circular-import-detection.js';
export * from './contracts-schema-consistency.js';
export * from './drizzle-orm-migration-guardrails.js';
export * from './missing-type-exports.js';
export * from './module-coupling-fan-out.js';
export * from './package-json-exports-field.js';
export * from './phantom-dependency-detection.js';
export * from './tsconfig-extends-validation.js';
