/**
 * Dependency-neutral contract for binding one staged RunScope around a mounted
 * Commander action. The implementation lives in pre-action-hook; this leaf
 * module prevents command/bootstrap dependency cycles.
 */
export interface CommandActionScopeRunner {
  readonly run: <T>(action: () => Promise<T>) => Promise<T>;
  /** Re-enter the owned scope for host error/output continuations after action unwind. */
  readonly runWithOwnedScope: <T>(continuation: () => Promise<T>) => Promise<T>;
  /** Dispose a not-yet-run or completed action scope at the host lifecycle boundary. */
  readonly disposeStaged: () => void;
}
