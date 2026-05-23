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
  FitDoneResult,
  SimDoneResult,
  ListChecksResult,
  ListRecipesResult,
  HistoryResult,
  DashboardResult,
  InitResult,
  ExperimentalResult,
  PluginResult,
  HelpResult,
  ErrorResult,
} from './types.js';

// Exit codes + error suggestion helper
export { EXIT_CODES, getErrorSuggestion } from './exit-codes.js';
export type { ErrorSuggestion } from './exit-codes.js';

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
  LegacyStoredSession,
  CheckCatalogEntry,
  RecipeCatalogEntry,
} from './persistence/store.js';
export { migrateLegacyStoredSession } from './persistence/store.js';

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

// `commander` is a typecheck-only dependency for the CliProgram alias
// below; bringing the type in via `import type` keeps the runtime
// bundle free of a commander require.
import type { Command } from 'commander';

/**
 * Type alias for Commander's `Command` class — re-exported here so
 * tool packages can drop the `as Command` cast in their `register(cli)`
 * implementations without growing a direct `commander` dependency.
 *
 * The alias is type-only: `commander` is a dev-dependency of
 * `@opensip-tools/contracts` (used at typecheck time only) and the
 * runtime bundle stays untouched.
 *
 * Tool packages that already depend on `commander` continue to import
 * `Command` directly; this alias is the boundary type for plugins that
 * want a typed `cli` parameter without taking a Commander dependency
 * of their own.
 */
export type CliProgram = Command;
