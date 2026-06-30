/**
 * @opensip-cli/contracts — public Tool↔runner contract facade.
 *
 * Tool packages (fitness, simulation, graph, and third-party plugins) and the
 * CLI entry-point both depend on this package for:
 *   - CLI option / output / result types
 *   - Exit code constants and error suggestions
 *   - The cross-tool StoredSession type (the SessionRepo runtime + the
 *     sessions schema live in @opensip-cli/session-store)
 *   - Runtime helpers that are part of the plugin authoring surface but whose
 *     implementation belongs in @opensip-cli/core (defineCommand,
 *     checkCompatibility, PLUGIN_API_VERSION)
 *
 * The GraphCatalog shape is DEFINED here (./graph-catalog.ts), not
 * re-exported from elsewhere. It is the contract surface between the
 * graph tool (which writes catalog.json) and @opensip-cli/dashboard
 * (which renders it): both producer and consumer depend on contracts
 * from below, so the shape lives in the layer beneath both. contracts
 * holds zero runtime dependency on dashboard or graph — these are
 * type-only declarations.
 *
 * This package is intentionally not "types-only": it may re-export small,
 * tool-facing runtime helpers from @opensip-cli/core and may own pure contract
 * helpers such as buildSignalEnvelope. It must not own host/runtime services
 * such as config loading, persistence, output delivery, or tool execution.
 *
 * contracts depends only on @opensip-cli/core. Tools depend on contracts. The
 * CLI entry-point depends on contracts and on every tool package — the
 * dependency graph stays acyclic.
 */

// CLI option / argument types
export type { FitOptions, InitOptions, ToolOptions } from './types.js';

// Signal envelope — the universal tool-run output currency (ADR-0011). The
// `CommandResult` payload every tool returns; it replaced the fitness-shaped
// `CliOutput`/`CheckOutput`/`FindingOutput` husk, which was retired in Phase 7.
export type {
  BaselineIdentity,
  DeclaredInputs,
  SignalEnvelope,
  RunVerdict,
  UnitResult,
  BuildEnvelopeInput,
} from './signal-envelope.js';
export { buildSignalEnvelope, DEFAULT_BASELINE_IDENTITY } from './signal-envelope.js';

// Command result types (the CommandResult union + per-command variants)
export type {
  CommandResult,
  ClearDoneResult,
  ConfigureDoneResult,
  UninstallDoneResult,
  GateDoneResult,
  GraphStatusResult,
  TextLinesResult,
  ToolsListResult,
  ToolsDoctorResult,
  ToolsCreateResult,
  ToolsListRow,
  ToolsValidateResult,
  ToolsValidateSection,
  ToolsInstallResult,
  ToolsUninstallResult,
  ToolsDataPurgeResult,
  SuiteAddResult,
  SuiteListEntry,
  SuiteListResult,
  SuiteListStep,
  SuiteRunResult,
  SuiteStepSummary,
  ListChecksResult,
  ListRecipesResult,
  HistorySession,
  HistorySuiteGroup,
  HistoryResult,
  ReportResult,
  InitResult,
  PreExistingFile,
  SimNoticeResult,
  PluginResult,
  PluginInfo,
  SyncEntry,
  SessionReplayResult,
  HelpResult,
  ErrorResult,
  GraphLookupMatch,
  GraphLookupResult,
  GraphImpactBasis,
  GraphImpactResult,
  ConfigValidateResult,
  ConfigSchemaResult,
} from './command-results.js';

// Render-only run-presentation adjunct (envelope-first-presentation plan). The
// single run variant on `CommandResult`: it carries the SignalEnvelope (the
// findings currency) plus the render-only bits (verboseDetail, host-owned
// durationMs, graph's banner caveat). It lives in its own module, so it needs
// its own re-export. It REPLACED the three per-tool fit/sim/graph done-result
// interfaces, which were hard-removed in RP-3; the
// `architecture-no-run-done-result` fitness check guards the surface against
// re-introducing them.
export type { RunPresentation } from './run-presentation.js';

// Command outcome — the OUTER currency wrapping every result and error (§5.5,
// launch). `CommandOutcome<T>` nests the unchanged `SignalEnvelope` under
// `.envelope` (run) / the `CommandResult` under `.data` (list/report) / errors
// under `.errors` (incl. the pre-handler bootstrap path). The host ASSEMBLES it;
// no tool chooses its own error JSON or success carrier. ADR-0024.
export type {
  CommandOutcome,
  CommandOutcomeStatus,
  ErrorDetail,
  WarningDetail,
  RenderHints,
} from './command-outcome.js';

// CLI diagnostics — typed bootstrap/setup substrate (ADR-0060, Phase 2). DEFINED in
// @opensip-cli/core; re-exported here for CommandOutcome and machine consumers.
export type {
  CliDiagnostic,
  CliDiagnosticCategory,
  CliDiagnosticCode,
  CliDiagnosticProvenance,
  CliDiagnosticSeverity,
} from './cli-diagnostic.js';
export { CLI_DIAGNOSTIC_CODES } from './cli-diagnostic.js';

// Run diagnostics — the shared, JSON-emittable diagnostics stream carried on a
// `CommandOutcome` (§5.10). One event vocabulary across the uniform tool
// lifecycle (discover → … → persist). DEFINED in @opensip-cli/core (beside the
// scope-owned diagnostics bus that PRODUCES it; core cannot import contracts);
// re-exported here so `CommandOutcome` (and machine consumers) can name it.
export type {
  RunDiagnostics,
  DiagnosticEvent,
  DiagnosticPhase,
  DiagnosticLevel,
} from '@opensip-cli/core';

// Canonical pass-rate (`score`) computation — shared by every tool that
// builds a signal envelope so the dashboard "PASS RATE" stays consistent
// across fit/graph and cannot drift back into per-tool formulas.
export { passRate } from './score.js';

// Exit codes + error suggestion helper + typed-error → exit-code mapping
export { EXIT_CODES, getErrorSuggestion, mapToolErrorToExitCode } from './exit-codes.js';
export type { ErrorSuggestion } from './exit-codes.js';

// Static tool-plugin manifest + the plugin-API epoch + provenance types +
// the pure compatibility gate (launch raw-vs-admitted contract).
// DEFINED in @opensip-cli/core (next to the Tool contract; core cannot
// import contracts); re-exported here for the public Tool↔runner surface.
export { PLUGIN_API_VERSION, checkCompatibility } from '@opensip-cli/core';
export type {
  RawToolPluginManifest,
  ToolPluginManifest,
  ToolCommandManifest,
  ToolProvenance,
  ToolResourceClass,
  ToolResourceRequirement,
  ToolSource,
  CompatibilityVerdict,
  // ADR-0054 M4-E: the serializable config descriptor a tool declares in its
  // manifest (the coarse host pass for external tools) + its JSON-Schema shape.
  ToolConfigManifestDescriptor,
  JsonSchemaObject,
  JsonSchemaNode,
  JsonSchemaPrimitiveType,
  // Capability domain model (launch, §5.3) — the shape a tool's
  // manifest `capabilities` slot now carries, plus the runtime domain spec.
  CapabilityDomainSpec,
  ToolCapabilityDeclaration,
  CapabilityContributionKind,
} from '@opensip-cli/core';

// The `cli:` block loader (`loadCliDefaults` / `CliDefaults`) moved to
// `@opensip-cli/config` in ADR-0023. Its runtime YAML projection was outside
// the contracts facade charter: importers now take it from the config layer.

// Command-plane types (launch, §5.4) — the declarative CommandSpec a
// tool exports for the host to mount, replacing raw-Commander access. DEFINED in
// @opensip-cli/core (beside the Tool contract; core cannot import contracts);
// re-exported here for the public Tool↔runner surface. `CommonFlagKey` is also
// re-exported from ./cli-flags (which now sources it from core) — both paths
// resolve to the same kernel type.
export {
  defineCommand,
  defineTool,
  COMMON_FLAG_KEYS,
  RAW_STREAM_REASONS,
  applyToolContributeScope,
  createToolScope,
  resolveToolHooks,
} from '@opensip-cli/core';
export { defineRunCommand, defineListCommand, defineAuxExportCommand } from './command-presets.js';
export type { DefineToolInput, ResolvedToolHooks } from '@opensip-cli/core';
export type {
  CommandSpec,
  OptionSpec,
  ArgSpec,
  CommandHandler,
  CommandContext,
  CommandOutputMode,
  CommandScopeRequirement,
  RawStreamReason,
} from '@opensip-cli/core';

// Tool-scoped recipe-default resolution (ADR-0022). The pure resolver every
// tool uses to pick its recipe name from --recipe / <tool>.recipe / default.
export { resolveToolRecipeName, BUILTIN_DEFAULT_RECIPE } from './recipe-default.js';
export type { ResolvedRecipe, RecipeSource } from './recipe-default.js';

// Cross-tool common-flag registry (ADR-0021). One source of truth for the flags
// every tool's run command shares; tools apply them via applyCommonFlags rather
// than re-declaring `--json`/`--cwd`/`--report-to`/… per tool.
export { commonFlags, applyCommonFlags, MANDATORY_COMMON_FLAGS } from './cli-flags.js';
export type { CommonFlagKey, CommonFlagSpec } from './cli-flags.js';

// Verbose-detail currency + builder (ADR-0021). The TYPES (VerboseDetail /
// FindingGroup / FindingLine) live in ./verbose-detail.ts (their currency home,
// so command-results and run-presentation can both name them without a cycle);
// `buildFindingGroups` is the shared Signal[] → FindingGroup[] mapping for the
// tools' `verboseDetail` carrier (fit + sim; one source, not per-tool).
// `groupSignalsBySource` is the shared `slug → Signal[]` index that fit's and
// graph's live-view row derivations both bucket through (one source, not
// per-tool — re-deriving it tripped `graph:duplicated-function-body`).
export { buildFindingGroups, groupSignalsBySource } from './verbose-detail.js';
export type {
  FindingGroupUnit,
  VerboseDetail,
  FindingGroup,
  FindingLine,
} from './verbose-detail.js';

// Session persistence type. The cross-tool StoredSession shape stays here
// as the contract surface; SessionRepo + the sessions schema +
// generateSessionId/sanitizeForFilename moved to @opensip-cli/session-store
// (audit 2026-05-29, contracts split).
export type {
  StoredSession,
  StoredSessionHostMetrics,
  ToolSessionReplay,
} from './session-types.js';
export type { ToolSessionRecord, ToolRunOutcome } from '@opensip-cli/core';
export { deriveRunOutcome, inferStoredRunOutcome } from '@opensip-cli/core';

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
  GraphFeatures,
  GraphFunctionFeatures,
  GraphPackageFeatures,
  GraphSccFeatures,
  GraphPackageEdgeFeature,
  GraphBlastScore,
} from './graph-catalog.js';

// Agent ergonomics — shared filter engine + impact compute (ADR-0085).
export {
  applyAgentFilters,
  buildAgentFilteredResult,
  normalizeAgentRunFilters,
  agentRunFlagSpecs,
  AgentFilterParseError,
} from './agent-filters.js';
export type { AgentFilteredResult } from './agent-filters.js';

// Agent command catalog (ADR-0084) — the self-describing entry-point surface
// the host `agent-catalog` command renders and `@opensip-cli/mcp` serves.
export { buildAgentCatalog } from './agent-catalog.js';
export type { AgentCatalog, CommandTier } from './agent-catalog.js';
export { computeImpact } from './graph-impact-compute.js';
export type { ImpactComputation, ImpactFunction, ImpactPackage } from './graph-impact-compute.js';

// SARIF + cloud reporting moved to @opensip-cli/output (audit
// 2026-05-29, contracts split; package renamed reporting→output in Phase 2,
// ADR-0011). The formatter/sink runtime + its types live there; contracts
// no longer re-exports them.

// `CliProgram` (the optional-commander host type) lives in its own module so
// this barrel stays a PURE re-export surface (auto-exempt from
// module-coupling-fan-out); see cli-program.ts for the commander peer-dep notes.
export type { CliProgram } from './cli-program.js';
