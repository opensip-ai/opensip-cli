/**
 * Pre-flight writability check for `init` (extracted from the init orchestrator).
 */

import { accessSync, constants } from 'node:fs';

import { SystemError } from '@opensip-cli/core';

/**
 * Fail closed before journal/promotion work when the project root cannot accept
 * authored files. Soft "rolled-back" InitResult shapes hide EACCES behind
 * status:ok + exit 1; agents and platform-acceptance require a structured
 * `command.error` that names `opensip-cli.config.yml` and the permission failure.
 *
 * @throws {SystemError} When the project directory is not writable.
 */
export function assertProjectRootWritableForInit(cwd: string): void {
  try {
    accessSync(cwd, constants.W_OK);
  } catch (error) {
    const code =
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'EACCES';
    throw new SystemError(
      `Cannot write opensip-cli.config.yml: the project directory is not writable (${code}).`,
    );
  }
}
