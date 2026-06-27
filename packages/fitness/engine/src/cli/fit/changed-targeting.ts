/**
 * Changed-file targeting for `fit --changed` (ADR-0085).
 */
import path from 'node:path';

import { computeImpact, type GraphCatalog, type FitOptions } from '@opensip-cli/contracts';
import { createToolLogger, currentScope, resolveChangedFiles } from '@opensip-cli/core';

const log = createToolLogger('fitness:cli');

export interface ChangedSetOk {
  readonly ok: true;
  readonly files: ReadonlySet<string>;
  readonly basis: string;
}

export interface ChangedSetFail {
  readonly ok: false;
  readonly warning: string;
}

export type ChangedSetResult = ChangedSetOk | ChangedSetFail;

function toAbsolute(cwd: string, relativePosix: string): string {
  return path.resolve(cwd, relativePosix.split('/').join(path.sep));
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
      evt: 'fitness.cli.changed.degraded',
      module: 'fitness:cli',
      reason: resolved.reason,
    });
    return { ok: false, warning: resolved.message };
  }

  const fileSet = new Set<string>();
  for (const rel of resolved.files) {
    fileSet.add(toAbsolute(args.cwd, rel));
  }

  if (args.includeImpacted === true) {
    const catalog = currentScope()?.graphCatalog?.() as GraphCatalog | null | undefined;
    if (!catalog) {
      log.warn({
        evt: 'fitness.cli.changed.degraded',
        module: 'fitness:cli',
        reason: 'graph-catalog-unavailable',
      });
      return {
        ok: true,
        files: fileSet,
        basis: `${resolved.basis.type}:changed-only (graph catalog unavailable)`,
      };
    }
    const impact = computeImpact(catalog, resolved.files);
    for (const fn of [...impact.changedFunctions, ...impact.impactedFunctions]) {
      fileSet.add(toAbsolute(args.cwd, fn.filePath));
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
    basis: resolved.basis.ref ? `changed:git:${resolved.basis.ref}` : 'changed:git:working-tree',
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
