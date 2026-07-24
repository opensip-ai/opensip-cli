import type { RuntimeAdoptionResult } from './runtime-results.js';

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

/** One uninstalled first-party adapter recommended after a pristine init. */
export interface InitOptionalToolRecommendation {
  readonly id: string;
  readonly pkg: string;
  readonly network: 'local-only' | 'networked';
  readonly languages: readonly string[];
  readonly installCommand: string;
  readonly projectInstallCommand: string;
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
   * Bounded, path-neutral outcome from Init's runtime-adoption coordinator.
   * Absent when Init refuses before runtime adoption starts or when reading a
   * result produced by an older CLI.
   *
   * Authored mutation counts live at `runtimeAdoption.authored`; they are not
   * duplicated on InitResult.
   */
  runtimeAdoption?: RuntimeAdoptionResult;
  /** Relevant uninstalled adapters after an eligible pristine init; absent otherwise. */
  optionalTools?: readonly InitOptionalToolRecommendation[];
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
    /**
     * The OBSERVED working-dir state at refusal time. `'pristine'` appears for
     * argument-validation refusals (e.g. `--keep --remove`) on an untouched
     * directory — the state is reported truthfully, never fabricated.
     */
    readonly state: 'pristine' | 'partial-config-only' | 'partial-dir-only' | 'fully-initialized';
    readonly preExistingFiles: readonly PreExistingFile[];
    readonly message: string;
  };
  /**
   * Set when customer-authored Init state changed between classification and
   * the transaction's exact preimage snapshot. No journal or customer
   * mutation exists yet; retrying performs a new classification and plan.
   */
  authoredStateChangedError?: {
    readonly observedState: NonNullable<InitResult['state']>;
    readonly message: string;
  };
  /**
   * When language resolution fails (no markers, unknown/empty
   * `--language`, missing cwd, …), init exits without writing and
   * surfaces this structured error. Polyglot marker sets are NOT an
   * error — every detected language is accepted in canonical order.
   */
  languageResolutionError?: {
    detected: readonly string[];
    message: string;
  };
}

export interface SimNoticeResult {
  type: 'sim-notice';
  tool: 'sim';
  cwd: string;
}
