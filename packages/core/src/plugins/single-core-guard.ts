/**
 * @fileoverview Single-`@opensip-cli/core` guard for discovered packages.
 *
 * A capability pack (check pack, scenario pack, graph adapter) that resolves a
 * core whose `currentScope()` is always `undefined` here registers its
 * contributions against a dead `AsyncLocalStorage` and silently degrades the
 * run — the failure mode seen when a globally-installed CLI discovers packs in
 * a project that vendors an INCOMPATIBLE `@opensip-cli/core`. Such packs are
 * refused at discovery time.
 *
 * Identity is by SCOPE ABI, not npm version and not file path (ADR-0103).
 * `runWithScope` pins its `AsyncLocalStorage` on `globalThis` under the
 * version-independent key `Symbol.for('@opensip-cli/core/scopeStorage')` (see
 * run-scope.ts), so every core that participates in that protocol AND agrees on
 * the RunScope read-surface — regardless of npm version, including pnpm's
 * hard-copied injected duplicates under `.pnpm/...` at a different PATH — shares
 * one scope store and is safe. The shared identity is therefore the scope ABI
 * ({@link SCOPE_ABI_VERSION}); a core with a DIFFERENT scope ABI is the genuine
 * split-scope risk and is refused.
 *
 * A core is assigned a scope ABI by, in order: (1) its explicit
 * `opensipScopeAbiVersion` manifest field; (2) if absent but its version is at
 * or above {@link SCOPE_ABI_MIN_CORE_VERSION} (the release that introduced the
 * shared-ALS pin), the inferred ABI 1; (3) otherwise none — a pre-pin core that
 * cannot share scope, for which the guard falls back to exact-version identity.
 * (A version comparison alone would wrongly reject same-ABI cross-version cores
 * and re-couple interop to release cadence; a path comparison would wrongly
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

import {
  coreVersionImplementsScopeAbi1,
  SCOPE_ABI_MANIFEST_FIELD,
  SCOPE_ABI_VERSION,
} from '../lib/scope-abi.js';

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

/** The `version` + scope-ABI fields of a `@opensip-cli/core` manifest. */
interface CoreManifestFields {
  readonly version?: string;
  readonly scopeAbi?: number;
}

/** Read `version` + `opensipScopeAbiVersion` from a `package.json` iff it is `@opensip-cli/core`. */
function coreFieldsFromManifest(manifestPath: string): CoreManifestFields | undefined {
  if (!existsSync(manifestPath)) return undefined;
  try {
    const json: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const record = (typeof json === 'object' && json !== null ? json : {}) as {
      name?: unknown;
      version?: unknown;
      [SCOPE_ABI_MANIFEST_FIELD]?: unknown;
    };
    if (record.name !== '@opensip-cli/core') return undefined;
    const version = typeof record.version === 'string' ? record.version : undefined;
    const rawAbi = record[SCOPE_ABI_MANIFEST_FIELD];
    const scopeAbi = typeof rawAbi === 'number' ? rawAbi : undefined;
    return { version, scopeAbi };
  } catch {
    return undefined;
  }
}

/** The `@opensip-cli/core` manifest fields that own a resolved entry path. */
function coreManifestAt(coreEntry: string): CoreManifestFields {
  // Walk up from the resolved entry (.../core/dist/index.js) to the package root.
  let dir = dirname(coreEntry);
  for (let depth = 0; depth < 6; depth += 1) {
    const fields = coreFieldsFromManifest(join(dir, 'package.json'));
    if (fields !== undefined) return fields;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

/**
 * The scope ABI a resolved core implements, or undefined when it cannot share
 * scope with this runtime (a pre-{@link SCOPE_ABI_MIN_CORE_VERSION} core with no
 * shared-ALS pin). Explicit `opensipScopeAbiVersion` wins; otherwise a core at or
 * above the floor is inferred as ABI 1 (the pin has existed since that release).
 */
function scopeAbiAt(coreEntry: string): number | undefined {
  const { version, scopeAbi } = coreManifestAt(coreEntry);
  if (scopeAbi !== undefined) return scopeAbi;
  if (version !== undefined && coreVersionImplementsScopeAbi1(version)) return 1;
  return undefined;
}

/** A resolved core's version + effective scope ABI, for guard diagnostics. */
export interface CoreDescription {
  readonly path: string;
  readonly version?: string;
  readonly scopeAbi?: number;
}

/** Describe a resolved core entry (version + effective scope ABI) for diagnostics. */
export function coreDescriptionAt(coreEntry: string): CoreDescription {
  return {
    path: coreEntry,
    version: coreManifestAt(coreEntry).version,
    scopeAbi: scopeAbiAt(coreEntry),
  };
}

/** This runtime's core version, captured once (paired with {@link selfCorePath}). */
const selfCoreVersion: string | undefined =
  selfCorePath === undefined ? undefined : coreManifestAt(selfCorePath).version;

/** This runtime's scope ABI (the code constant — the running core always knows its own). */
export function selfScopeAbiVersion(): number {
  return SCOPE_ABI_VERSION;
}

/** This runtime's resolved core version string, for diagnostics (undefined if unresolved). */
export function selfCoreVersionString(): string | undefined {
  return selfCoreVersion;
}

/**
 * Whether a resolved core entry is THE SAME core as this runtime's: the same
 * physical path, or a core sharing this runtime's scope ABI (pnpm's injected
 * hard-copy under `.pnpm/...`, or a different npm version that still implements
 * {@link SCOPE_ABI_VERSION}) — both share the globalThis-pinned scope ALS. A core
 * whose ABI cannot be resolved (pre-pin, unreadable) falls back to exact-version
 * identity; a resolvable DIFFERENT ABI is foreign.
 */
function isSameCore(coreEntry: string): boolean {
  if (coreEntry === selfCorePath) return true;
  const foreignAbi = scopeAbiAt(coreEntry);
  if (foreignAbi !== undefined) return foreignAbi === SCOPE_ABI_VERSION;
  // No resolvable scope ABI (a pre-pin or unreadable core) → conservative
  // exact-version identity, matching the pre-ADR-0103 behaviour for such cores.
  if (selfCoreVersion === undefined) return false;
  return coreManifestAt(coreEntry).version === selfCoreVersion;
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
