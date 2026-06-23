/**
 * @fileoverview Resolve the path to opensip-cli.config.yml.
 *
 * Resolution order (first match wins):
 *   1. Explicit path — passed from --config CLI flag or programmatic caller.
 *   2. package.json — `opensip-cli.configPath` field at <rootDir>/package.json.
 *   3. Default — <rootDir>/opensip-cli.config.yml.
 *
 * Throws ValidationError if none of the above resolve to an existing file.
 * This is intentional: running fitness checks with no config silently
 * produces zero findings (file-based checks get zero files), which looks
 * green but actually didn't run anything.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { ValidationError } from './lib/errors.js';

/** Canonical filename for the opensip-cli project config. */
export const PROJECT_CONFIG_FILENAME = 'opensip-cli.config.yml';

/** Key read from package.json to locate a non-default config path. */
const PKG_JSON_POINTER_FIELD = 'opensip-cli';
const PKG_JSON_POINTER_SUBFIELD = 'configPath';

/** Read `configPath` from <rootDir>/package.json. Returns null when absent. */
function readConfigPathFromPackageJson(rootDir: string): string | null {
  const pkgPath = join(rootDir, 'package.json');
  if (!existsSync(pkgPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    // Malformed package.json is the user's problem to fix — don't
    // silently mask it with a config-resolution error. The subsequent
    // fall-through to the default path will succeed or fail as usual.
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const toolSection = root[PKG_JSON_POINTER_FIELD];
  if (typeof toolSection !== 'object' || toolSection === null) return null;

  const section = toolSection as Record<string, unknown>;
  const raw = section[PKG_JSON_POINTER_SUBFIELD];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}

/**
 * Resolve the config file path for a given rootDir.
 *
 * @param rootDir - Absolute path to the project root.
 * @param explicitPath - Optional path from `--config` CLI flag. May be
 *   absolute or relative to `rootDir`.
 * @throws {ValidationError} When no config file exists at any resolved
 *   location. The error message enumerates every path attempted so
 *   operators can diagnose without re-running with --debug.
 */
export function resolveProjectConfigPath(rootDir: string, explicitPath?: string): string {
  const attempts: string[] = [];

  // 1. --config flag (explicit)
  if (explicitPath && explicitPath.length > 0) {
    const resolved = isAbsolute(explicitPath) ? explicitPath : resolve(rootDir, explicitPath);
    attempts.push(`--config ${resolved}`);
    if (existsSync(resolved)) return resolved;
    throw new ValidationError(`Config path from --config flag does not exist: ${resolved}`, {
      operation: 'resolve',
      loader: 'project-config',
    });
  }

  // 2. package.json#opensip-cli.configPath
  const pointerRaw = readConfigPathFromPackageJson(rootDir);
  if (pointerRaw) {
    const resolved = isAbsolute(pointerRaw) ? pointerRaw : resolve(rootDir, pointerRaw);
    attempts.push(
      `package.json#${PKG_JSON_POINTER_FIELD}.${PKG_JSON_POINTER_SUBFIELD} → ${resolved}`,
    );
    if (existsSync(resolved)) return resolved;
    throw new ValidationError(
      `package.json "${PKG_JSON_POINTER_FIELD}.${PKG_JSON_POINTER_SUBFIELD}" points to a file that does not exist: ${resolved}`,
      { operation: 'resolve', loader: 'project-config' },
    );
  }

  // 3. Default: <rootDir>/opensip-cli.config.yml
  const defaultPath = join(rootDir, PROJECT_CONFIG_FILENAME);
  attempts.push(defaultPath);
  if (existsSync(defaultPath)) return defaultPath;

  throw new ValidationError(
    `No ${PROJECT_CONFIG_FILENAME} found. Checked:\n` +
      attempts.map((a) => `  - ${a}`).join('\n') +
      `\n\nRun 'opensip init' to scaffold one, or pass --config <path> ` +
      `to point at an existing config.`,
    { operation: 'resolve', loader: 'project-config', code: 'ERRORS.CONFIG.NOT_FOUND' },
  );
}
