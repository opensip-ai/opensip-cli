/**
 * Canonical filesystem containment and project-relative path helpers.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, relative, sep } from 'node:path';

/**
 * Return whether `child` resolves to `parent` or a descendant of it.
 *
 * Resolution failures return false, preserving fail-closed containment.
 */
export function isPathInside(child: string, parent: string): boolean {
  let realChild: string;
  let realParent: string;
  try {
    realChild = realpathSync(child);
    realParent = realpathSync(parent);
  } catch {
    // @swallow-ok A missing or unresolvable path is not proven contained.
    return false;
  }
  if (realChild === realParent) return true;
  return realChild.startsWith(realParent + sep);
}

/**
 * Normalize a path to project-relative POSIX form.
 *
 * Absolute paths are first made relative to `cwd`; platform separators are
 * then converted to `/`.
 */
export function toPosixRelative(cwd: string, filePath: string): string {
  const normalized = normalize(filePath);
  if (isAbsolute(normalized)) {
    return relative(cwd, normalized).split(sep).join('/');
  }
  return normalized.split(sep).join('/');
}
