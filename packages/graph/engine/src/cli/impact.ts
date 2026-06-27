/**
 * `opensip graph impact` — read-only changed→impact analysis (ADR-0085, spec §5.3).
 */
import path from 'node:path';

import { computeImpact, type GraphImpactResult } from '@opensip-cli/contracts';
import {
  ConfigurationError,
  createToolLogger,
  resolveChangedFiles,
  SystemError,
  ToolError,
} from '@opensip-cli/core';

import { CatalogRepo } from '../persistence/catalog-repo.js';

import { runGraph } from './orchestrate.js';

import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

const log = createToolLogger('graph:cli');

export interface ImpactCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly raw?: boolean;
  readonly changed?: boolean;
  readonly since?: string;
  readonly files?: readonly string[];
  readonly top?: string;
  readonly noCache?: boolean;
}

function parseTopCap(top?: string): number | undefined {
  if (top === undefined || top === '') return undefined;
  const n = Number.parseInt(top, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigurationError(`Invalid --top value "${top}": must be a non-negative integer`);
  }
  return n;
}

function toPosixRelative(cwd: string, filePath: string): string {
  const normalized = path.normalize(filePath);
  if (path.isAbsolute(normalized)) {
    return path.relative(cwd, normalized).split(path.sep).join('/');
  }
  return normalized.split(path.sep).join('/');
}

function recommendedCommands(): readonly string[] {
  return [
    'opensip fit --changed --include-impacted --json',
    'opensip fit --recipe agent-risk --json --filter high-impact',
    'opensip graph --recipe agent-final --gate-compare',
  ];
}

function humanImpactLines(result: GraphImpactResult): readonly string[] {
  const changed = result.changedFunctions.length;
  const impacted = result.impactedFunctions.length;
  const packages = result.impactedPackages.length;
  const lines = [
    `Changed ${String(result.changedFiles.length)} file(s) → ${String(changed)} function(s)`,
    `Impacted ${String(impacted)} additional function(s) across ${String(packages)} package(s)`,
  ];
  if (result.truncated) {
    lines.push('(truncated — use --top to cap or --json for full detail)');
  }
  lines.push('', 'Recommended next commands:');
  for (const cmd of result.recommendedCommands) {
    lines.push(`  ${cmd}`);
  }
  return lines;
}

function resolveImpactBasis(opts: ImpactCommandOptions): {
  changedFiles: readonly string[];
  basis: GraphImpactResult['basis'];
} {
  const explicitFiles = opts.files ?? [];
  if (explicitFiles.length > 0) {
    const changedFiles = explicitFiles.map((f) => toPosixRelative(opts.cwd, f));
    return { changedFiles, basis: { type: 'files', files: changedFiles } };
  }
  if (opts.changed === true || opts.since) {
    const resolved = resolveChangedFiles(opts.cwd, { since: opts.since });
    if (!resolved.ok) {
      throw new ConfigurationError(resolved.message, { code: resolved.reason });
    }
    return { changedFiles: resolved.files, basis: resolved.basis };
  }
  throw new ConfigurationError('impact: specify --changed, --since <ref>, or --files <paths...>');
}

async function emitImpactOutput(
  cli: ToolCliContext,
  result: GraphImpactResult,
  opts: Pick<ImpactCommandOptions, 'json' | 'raw'>,
): Promise<void> {
  if (opts.json === true) {
    if (opts.raw === true) {
      cli.emitRaw(result);
    } else {
      cli.emitJson(result);
    }
    return;
  }
  await cli.render({
    type: 'graph-status',
    lines: [...humanImpactLines(result)],
  });
}

async function loadOrBuildCatalog(
  cwd: string,
  datastore: DataStore,
  noCache?: boolean,
): Promise<NonNullable<ReturnType<CatalogRepo['loadCatalogContract']>>> {
  const repo = new CatalogRepo(datastore);
  let catalog = repo.loadCatalogContract();
  if (catalog !== null && noCache !== true) return catalog;

  await runGraph({ cwd, noCache: noCache === true, datastore });
  catalog = repo.loadCatalogContract();
  if (!catalog) {
    throw new ConfigurationError(
      'impact: No graph catalog found after rebuild. Run `opensip graph` first.',
    );
  }
  return catalog;
}

/**
 * Run `graph impact` and return a {@link GraphImpactResult}.
 *
 * @throws {ConfigurationError} when basis resolution or catalog load fails.
 * @throws {SystemError} on unexpected failures.
 */
export async function executeImpact(
  opts: ImpactCommandOptions,
  cli: ToolCliContext,
): Promise<GraphImpactResult> {
  log.info({ evt: 'graph.cli.impact.start', module: 'graph:cli' });
  try {
    const datastore = cli.scope.datastore() as DataStore | undefined;
    if (!datastore) {
      throw new ConfigurationError('impact: graph impact requires a DataStore on ToolCliContext.');
    }

    const { changedFiles, basis } = resolveImpactBasis(opts);

    const catalog = await loadOrBuildCatalog(opts.cwd, datastore, opts.noCache);
    const topCap = parseTopCap(opts.top);
    const computation = computeImpact(catalog, changedFiles, { top: topCap });

    const result: GraphImpactResult = {
      type: 'graph-impact',
      basis,
      changedFiles,
      changedFunctions: computation.changedFunctions,
      impactedFunctions: computation.impactedFunctions,
      impactedPackages: computation.impactedPackages,
      recommendedCommands: recommendedCommands(),
      truncated: computation.truncated,
    };

    cli.setExitCode(0);
    log.info({
      evt: 'graph.cli.impact.complete',
      module: 'graph:cli',
      changedFiles: changedFiles.length,
      impactedFunctions: computation.impactedFunctions.length,
      impactedPackages: computation.impactedPackages.length,
    });

    await emitImpactOutput(cli, result, opts);

    return result;
  } catch (error) {
    log.error({
      evt: 'graph.cli.impact.error',
      err: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof ToolError) throw error;
    throw new SystemError(`impact: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
