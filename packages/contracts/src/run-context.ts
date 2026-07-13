/** Leaf run-context types shared by persisted runs, suite results, and evidence manifests. */

export type SuiteRunScopeMode = 'changed' | 'full';
export type SuiteRunScopeSource = 'default' | 'explicit' | 'fallback';

export interface SuiteRunScope {
  readonly mode: SuiteRunScopeMode;
  /** Why this mode applies: built-in default, user flag, or no-git fallback. */
  readonly source: SuiteRunScopeSource;
  /** Git ref base when running with --since. */
  readonly ref?: string;
  /** Changed-file count from the host-side resolution (display/brief only). */
  readonly changedFiles?: number;
  /** Human-readable notice, e.g. the no-git fallback explanation. */
  readonly notice?: string;
}

export interface RunStepReference {
  readonly runId: string;
  readonly stepId: string;
  readonly logicalStepKey: string;
  readonly ordinal: number;
  readonly attempt: number;
}
