/**
 * @fileoverview Single-`@opensip-cli/core` guard for discovered packages.
 *
 * A capability pack (check pack, scenario pack, graph adapter) that resolves a
 * core whose `currentScope()` is always `undefined` here registers its
 * contributions against a dead `AsyncLocalStorage` and silently degrades the
 * run — the failure mode seen when a globally-installed CLI discovers packs in
 * a project that vendors a DIFFERENT `@opensip-cli/core`. Such packs are refused
 * at discovery time.
 *
 * Identity is by core VERSION, not file path. `runWithScope` pins its
 * `AsyncLocalStorage` on `globalThis` (see run-scope.ts), so every
 * SAME-VERSION copy of core — including pnpm's hard-copied injected duplicates
 * under `.pnpm/...`, which resolve a different PATH than the workspace copy —
 * shares one scope store and is safe. Only a DIFFERENT-version core is a
 * genuine split-scope risk and is refused. (A path comparison would wrongly
 * reject the injected duplicates and load zero packs.)
 *
 * Packs that don't depend on core at all resolve nothing and pass. The guard is
 * tool-agnostic: the generic discovery substrate applies it to EVERY domain's
 * packs, so the policy lives here once instead of in each tool's loader.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The `@opensip-cli/core` THIS module resolves — the canonical core whose
 * `runWithScope` populates `currentScope()`. Captured once. `undefined` disables
 * the guard (fail-open; defensive only — core always resolves from itself).
 */
const selfCorePath: string | undefined = (() => {
  try {
    return createRequire(import.meta.url).resolve('@opensip-cli/core');
  } catch {
    /* v8 ignore next 2 -- core resolves from itself; defensive only */
    return;
  }
})();

/** The canonical `@opensip-cli/core` path this runtime resolves (for diagnostics). */
export function selfCore(): string | undefined {
  return selfCorePath;
}

/** Resolve `@opensip-cli/core` from a createRequire anchor (undefined when absent). */
function resolveCoreFromAnchor(anchor: string): string | undefined {
  try {
    return createRequire(anchor).resolve('@opensip-cli/core');
  } catch {
    return undefined;
  }
}

/** Resolve `@opensip-cli/fitness` from a createRequire anchor (undefined when absent). */
function resolveFitnessFromAnchor(anchor: string): string | undefined {
  try {
    return createRequire(anchor).resolve('@opensip-cli/fitness');
  } catch {
    return undefined;
  }
}

/** Version from a `package.json` iff it is `@opensip-cli/core`; else undefined. */
function coreVersionFromManifest(manifestPath: string): string | undefined {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const json: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const record = (typeof json === 'object' && json !== null ? json : {}) as {
      name?: unknown;
      version?: unknown;
    };
    if (record.name !== '@opensip-cli/core' || typeof record.version !== 'string') return undefined;
    return record.version;
  } catch {
    return undefined;
  }
}

/** Read the `@opensip-cli/core` version that owns a resolved entry path. */
function coreVersionAt(coreEntry: string): string | undefined {
  // Walk up from the resolved entry (.../core/dist/index.js) to the package root.
  let dir = dirname(coreEntry);
  for (let depth = 0; depth < 6; depth += 1) {
    const version = coreVersionFromManifest(join(dir, 'package.json'));
    if (version !== undefined) return version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** This runtime's core version, captured once (paired with {@link selfCorePath}). */
const selfCoreVersion: string | undefined =
  selfCorePath === undefined ? undefined : coreVersionAt(selfCorePath);

/**
 * Whether a resolved core entry is THE SAME core as this runtime's: the same
 * physical path, or a same-version duplicate (pnpm's injected hard-copy under
 * `.pnpm/...`) that shares the globalThis-pinned scope ALS. A different version
 * — or an unreadable one — is foreign.
 */
function isSameCore(coreEntry: string): boolean {
  if (coreEntry === selfCorePath) return true;
  if (selfCoreVersion === undefined) return false;
  return coreVersionAt(coreEntry) === selfCoreVersion;
}

/**
 * The pack's resolved `@opensip-cli/core` if it differs from {@link selfCore}; else
 * undefined. Probes both the pack's direct core dep and the core that
 * `@opensip-cli/fitness` resolves when the pack depends on fitness — fit-packs
 * execute `check.run()` through fitness's `define-check`, which reads
 * `currentScope()` from fitness's core copy, not the pack's direct one.
 */
export function foreignCorePath(packageDir: string): string | undefined {
  if (selfCorePath === undefined) return undefined;
  // The anchor file need not exist — createRequire only uses its directory as
  // the resolution base, walking up node_modules from the pack.
  const anchor = pathToFileURL(join(packageDir, 'noop.js')).href;

  const directCore = resolveCoreFromAnchor(anchor);
  if (directCore !== undefined && !isSameCore(directCore)) {
    return directCore;
  }

  const fitnessEntry = resolveFitnessFromAnchor(anchor);
  if (fitnessEntry !== undefined) {
    const transitiveCore = resolveCoreFromAnchor(fitnessEntry);
    if (transitiveCore !== undefined && !isSameCore(transitiveCore)) {
      return transitiveCore;
    }
  }

  return undefined;
}

/**
 * Keep only the packages that resolve THIS runtime's `@opensip-cli/core`
 * (or none at all). `onForeign` is invoked for each dropped pack with the foreign
 * core path it resolved, for a caller-shaped diagnostic.
 */
export function filterSameCorePackages<
  T extends { readonly name: string; readonly packageDir: string },
>(packages: readonly T[], onForeign?: (pkg: T, foreignCore: string) => void): T[] {
  if (selfCorePath === undefined) return [...packages];
  return packages.filter((pkg) => {
    const foreign = foreignCorePath(pkg.packageDir);
    if (foreign === undefined) return true;
    onForeign?.(pkg, foreign);
    return false;
  });
}
