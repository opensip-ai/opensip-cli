/**
 * Changed-file targeting for `fit --changed` (ADR-0085).
 */
import path from 'node:path';

import {
  buildImpactTrust,
  changedEntriesToImpactUncertainties,
  computeImpact,
  gitWarningsToImpactUncertainties,
  mergeImpactUncertainties,
  type FitOptions,
  type GraphCatalog,
  type ImpactTrust,
  type ImpactUncertainty,
} from '@opensip-cli/contracts';
import { createToolLogger, currentScope, resolveChangedFiles } from '@opensip-cli/core';

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
 * Intersect each check's target file list with the changed set; drop empty checks.
 */
export function restrictFileMapToChanged(
  scopeMap: Map<string, readonly string[]>,
  changedAbs: ReadonlySet<string>,
): Map<string, readonly string[]> {
  const narrowed = new Map<string, readonly string[]>();
  for (const [slug, files] of scopeMap) {
    const intersection = files.filter((f) => changedAbs.has(path.resolve(f)));
    if (intersection.length > 0) {
      narrowed.set(slug, intersection);
    }
  }
  return narrowed;
}
