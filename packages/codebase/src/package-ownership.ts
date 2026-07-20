import type { PackageFact } from '@opensip-cli/contracts';

/** Return the deepest package root containing one normalized project path. */
export function findOwningPackage(
  path: string,
  packages: readonly PackageFact[],
): PackageFact | undefined {
  let owner: PackageFact | undefined;
  let ownerSpecificity = -1;
  for (const candidate of packages) {
    const { root } = candidate;
    const containsPath = root === '.' || path === root || path.startsWith(`${root}/`);
    // `.` is the workspace fallback, not a one-character package root. Giving
    // both the same string-length score makes an actual root such as `a` lose
    // whenever the workspace package is visited first.
    const specificity = root === '.' ? 0 : root.length;
    if (containsPath && specificity > ownerSpecificity) {
      owner = candidate;
      ownerSpecificity = specificity;
    }
  }
  return owner;
}
