/**
 * @fileoverview Resolve the path to opensip-cli.config.yml.
 *
 * Resolution order (first match wins):
 *   1. Explicit path — passed from --config CLI flag or programmatic caller.
 *   2. Default — <rootDir>/opensip-cli.config.yml.
 *
 * Throws a registered ToolError if none of the above resolve to an existing file.
 * This is intentional: running fitness checks with no config silently
 * produces zero findings (file-based checks get zero files), which looks
 * green but actually didn't run anything.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { coreErrorCatalog } from './lib/errors/core-error-catalog.js';
import { createToolError } from './lib/errors.js';

/** Canonical filename for the opensip-cli project config. */
export const PROJECT_CONFIG_FILENAME = 'opensip-cli.config.yml';

/**
 * Resolve the config file path for a given rootDir.
 *
 * @param rootDir - Absolute path to the project root.
 * @param explicitPath - Optional path from `--config` CLI flag. May be
 *   absolute or relative to `rootDir`.
 * @throws {ToolError} `CORE.CONFIG.NOT_FOUND` when no config file exists at any
 *   resolved location, or `CORE.CONFIG.EXPLICIT_PATH_MISSING` when an explicit
 *   `--config` path is absent. Both definitions are `exposure: 'public'`, which is what keeps
 *   the enumerated attempt list in the outward message — under the previous unmapped
 *   `ERRORS.` code the whole list was replaced by "An unexpected internal failure occurred."
 */
export function resolveProjectConfigPath(rootDir: string, explicitPath?: string): string {
  const attempts: string[] = [];

  // 1. --config flag (explicit)
  if (explicitPath && explicitPath.length > 0) {
    const resolved = isAbsolute(explicitPath) ? explicitPath : resolve(rootDir, explicitPath);
    attempts.push(`--config ${resolved}`);
    if (existsSync(resolved)) return resolved;
    throw createToolError(
      coreErrorCatalog.require('CORE.CONFIG.EXPLICIT_PATH_MISSING'),
      `Config path from --config flag does not exist: ${resolved}`,
    );
  }

  // 2. Default: <rootDir>/opensip-cli.config.yml
  const defaultPath = join(rootDir, PROJECT_CONFIG_FILENAME);
  attempts.push(defaultPath);
  if (existsSync(defaultPath)) return defaultPath;

  throw createToolError(
    coreErrorCatalog.require('CORE.CONFIG.NOT_FOUND'),
    `No ${PROJECT_CONFIG_FILENAME} found. Checked:\n` +
      attempts.map((a) => `  - ${a}`).join('\n') +
      `\n\nRun 'opensip init' to scaffold one, or pass --config <path> ` +
      `to point at an existing config.`,
  );
}
