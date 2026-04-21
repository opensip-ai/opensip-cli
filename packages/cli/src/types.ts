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
  debug: boolean;
}

/** Options for the `init` subcommand. */
export interface InitOptions {
  cwd: string;
  json: boolean;
  debug: boolean;
}

/** Options for `sim` subcommand. */
export interface ToolOptions {
  cwd: string;
  json: boolean;
  debug: boolean;
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
    checks: Array<{
      checkSlug: string;
      errorCount: number;
      warningCount: number;
      error?: string;
      violations?: Array<{
        severity: 'error' | 'warning';
        message: string;
        file?: string;
        line?: number;
        suggestion?: string;
      }>;
    }>;
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
  checks: Array<{ slug: string; description: string; tags: string[] }>;
  totalCount: number;
}

export interface ListRecipesResult {
  type: 'list-recipes';
  recipes: Array<{ name: string; description: string; checkCount: string }>;
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
}

export interface ExperimentalResult {
  type: 'experimental';
  tool: 'sim';
  cwd: string;
}

export interface PluginResult {
  type: 'plugin';
  action: 'list' | 'install' | 'remove';
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
