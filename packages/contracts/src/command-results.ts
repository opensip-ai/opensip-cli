// @fitness-ignore-file file-length-limit -- one cohesive contract surface: the CommandResult discriminated union plus every per-command variant interface, each member carrying load-bearing JSDoc. Splitting the union across files would fragment the single type the host renders/dispatches. Sits just past the 400-line soft limit (and only shrank under ADR-0035, which removed the per-tool exit-flag field).
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

import type { RunPresentation } from './run-presentation.js';
import type { StoredSession } from './session-types.js';
import type { SignalEnvelope } from './signal-envelope.js';
import type { ToolProvenance } from '@opensip-cli/core';

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
  | ListChecksResult
  | ListRecipesResult
  | HistoryResult
  | ReportResult
  | InitResult
  | SimNoticeResult
  | PluginResult
  | ClearDoneResult
  | ConfigureDoneResult
  | UninstallDoneResult
  | TextLinesResult
  | ToolsListResult
  | ToolsValidateResult
  | ToolsInstallResult
  | ToolsUninstallResult
  | ToolsDataPurgeResult
  | SessionReplayResult
  | HelpResult
  | ErrorResult;

/** Outcome of an `opensip uninstall` run. */
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

/** Outcome of an `opensip configure` interactive run. */
export interface ConfigureDoneResult {
  type: 'configure-done';
  /** Where the global config landed on disk. */
  configPath: string;
  /** Discriminator: did the user supply a key, or bail at the prompt? */
  action: 'saved' | 'cancelled';
  /** When `action === 'saved'`, the masked-for-display key (`abcd…wxyz`). */
  maskedKey?: string;
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

/**
 * Generic human-readable line carrier for extension commands that do not need a
 * bespoke first-party view. This keeps `command-result` usable without adding a
 * new closed union member for every simple command shape.
 */
export interface TextLinesResult {
  type: 'text-lines';
  /** Optional heading rendered above the lines. */
  readonly title?: string;
  /** Pre-composed display lines, one string per line. */
  readonly lines: readonly string[];
}

/** One row of the `tools list` effective-tool inventory (ADR-0041). */
export interface ToolsListRow {
  /** The tool's stable id (from its manifest; package name when unreadable). */
  readonly id: string;
  /** npm package name, when the tool is a package install. */
  readonly packageName?: string;
  readonly version: string;
  /** Where the tool comes from, in the user-facing vocabulary. */
  readonly source: 'bundled' | 'global' | 'project';
  /** Command names the manifest declares (names only — no runtime is loaded). */
  readonly commands: readonly string[];
  /**
   * `loaded` — admitted by THIS run's bootstrap; `manifest-only` — present on
   * disk (marker + manifest file read) but not loaded this run. `tools list`
   * never dynamic-imports a runtime, so this is as much as a listing can know.
   */
  readonly status: 'loaded' | 'manifest-only';
  /** True on a GLOBAL row whose tool id is shadowed by a project-local install. */
  readonly shadowed?: boolean;
}

/** Outcome of `opensip tools list` (ADR-0041). */
export interface ToolsListResult {
  type: 'tools-list';
  tools: readonly ToolsListRow[];
  totalCount: number;
}

/** One `tools validate` report section (ADR-0041 / ADR-0042 Tier A). */
export interface ToolsValidateSection {
  readonly name: string;
  /**
   * `skipped` = the section could not run AND that is expected (in-place path
   * validation without `--install-deps`); it still makes the overall verdict
   * `incomplete`, never `passed` — an unverified runtime is not a pass.
   */
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly diagnostics: readonly string[];
}

/** Outcome of `opensip tools validate <spec>` (ADR-0041). */
export interface ToolsValidateResult {
  type: 'tools-validate';
  readonly spec: string;
  readonly toolId?: string;
  readonly verdict: 'passed' | 'failed' | 'incomplete';
  readonly sections: readonly ToolsValidateSection[];
}

/** Outcome of `opensip tools install <spec>` (ADR-0041): stage → validate → activate. */
export interface ToolsInstallResult {
  type: 'tools-install';
  readonly spec: string;
  readonly success: boolean;
  /** The requested install scope. */
  readonly scope: 'global' | 'project';
  /** The full validation report the activation decision was made on. */
  readonly validation: ToolsValidateResult;
  readonly toolId?: string;
  readonly version?: string;
  /** Activation-step failure detail (validation failures live in `validation`). */
  readonly error?: string;
}

/** Outcome of `opensip tools data-purge <tool-id>` (ADR-0042): per-tool row counts. */
export interface ToolsDataPurgeResult {
  type: 'tools-data-purge';
  readonly toolId: string;
  readonly sessions: number;
  readonly baselineEntries: number;
  /** Whether a baseline existence marker was removed. */
  readonly baselineMeta: boolean;
  readonly stateRows: number;
}

/** Outcome of `opensip tools uninstall <name-or-id>` (ADR-0041). */
export interface ToolsUninstallResult {
  type: 'tools-uninstall';
  /** The id-or-package-name argument as given. */
  readonly target: string;
  readonly success: boolean;
  /** The resolved identity that was removed (displayed before deletion). */
  readonly removed?: {
    readonly id: string;
    readonly packageName: string;
    readonly scope: 'global' | 'project';
  };
  readonly error?: string;
}

export interface ListChecksResult {
  type: 'list-checks';
  checks: { slug: string; description: string; tags: string[] }[];
  totalCount: number;
  /**
   * Optional heading for the rendered list (tool-command-surface-taxonomy Task
   * 3.4). Lets a non-fitness producer reuse the shared `list-checks` shape +
   * `viewListChecks` renderer with an accurate title (e.g. `graph list` →
   * "Available Graph Rules"). Omitted ⇒ the renderer's default
   * "Available Fitness Checks" (the fit-list surface is unchanged).
   */
  title?: string;
}

export interface ListRecipesResult {
  type: 'list-recipes';
  recipes: { name: string; description: string; checkCount: string }[];
}

export interface HistorySession extends StoredSession {
  readonly summary?: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly showCommand: string;
}

export interface HistoryResult {
  type: 'history';
  sessions: HistorySession[];
}

export interface ReportResult {
  type: 'report';
  path: string;
  opened: boolean;
}

/** Classification for a file present under `opensip-cli/` before init ran. */
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
  /** True when init appended `opensip-cli/.runtime/` to .gitignore. */
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

export interface SimNoticeResult {
  type: 'sim-notice';
  tool: 'sim';
  cwd: string;
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
 * `CommandResult` (`'run-presentation'`, `'list-checks'`, …).
 * Consumers switch on `result.type` directly; producer/consumer drift
 * surfaces at compile time.
 */
export type PluginResult =
  | {
      type: 'plugin-list';
      /**
       * Ordered plugin domains to render, sourced from registered tool
       * `pluginLayout` descriptors plus the built-in Tool plugin domain.
       */
      domains: readonly string[];
      plugins: readonly PluginInfo[];
      totalCount: number;
      /**
       * Provenance of the tools admitted through the launch compatibility
       * gate this run (source + identity + `manifestHash`). Additive — a
       * parallel section to the discovered-plugin list, sourced from the
       * per-run provenance holder, not from a disk re-scan. Empty array
       * when no bootstrap ran (e.g. isolated unit tests).
       */
      toolProvenance: readonly ToolProvenance[];
    }
  | { type: 'plugin-add'; packageName: string; success: boolean; error?: string }
  | { type: 'plugin-remove'; packageName: string; success: boolean; error?: string }
  | {
      type: 'plugin-sync';
      synced: readonly SyncEntry[];
      success: boolean;
      errors?: readonly string[];
    };

/**
 * Outcome of `sessions show <ref>` (and the `--show` shorthand on fit/graph/sim)
 * on the non-`--json` path. Unlike a live run, a replay is uniform across tools:
 * it carries the projected {@link SignalEnvelope} (ADR-0011) + display metadata,
 * and `resultToView` renders it through the SAME shared envelope→table view every
 * tool's live results use — so a replayed graph session finally shows a table,
 * and none of them show the live-run "Use --verbose / report" footer (which is
 * guidance for a fresh run, not a replay).
 */
export interface SessionReplayResult {
  type: 'session-replay';
  readonly session: {
    readonly id: string;
    readonly tool: string;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly recipe?: string;
    readonly score: number;
    readonly passed: boolean;
    readonly durationMs: number;
  };
  /** The projected run envelope — rendered via the shared per-unit table. */
  readonly envelope: SignalEnvelope;
  /** Replay fidelity, e.g. `'projection'` (rebuilt from persisted findings). */
  readonly fidelity: string;
}

export interface HelpResult {
  type: 'help';
}

export interface ErrorResult {
  type: 'error';
  message: string;
  suggestion?: string;
  exitCode: number;
}
