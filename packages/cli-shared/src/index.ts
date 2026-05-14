/**
 * @opensip-tools/cli-shared — shared CLI infrastructure.
 *
 * Tool packages (fitness, simulation) and the CLI entry-point both
 * depend on this package for:
 *   - CLI option / output / result types
 *   - Exit code constants and error suggestions
 *   - Session persistence (saveSession, loadSessions, dashboard generator)
 *
 * cli-shared depends only on @opensip-tools/core. Tools depend on
 * cli-shared. The CLI entry-point depends on cli-shared and on every
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
  TOOLS_HOME,
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

// Dashboard HTML generator
export { generateDashboardHtml } from './persistence/dashboard/index.js';
