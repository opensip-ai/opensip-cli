import type { StoredSession } from './persistence/store.js';

// =============================================================================
// CLI OPTIONS TYPES
// =============================================================================

/** Options for the `fit` subcommand (derived from Commander flags). */
export interface FitOptions {
  recipe?: string;
  check?: string;
  tags?: string;
  list: boolean;
  recipes: boolean;
  json: boolean;
  verbose: boolean;
  findings: boolean;
  reportTo?: string;
  apiKey?: string;
  exclude: string[];
  cwd: string;
  /** Explicit path to opensip-tools.config.yml (overrides package.json pointer and default location). */
  config?: string;
  debug: boolean;
  /** Architecture-gate: save the current run's findings as a baseline. Mutually exclusive with --gate-compare. */
  gateSave?: boolean;
  /** Architecture-gate: compare current findings against a saved baseline; exit 1 if regressions found. Mutually exclusive with --gate-save. */
  gateCompare?: boolean;
  /** Path to the baseline file used by --gate-save / --gate-compare. Default: opensip-tools/.runtime/baseline.sarif */
  baseline?: string;
}

/** Options for the `init` subcommand. */
export interface InitOptions {
  cwd: string;
  json: boolean;
  debug: boolean;
  /**
   * Comma-separated language list. When omitted, init detects the
   * project's primary language(s) by inspecting filesystem markers
   * (Cargo.toml, pyproject.toml, etc.) and exits 2 with a prompt if
   * the result is ambiguous.
   */
  language?: string;
  /**
   * Re-scaffold example files. Preserve any custom files in
   * `opensip-tools/`. Mutually exclusive with `remove`.
   */
  keep?: boolean;
  /**
   * Delete `opensip-tools/` entirely, then scaffold fresh. Mutually
   * exclusive with `keep`.
   */
  remove?: boolean;
}

/** Options for `sim` subcommand. */
export interface ToolOptions {
  cwd: string;
  json: boolean;
  debug: boolean;
  /** Recipe name to run. Defaults to the built-in `default` if omitted. */
  recipe?: string;
  /** Filter by scenario kind (load / chaos / invariant / fix-evaluation). */
  kind?: string;
}

/**
 * Backwards-compatible alias — commands that previously accepted CliArgs
 * can accept this union instead. The shape covers all fields used by any command.
 *
 * @deprecated Do not extend this interface for new flags. Add new
 * flags to the per-command options interface instead — `FitOptions`
 * for the `fit` subcommand, `ToolOptions` for `sim`, `InitOptions` for
 * `init`. The remaining call sites use `*OptsToCliArgs` adapter
 * functions in fitness/simulation/cli to bridge the two shapes; over
 * time those adapters fold away and the per-command types become the
 * single source of truth. See
 * `docs/architecture/70-surfaces/02-plugin-authoring.md` for the
 * adapter pattern and the rationale.
 */
export interface CliArgs {
  command: string;
  json: boolean;
  check?: string;
  recipe?: string;
  cwd: string;
  help: boolean;
  list: boolean;
  listRecipes: boolean;
  verbose: boolean;
  reportTo?: string;
  apiKey?: string;
  exclude: string[];
  findings: boolean;
  tags?: string;
  /** Suppress banner/boxes; show only the pass-fail summary line. */
  quiet?: boolean;
  /** Open the HTML dashboard in the default browser after a successful run. */
  open?: boolean;
  /** Explicit opensip-tools.config.yml path from --config flag. */
  config?: string;
  /** Architecture-gate flags — see FitOptions for details. */
  gateSave?: boolean;
  gateCompare?: boolean;
  baseline?: string;
  /**
   * Sim-only: filter scenarios by kind.
   * One of 'load' | 'chaos' | 'invariant' | 'fix-evaluation', or undefined for all.
   */
  kind?: string;
}

/** Structured JSON output format */
export interface CliOutput {
  readonly version: '1.0';
  readonly tool: 'fit' | 'sim' | 'graph';
  readonly timestamp: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly summary: { total: number; passed: number; failed: number; errors: number; warnings: number };
  readonly checks: readonly CheckOutput[];
  readonly durationMs: number;
}

export interface CheckOutput {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount?: number;
  readonly findings: readonly FindingOutput[];
  readonly durationMs: number;
  /**
   * Optional check-level error string. Populated when the check itself
   * threw (load error, runtime exception, timeout). Distinct from
   * findings, which describe code-level violations the check detected.
   */
  readonly error?: string;
}

export interface FindingOutput {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
}

export interface TableRow {
  check: string;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  errors: number;
  warnings: number;
  validated: string;
  ignored: number;
  duration: string;
  durationMs: number;
}

export interface SummaryOptions {
  passed: number;
  failed: number;
  totalErrors: number;
  totalWarnings: number;
  totalIgnored: number;
  durationMs: number;
}

// =============================================================================
// CommandResult — union type for all command results
// =============================================================================

/** Union type for all command results — App.tsx dispatches on result.type */
export type CommandResult =
  | FitDoneResult
  | SimDoneResult
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
  rows: TableRow[];
  summary: SummaryOptions;
  label: string;
  cwd: string;
  findings?: {
    checks: readonly CheckOutput[];
  };
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
  /** Optional `--kind` filter (load / chaos / invariant / fix-evaluation). */
  kind?: string;
}

/** Outcome of a `sim --recipe <name>` run. */
export interface SimDoneResult {
  type: 'sim-done';
  recipeName: string;
  cwd: string;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  scenarios: {
    scenarioId: string;
    scenarioName: string;
    kind: 'load' | 'chaos' | 'invariant' | 'fix-evaluation';
    passed: boolean;
    durationMs: number;
    error?: string;
  }[];
  durationMs: number;
  /** Whether the run should cause a non-zero exit code (any scenario failed). */
  shouldFail?: boolean;
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
 * Discriminated union — one variant per `plugin` subcommand. Replaces
 * the previous open-dictionary shape (`{ type: 'plugin'; action: …;
 * [key: string]: unknown }`) so consumers can switch on `action`
 * without `as { … }` casts and producer/consumer drift surfaces at
 * compile time.
 *
 * Two-level discriminator convention (intentional asymmetry with the
 * rest of `CommandResult`): every variant shares `type: 'plugin'` and
 * fans out on a second field, `action: 'list' | 'add' | 'remove' |
 * 'sync'`. Other `CommandResult` variants discriminate on `type` alone
 * (e.g. `'fit-done'`, `'sim-done'`, `'list-checks'`).
 *
 * This is deliberate: the four plugin operations form a tight cluster
 * — they share UI surface (one `PluginFeedback` component), share
 * routing (one `'plugin'` arm in `App.tsx`), and share semantics
 * ("modify or report on the plugin registry"). Lifting them to four
 * top-level variants would multiply switch arms across `App.tsx` and
 * the `CommandResult` consumers without a corresponding gain in
 * clarity. Future tools with a similar tight cluster of subcommands
 * (e.g. `sessions list/purge`) MAY follow this pattern intentionally;
 * tools with loosely-related subcommands SHOULD lift to top-level
 * `type` literals.
 */
export type PluginResult =
  | { type: 'plugin'; action: 'list'; plugins: readonly PluginInfo[]; totalCount: number }
  | { type: 'plugin'; action: 'add'; packageName: string; success: boolean; error?: string }
  | { type: 'plugin'; action: 'remove'; packageName: string; success: boolean; error?: string }
  | {
      type: 'plugin';
      action: 'sync';
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
