/**
 * @fileoverview Single-`@opensip-tools/core` guard for discovered packages.
 *
 * A capability pack (check pack, scenario pack, graph adapter) that resolves a
 * DIFFERENT physical `@opensip-tools/core` than the running engine registers its
 * contributions against a core whose `currentScope()` is always `undefined` here
 * (a different `AsyncLocalStorage`). That silently degrades the run — the failure
 * mode seen when a globally-installed CLI discovers packs in a project that
 * vendors its own `@opensip-tools/*`. Such packs are refused at discovery time.
 *
 * Packs that don't depend on core at all resolve nothing and pass. The guard is
 * tool-agnostic: the generic discovery substrate applies it to EVERY domain's
 * packs, so the policy lives here once instead of in each tool's loader.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The `@opensip-tools/core` THIS module resolves — the canonical core whose
 * `runWithScope` populates `currentScope()`. Captured once. `undefined` disables
 * the guard (fail-open; defensive only — core always resolves from itself).
 */
const selfCorePath: string | undefined = (() => {
  try {
    return createRequire(import.meta.url).resolve('@opensip-tools/core');
  } catch {
    /* v8 ignore next 2 -- core resolves from itself; defensive only */
    // @fitness-ignore-next-line error-handling-quality -- an unresolvable self-core disables the guard (fail-open), not an error.
    return;
  }
})();

/** The canonical `@opensip-tools/core` path this runtime resolves (for diagnostics). */
export function selfCore(): string | undefined {
  return selfCorePath;
}

/** The pack's resolved `@opensip-tools/core` if it differs from {@link selfCore}; else undefined. */
export function foreignCorePath(packageDir: string): string | undefined {
  if (selfCorePath === undefined) return undefined;
  try {
    // The anchor file need not exist — createRequire only uses its directory as
    // the resolution base, walking up node_modules from the pack.
    const anchor = pathToFileURL(join(packageDir, 'noop.js')).href;
    const packCore = createRequire(anchor).resolve('@opensip-tools/core');
    return packCore === selfCorePath ? undefined : packCore;
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- resolution probe: a pack with no core dep throws here, and "no foreign core → allow" is the contract.
    return undefined;
  }
}

/**
 * Keep only the packages that resolve THIS runtime's `@opensip-tools/core`
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
