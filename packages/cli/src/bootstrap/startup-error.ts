import { EXIT_CODES, mapToolErrorToExitCode } from '@opensip-cli/contracts';
import { ConfigurationError, ToolError } from '@opensip-cli/core';

import { BootstrapError } from './bootstrap-error.js';

/** Preserve canonical exit semantics while giving pre-dispatch failures JSON shape. */
export function startupFailureAsBootstrapError(error: unknown): BootstrapError {
  if (error instanceof BootstrapError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const configurationFailure = error instanceof ConfigurationError;
  return new BootstrapError({
    message,
    humanMessage: `✗ ${message}`,
    suggestion: configurationFailure
      ? "Run 'opensip status' to inspect runtime state, then retry the command."
      : 'Retry after the active OpenSIP process or runtime coordination failure is resolved.',
    exitCode: error instanceof ToolError ? mapToolErrorToExitCode(error) : EXIT_CODES.RUNTIME_ERROR,
  });
}
