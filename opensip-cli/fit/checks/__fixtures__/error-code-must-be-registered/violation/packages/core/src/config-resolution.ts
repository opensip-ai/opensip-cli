/**
 * Reduced from the real confirmed site:
 *   packages/core/src/config-resolution.ts  (resolveProjectConfigPath)
 *
 * `ERRORS` is not a registered catalog head and is not one of the
 * `legacyFamilyCode()` cases (CONFIG / CONFIGURATION / VALIDATION / PLUGIN /
 * TIMEOUT / SYSTEM / NETWORK / CAPABILITY), so `definitionFromLegacyCode`
 * demotes the most common first-run failure to CORE.SYSTEM.UNKNOWN_FAILURE:
 * severity fatal, exposure operator-only, responsibility unknown, exitClass
 * fatal — instead of a user-actionable configuration error.
 *
 * The second site is reduced from packages/graph/engine/src/cli/impact.ts,
 * where the code is assembled from a template substitution and therefore
 * cannot appear in any catalog by construction.
 */

import { ConfigurationError, ValidationError } from './lib/errors.js';

export const PROJECT_CONFIG_FILENAME = 'opensip-cli.config.yml';

export function resolveProjectConfigPath(attempts: readonly string[]): string {
  throw new ValidationError(
    `No ${PROJECT_CONFIG_FILENAME} found. Checked:\n` + attempts.join('\n'),
    {
      operation: 'resolve',
      loader: 'project-config',
      code: 'ERRORS.CONFIG.NOT_FOUND',
    },
  );
}

export function rejectImpact(message: string, reason: string): never {
  throw new ConfigurationError(message, { code: `CONFIG.GRAPH.${reason}` });
}
