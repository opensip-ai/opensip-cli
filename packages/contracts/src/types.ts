// =============================================================================
// CLI OPTIONS TYPES
// =============================================================================

/** Options for the `fit` subcommand (derived from Commander flags). */
export interface FitOptions {
  recipe?: string;
  check?: string;
  /**
   * Tag filters for ad-hoc check selection. Repeatable and/or
   * comma-separated: `--tags a --tags b` and `--tags a,b` both accumulate
   * (the `--tags` OptionSpec declares an array accumulator). Each element
   * may itself be a comma-separated list; consumers flatten + trim.
   */
  tags?: string[];
  list: boolean;
  recipes: boolean;
  json: boolean;
  verbose: boolean;
  reportTo?: string;
  apiKey?: string;
  exclude: string[];
  cwd: string;
  /** Explicit path to opensip-cli.config.yml (overrides package.json pointer and default location). */
  config?: string;
  debug: boolean;
  /** Suppress banner/boxes; show only the pass-fail summary line. */
  quiet?: boolean;
  /** Open the HTML report in the default browser after a successful run. */
  open?: boolean;
  /** Replay a stored fit session by id, or `latest` for the latest fit session. */
  show?: string;
  /** Architecture-gate: save the current run's findings as a baseline. Mutually exclusive with --gate-compare. */
  gateSave?: boolean;
  /** Architecture-gate: compare current findings against a saved baseline; exit 1 if regressions found. Mutually exclusive with --gate-save. */
  gateCompare?: boolean;
  /** Agent filter tokens (repeatable). See agentRunFlagSpecs / applyAgentFilters (ADR-0085). */
  filter?: string[];
  /** Limit returned signals (sugar for --filter top:<n>). */
  top?: string;
  /** Emit unwrapped agent-filtered payload (no CommandOutcome wrapper). */
  raw?: boolean;
  /** Run only checks whose targets intersect git-changed files (ADR-0085). */
  changed?: boolean;
  /** Git ref base for --changed (diff <since>...HEAD). */
  since?: string;
  /** Expand changed set with graph-impacted files (requires catalog on scope). */
  includeImpacted?: boolean;
}

/** Options for the `init` subcommand. */
export interface InitOptions {
  cwd: string;
  json: boolean;
  debug: boolean;
  /**
   * Language list. Repeatable and/or comma-separated: `--language ts
   * --language rust` and `--language ts,rust` both accumulate (the
   * `--language` OptionSpec declares an array accumulator). When omitted,
   * init detects the project's primary language(s) by inspecting filesystem
   * markers (Cargo.toml, pyproject.toml, etc.) and exits 2 with a prompt if
   * the result is ambiguous.
   */
  language?: string[];
  /**
   * Re-scaffold example files. Preserve any custom files in
   * `opensip-cli/`. Mutually exclusive with `remove`.
   */
  keep?: boolean;
  /**
   * Delete `opensip-cli/` entirely, then scaffold fresh. Mutually
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
  /** Replay a stored tool session by id, or `latest` for the latest session for this tool. */
  show?: string;
}
