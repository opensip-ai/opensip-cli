import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Stored-session cwd containment.
 *
 * This intentionally compares normalized strings, not realpaths: session rows
 * are historical evidence and their directories may no longer exist. Matching
 * is byte-exact and case-sensitive. Empty or relative stored cwd values are
 * treated as foreign so scoping fails closed.
 */
export function isSessionCwdWithin(storedCwd: string, root: string): boolean {
  if (storedCwd.length === 0 || !isAbsolute(storedCwd)) return false;
  const resolvedRoot = resolve(root);
  const resolvedCwd = resolve(storedCwd);
  const descendantPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(descendantPrefix);
}
