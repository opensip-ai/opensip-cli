// @fitness-ignore-file unbounded-memory -- the host's readFile delegates to ts.sys.readFile over single source/config files during module resolution; per-file memory bounded by source size (same class as index.ts / parse-fast.ts)
/**
 * Shared module-resolution host construction for the TypeScript adapter.
 *
 * Both per-specifier resolution call sites — dependency-edge resolution
 * (`resolveSiteTargets` in index.ts) and the program-free partition-time
 * import scan (`scanImports` in scan-imports.ts, ADR-0045) — resolve
 * specifiers through `ts.resolveModuleName` against this host. Extracted
 * so the host construction logic is never duplicated.
 */

import ts from 'typescript';

/**
 * Wrap `ts.sys` into a `ModuleResolutionHost`. Methods are bound
 * through arrow functions to satisfy `@typescript-eslint/unbound-method`
 * (arrow `this` is lexical / void). `useCaseSensitiveFileNames` is a
 * boolean property on modern `ts.sys` — the function-vs-boolean branch
 * in earlier code was unreachable dead-code (both branches returned the
 * same value).
 */
export function createModuleResolutionHost(): ts.ModuleResolutionHost {
  return {
    fileExists: (fileName: string): boolean => ts.sys.fileExists(fileName),
    readFile: (fileName: string, encoding?: string): string | undefined =>
      ts.sys.readFile(fileName, encoding),
    directoryExists: (directoryName: string): boolean => ts.sys.directoryExists(directoryName),
    getCurrentDirectory: (): string => ts.sys.getCurrentDirectory(),
    getDirectories: (path: string): string[] => ts.sys.getDirectories(path),
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}
