import { currentScope } from '@opensip-cli/core';

/**
 * Build the project-selection arguments shared by every off-thread live-tool
 * worker. The active scope owns the resolved config path, so workers receive
 * the same project/config selection as their host invocation.
 */
export function workerProjectSelectionArgs(cwd: string): string[] {
  const configPath = currentScope()?.projectContext?.configPath;
  return ['--cwd', cwd, ...(configPath === undefined ? [] : ['--config', configPath])];
}
