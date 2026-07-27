import { HarnessPrerequisiteError } from './spawn.js';

export type WorkspacePreparationCondition = 'fixture-copy' | 'workspace-edit';

function nativeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Harness-local, data-free classification for disposable workspace preparation failures. */
export class WorkspacePreparationError extends HarnessPrerequisiteError {
  public readonly nativeCode: string | undefined;

  public constructor(
    public readonly condition: WorkspacePreparationCondition,
    public readonly operationIndex: number,
    cause: unknown,
  ) {
    const nativeCode = nativeErrorCode(cause);
    const codeDetail = nativeCode === undefined ? '' : ` (${nativeCode})`;
    super(
      `Agent-eval ${condition} failed at operation ${String(operationIndex + 1)}${codeDetail}.`,
      { cause },
    );
    this.name = 'WorkspacePreparationError';
    this.nativeCode = nativeCode;
  }
}
