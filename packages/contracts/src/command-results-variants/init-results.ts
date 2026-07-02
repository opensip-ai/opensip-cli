/** Classification for a file present under `opensip-cli/` before init ran. */
export interface PreExistingFile {
  readonly path: string;
  readonly classification: 'scaffolded' | 'custom' | 'stale-scaffolded';
}

export type AgentGuidanceTargetAction = 'created' | 'updated' | 'unchanged' | 'skipped';

export interface AgentGuidanceTargetResult {
  readonly path: string;
  readonly action: AgentGuidanceTargetAction;
  readonly reason?: string;
}

export interface AgentGuidanceResult {
  readonly changed: boolean;
  readonly targets: readonly AgentGuidanceTargetResult[];
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
  /**
   * True when init refreshed project guidance / runtime ignores without
   * rewriting config or scaffold examples. Absent means "not a refresh result."
   */
  refreshed?: boolean;
  /** True when init appended `opensip-cli/.runtime/` to .gitignore. */
  gitignoreUpdated?: boolean;
  /** Per-target managed guidance actions for supported agent instruction files. */
  agentGuidance?: AgentGuidanceResult;
  /** True when init created the default agent playbook. Legacy compatibility field. */
  agentsMdCreated?: boolean;
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
