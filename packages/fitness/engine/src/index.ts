/**
 * @opensip-tools/fitness — public barrel.
 *
 * This barrel is the **marketplace contract surface** for the fitness tool:
 * the check / recipe / plugin authoring API plus the `fitnessTool` plugin
 * descriptor. It is deliberately curated to match
 * `docs/public/10-concepts/04-contract-surfaces.md` — a check pack depends
 * only on what is exported here.
 *
 * Engine internals — registries, the recipe service, `ExecutionContext`,
 * targets/signalers config, the plugin loader, check-package discovery, the
 * `fit`/`dashboard`/`list-*` CLI handlers, the architecture-gate primitives,
 * and the persistence repos (`FitBaselineRepo`) — are NOT public. The CLI
 * drives fitness through the Tool contract (`fitnessTool`), never by importing
 * those symbols; fitness's own `tool.ts` wires them via relative imports. The
 * handful that cross-package test suites need are exposed via
 * `@opensip-tools/fitness/internal` (see `./internal.ts`), which production
 * code is forbidden from importing (dependency-cruiser `no-cross-package-internal`,
 * ADR-0009 / ADR-0013).
 *
 * The exact value-export set is locked by `__tests__/public-api.test.ts`:
 * adding or removing a runtime export here fails that test on purpose. Adding
 * a symbol to this barrel is a minor change; removing one is a major change.
 */

// ── Check authoring API ────────────────────────────────────────────
export { defineCheck } from './framework/define-check.js';
export { defineRegexListCheck } from './framework/define-regex-list-check.js';
export type {
  RegexListCheckPattern,
  RegexListCheckOptions,
  DefineRegexListCheckConfig,
} from './framework/define-regex-list-check.js';

// ── Recipe authoring API ───────────────────────────────────────────
// `defineRecipe` is the stable authoring entry point; `FitnessRecipeDefinition`
// is the object an author writes. The produced `FitnessRecipe`, the recipe
// service, registries, and `RecipeCheckResult` are engine internals (the doc
// names `FitnessRecipe` / `RecipeCheckResult` as non-contract) and stay
// unexported — `defineRecipe`'s inferred return type carries them where needed.
export { defineRecipe } from './recipes/types.js';
export type { FitnessRecipeDefinition } from './recipes/types.js';

// ── Re-exported kernel convenience ─────────────────────────────────
// Lets a pack barrel set `metadata.version` from its own package.json without
// duplicating the literal or adding a direct @opensip-tools/core dep.
export { readPackageVersion } from '@opensip-tools/core';

// ── Check authoring types ──────────────────────────────────────────
export type {
  CheckViolation,
  CheckScope,
  FileAccessor,
  CheckConcern,
  CheckLanguage,
} from './framework/check-config.js';
export type { Check } from './framework/check-types.js';
export { isCheck, collectCheckObjects } from './framework/check-types.js';

// ── Findings output shape (the data a check run produces) ───────────
export type {
  Finding,
  Severity,
  FindingSeverity,
  ToolOutput,
  CheckResult,
  CheckInfo,
  CheckResultMetadata,
  ItemType,
} from './types/findings.js';

// ── Authoring helpers — snippet/line extraction, file access ────────
export { getLineNumber, extractSnippet, isAPIFile } from './framework/result-builder.js';
export { execAbortable } from './framework/abortable-exec.js';
// File cache (checks read content through it; pack tests may seed/clear it).
export { fileCache } from './framework/file-cache.js';
export { buildImportGraph, findStronglyConnectedComponents } from './framework/import-graph.js';
export type { ImportGraph } from './framework/import-graph.js';

// Regex-based string/comment strippers — language-agnostic, good enough for
// universal/text checks. (The TS-AST-aware, position-preserving `filterContent`
// lives in @opensip-tools/lang-typescript; TS checks import it from there.)
export {
  isInsideStringLiteral,
  stripStringLiterals,
  stripStringsAndComments,
  stripStringsAndCommentsPreservingPositions,
} from './framework/strip-literals.js';

// ── Recipe-aware check config accessors ────────────────────────────
// A check reads its recipe-provided config via `getCheckConfig`; the set/clear
// pair is used by pack test suites to drive a check under a given config.
export {
  getCheckConfig,
  setCurrentRecipeCheckConfig,
  clearCurrentRecipeCheckConfig,
} from './recipes/check-config.js';

// ── Check-author display / util helpers (extracted from per-pack copies) ──
export {
  isCommentLine,
  isTestFile,
  applyCheckDisplay,
  getCheckDisplayName,
  getCheckIcon,
  makeDisplayHelpers,
  createPathMatcher,
} from './check-utils/index.js';
export type {
  IsCommentLineOptions,
  IsTestFileOptions,
  DisplayHelpers,
  PathPattern,
} from './check-utils/index.js';

// ── Plugin authoring contract ──────────────────────────────────────
// `CheckDisplayEntry` types a pack's `display/index.ts`; `FitPluginExports`
// types a user-authored `.mjs` fit plugin module.
export type { CheckDisplayEntry, FitPluginExports } from './plugins/types.js';

// ── Tool plugin export ─────────────────────────────────────────────
// Re-exported as `tool` so the third-party plugin-discovery walker (which keys
// on `mod.tool`) treats first-party and third-party Tool packages uniformly;
// dedup at register-tools.ts handles the duplicate-id case.
export { fitnessTool, fitnessTool as tool } from './tool.js';
