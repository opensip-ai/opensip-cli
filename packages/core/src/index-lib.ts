// Lib — errors + Result pattern
export {
  ToolError,
  ValidationError,
  NotFoundError,
  SystemError,
  TimeoutError,
  NetworkError,
  ConfigurationError,
  PluginIncompatibleError,
  UnknownCapabilityDomainError,
  CapabilitySchemaMismatchError,
} from './lib/errors.js';
export { ok, err, tryCatchAsync, tryCatch } from './lib/errors.js';
export { canonicalToolErrorCode, toolErrorFromCanonicalCode } from './lib/errors.js';
export type { Result, ToolErrorCode, ToolErrorOptions } from './lib/errors.js';

// Lib — logger.
//
// Production callers should import the typed `logger` singleton +
// helper functions; `LoggerImpl` is exported for tests (and tools
// that need an isolated logger) — advanced / discouraged for
// general use, see the file-level docstring on lib/logger.ts.
// `getRunId()` free function was removed in Item 2 — read
// `currentScope()?.runId` instead. The instance methods
// `LoggerImpl.{get,set}RunId` survive for isolated-instance test use.
export { logger, LoggerImpl, configureLogger, createRunLogger } from './lib/logger.js';
export type { Logger, LogLevel, LoggerOptions, RunIdProvider } from './lib/logger.js';
export { createToolLogger } from './lib/create-tool-logger.js';

// Lib — telemetry (tracing). The kernel sibling of `logger`: a thin seam over
// the OpenTelemetry *API* (`@opentelemetry/api`) only. No-op until an SDK
// registers a global provider at the application boundary (the CLI). Tools emit
// spans via `withSpan` and reach span types through this barrel so they never
// import `@opentelemetry/api` directly — the kernel is the single seam.
export {
  getTracer,
  withSpan,
  withSpanAsync,
  currentTraceparent,
  getMeter,
} from './lib/telemetry.js';
export type { Span, Attributes, Tracer } from '@opentelemetry/api';

// Lib — environment registry (north-star §5.12, launch). The kernel
// observability primitive that governs the env surface: a tool/host declares an
// `EnvVarSpec` (canonical name, aliases, coercion, default, docs, deprecation) and
// every env read flows through `EnvRegistry.get`. Reading `process.env` inside
// this primitive is the one sanctioned site; the `env-via-registry` guardrail
// fails CI on raw reads elsewhere. The immutable definition table lets a static
// instance serve the pre-scope readers (theme, graph heap-preflight).
export { EnvRegistry } from './lib/env-registry.js';
export type { EnvVarSpec, EnvDeprecation, EnvReadResult } from './lib/env-registry.js';

// Lib — run correlation (subprocess-correlation telemetry spec). The PURE
// correlation primitive: the `RunCorrelation` field set, the canonical
// `OPENSIP_*` env names + their docs as the frozen `CORRELATION_ENV_SPECS`
// table (the single source of truth the CLI host spreads into its env surface),
// the settled OTel attr constants, and the `correlationToEnv`/`correlationFromEnv`
// codec. Pure leaf — no `@opensip-cli/config` import (core stays a kernel); the
// cloud-aware assembly happens at the bootstrap composition root.
export {
  correlationToEnv,
  correlationFromEnv,
  liveEngineCorrelation,
  CORRELATION_ENV_SPECS,
  CORRELATION_ENV,
  REPO_OTEL_ATTR,
  TENANT_OTEL_ATTR,
} from './lib/run-correlation.js';
export type { RunCorrelation } from './lib/run-correlation.js';

// Lib — run diagnostics (north-star §5.10, launch). The shared,
// JSON-emittable diagnostics vocabulary carried on a `CommandOutcome`, produced
// by the scope-owned `DiagnosticsBus`. Types DEFINED here (the bus that produces
// them is here; contracts re-exports the types for `CommandOutcome`).
export { DiagnosticsBus } from './lib/diagnostics-bus.js';
export type {
  RunDiagnostics,
  DiagnosticEvent,
  DiagnosticPhase,
  DiagnosticLevel,
} from './lib/run-diagnostics.js';

// Lib — CLI diagnostics (ADR-0060, Phase 2). Typed bootstrap/setup substrate
// buffered by the scope-owned collector and classified before host rendering.
// Types DEFINED here; re-exported by @opensip-cli/contracts for CommandOutcome.
export {
  CLI_DIAGNOSTIC_CODES,
  formatCliDiagnosticHuman,
  withLogRef,
} from './lib/cli-diagnostic.js';
export type {
  CliDiagnostic,
  CliDiagnosticCategory,
  CliDiagnosticCode,
  CliDiagnosticProvenance,
  CliDiagnosticSeverity,
} from './lib/cli-diagnostic.js';
export {
  BootstrapDiagnosticsCollector,
  isRelevantDiagnostic,
} from './lib/bootstrap-diagnostics.js';
export {
  classifyIntegrityFailure,
  classifyModuleError,
  detectIntegrityFailure,
  scrubModuleNotFoundMessage,
  scrubModuleNotFoundPath,
} from './lib/diagnostic-classifier.js';
export type { IntegrityFailureInput } from './lib/diagnostic-classifier.js';
export {
  capabilityDiscoveryToCliDiagnostic,
  fitnessEmptyCheckRegistryDiagnostic,
  fitnessPluginLoadFailedDiagnostic,
} from './lib/capability-diagnostic.js';

// Lib — permissive YAML reader (returns undefined on missing/malformed
// files). Used by plugin-discovery sites that need to peek at a single
// field of opensip-cli.config.yml without dragging in a Zod schema.
// Advanced / discouraged for general use — tools that need structured
// parse errors should use `readYamlFileOrThrow` instead, or build their
// own dedicated loader (see fitness's targets/loader.ts for a
// schema-validating example).
export { readYamlFile, readYamlFileOrThrow } from './lib/yaml.js';
export type { ReadYamlFileOrThrowOptions } from './lib/yaml.js';

// Lib — shallow JSON-value guards shared by config/projector code paths.
export { isPlainRecord } from './lib/json-guards.js';
export { projectJsonScalarMetadata } from './lib/json-scalars.js';
export type { JsonScalar } from './lib/json-scalars.js';

// Lib — IDs
export { generateId, generatePrefixedId, extractTimestamp, generateUUID } from './lib/ids.js';

// Lib — payload version extraction (inner __version convention for
// tool-owned opaque session payloads and toolState). Pure function with
// no knowledge of any tool payload shape. Used by decode/hydrate/replay
// paths and by tools for their own state versioning.
export { extractPayloadVersion } from './lib/payload-version.js';

// Lib — retry
export { withRetry } from './lib/retry.js';
export type { RetryOptions } from './lib/retry.js';

// Lib — file lock (state concurrency, ADR-0075). Generic lockfile primitive for
// datastore-file and artifact-file write serialization.
export { withFileLock, withFileLockAsync } from './lib/file-lock.js';
export type {
  FileLockEvent,
  FileLockEventKind,
  FileLockMetadata,
  StateLockPolicy,
  WithFileLockOptions,
} from './lib/file-lock.js';

// Lib — execution substrate (north-star §5.8, launch). One bounded
// scheduler + per-unit timeout/retry that fit + sim recipes run on, so
// timeout/maxParallel/stopOnFirstFailure mean the same thing in every domain
// (and a declared `timeout` actually aborts — the §4.3 sim fix). Plus the shared
// `deriveRecipeId` (one `<prefix>_<name>` scheme across domains).
export {
  scheduleUnits,
  yieldToEventLoop,
  runWithTimeout,
  runWithRetry,
  executePipeline,
} from './lib/execution/index.js';
export type {
  ScheduleUnitsOptions,
  UnitRunOutcome,
  RunWithTimeoutOptions,
  PipelineRetryOptions,
  PipelineRetryOutcome,
  ExecutePipelineOptions,
  WorkflowExecutionOptions,
  WorkflowRetryOptions,
} from './lib/execution/index.js';
export { deriveRecipeId } from './lib/recipe-id.js';

// Lib — package-version reader (used by first-party Tools to set
// metadata.version without duplicating the literal in source).
export { readPackageVersion } from './lib/package-version.js';

// Lib — shared presentation formatters (duration, …) used by more than one
// tool's CLI/report layer; centralized here since tools cannot depend on
// each other.
export { formatDuration } from './lib/format.js';

// Lib — host-owned run timer (host-owned-run-timing). The single
// RunTimer created by the CLI host at the command boundary; exposed to
// tools exclusively via ToolCliContext.runSession.timing (and via the
// optional LiveViewContext second arg to live renderers). Tools must
// not construct their own for StoredSession timing.
export { createRunTimer, createRunLifecycle } from './lib/run-timer.js';
export type { RunTimer, RunLifecycle, RunTimingSnapshot } from './lib/run-timer.js';

// Lib — path resolver (project-local opensip-cli/.runtime, user-level
// ~/.opensip-cli/config.yml). Every consumer constructs paths through
// this module so a layout change is a single-file edit.
export {
  resolveProjectPaths,
  resolveUserPaths,
  isPathInside,
  toPosixRelative,
} from './lib/paths.js';
export type { ProjectPaths, UserPaths, PathDomain } from './lib/paths.js';

// Lib — project-context resolver. One-shot ancestor walk from cwd to
// the nearest opensip-cli.config.yml. Returns a ProjectContext that
// every downstream consumer (CLI bootstrap, tool action handlers,
// uninstall/init/dashboard) reads from instead of re-deriving cwd
// semantics.
export { resolveProjectContext } from './lib/project-context.js';
export type { ProjectContext, ResolveProjectContextInput } from './lib/project-context.js';

// Lib — per-invocation presentation settings (banner size + CLI version)
// read by the render paths off `currentScope()?.ui`. Populated by the CLI
// bootstrap; absent in tests and non-rendering callers.
export type { UiContext } from './lib/ui-context.js';

// Lib — config schemaVersion. Permissive top-level field reader +
// CLI/config compatibility classifier. Used by pre-action-hook for
// upgrade-mismatch detection.
export {
  CLI_SUPPORTED_SCHEMA_VERSION,
  readConfigSchemaVersion,
  checkSchemaCompat,
} from './lib/config-version.js';
export type { SchemaCompat } from './lib/config-version.js';

// Lib — phantom-dir detector. Warns about orphaned opensip-cli/
// subtrees left over from pre-discovery runs. Returns paths; callers
// surface them; never auto-deletes.
export { detectPhantomRuntimes } from './lib/phantom-detect.js';

// Lib — host-owned git changed-file resolver (ADR-0085). Single source of truth
// for `fit --changed` and `graph impact --changed`; tools must not shell out
// independently.
export { resolveChangedFiles } from './lib/git-changed-files.js';
export type { ChangedFilesResult, ChangedFileBasis } from './lib/git-changed-files.js';
