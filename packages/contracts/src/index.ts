/**
 * @opensip-tools/contracts — shared contract types.
 *
 * Tool packages (fitness, simulation) and the CLI entry-point both
 * depend on this package for:
 *   - CLI option / output / result types
 *   - Exit code constants and error suggestions
 *   - Session persistence (saveSession, loadSessions, dashboard generator)
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

// Dashboard HTML generator
export { generateDashboardHtml } from './persistence/dashboard/index.js';
export type {
  GraphCatalog,
  GraphFunctionOccurrence,
  GraphCallEdge,
  GraphParam,
  GraphFunctionKind,
  GraphCallResolution,
  GraphCallConfidence,
  GraphVisibility,
} from './persistence/dashboard/code-paths/types.js';
