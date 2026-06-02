import type { ToolShortId } from '@opensip-tools/core';

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
  /** Suppress banner/boxes; show only the pass-fail summary line. */
  quiet?: boolean;
  /** Open the HTML dashboard in the default browser after a successful run. */
  open?: boolean;
  /** Architecture-gate: save the current run's findings as a baseline. Mutually exclusive with --gate-compare. */
  gateSave?: boolean;
  /** Architecture-gate: compare current findings against a saved baseline; exit 1 if regressions found. Mutually exclusive with --gate-save. */
  gateCompare?: boolean;
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

// =============================================================================
// OUTPUT TYPES — the structured JSON shape and its parts. Shared by the
// CommandResult variants in `command-results.ts`.
// =============================================================================

/** Structured JSON output format */
export interface CliOutput {
  readonly version: '1.0';
  readonly tool: ToolShortId;
  readonly timestamp: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly summary: { total: number; passed: number; failed: number; errors: number; warnings: number };
  readonly checks: readonly CheckOutput[];
  readonly durationMs: number;
  /**
   * Graph-only: the call-graph resolution tier this run used. `'fast'`
   * means edges are approximate (syntactic, no type checker); absent or
   * `'exact'` means semantic. Surfaced so machine consumers of `graph
   * --json` can branch on edge fidelity. Other tools never set it.
   */
  readonly resolutionMode?: 'exact' | 'fast';
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
