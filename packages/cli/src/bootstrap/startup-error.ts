import { mapExitClassToExitCode } from '@opensip-cli/contracts';
import { normalizeFailure, toPublicFailureProjection } from '@opensip-cli/core';

import { BootstrapError } from './bootstrap-error.js';

/** Preserve canonical exit semantics while giving pre-dispatch failures JSON shape. */
export function startupFailureAsBootstrapError(error: unknown): BootstrapError {
  if (error instanceof BootstrapError) return error;
  const envelope = normalizeFailure(error);
  const projection = toPublicFailureProjection(envelope);
  const message =
    typeof projection.message === 'string' ? projection.message : 'The operation failed.';
  const configurationFailure = envelope.definition.exitClass === 'configuration';
  return new BootstrapError({
    message,
    humanMessage: `✗ ${message}`,
    suggestion: configurationFailure
      ? "Run 'opensip status' to inspect runtime state, then retry the command."
      : 'Retry after the active OpenSIP process or runtime coordination failure is resolved.',
    exitCode: mapExitClassToExitCode(envelope.definition.exitClass),
  });
}
