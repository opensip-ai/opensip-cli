/**
 * `opensip graph impact` — read-only changed→impact analysis (ADR-0085, spec §5.3).
 */
import { createHash } from 'node:crypto';

import {
  buildSignalEnvelope,
  computeImpact,
  EXIT_CODES,
  gitWarningsToImpactUncertainties,
  type GraphImpactCatalogIdentity,
  type GraphImpactResult,
  type ImpactUncertainty,
  type SignalEnvelope,
  type UnitResult,
} from '@opensip-cli/contracts';
import {
  ConfigurationError,
  createSignal,
  createToolLogger,
  currentScope,
  resolveChangedFiles,
  resolveVerdictPolicy,
  SystemError,
  ToolError,
  toPosixRelative,
  type ChangedFileEntry,
  type Signal,
  type ToolCliContext,
  type ToolSessionContribution,
} from '@opensip-cli/core';

import { graphFingerprintStrategy } from '../baseline-strategy.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import {
  fitProjectionToByteBudget,
  MAX_IMPACT_REPORT_PROJECTION_BYTES,
  projectImpactForReport,
} from '../persistence/impact-report-projection.js';
import { buildGraphSessionPayload } from '../persistence/session-payload.js';

import { contributionFromGraphPayload } from './graph-session-contribution.js';
import { runGraph } from './orchestrate.js';

import type { DataStore } from '@opensip-cli/datastore';

const log = createToolLogger('graph:cli');
const IMPACT_RULE_ID = 'graph.impact.blast-radius';

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
    `Verification coverage: ${result.trust.coverage}${result.trust.fullyVerified ? ' (fully verified)' : ' (broader verification required)'}`,
  ];
  if (result.trust.uncertainties.length > 0) {
    lines.push(`Uncertainty: ${result.trust.uncertainties.map((item) => item.code).join(', ')}`);
  }
  if (result.truncated) {
    lines.push('(truncated — use --top to cap or --json for full detail)');
  }
  lines.push('', 'Recommended next commands:');
  for (const cmd of result.recommendedCommands) {
    lines.push(`  ${cmd}`);
  }
  return lines;
}

function buildImpactSignals(result: GraphImpactResult): readonly Signal[] {
  if (result.impactedFunctions.length === 0) return [];
  const primaryFunction = result.impactedFunctions[0] ?? result.changedFunctions[0];
  const impactedFiles = new Set(result.impactedFunctions.map((fn) => fn.filePath));
  const blastConfidence = blastConfidenceForTrust(result.trust.coverage);
  return [
    createSignal({
      source: 'graph',
      ruleId: IMPACT_RULE_ID,
      severity: 'low',
      category: 'architecture',
      message:
        `Graph impact found ${String(result.impactedFunctions.length)} downstream function(s) ` +
        `for ${String(result.changedFiles.length)} changed file(s).`,
      suggestion: 'Review impacted callers before relying on the changed-code-only result.',
      ...(primaryFunction === undefined
        ? {}
        : {
            code: {
              file: primaryFunction.filePath,
              line: primaryFunction.line,
            },
          }),
      metadata: {
        basis: result.basis,
        changedFiles: result.changedFiles,
        changedFunctions: result.changedFunctions.length,
        impactedFunctions: result.impactedFunctions.length,
        impactedFiles: result.impactedFiles,
        impactedPackages: result.impactedPackages.map((pkg) => pkg.name),
        recommendedCommands: result.recommendedCommands,
        trust: result.trust,
        truncated: result.truncated,
        blastRadius: {
          dependents: result.impactedFunctions.length,
          impactedFiles: impactedFiles.size,
          confidence: blastConfidence,
        },
      },
    }),
  ];
}

function blastConfidenceForTrust(
  coverage: GraphImpactResult['trust']['coverage'],
): 'low' | 'medium' | 'high' {
  if (coverage === 'full') return 'high';
  if (coverage === 'partial') return 'medium';
  return 'low';
}

function buildImpactEnvelope(result: GraphImpactResult, durationMs: number): SignalEnvelope {
  const signals = buildImpactSignals(result);
  const units: UnitResult[] = [
    {
      slug: IMPACT_RULE_ID,
      passed: true,
      violationCount: signals.length,
      durationMs,
    },
  ];
  return buildSignalEnvelope({
    tool: 'graph',
    runId: currentScope()?.runId ?? '',
    createdAt: new Date().toISOString(),
    units,
    signals,
    policy: resolveVerdictPolicy('graph'),
    runFaulted: false,
    fingerprintStrategy: graphFingerprintStrategy,
    verification: result.trust,
  });
}

/** Build graph's generic session contribution for a human-facing `graph impact` run. */
export function buildImpactSessionContribution(
  opts: Pick<ImpactCommandOptions, 'cwd'>,
  result: GraphImpactResult,
): ToolSessionContribution {
  const ordinaryPayload = buildGraphSessionPayload(buildImpactSignals(result), [IMPACT_RULE_ID]);
  const projected = projectImpactForReport(result);
  const impact = fitProjectionToByteBudget(projected, MAX_IMPACT_REPORT_PROJECTION_BYTES);
  const retained = impact ?? projected;
  log.info({
    evt: 'graph.cli.impact.session_projection',
    retainedChangedFiles: impact?.changedFiles.length ?? 0,
    retainedChangedFunctions: impact?.changedFunctions.length ?? 0,
    retainedImpactedFunctions: impact?.impactedFunctions.length ?? 0,
    retainedImpactedFiles: impact?.impactedFiles.length ?? 0,
    retainedImpactedPackages: impact?.impactedPackages.length ?? 0,
    retainedRecommendedCommands: impact?.recommendedCommands.length ?? 0,
    omittedChangedFiles:
      retained.omitted.changedFiles + (impact === undefined ? retained.changedFiles.length : 0),
    omittedChangedFunctions:
      retained.omitted.changedFunctions +
      (impact === undefined ? retained.changedFunctions.length : 0),
    omittedImpactedFunctions:
      retained.omitted.impactedFunctions +
      (impact === undefined ? retained.impactedFunctions.length : 0),
    omittedImpactedFiles:
      retained.omitted.impactedFiles + (impact === undefined ? retained.impactedFiles.length : 0),
    omittedImpactedPackages:
      retained.omitted.impactedPackages +
      (impact === undefined ? retained.impactedPackages.length : 0),
    omittedRecommendedCommands:
      retained.omitted.recommendedCommands +
      (impact === undefined ? retained.recommendedCommands.length : 0),
    trustCoverage: result.trust.coverage,
    sourceTruncated: result.truncated,
    ...(impact === undefined ? { omittedReason: 'projection-overflow' } : {}),
  });
  const payload = {
    ...ordinaryPayload,
    ...(impact === undefined
      ? { impactStatus: 'omitted-overflow' as const }
      : { impactStatus: 'available' as const, impact }),
  };
  return contributionFromGraphPayload({ cwd: opts.cwd }, payload);
}

function digestIdentity(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedCatalogIdentity(catalog: {
  readonly builtAt: string;
  readonly language: string;
  readonly filesFingerprint?: string;
  readonly resolutionMode?: 'exact' | 'fast';
  readonly cacheKey?: string;
}): GraphImpactCatalogIdentity | undefined {
  if (
    catalog.filesFingerprint === undefined ||
    catalog.cacheKey === undefined ||
    catalog.builtAt.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(catalog.builtAt) ||
    !Number.isFinite(Date.parse(catalog.builtAt)) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/u.test(catalog.language)
  ) {
    return undefined;
  }
  return {
    builtAt: catalog.builtAt,
    language: catalog.language,
    // Raw file fingerprints contain absolute paths. A digest preserves
    // equality while keeping result/session evidence project-root-free.
    filesFingerprint: digestIdentity(catalog.filesFingerprint),
    ...(catalog.resolutionMode === undefined ? {} : { resolutionMode: catalog.resolutionMode }),
    cacheKeyDigest: digestIdentity(catalog.cacheKey),
  };
}

function resolveImpactBasis(opts: ImpactCommandOptions): {
  changedFiles: readonly string[];
  basis: GraphImpactResult['basis'];
  entries: readonly ChangedFileEntry[];
  uncertainties: readonly ImpactUncertainty[];
} {
  const explicitFiles = opts.files ?? [];
  if (explicitFiles.length > 0) {
    const changedFiles = explicitFiles.map((f) => toPosixRelative(opts.cwd, f));
    return {
      changedFiles,
      basis: { type: 'files', files: changedFiles },
      entries: changedFiles.map((path) => ({ path, status: 'unknown' })),
      uncertainties: [],
    };
  }
  if (opts.changed === true || opts.since) {
    const resolved = resolveChangedFiles(opts.cwd, { since: opts.since });
    if (!resolved.ok) {
      throw new ConfigurationError(resolved.message, { code: resolved.reason });
    }
    return {
      changedFiles: resolved.files,
      basis: resolved.basis,
      entries: resolved.entries,
      uncertainties: gitWarningsToImpactUncertainties(resolved.basis.warnings),
    };
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
  const startedAt = Date.now();
  log.info({ evt: 'graph.cli.impact.start', module: 'graph:cli' });
  try {
    const datastore = cli.scope.datastore() as DataStore | undefined;
    if (!datastore) {
      throw new ConfigurationError('impact: graph impact requires a DataStore on ToolCliContext.');
    }

    const { changedFiles, basis, entries, uncertainties } = resolveImpactBasis(opts);

    const catalog = await loadOrBuildCatalog(opts.cwd, datastore, opts.noCache);
    const topCap = parseTopCap(opts.top);
    const computation = computeImpact(catalog, changedFiles, {
      top: topCap,
      changedFileEntries: entries,
      uncertainties,
    });
    const catalogIdentity = boundedCatalogIdentity(catalog);

    const result: GraphImpactResult = {
      type: 'graph-impact',
      ...(catalogIdentity === undefined ? {} : { catalog: catalogIdentity }),
      basis,
      changedFiles,
      changedFunctions: computation.changedFunctions,
      impactedFunctions: computation.impactedFunctions,
      impactedPackages: computation.impactedPackages,
      impactedFiles: computation.impactedFiles,
      trust: computation.trust,
      recommendedCommands: recommendedCommands(),
      truncated: computation.truncated,
    };

    cli.setExitCode(EXIT_CODES.SUCCESS);
    const envelope = buildImpactEnvelope(result, Math.max(0, Date.now() - startedAt));
    await cli.deliverSignals(envelope, {
      cwd: opts.cwd,
      runFailed: !envelope.verdict.passed,
    });
    log.info({
      evt: 'graph.cli.impact.complete',
      module: 'graph:cli',
      changedFiles: changedFiles.length,
      impactedFunctions: computation.impactedFunctions.length,
      impactedPackages: computation.impactedPackages.length,
      trustCoverage: computation.trust.coverage,
      fullyVerified: computation.trust.fullyVerified,
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
