/**
 * Host-owned outer command boundary. Commander does not guarantee postAction
 * after every rejected action, so error presentation must run while the staged
 * scope is still owned and teardown must live in an unconditional finally.
 */

import type { CommandActionScopeRunner } from './command-action-scope-runner.js';

export interface CommandDispatchBoundaryInput {
  readonly dispatch: () => Promise<unknown>;
  readonly actionScope: CommandActionScopeRunner;
  readonly presentError: (error: unknown) => Promise<void>;
  readonly disposeAmbientScope: () => void;
}

export async function runCommandDispatchBoundary(
  input: CommandDispatchBoundaryInput,
): Promise<void> {
  try {
    await input.dispatch();
  } catch (error) {
    await input.actionScope.runWithOwnedScope(() => input.presentError(error));
  } finally {
    input.actionScope.disposeStaged();
    input.disposeAmbientScope();
  }
}
