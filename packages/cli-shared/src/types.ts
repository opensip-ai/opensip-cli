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
  /** Path to the baseline file used by --gate-save / --gate-compare. Default: .opensip-tools/baseline.sarif */
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
   * Overwrite an existing opensip-tools.config.yml or example files
   * without prompting. Default false — the safe behavior is to refuse
   * overwriting.
   */
  force: boolean;
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
  readonly tool: 'fit' | 'sim';
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
  | HelpResult
  | ErrorResult;

export interface ClearDoneResult {
  type: 'clear-done';
  action: 'done' | 'cancelled' | 'empty';
  deletedCount: number;
  sessionCount: number;
}

export interface FitDoneResult {
  type: 'fit-done';
  rows: TableRow[];
  summary: SummaryOptions;
  label: string;
  cwd: string;
  findings?: {
    checks: {
      checkSlug: string;
      errorCount: number;
      warningCount: number;
      error?: string;
      violations?: {
        severity: 'error' | 'warning';
        message: string;
        file?: string;
        line?: number;
        suggestion?: string;
      }[];
    }[];
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

export interface InitResult {
  type: 'init';
  created: boolean;
  path: string;
  alreadyExists: boolean;
  cwd: string;
  configFilename: string;
  /** Languages selected for this scaffold (post-detection or from --language). */
  languages?: readonly ('typescript' | 'rust' | 'python' | 'go' | 'java' | 'cpp')[];
  /**
   * Every file v3 init created, in display order. Includes the
   * config file plus example check / recipe / scenario scaffolds.
   * Empty when alreadyExists is true (nothing was written).
   */
  createdFiles?: readonly string[];
  /** True when init appended `opensip-tools/.runtime/` to .gitignore. */
  gitignoreUpdated?: boolean;
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

export interface PluginResult {
  type: 'plugin';
  action: 'list' | 'install' | 'remove' | 'sync' | 'add';
  [key: string]: unknown;
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
