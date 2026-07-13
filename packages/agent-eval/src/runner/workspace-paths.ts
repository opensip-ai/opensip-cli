import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function nearestExisting(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

/**
 * Resolve a task-declared relative path without permitting lexical or symlink escape.
 *
 * @throws {Error} When the path is empty, absolute, outside the root, or escapes via a symlink.
 */
export function resolveInsideRoot(root: string, relativePath: string): string {
  if (relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new Error(`Task path must be a non-empty relative path: ${relativePath}`);
  }

  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(lexicalRoot, relativePath);
  if (!isInside(lexicalRoot, lexicalTarget)) {
    throw new Error(`Task path escapes the workspace root: ${relativePath}`);
  }

  const realRoot = realpathSync.native(lexicalRoot);
  const existing = nearestExisting(lexicalTarget);
  const realExisting = realpathSync.native(existing);
  const effectiveTarget = resolve(realExisting, relative(existing, lexicalTarget));
  if (!isInside(realRoot, effectiveTarget)) {
    throw new Error(`Task path escapes the workspace root through a symlink: ${relativePath}`);
  }
  return lexicalTarget;
}
