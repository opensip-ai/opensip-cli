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
  /**
   * `--report-to <url>` — POST the run's signals to OpenSIP Cloud or a
   * compatible receiver. sim gained cloud egress when it began emitting the
   * signal envelope (ADR-0011, Phase 4); the composition root's
   * `deliverSignals` owns the actual egress (and exit code 4).
   */
  reportTo?: string;
  /** `--api-key <key>` — auth for `--report-to`. */
  apiKey?: string;
}
