/**
 * @fileoverview Single-`@opensip-cli/core` guard for discovered packages.
 *
 * A capability pack (check pack, scenario pack, graph adapter) that resolves a
 * DIFFERENT physical `@opensip-cli/core` than the running engine registers its
 * contributions against a core whose `currentScope()` is always `undefined` here
 * (a different `AsyncLocalStorage`). That silently degrades the run — the failure
 * mode seen when a globally-installed CLI discovers packs in a project that
 * vendors its own `@opensip-cli/*`. Such packs are refused at discovery time.
 *
 * Packs that don't depend on core at all resolve nothing and pass. The guard is
 * tool-agnostic: the generic discovery substrate applies it to EVERY domain's
 * packs, so the policy lives here once instead of in each tool's loader.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
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
    // @fitness-ignore-next-line error-handling-quality -- an unresolvable self-core disables the guard (fail-open), not an error.
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
    // @fitness-ignore-next-line error-handling-quality -- resolution probe: no core dep is "no foreign core → allow".
    return undefined;
  }
}

/** Resolve `@opensip-cli/fitness` from a createRequire anchor (undefined when absent). */
function resolveFitnessFromAnchor(anchor: string): string | undefined {
  try {
    return createRequire(anchor).resolve('@opensip-cli/fitness');
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- resolution probe: no fitness dep is fine for non-fit packs.
    return undefined;
  }
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
  if (directCore !== undefined && directCore !== selfCorePath) {
    return directCore;
  }

  const fitnessEntry = resolveFitnessFromAnchor(anchor);
  if (fitnessEntry !== undefined) {
    const transitiveCore = resolveCoreFromAnchor(fitnessEntry);
    if (transitiveCore !== undefined && transitiveCore !== selfCorePath) {
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
