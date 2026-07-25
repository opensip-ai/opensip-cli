/**
 * VIOLATION fixture — `control-flow` collapse.
 *
 * Reduced from the real confirmed site
 * `packages/fitness/checks-universal/src/checks/architecture/tool-has-manifest.ts:141-160`
 * (`analyzeAllToolManifests`).
 *
 * The catch is documented as covering "a malformed package.json", but the
 * single `await files.read(...)` inside the try also throws on an aborted run
 * and on the FileAccessor's catalogued `VALIDATION.FITNESS.FILE_TOO_LARGE` /
 * `VALIDATION.FITNESS.PATH_NOT_IN_SET`. All of them collapse into `continue`,
 * so the walk silently reports a clean, INCOMPLETE inventory.
 */

interface FileAccessor {
  readonly paths: readonly string[];
  read(filePath: string): Promise<string>;
}

interface PackageJson {
  readonly name?: string;
}

export async function collectManifests(files: FileAccessor): Promise<PackageJson[]> {
  const manifests: PackageJson[] = [];
  for (const filePath of files.paths) {
    if (!filePath.endsWith('package.json')) continue;
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(await files.read(filePath)) as PackageJson;
    } catch {
      // A malformed package.json is some other check's concern; a tool
      // manifest cannot be read from it either way, so skip silently.
      continue;
    }
    manifests.push(pkg);
  }
  return manifests;
}
