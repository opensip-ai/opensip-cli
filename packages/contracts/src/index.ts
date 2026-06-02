/**
 * @opensip-tools/contracts — shared contract types.
 *
 * Tool packages (fitness, simulation) and the CLI entry-point both
 * depend on this package for:
 *   - CLI option / output / result types
 *   - Exit code constants and error suggestions
 *   - The cross-tool StoredSession type (the SessionRepo runtime + the
 *     sessions schema live in @opensip-tools/session-store)
 *
 * The GraphCatalog shape is DEFINED here (./graph-catalog.ts), not
 * re-exported from elsewhere. It is the contract surface between the
 * graph tool (which writes catalog.json) and @opensip-tools/dashboard
 * (which renders it): both producer and consumer depend on contracts
 * from below, so the shape lives in the layer beneath both. contracts
 * holds zero runtime dependency on dashboard or graph — these are
 * type-only declarations.
 *
 * contracts depends only on @opensip-tools/core. Tools depend on
 * contracts. The CLI entry-point depends on contracts and on every
 * tool package — the dependency graph stays acyclic.
 */

// CLI option / argument types
export type {
  FitOptions,
  InitOptions,
  ToolOptions,
} from './types.js';

// Output types (the structured JSON shape and its parts)
export type {
  CliOutput,
  CheckOutput,
  FindingOutput,
  TableRow,
  SummaryOptions,
} from './types.js';

// Command result types (the CommandResult union + per-command variants)
export type {
  CommandResult,
  ClearDoneResult,
  ConfigureDoneResult,
  UninstallDoneResult,
  FitDoneResult,
  SimDoneResult,
  GraphDoneResult,
  GateDoneResult,
  GraphStatusResult,
  ListChecksResult,
  ListRecipesResult,
  HistoryResult,
  DashboardResult,
  InitResult,
  PreExistingFile,
  ExperimentalResult,
  PluginResult,
  PluginInfo,
  SyncEntry,
  HelpResult,
  ErrorResult,
} from './command-results.js';

// Canonical pass-rate (`score`) computation — shared by every tool that
// builds a CliOutput so the dashboard "PASS RATE" stays consistent across
// fit/graph and cannot drift back into per-tool formulas.
export { passRate } from './score.js';

// Exit codes + error suggestion helper + typed-error → exit-code mapping
export { EXIT_CODES, getErrorSuggestion, mapToolErrorToExitCode } from './exit-codes.js';
export type { ErrorSuggestion } from './exit-codes.js';

// CLI defaults loader (`cli:` block of opensip-tools.config.yml).
// Lives in contracts because the CLI-pre-action seam is tool-agnostic;
// see ./cli-config.ts for the rationale.
export { loadCliDefaults } from './cli-config.js';
export type { CliDefaults } from './cli-config.js';

// Session persistence type. The cross-tool StoredSession shape stays here
// as the contract surface; SessionRepo + the sessions schema +
// generateSessionId/sanitizeForFilename moved to @opensip-tools/session-store
// (audit 2026-05-29, contracts split).
export type { StoredSession } from './session-types.js';

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
  GraphResolutionMode,
  GraphVisibility,
} from './graph-catalog.js';

// SARIF + cloud reporting moved to @opensip-tools/reporting (audit
// 2026-05-29, contracts split). The build/cloud-report runtime + its
// types live there; contracts no longer re-exports them.

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
