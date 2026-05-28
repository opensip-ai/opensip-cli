// @fitness-ignore-file unbounded-memory -- reads npm package.json files; bounded by standard package metadata size
/**
 * @fileoverview Resolve a package's main entry point from its
 * `package.json` — shared between plugin discovery (project-local
 * `.runtime/plugins/<domain>/node_modules/`) and tool-package discovery
 * (any installed `opensipTools.kind === 'tool'` package).
 *
 * The two discovery sites previously inlined the same exports-map walk,
 * each with its own `eslint-disable-next-line sonarjs/cognitive-complexity`
 * suppression. Extracting the resolver removes the duplication and keeps
 * each caller small enough to satisfy the rule on its own.
 *
 * Resolution order matches Node's: `exports['.']` (string or condition
 * object — `import` / `default` / `node` selected in that order) →
 * `pkg.main` → `./index.js`. Returns the joined absolute path of the
 * entry, plus the package name from `pkg.name`. Returns `undefined`
 * when `package.json` is missing, malformed, or has no resolvable
 * entry.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PackageEntryResolution {
  /** Package name from `pkg.name`. Falls back to caller-supplied default if absent. */
  readonly name: string;
  /** Absolute path to the resolved entry point. */
  readonly entry: string;
  /** Raw entry path before joining (for callers that want the relative form). */
  readonly rawEntry: string;
}

interface PackageJsonShape {
  readonly name?: string;
  readonly main?: string;
  readonly exports?: Record<string, unknown> | string;
}

/**
 * Resolve a package's entry-point from its directory.
 *
 * @param packageDir   Absolute path to the package directory.
 * @param fallbackName Name to use if `pkg.name` is missing — typically
 *                     the directory entry the caller iterated over.
 * @returns The resolved entry plus name, or `undefined` if `package.json`
 *          is absent, malformed, or has no resolvable entry.
 */
export function resolvePackageEntryPoint(
  packageDir: string,
  fallbackName?: string,
): PackageEntryResolution | undefined {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return undefined;

  let pkg: PackageJsonShape;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as PackageJsonShape;
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- malformed/unreadable package.json deliberately surfaces via undefined return; caller treats as "no resolvable entry" (documented in the function's JSDoc).
    return undefined;
  }

  const name = pkg.name ?? fallbackName;
  if (!name) return undefined;

  const rawEntry = resolveEntryFromExportsField(pkg.exports) ?? pkg.main ?? './index.js';
  return {
    name,
    entry: join(packageDir, rawEntry),
    rawEntry,
  };
}

/**
 * Walk the `exports` field of a parsed `package.json` and pick the
 * main entry. Returns the raw (relative) entry string or `undefined`
 * when no resolvable entry is present.
 *
 * Handles three shapes:
 *   - `"exports": "./dist/index.js"`               (string)
 *   - `"exports": { ".": "./dist/index.js" }`      (object, string `.`)
 *   - `"exports": { ".": { "import": "./..." } }`  (object, condition `.`)
 */
function resolveEntryFromExportsField(
  exportsField: PackageJsonShape['exports'],
): string | undefined {
  if (typeof exportsField === 'string') return exportsField;
  if (!exportsField || typeof exportsField !== 'object') return undefined;
  if (!('.' in exportsField)) return undefined;
  const dot = exportsField['.'];
  if (typeof dot === 'string') return dot;
  if (!dot || typeof dot !== 'object') return undefined;
  const conditions = dot as Record<string, unknown>;
  // Order matches Node's "exports" condition resolution priority for
  // ESM consumers: prefer 'import', then 'default', then 'node'.
  if (typeof conditions.import === 'string') return conditions.import;
  if (typeof conditions.default === 'string') return conditions.default;
  if (typeof conditions.node === 'string') return conditions.node;
  return undefined;
}
