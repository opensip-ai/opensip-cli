/**
 * @fileoverview Shared config-path-relativization helper.
 *
 * Extracted from two byte-identical copies (`runtime-wiring-snapshot.ts` and
 * `sqlite-graph-query-context.ts`) surfaced by the yagni duplicate-body audit.
 * Both call sites need the same host-config-path echo: relativize a resolved
 * config path against the project root, defending against paths that escape
 * the project (symlink/absolute weirdness) or carry control characters.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Renders `configPath` relative to `projectRoot` using POSIX `/` separators,
 * for display/identity purposes only (never for filesystem access).
 *
 * Returns a sentinel instead of throwing for inputs that would otherwise leak
 * host filesystem structure: control characters (`<invalid-config-path>`) or
 * a resolved path outside the project root (`<outside-project>`).
 */
export function projectRelativeConfigPath(projectRoot: string, configPath: string): string {
  if (/\p{Cc}/u.test(configPath)) return '<invalid-config-path>';
  const root = resolve(projectRoot);
  const absolute = resolve(root, configPath);
  const value = relative(root, absolute);
  if (value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    return '<outside-project>';
  }
  return (value || '.').split(sep).join('/');
}
