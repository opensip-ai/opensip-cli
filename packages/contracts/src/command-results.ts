/**
 * CommandResult — the discriminated union of every command outcome, plus its
 * per-command variant interfaces.
 *
 * Extracted from `types.ts` so that file stays focused on CLI option / output
 * shapes and neither grows past the file-length limit. This module depends on
 * `session-types.ts` for `StoredSession` and `signal-envelope.ts` for the
 * `SignalEnvelope` every migrated tool returns; `types.ts` does NOT import
 * back, so there is no cycle. Re-exported from the package barrel
 * (`index.ts`), so consumers still import these from `@opensip-tools/contracts`.
 */

import type { StoredSession } from './session-types.js';
import type { SignalEnvelope } from './signal-envelope.js';

// --- Verbose detail currency (ADR-0021) -------------------------------------
//
// `--verbose` is an output-currency concern, not a per-tool live-runner concern.
// A tool's verbose "detail body" is carried as renderer-agnostic data on its
// *DoneResult and rendered ONCE by the cli `resultToView` seam, so it is
// identical in a TTY and a pipe. The body is a typed union so tools that have
// line-oriented detail (graph's catalog/findings/entry-point dump) and tools
// with per-finding detail (fit/sim, coloured by severity) share one carrier
// without flattening one into the other.

/** One displayed finding inside a verbose findings group. Display fields only —
 *  no core `Signal` type leaks into contracts. */
export interface FindingLine {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Source location for display, e.g. `"path/to/file.ts:42"`. */
  readonly location?: string;
  readonly suggestion?: string;
}

/** A verbose findings block — one per unit (check / scenario) that emitted ≥1
 *  finding, or that errored. */
export interface FindingGroup {
  /** Display name (pretty), falling back to the unit slug. */
  readonly title: string;
  /** Set when the unit itself errored (vs. emitted findings). */
  readonly error?: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly findings: readonly FindingLine[];
}

/** Renderer-agnostic verbose detail body carried on a migrated `*DoneResult`.
 *  `resultToView` switches on `kind`: `lines` → verbatim text; `findings` → the
 *  coloured findings block (rendered identically in Ink and plain text). */
export type VerboseDetail =
  | { readonly kind: 'lines'; readonly lines: readonly string[] }
  | { readonly kind: 'findings'; readonly groups: readonly FindingGroup[] };

/** Union type for all command results — App.tsx dispatches on result.type */
export type CommandResult =
  | FitDoneResult
  | SimDoneResult
  | GraphDoneResult
  | GateDoneResult
  | GraphStatusResult
  | ListChecksResult
  | ListRecipesResult
  | HistoryResult
  | DashboardResult
  | InitResult
  | ExperimentalResult
  | PluginResult
  | ClearDoneResult
  | ConfigureDoneResult
  | UninstallDoneResult
  | HelpResult
  | ErrorResult;

/** Outcome of an `opensip-tools uninstall` run. */
export interface UninstallDoneResult {
  type: 'uninstall-done';
  /** Discriminator on the dispatch the run took. */
  action: 'removed' | 'dry-run' | 'cancelled' | 'empty';
  /** 'user' (default) or 'project' (`--project [path]`). */
  mode: 'user' | 'project';
  /** Targets considered for removal. Empty when `action === 'empty'`. */
  targets: readonly { readonly path: string; readonly kind: 'file' | 'dir' }[];
  /** Total bytes the targets occupied on disk (0 when nothing was found). */
  sizeBytes: number;
  /** Resolved root that was probed (user-level dir or project dir). */
  rootPath: string;
}

export interface ClearDoneResult {
  type: 'clear-done';
  action: 'done' | 'cancelled' | 'empty';
  deletedCount: number;
  sessionCount: number;
}

/** Outcome of an `opensip-tools configure` interactive run. */
export interface ConfigureDoneResult {
  type: 'configure-done';
  /** Where the global config landed on disk. */
  configPath: string;
  /** Discriminator: did the user supply a key, or bail at the prompt? */
  action: 'saved' | 'cancelled';
  /** When `action === 'saved'`, the masked-for-display key (`abcd…wxyz`). */
  maskedKey?: string;
}

export interface FitDoneResult {
  type: 'fit-done';
  label: string;
  cwd: string;
  /**
   * The run's signal envelope (ADR-0011). REQUIRED since Phase 6 (fitness is
   * migrated): the composition root derives the terminal table (one row per
   * check `unit`, grouped by `signal.source === checkSlug`) and the
   * `--json`/cloud/`--report-to` paths FROM this envelope. The fitness-only
   * `Validated`/`Ignores` columns ride on `envelope.units` as
   * `filesValidated`/`itemType`/`ignoredCount`.
   */
  envelope: SignalEnvelope;
  reportStatus?: {
    url: string;
    findingCount: number;
    runCount: number;
    success: boolean;
    error?: string;
    chunksTotal?: number;
    chunksSucceeded?: number;
  };
  /** Whether the run should cause a non-zero exit code (based on failOnErrors/failOnWarnings config) */
  shouldFail?: boolean;
  /** Whether an opensip-tools.config.yml was found in the target directory */
  configFound?: boolean;
  /**
   * Verbose detail body (ADR-0021), present only on `--verbose`/`--findings`
   * runs. Rendered by the shared `resultToView` seam so the detail is identical
   * in a TTY and a pipe. Fit populates the `findings` kind.
   */
  readonly verboseDetail?: VerboseDetail;
  /**
   * User-facing non-fatal warnings collected during the run (plugin load
   * failures, unknown languages in config, missing check packages, etc.).
   *
   * These flow through the result rather than direct stderr writes because
   * the live-view renderer (Ink) owns the screen and any ambient stderr
   * write during render desyncs Ink's cursor tracking. Renderers display
   * these in the summary; non-Ink paths (--json, gate modes) surface them
   * at their own boundary.
   */
  warnings?: readonly string[];
}

/**
 * Outcome of a `graph <scope>` run on the non-`--json` path. Carries only
 * plain data (no graph types — contracts sits below graph) so `resultToView`
 * can express it as a view-model the render seam emits as Ink or plain text.
 */
export interface GraphDoneResult {
  type: 'graph-done';
  /** Fast-tier approximation caveat, or `undefined` for an exact catalog. */
  readonly resolutionBanner?: string;
  /** Counts for the shared one-line PASS/FAIL summary. */
  readonly summary: { readonly passed: number; readonly failed: number; readonly errors: number; readonly warnings: number };
  readonly durationMs: number;
  /**
   * Verbose detail body (ADR-0021). Graph populates the `lines` kind (its
   * catalog / findings-by-rule / entry-point dump). Rendered by the shared
   * `resultToView` seam; the non-verbose footer hints are emitted by the seam
   * too (the old per-result `reportLines`/`footerHints` were retired here).
   */
  readonly verboseDetail?: VerboseDetail;
}

/**
 * Outcome of a `fit --gate-save` / `fit --gate-compare` run on the
 * non-`--json` path. Carries the already-composed lines so the render seam
 * emits them as Ink or plain text. Exit code (degraded → 1) set by the caller.
 */
export interface GateDoneResult {
  type: 'gate-done';
  /** Full gate output, one string per line (save summary or compare report). */
  readonly lines: readonly string[];
}

/**
 * Generic carrier for graph's line-oriented mode output that has no Ink
 * component twin: `graph-lookup`, `--workspace`, and the `--report-to` status
 * line. Carries pre-composed plain lines (no graph types — contracts sits
 * below graph) so the render seam emits them as Ink or plain text instead of
 * the command writing to stdout directly. The `--json` paths for these
 * commands are unaffected and still write their machine output at their own
 * boundary.
 */
export interface GraphStatusResult {
  type: 'graph-status';
  /** Pre-composed report lines, one string per line. */
  readonly lines: readonly string[];
}

export interface ListChecksResult {
  type: 'list-checks';
  checks: { slug: string; description: string; tags: string[] }[];
  totalCount: number;
}

export interface ListRecipesResult {
  type: 'list-recipes';
  recipes: { name: string; description: string; checkCount: string }[];
}

export interface HistoryResult {
  type: 'history';
  sessions: StoredSession[];
}

export interface DashboardResult {
  type: 'dashboard';
  path: string;
  opened: boolean;
}

/** Classification for a file present under `opensip-tools/` before init ran. */
export interface PreExistingFile {
  readonly path: string;
  readonly classification: 'scaffolded' | 'custom' | 'stale-scaffolded';
}

export interface InitResult {
  type: 'init';
  created: boolean;
  path: string;
  cwd: string;
  configFilename: string;
  /**
   * Set when init refused because the user invoked it from inside an
   * existing project without an explicit --cwd flag. Carries the
   * discovered root path and the rendered message — the message is
   * computed in init.ts so --json consumers get the same string the
   * human-readable renderer prints.
   */
  insideExistingProject?: {
    readonly discoveredRoot: string;
    readonly message: string;
  };
  /**
   * The state of the working directory at init time. Useful for
   * `--json` consumers and for the rendered output to show what
   * happened. Absent when init bailed before classification (cwd
   * missing, language unresolvable, mutex flag error).
   */
  state?: 'pristine' | 'fully-initialized' | 'partial-config-only' | 'partial-dir-only';
  /** Languages selected for this scaffold (post-detection or from --language). */
  languages?: readonly ('typescript' | 'rust' | 'python' | 'go' | 'java' | 'cpp')[];
  /**
   * Every file init created, in display order. Includes the config
   * file plus example check / recipe / scenario scaffolds. Empty
   * when init refused to write anything.
   */
  createdFiles?: readonly string[];
  /** True when init appended `opensip-tools/.runtime/` to .gitignore. */
  gitignoreUpdated?: boolean;
  /**
   * Files that existed before init ran, classified. Empty (or absent)
   * in state 'pristine'. Populated for the other states so the user
   * can see what survived (`--keep`) or was removed (`--remove`).
   */
  preExistingFiles?: readonly PreExistingFile[];
  /**
   * When init refuses due to partial state (or fully-initialized state)
   * and no flag was passed, surfaces what's there + a flag hint. Set
   * together with `created: false`.
   */
  partialStateError?: {
    readonly state: 'partial-config-only' | 'partial-dir-only' | 'fully-initialized';
    readonly preExistingFiles: readonly PreExistingFile[];
    readonly message: string;
  };
  /**
   * When detection is ambiguous and --language wasn't passed, init
   * exits without writing anything and surfaces this error so the
   * user can re-invoke with --language <list>.
   */
  ambiguousLanguageError?: {
    detected: readonly string[];
    message: string;
  };
}

export interface ExperimentalResult {
  type: 'experimental';
  tool: 'sim';
  cwd: string;
}

/** Outcome of a `sim --recipe <name>` run. */
export interface SimDoneResult {
  type: 'sim-done';
  recipeName: string;
  cwd: string;
  durationMs: number;
  /** Whether the run should cause a non-zero exit code (any scenario failed). */
  shouldFail?: boolean;
  /**
   * The run's signal envelope (ADR-0011). REQUIRED since Phase 4 (sim is
   * migrated): the composition root derives the terminal table (one row per
   * scenario `unit`, grouped by `signal.source === scenarioId`) and the
   * `--json`/cloud/`--report-to` paths FROM this envelope. The per-scenario
   * pass/fail summary is recovered from `envelope.units`, so no scenario
   * summary fields are duplicated on the result.
   */
  envelope: SignalEnvelope;
  /**
   * Verbose detail body (ADR-0021), present only on `--verbose` runs. Rendered
   * by the shared `resultToView` seam. Sim populates the `findings` kind
   * (per-scenario detail).
   */
  readonly verboseDetail?: VerboseDetail;
}

/**
 * Identity of a discovered plugin (exposed by `plugin list`).
 * Mirrors the `DiscoveredPlugin` shape from core, but kept here as a
 * separate contract type so the CLI ↔ plugin-result boundary is
 * stable independently of core's internal representation.
 */
export interface PluginInfo {
  readonly domain: string;
  readonly namespace: string;
  readonly pluginType: 'package' | 'file';
}

/**
 * Per-package status from `plugin sync`. `installed: true` means the
 * `npm install` succeeded; `false` means it failed (the message is
 * carried in the surrounding `errors[]`).
 */
export interface SyncEntry {
  readonly domain: string;
  readonly package: string;
  readonly installed: boolean;
}

/**
 * Discriminated union — one variant per `plugin` subcommand. Each
 * variant has its own top-level `type` literal, matching the rest of
 * `CommandResult` (`'fit-done'`, `'sim-done'`, `'list-checks'`, …).
 * Consumers switch on `result.type` directly; producer/consumer drift
 * surfaces at compile time.
 */
export type PluginResult =
  | { type: 'plugin-list'; plugins: readonly PluginInfo[]; totalCount: number }
  | { type: 'plugin-add'; packageName: string; success: boolean; error?: string }
  | { type: 'plugin-remove'; packageName: string; success: boolean; error?: string }
  | {
      type: 'plugin-sync';
      synced: readonly SyncEntry[];
      success: boolean;
      errors?: readonly string[];
    };

export interface HelpResult {
  type: 'help';
}

export interface ErrorResult {
  type: 'error';
  message: string;
  suggestion?: string;
  exitCode: number;
}
