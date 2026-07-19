import type { PackageFact } from '@opensip-cli/contracts';

/** Return the deepest package root containing one normalized project path. */
export function findOwningPackage(
  path: string,
  packages: readonly PackageFact[],
): PackageFact | undefined {
  let owner: PackageFact | undefined;
  let ownerLength = -1;
  for (const candidate of packages) {
    const { root } = candidate;
    const containsPath = root === '.' || path === root || path.startsWith(`${root}/`);
    if (containsPath && root.length > ownerLength) {
      owner = candidate;
      ownerLength = root.length;
    }
  }
  return owner;
}
