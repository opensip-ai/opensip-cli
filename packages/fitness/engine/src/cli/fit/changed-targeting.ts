/**
 * Changed-file targeting for `fit --changed` (ADR-0085).
 */
import path from 'node:path';

import {
  buildImpactTrust,
  changedEntriesToImpactUncertainties,
  gitWarningsToImpactUncertainties,
  mergeImpactUncertainties,
  type FitOptions,
  type GraphCatalog,
  type ImpactTrust,
  type ImpactUncertainty,
} from '@opensip-cli/contracts';
import { createToolLogger, currentScope, resolveChangedFiles } from '@opensip-cli/core';
import { computeImpact } from '@opensip-cli/shared-analysis';

const log = createToolLogger('fitness:cli');
const WORKING_TREE_BASIS = 'changed:git:working-tree';
const CHANGED_DEGRADED_EVENT = 'fitness.cli.changed.degraded';

export interface ChangedSetOk {
  readonly ok: true;
  readonly files: ReadonlySet<string>;
  readonly basis: string;
  readonly trust: ImpactTrust;
  readonly warning?: string;
}

export interface ChangedSetFail {
  readonly ok: false;
  readonly warning: string;
}

export type ChangedSetResult = ChangedSetOk | ChangedSetFail;

function toAbsolute(cwd: string, relativePosix: string): string {
  return path.resolve(cwd, relativePosix.split('/').join(path.sep));
}

function fallbackWarning(trust: ImpactTrust): string | undefined {
  if (trust.fullyVerified) return undefined;
  const reasons = trust.uncertainties.map((item) => item.code).join(', ');
  const suffix = reasons ? ` (${reasons})` : '';
  return `Impact verification is ${trust.coverage}; running the full fit target set instead of a narrowed changed-file set${suffix}.`;
}

function conservativeTrust(uncertainties: readonly ImpactUncertainty[]): ImpactTrust {
  return buildImpactTrust({ uncertainties, fallback: 'full-run' });
}

function basisLabel(ref: string | undefined): string {
  return ref ? `changed:git:${ref}` : WORKING_TREE_BASIS;
}

function fallbackResult(input: {
  readonly files: ReadonlySet<string>;
  readonly basis: string;
  readonly trust: ImpactTrust;
  readonly reason: string;
}): ChangedSetOk {
  log.warn({
    evt: CHANGED_DEGRADED_EVENT,
    module: 'fitness:cli',
    reason: input.reason,
    uncertainties: input.trust.uncertainties.map((item) => item.code),
  });
  return {
    ok: true,
    files: input.files,
    basis: input.basis,
    trust: input.trust,
    warning: fallbackWarning(input.trust),
  };
}

function resolveCatalogFallback(
  fileSet: ReadonlySet<string>,
  gitUncertainties: readonly ImpactUncertainty[],
): ChangedSetOk {
  return fallbackResult({
    files: fileSet,
    basis: 'changed:full-run-fallback (graph catalog unavailable)',
    trust: conservativeTrust([
      ...gitUncertainties,
      {
        code: 'graph-catalog-unavailable',
        source: 'catalog',
        message: 'Graph catalog is unavailable for --include-impacted.',
      },
    ]),
    reason: 'graph-catalog-unavailable',
  });
}

/**
 * Resolve the changed file set (absolute paths) for a `--changed` fit run.
 */
export function resolveChangedSet(
  args: Pick<FitOptions, 'cwd' | 'since' | 'changed' | 'includeImpacted'>,
): ChangedSetResult {
  if (args.changed !== true && !args.since) {
    return { ok: false, warning: 'resolveChangedSet called without --changed or --since' };
  }

  const resolved = resolveChangedFiles(args.cwd, { since: args.since });
  if (!resolved.ok) {
    log.warn({
      evt: CHANGED_DEGRADED_EVENT,
      module: 'fitness:cli',
      reason: resolved.reason,
    });
    return { ok: false, warning: resolved.message };
  }

  const fileSet = new Set<string>();
  for (const rel of resolved.files) {
    fileSet.add(toAbsolute(args.cwd, rel));
  }
  const gitUncertainties = mergeImpactUncertainties(
    gitWarningsToImpactUncertainties(resolved.basis.warnings),
    changedEntriesToImpactUncertainties(resolved.entries),
  );
  if (args.includeImpacted !== true && gitUncertainties.length > 0) {
    return fallbackResult({
      files: fileSet,
      basis: basisLabel(resolved.basis.ref),
      trust: conservativeTrust(gitUncertainties),
      reason: 'changed-file-uncertain',
    });
  }

  if (args.includeImpacted === true) {
    const catalog = currentScope()?.graphCatalog?.() as GraphCatalog | null | undefined;
    if (!catalog) {
      return resolveCatalogFallback(fileSet, gitUncertainties);
    }
    const impact = computeImpact(catalog, resolved.files, {
      changedFileEntries: resolved.entries,
      uncertainties: gitUncertainties,
    });
    for (const fn of [...impact.changedFunctions, ...impact.impactedFunctions]) {
      fileSet.add(toAbsolute(args.cwd, fn.filePath));
    }
    if (!impact.trust.fullyVerified) {
      return fallbackResult({
        files: fileSet,
        basis: basisLabel(resolved.basis.ref),
        trust: conservativeTrust(impact.trust.uncertainties),
        reason: 'impact-trust-uncertain',
      });
    }
  }

  log.info({
    evt: 'fitness.cli.changed.resolved',
    module: 'fitness:cli',
    changedFiles: resolved.files.length,
    impactedFiles: fileSet.size,
  });

  return {
    ok: true,
    files: fileSet,
    basis: basisLabel(resolved.basis.ref),
    trust: buildImpactTrust(),
  };
}

/**
 * Intersect each per-file check's scope-resolved target file list with the changed
 * set. `fullScopeKeys` (the `analyzeAll` checks) are exempt — they keep their FULL
 * file list.
 *
 * Two invariants:
 * 1. A per-file (`analyze`) check with NO changed files keeps an EMPTY entry — it
 *    is NOT dropped. Dropping it would leave `checkTargetFiles.get(checkId)` undefined,
 *    and the check's `matchFiles()` then falls back to the whole-repo fileCache
 *    (which honors only `globalExcludes`, not the target-level `*.test.ts` /
 *    `__tests__` excludes) — so a `--changed` run would silently scan the ENTIRE
 *    repo, including test files. The empty entry pins the check to "scan nothing".
 * 2. An `analyzeAll` (cross-file / whole-repo invariant) check keeps its FULL file
 *    list — narrowing it to the changed subset would make an unchanged target read
 *    as absent (a false "missing" violation), so its result must not depend on what
 *    changed. Full scope is target-resolved (globalExcludes + `*.test.ts` excludes
 *    already applied), so it stays clean and matches the full run.
 */
export function restrictFileMapToChanged(
  scopeMap: Map<string, readonly string[]>,
  changedAbs: ReadonlySet<string>,
  fullScopeKeys: ReadonlySet<string>,
): Map<string, readonly string[]> {
  const narrowed = new Map<string, readonly string[]>();
  for (const [key, files] of scopeMap) {
    narrowed.set(
      key,
      fullScopeKeys.has(key) ? files : files.filter((f) => changedAbs.has(path.resolve(f))),
    );
  }
  return narrowed;
}

/** Inputs for {@link seedScopelessChangedTargets}. */
export interface ScopelessSeedInput {
  /**
   * Scope-map keys (`check.config.id`) of EVERY check resolved for this run —
   * including the ones scope resolution produced no entry for.
   */
  readonly allCheckKeys: readonly string[];
  /** The `analyzeAll` checks, which keep their whole-repo view under `--changed`. */
  readonly fullScopeKeys: ReadonlySet<string>;
  /**
   * The changed set as an absolute-path list, ALREADY filtered by
   * `globalExcludes` (and by the inside-root guard `applyGlobalExcludes` adds).
   */
  readonly changedTargets: readonly string[];
}

/**
 * Seed a changed-set entry for every per-file check that scope resolution left
 * with NO key in the map at all — a check declaring no `scope` (or an empty
 * `languages`/`concerns` pair) and carrying no `checkOverrides` entry.
 *
 * {@link restrictFileMapToChanged} can only narrow keys that ALREADY exist, so
 * without this pass a scope-less check keeps `checkTargetFiles.get(checkId) ===
 * undefined` under `--changed`/`--since`. Its `matchFiles()` then falls back to
 * the whole prewarm universe (globalExcludes only) and the check silently scans
 * the ENTIRE repo — every unchanged file included — while the run still reports
 * a fully-verified changed-file narrowing. That is the same defect the two
 * invariants on `restrictFileMapToChanged` close for keys that DO exist; this
 * closes it for the absent-key case.
 *
 * The changed set is the tightest honest bound available for such a check: it
 * has no target, so there are no target-level excludes to inherit, and
 * `globalExcludes` has already been applied to `changedTargets` by the caller.
 *
 * `analyzeAll` (cross-file / whole-repo invariant) checks are deliberately NOT
 * seeded: narrowing them to the changed subset would make an unchanged target
 * read as absent, so an absent key — whole-repo fallback — is the correct
 * behaviour for them, exactly as `fullScopeKeys` keeps full lists for the keys
 * that exist.
 */
export function seedScopelessChangedTargets(
  scopeMap: Map<string, readonly string[]>,
  input: ScopelessSeedInput,
): Map<string, readonly string[]> {
  const seeded = new Map(scopeMap);
  for (const key of input.allCheckKeys) {
    if (seeded.has(key) || input.fullScopeKeys.has(key)) continue;
    seeded.set(key, input.changedTargets);
  }
  return seeded;
}
