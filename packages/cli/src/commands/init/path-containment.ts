import { isAbsolute, relative, sep } from 'node:path';

/** True when `path` is the same as `root` or a descendant (no `..` escape). */
export function isPathContained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
}
