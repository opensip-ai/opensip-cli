/**
 * @opensip-tools/contracts — shared contract types.
 *
 * Tool packages (fitness, simulation) and the CLI entry-point both
 * depend on this package for:
 *   - CLI option / output / result types
 *   - Exit code constants and error suggestions
 *   - Session persistence (saveSession, loadSessions)
 *
 * Dashboard rendering moved to @opensip-tools/dashboard (Layer 3).
 * contracts type-re-exports the GraphCatalog shape from there as part
 * of the contract surface between the graph tool and the dashboard;
 * that re-export is type-only (erased at compile time) so contracts
 * keeps zero runtime dependency on dashboard.
 *
 * contracts depends only on @opensip-tools/core. Tools depend on
 * contracts. The CLI entry-point depends on contracts and on every
 * tool package — the dependency graph stays acyclic.
 */

// CLI option / argument types
export type {
  CliArgs,
  FitOptions,
  InitOptions,
  ToolOptions,
} from './types.js';

// Output and result types
export type {
  CliOutput,
  CheckOutput,
  FindingOutput,
  TableRow,
  SummaryOptions,
  CommandResult,
  ClearDoneResult,
  ConfigureDoneResult,
  UninstallDoneResult,
  FitDoneResult,
  SimDoneResult,
  ListChecksResult,
  ListRecipesResult,
  HistoryResult,
  DashboardResult,
  InitResult,
  ExperimentalResult,
  PluginResult,
  PluginInfo,
  SyncEntry,
  HelpResult,
  ErrorResult,
} from './types.js';

// Exit codes + error suggestion helper
export { EXIT_CODES, getErrorSuggestion } from './exit-codes.js';
export type { ErrorSuggestion } from './exit-codes.js';

// CLI defaults loader (`cli:` block of opensip-tools.config.yml).
// Lives in contracts because the CLI-pre-action seam is tool-agnostic;
// see ./cli-config.ts for the rationale.
export { loadCliDefaults } from './cli-config.js';
export type { CliDefaults } from './cli-config.js';

// Session persistence
export {
  configurePersistencePaths,
  saveSession,
  loadSessions,
  loadLatestSession,
  countSessions,
  clearAllSessions,
  clearSessionsOlderThan,
  getStoreDir,
  getReportsDir,
  generateSessionId,
  sanitizeForFilename,
} from './persistence/store.js';
export type {
  StoredSession,
  CheckCatalogEntry,
  RecipeCatalogEntry,
} from './persistence/store.js';
// `LegacyStoredSession` and `migrateLegacyStoredSession` are intentionally
// NOT re-exported here — they are an internal implementation detail of
// `loadSessions`. Tests reach in via the relative path. Promote them to
// the barrel only if a real external consumer materializes.

// Graph catalog type surface. This is the contract surface between the
// graph tool (which writes catalog.json) and the dashboard package
// (which renders it). Lives in contracts because both producer and
// consumer depend on the shape — contracts is the layer below both.
export type {
  GraphCatalog,
  GraphFunctionOccurrence,
  GraphCallEdge,
  GraphParam,
  GraphFunctionKind,
  GraphCallResolution,
  GraphCallConfidence,
  GraphVisibility,
} from './graph-catalog.js';

// `commander` is referenced here purely as a type — `import type` keeps
// the runtime bundle (`dist/index.js`) free of any commander require.
// The package declares `commander` as an OPTIONAL peer dependency
// (see package.json `peerDependencies` + `peerDependenciesMeta`) so
// consumers who want to use `CliProgram` get commander surfaced in
// their dependency graph, while plugins that never touch `CliProgram`
// pay no install cost.
import type { Command } from 'commander';

/**
 * Type alias for Commander's `Command` class — re-exported here so
 * tool packages can drop the `as Command` cast in their `register(cli)`
 * implementations.
 *
 * `commander` is an OPTIONAL peer dependency of
 * `@opensip-tools/contracts`. Plugin authors who reference `CliProgram`
 * (directly or via the `Tool` contract) need `commander` resolvable in
 * their own `node_modules`; pnpm/npm will surface the peer requirement
 * in install output. Plugins that never touch `CliProgram` can skip
 * commander entirely. The alias erases at compile time — no runtime
 * commander require lands in `dist/index.js`.
 */
export type CliProgram = Command;
