/**
 * CommandResult — the discriminated union of every command outcome, plus its
 * per-command variant interfaces.
 *
 * Extracted from `types.ts` so that file stays focused on CLI option / output
 * shapes and neither grows past the file-length limit. This module depends on
 * `session-types.ts` for `StoredSession` and `signal-envelope.ts` for the
 * `SignalEnvelope` every migrated tool returns; `types.ts` does NOT import
 * back, so there is no cycle. Re-exported from the package barrel
 * (`index.ts`), so consumers still import these from `@opensip-cli/contracts`.
 */

export type {
  UninstallDoneResult,
  UninstallRemovalBuckets,
  UninstallRecoveryStatus,
  ClearDoneResult,
  ConfigureDoneResult,
  GateDoneResult,
  GraphStatusResult,
  TextLinesResult,
} from './command-results-variants/done-results.js';
export type {
  GraphLookupMatch,
  GraphLookupResult,
} from './command-results-variants/graph-results.js';
export type {
  GraphImpactBasis,
  GraphImpactCatalogIdentity,
  GraphImpactResult,
} from './command-results-variants/graph-impact-result.js';
export type {
  ConfigMigrateResult,
  ConfigValidateResult,
  ConfigSchemaResult,
} from './command-results-variants/config-results.js';
export type {
  ToolsListRow,
  ToolsCreateResult,
  ToolsListResult,
  ToolsAvailableRow,
  ToolsAvailableResult,
  ToolsDoctorResult,
  ToolsValidateSection,
  ToolsValidateResult,
  ToolsInstallResult,
  ToolsDataPurgeResult,
  ToolsUninstallResult,
} from './command-results-variants/tools-results.js';
export type {
  SuiteAddResult,
  SuiteListEntry,
  SuiteListResult,
  SuiteListStep,
  SuiteRunResult,
  SuiteRunScope,
  SuiteRunScopeMode,
  SuiteRunScopeSource,
  SuiteStepSummary,
} from './command-results-variants/suite-results.js';
export type { ReviewBrief } from './review-brief.js';
export type {
  ListChecksResult,
  ListRecipesResult,
  HistorySession,
  HistorySuiteGroup,
  HistoryResult,
  ReportResult,
} from './command-results-variants/list-history-results.js';
export type {
  AgentGuidanceResult,
  AgentGuidanceTargetAction,
  AgentGuidanceTargetResult,
  InitOptionalToolRecommendation,
  PreExistingFile,
  InitResult,
  SimNoticeResult,
} from './command-results-variants/init-results.js';
export type {
  PluginInfo,
  SyncEntry,
  PluginResult,
} from './command-results-variants/plugin-results.js';
export type {
  PolicyAuditResult,
  PolicyAuditRow,
  PolicyDecisionOutcome,
  PolicyDecisionSummary,
  PolicyExplainResult,
  PolicyMode,
  PolicyStatusResult,
  PolicyTrustResult,
} from './command-results-variants/policy-results.js';
export type {
  SessionReplayResult,
  HelpResult,
  ErrorResult,
} from './command-results-variants/session-results.js';
export type {
  ParentRunSummary,
  RunDetailResult,
  RunHistoryResult,
  RunSessionFollowUp,
  RuntimeAdoptionReasonCode,
  RuntimeAdoptionResult,
  RuntimeAdoptionState,
  RuntimeAdoptionStatus,
  RuntimeAuthoredMutationSummary,
  RuntimeCacheRetentionPolicy,
  RuntimeCacheLocationProjection,
  RuntimeEvidenceDatabaseProjection,
  RuntimeEvidenceRetentionPolicy,
  RuntimeIdentityStrength,
  RuntimeLeaseActivity,
  RuntimeLocationProjection,
  RuntimeNextCommand,
  RuntimeRecoveryCommand,
  RuntimeRecoveryPhase,
  RuntimeRecoveryReasonCode,
  RuntimeStatusResult,
  RuntimeStoragePlane,
} from './command-results-variants/runtime-results.js';
export type {
  RepairApplyVerifyResult,
  RepairVerificationCommand,
  RepairVerificationCoverage,
  RepairVerificationFailure,
  RepairVerificationFindingMatch,
  RepairVerificationResult,
  RepairVerificationScope,
  RepairVerificationStatus,
} from './command-results-variants/repair-apply-verify-results.js';
export type {
  RepairActionRef,
  RepairApplyResult,
  RepairFileChange,
  RepairPreviewResult,
  RepairRefusal,
  RepairSessionRef,
  RepairSignalRef,
} from './command-results-variants/repair-results.js';

import type {
  ConfigMigrateResult,
  ConfigSchemaResult,
  ConfigValidateResult,
} from './command-results-variants/config-results.js';
import type {
  UninstallDoneResult,
  ClearDoneResult,
  ConfigureDoneResult,
  GateDoneResult,
  GraphStatusResult,
  TextLinesResult,
} from './command-results-variants/done-results.js';
import type { GraphImpactResult } from './command-results-variants/graph-impact-result.js';
import type { GraphLookupResult } from './command-results-variants/graph-results.js';
import type { InitResult, SimNoticeResult } from './command-results-variants/init-results.js';
import type {
  ListChecksResult,
  ListRecipesResult,
  HistoryResult,
  ReportResult,
} from './command-results-variants/list-history-results.js';
import type { PluginResult } from './command-results-variants/plugin-results.js';
import type {
  PolicyAuditResult,
  PolicyExplainResult,
  PolicyStatusResult,
  PolicyTrustResult,
} from './command-results-variants/policy-results.js';
import type { RepairApplyVerifyResult } from './command-results-variants/repair-apply-verify-results.js';
import type {
  RepairApplyResult,
  RepairPreviewResult,
} from './command-results-variants/repair-results.js';
import type {
  RunDetailResult,
  RunHistoryResult,
  RuntimeStatusResult,
} from './command-results-variants/runtime-results.js';
import type {
  SessionReplayResult,
  HelpResult,
  ErrorResult,
} from './command-results-variants/session-results.js';
import type {
  SuiteAddResult,
  SuiteListResult,
  SuiteRunResult,
} from './command-results-variants/suite-results.js';
import type {
  ToolsListResult,
  ToolsAvailableResult,
  ToolsDoctorResult,
  ToolsCreateResult,
  ToolsValidateResult,
  ToolsInstallResult,
  ToolsDataPurgeResult,
  ToolsUninstallResult,
} from './command-results-variants/tools-results.js';
import type { RunPresentation } from './run-presentation.js';

/** Union type for all command results — App.tsx dispatches on result.type */
export type CommandResult =
  // The render-only run-presentation adjunct (envelope-first-presentation plan):
  // the SINGLE run variant. It replaced the three per-tool fit/sim/graph
  // done-result interfaces, hard-removed in RP-3. `resultToView` carries exactly
  // one run case (`run-presentation`); the `architecture-no-run-done-result`
  // fitness check guards against re-introducing a per-tool done-result here.
  | RunPresentation
  | GateDoneResult
  | GraphStatusResult
  | GraphLookupResult
  | GraphImpactResult
  | ConfigValidateResult
  | ConfigSchemaResult
  | ConfigMigrateResult
  | ListChecksResult
  | ListRecipesResult
  | HistoryResult
  | ReportResult
  | InitResult
  | SimNoticeResult
  | PluginResult
  | PolicyStatusResult
  | PolicyExplainResult
  | PolicyAuditResult
  | PolicyTrustResult
  | ClearDoneResult
  | ConfigureDoneResult
  | UninstallDoneResult
  | TextLinesResult
  | ToolsListResult
  | ToolsAvailableResult
  | ToolsDoctorResult
  | ToolsCreateResult
  | ToolsValidateResult
  | ToolsInstallResult
  | ToolsUninstallResult
  | ToolsDataPurgeResult
  | SuiteRunResult
  | SuiteListResult
  | SuiteAddResult
  | RepairPreviewResult
  | RepairApplyResult
  | RepairApplyVerifyResult
  | RuntimeStatusResult
  | RunHistoryResult
  | RunDetailResult
  | SessionReplayResult
  | HelpResult
  | ErrorResult;
