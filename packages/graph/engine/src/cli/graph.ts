// @fitness-ignore-file error-handling-quality -- CLI output baseline-write at line 597 is best-effort by design ("don't fail the run"); the comment + v8-ignore at the catch already document that user-visible behavior is unaffected if the persistence layer hiccups.
/**
 * `opensip-tools graph` — main subcommand handler.
 *
 * Runs the full pipeline and prints a comprehensive report covering
 * rules, entry points, and catalog summary in one invocation. Per
 * DEC-8, a switch in this handler dispatches to the right renderer.
 *
 * History: v0.2 originally split this into three subcommands (`graph`,
 * `graph-orphans`, `graph-entry-points`). The two filtered views are
 * now sections in this unified report.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { EXIT_CODES, SessionRepo } from '@opensip-tools/contracts';
import {
  ConfigurationError,
  generatePrefixedId,
  logger,
  ToolError,
  ValidationError,
} from '@opensip-tools/core';
import { reportToCloud } from '@opensip-tools/fitness';

import { compareToBaseline, fingerprintSignal, saveBaseline } from '../gate.js';
import { GraphBaselineRepo } from '../persistence/baseline-repo.js';
import { renderCatalogJson } from '../render/catalog-json.js';
import { buildCliOutput, buildCliOutputFromFindings, renderJson } from '../render/json.js';
import { renderSarif } from '../render/sarif.js';
import { inferEntryPoints } from '../rules/_entry-points.js';
import { currentRules } from '../rules/registry.js';

import { runGraph } from './orchestrate.js';
import { runPackagesInParallel } from './packages-runner.js';
import { MemoryPressureError } from './pressure-monitor.js';
import { discoverWorkspacePackages, resolvePackageScope } from './scope.js';

import type { PackageRunResult } from './packages-runner.js';
import type { EntryPoint } from '../rules/_entry-points.js';
import type { Catalog, Indexes } from '../types.js';
import type { FindingOutput } from '@opensip-tools/contracts';
import type { Signal, ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

const ENTRY_POINTS_PREVIEW = 10;
const FINDINGS_PREVIEW = 10;

const EVT_GRAPH_COMPLETE = 'graph.cli.graph.complete';
const MODULE_GRAPH_CLI = 'graph:cli';
const MODULE_GRAPH_RENDER = 'graph:render';

function countFiles(catalog: Catalog): number {
  const files = new Set<string>();
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (!occs) continue;
    for (const o of occs) files.add(o.filePath);
  }
  return files.size;
}

function countOccurrences(catalog: Catalog): number {
  let n = 0;
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (occs) n += occs.length;
  }
  return n;
}

export interface GraphCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly noCache?: boolean;
  readonly gateSave?: boolean;
  readonly gateCompare?: boolean;
  readonly baseline?: string;
  readonly reportTo?: string;
  readonly apiKey?: string;
  /**
   * Optional --package <name|path> scope. When set, the run targets a
   * single workspace package's tsconfig instead of the whole project.
   * See docs/plans/graph-performance-improvements.md Phase 6.
   */
  readonly packageScope?: string;
  /**
   * Optional --packages flag (no argument). When set, the run fans out
   * across every workspace package under packages/** with a tsconfig.
   * Each package runs in its own child process; findings are
   * aggregated in the parent. Wave 3 of the perf plan.
   */
  readonly allPackages?: boolean;
  /**
   * Optional concurrency cap for --packages. Defaults to
   * `os.cpus().length - 1`. Exposed primarily for tests.
   */
  readonly packagesConcurrency?: number;
  /**
   * Path to the CLI entry script. When --packages is set, child
   * processes invoke `node <cliScript> graph --package <dir> --json`.
   * Tools wiring `executeGraph` should pass `process.argv[1]`.
   */
  readonly cliScript?: string;
  /**
   * --catalog-output <path>. When set, runs in catalog-JSON emission
   * mode: walks the engine's `Catalog` + edges, derives opensip-
   * compatible symbol/edge IDs, and writes a `CatalogExport` JSON
   * document to the path. File output (not stdout) because catalog
   * JSON for 100k-file repos exceeds practical stdout buffer sizes.
   *
   * Required companion opts when set: `tenantId`, `repoId`, `gitSha`.
   * `runId` is auto-generated if not provided.
   *
   * Phase 3 Task 3.4 per opensip DEC-498. Phase 6's
   * EngineSubprocessPort invokes this mode per commit-sync run.
   */
  readonly catalogOutput?: string;
  /** Tenant scope for catalog-output provenance. */
  readonly tenantId?: string;
  /** Repository scope — applied to every row in catalog-output. */
  readonly repoId?: string;
  /** Commit SHA the catalog was extracted at — provenance for every row. */
  readonly gitSha?: string;
  /** Optional UUID for the catalog-output run. Auto-generated if absent. */
  readonly runId?: string;
}

export async function executeGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  logger.info({ evt: 'graph.cli.graph.start', module: MODULE_GRAPH_CLI, cwd: opts.cwd });
  const startedAt = new Date().toISOString();
  try {
    validateMutuallyExclusiveFlags(opts);
    if (opts.allPackages === true) {
      await executePackagesGraph(opts, cli);
      return;
    }
    const { runCwd, runTsConfig } = resolveRunScope(opts);
    const result = await runGraph({
      cwd: runCwd,
      noCache: opts.noCache,
      tsConfigPath: runTsConfig,
      datastore: cli.scope.datastore() as DataStore | undefined,
    });
    await dispatchGraphResult(opts, result, cli, startedAt);
  } catch (error) {
    handleGraphError('graph', error, cli);
  }
}

function validateMutuallyExclusiveFlags(opts: GraphCommandOptions): void {
  if (opts.gateSave === true && opts.gateCompare === true) {
    throw new ConfigurationError('--gate-save and --gate-compare are mutually exclusive.');
  }
  if (
    opts.allPackages === true &&
    typeof opts.packageScope === 'string' &&
    opts.packageScope.length > 0
  ) {
    throw new ConfigurationError('--package and --packages are mutually exclusive.');
  }
}

function resolveRunScope(opts: GraphCommandOptions): {
  readonly runCwd: string;
  readonly runTsConfig: string | undefined;
} {
  if (typeof opts.packageScope !== 'string' || opts.packageScope.length === 0) {
    return { runCwd: opts.cwd, runTsConfig: undefined };
  }
  const scope = resolvePackageScope({ cwd: opts.cwd, packageArg: opts.packageScope });
  logger.info({
    evt: 'graph.cli.graph.scope',
    module: MODULE_GRAPH_CLI,
    package: opts.packageScope,
    packageDir: scope.packageDirAbs,
  });
  return { runCwd: scope.packageDirAbs, runTsConfig: scope.tsConfigPathAbs };
}

async function dispatchGraphResult(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
  cli: ToolCliContext,
  startedAt: string,
): Promise<void> {
  if (opts.gateSave === true || opts.gateCompare === true) {
    await runGateMode(opts, result.signals, cli);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI });
    return;
  }
  if (typeof opts.reportTo === 'string' && opts.reportTo.length > 0) {
    await runReportMode(opts, result.signals, cli);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI });
    return;
  }
  if (typeof opts.catalogOutput === 'string' && opts.catalogOutput.length > 0) {
    runCatalogJsonMode(opts, result, cli, startedAt);
    logger.info({ evt: EVT_GRAPH_COMPLETE, module: MODULE_GRAPH_CLI });
    return;
  }
  renderGraphResult(opts, result);
  // `--json` is a peer of --gate-save / --gate-compare / --report-to /
  // --catalog-output: the run's purpose is producing a machine-readable
  // artifact, not populating dashboard session history. Skipping the
  // session write here also means children spawned by
  // `executePackagesGraph` (which always run with --json) don't each
  // write a row — the parent persists exactly one aggregate session
  // for the whole `--packages` invocation.
  if (opts.json !== true) {
    persistSession(opts, result.signals, cli.scope.datastore() as DataStore | undefined);
  }
  cli.setExitCode(EXIT_CODES.SUCCESS);
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    signals: result.signals.length,
  });
}

function renderGraphResult(
  opts: GraphCommandOptions,
  result: Awaited<ReturnType<typeof runGraph>>,
): void {
  if (opts.json === true) {
    logger.info({ evt: 'graph.render.json.start', module: MODULE_GRAPH_RENDER });
    const out = renderJson(result.signals, { cwd: opts.cwd, tool: 'graph', command: 'graph' });
    process.stdout.write(`${out}\n`);
    logger.info({ evt: 'graph.render.json.complete', module: MODULE_GRAPH_RENDER });
    return;
  }
  logger.info({ evt: 'graph.render.table.start', module: MODULE_GRAPH_RENDER });
  writeUnifiedReport({
    catalog: result.catalog,
    indexes: result.indexes,
    signals: result.signals,
    cacheHit: result.cacheHit,
  });
  logger.info({ evt: 'graph.render.table.complete', module: MODULE_GRAPH_RENDER });
}

/**
 * `graph --packages` — fan a graph run out across every workspace
 * package under <cwd>/packages/** and aggregate the findings. Each
 * package runs in its own child process; per-package memory ceiling
 * scales naturally. See docs/plans/graph-performance-improvements.md
 * Wave 3.
 */
async function executePackagesGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) {
    throw new ConfigurationError(
      '--packages: could not determine the CLI entry script (process.argv[1] is empty).',
    );
  }
  const packageDirs = discoverWorkspacePackages(opts.cwd);
  if (packageDirs.length === 0) {
    throw new ConfigurationError(
      `--packages: no workspace packages with tsconfig.json found under ${opts.cwd}/packages/**.`,
    );
  }

  const startedAt = Date.now();
  const result = await runPackagesInParallel({
    cwd: opts.cwd,
    packageDirs,
    cliScript,
    concurrency: opts.packagesConcurrency,
    noCache: opts.noCache,
  });
  const durationMs = Date.now() - startedAt;

  const allFindings: FindingOutput[] = [];
  for (const r of result.perPackage) allFindings.push(...r.findings);

  if (opts.json === true) {
    process.stdout.write(`${renderPackagesJson(result.perPackage, durationMs)}\n`);
  } else {
    writePackagesReport(result.perPackage, durationMs);
    // Persist exactly one aggregate session for the whole --packages
    // invocation. Matches the contract "one human-facing CLI invocation
    // = one session" that fitness/sim already follow; the per-package
    // child processes don't persist because they always run with --json
    // (see dispatchGraphResult).
    persistPackagesSession(opts, allFindings, durationMs, cli);
  }

  // If any child failed to spawn or exited with an error, surface it
  // as a runtime error. The parent itself succeeded if every child
  // returned exit 0.
  if (result.anyChildFailed) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(
      `graph --packages: at least one package run failed; see per-package output above.\n`,
    );
  } else {
    cli.setExitCode(EXIT_CODES.SUCCESS);
  }
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    packages: result.perPackage.length,
    findings: allFindings.length,
    failed: result.anyChildFailed,
    durationMs,
  });
}

function writePackagesReport(
  perPackage: readonly PackageRunResult[],
  durationMs: number,
): void {
  const totalFindings = perPackage.reduce((n, r) => n + r.findings.length, 0);
  const lines: string[] = [
    'opensip-tools graph --packages',
    '',
    `== Packages (${String(perPackage.length)}) ==`,
    ...renderPackagesStatusLines(perPackage),
    '',
    '== Findings ==',
    ...renderPackagesFindingsLines(perPackage),
    '== Summary ==',
    `${String(totalFindings)} total finding(s) across ${String(perPackage.length)} package(s) in ${String(durationMs)} ms.`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function renderPackagesStatusLines(perPackage: readonly PackageRunResult[]): readonly string[] {
  const out: string[] = [];
  for (const r of perPackage) {
    const status = r.exitCode === 0 ? 'ok' : `FAILED (exit ${String(r.exitCode)})`;
    const display = packageDisplay(r);
    out.push(`  ${display}: ${String(r.findings.length)} finding(s) — ${status}`);
    if (r.exitCode !== 0 && r.stderr.length > 0) {
      const stderrPreview = r.stderr.split('\n').slice(0, 3).join('\n    ');
      out.push(`    stderr: ${stderrPreview}`);
    }
  }
  return out;
}

function renderPackagesFindingsLines(perPackage: readonly PackageRunResult[]): readonly string[] {
  const out: string[] = [];
  for (const r of perPackage) {
    if (r.findings.length === 0) continue;
    out.push(`[${packageDisplay(r)}]`, ...renderPackageFindingPreview(r), '');
  }
  return out;
}

function renderPackageFindingPreview(r: PackageRunResult): readonly string[] {
  const preview = r.findings.slice(0, FINDINGS_PREVIEW);
  const lines = preview.map((f) => {
    const loc = typeof f.line === 'number' ? `:${String(f.line)}` : '';
    return `  ${f.filePath}${loc} — ${f.message}`;
  });
  if (r.findings.length > preview.length) {
    lines.push(`  ... ${String(r.findings.length - preview.length)} more (use --json for full list)`);
  }
  return lines;
}

function packageDisplay(r: PackageRunResult): string {
  return r.displayPath.length > 0 ? r.displayPath : r.packageDir;
}

function renderPackagesJson(
  perPackage: readonly PackageRunResult[],
  durationMs: number,
): string {
  return JSON.stringify(
    {
      version: '1.0',
      tool: 'graph',
      command: 'graph',
      mode: 'packages',
      timestamp: new Date().toISOString(),
      durationMs,
      packages: perPackage.map((r) => ({
        packageDir: r.packageDir,
        displayPath: r.displayPath,
        exitCode: r.exitCode,
        findings: r.findings,
      })),
      totalFindings: perPackage.reduce((n, r) => n + r.findings.length, 0),
    },
    null,
    2,
  );
}

export interface UnifiedReportInput {
  readonly catalog: Catalog | null;
  readonly indexes: Indexes | null;
  readonly signals: readonly Signal[];
  readonly cacheHit: boolean;
}

/**
 * Build the unified terminal report lines: catalog summary, findings
 * grouped by rule, top-N entry points, and a single-line summary. The
 * caller decides where to write them (raw stdout for non-interactive
 * paths, or the Ink view in the default human-report path).
 */
export function buildUnifiedReportLines(input: UnifiedReportInput): readonly string[] {
  const knownRuleIds = currentRules().map((r) => r.slug);
  const byRule = groupSignalsByRule(input.signals);
  const eps = input.catalog && input.indexes
    ? enrichEntryPoints(input.catalog, input.indexes)
    : [];

  return [
    ...renderCatalogSection(input.catalog, input.cacheHit),
    '',
    ...renderFindingsSection(input.signals.length, byRule, knownRuleIds),
    ...renderEntryPointsSection(eps),
    '',
    ...renderSummarySection(byRule, knownRuleIds, input.signals.length),
  ];
}

function writeUnifiedReport(input: UnifiedReportInput): void {
  const lines = ['opensip-tools graph', '', ...buildUnifiedReportLines(input)];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function renderCatalogSection(catalog: Catalog | null, cacheHit: boolean): readonly string[] {
  const lines: string[] = ['== Catalog =='];
  if (catalog) {
    const fileCount = countFiles(catalog);
    const fnCount = countOccurrences(catalog);
    lines.push(
      `${String(fnCount)} functions across ${String(fileCount)} files (cacheHit=${String(cacheHit)})`,
    );
  } else {
    /* v8 ignore next */
    lines.push('(no catalog produced)');
  }
  return lines;
}

function renderFindingsSection(
  totalSignals: number,
  byRule: ReadonlyMap<string, readonly Signal[]>,
  knownRuleIds: readonly string[],
): readonly string[] {
  const lines: string[] = [`== Findings (${String(totalSignals)}) ==`];
  for (const ruleId of knownRuleIds) {
    lines.push(...renderRuleBlock(ruleId, byRule.get(ruleId) ?? []));
  }
  return lines;
}

function renderRuleBlock(ruleId: string, findings: readonly Signal[]): readonly string[] {
  const header = `[${ruleId}] ${String(findings.length)} finding(s)`;
  const preview = findings.slice(0, FINDINGS_PREVIEW).map((f) => {
    const loc = f.line ? `:${String(f.line)}` : '';
    return `  ${f.filePath}${loc} — ${f.message}`;
  });
  const overflow = findings.length > preview.length
    /* v8 ignore next */
    ? [`  ... ${String(findings.length - preview.length)} more (use --json for full list)`]
    : [];
  return [header, ...preview, ...overflow, ''];
}

function renderEntryPointsSection(eps: readonly EnrichedEntryPoint[]): readonly string[] {
  const header = `== Entry points (${String(eps.length)}) ==`;
  if (eps.length === 0) return [header, '(none inferred)'];
  const top = [...eps].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)).slice(0, ENTRY_POINTS_PREVIEW);
  const intro = `Top ${String(top.length)} (use --json for full list):`;
  const items = top.map((ep) => `  [${ep.reason}] ${ep.qualifiedName}`);
  return [header, intro, ...items];
}

function renderSummarySection(
  byRule: ReadonlyMap<string, readonly Signal[]>,
  knownRuleIds: readonly string[],
  totalSignals: number,
): readonly string[] {
  const stats = summarizeRules(byRule, knownRuleIds);
  return [
    '== Summary ==',
    `${String(stats.clean)} rule(s) clean, ${String(stats.dirty)} with findings (${String(totalSignals)} total).`,
    'Run `opensip-tools dashboard` for the interactive Code Paths view.',
  ];
}

interface EnrichedEntryPoint {
  readonly reason: EntryPoint['reason'];
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
}

function enrichEntryPoints(catalog: Catalog, indexes: Indexes): readonly EnrichedEntryPoint[] {
  const eps = inferEntryPoints(catalog, indexes);
  const out: EnrichedEntryPoint[] = [];
  for (const ep of eps) {
    const occ = indexes.byBodyHash.get(ep.bodyHash);
    if (!occ) continue;
    out.push({
      reason: ep.reason,
      qualifiedName: occ.qualifiedName,
      filePath: occ.filePath,
      line: occ.line,
    });
  }
  return out;
}

function groupSignalsByRule(signals: readonly Signal[]): ReadonlyMap<string, readonly Signal[]> {
  const out = new Map<string, Signal[]>();
  for (const s of signals) {
    let arr = out.get(s.ruleId);
    if (!arr) {
      arr = [];
      out.set(s.ruleId, arr);
    }
    arr.push(s);
  }
  return out;
}

function summarizeRules(
  byRule: ReadonlyMap<string, readonly Signal[]>,
  knownRuleIds: readonly string[],
): { readonly clean: number; readonly dirty: number } {
  let clean = 0;
  let dirty = 0;
  for (const ruleId of knownRuleIds) {
    const findings = byRule.get(ruleId) ?? [];
    if (findings.length === 0) clean += 1;
    else dirty += 1;
  }
  return { clean, dirty };
}

function persistSession(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  datastore: DataStore | undefined,
): void {
  if (!datastore) return;
  saveGraphSession(opts, buildCliOutput(signals, 'graph'), datastore);
}

function persistPackagesSession(
  opts: GraphCommandOptions,
  findings: readonly FindingOutput[],
  durationMs: number,
  cli: ToolCliContext,
): void {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (!datastore) return;
  saveGraphSession(opts, buildCliOutputFromFindings(findings, 'graph', durationMs), datastore);
}

function saveGraphSession(
  opts: GraphCommandOptions,
  cliOutput: ReturnType<typeof buildCliOutput>,
  datastore: DataStore,
): void {
  try {
    const repo = new SessionRepo(datastore);
    repo.save({
      id: generatePrefixedId('graph'),
      tool: 'graph',
      timestamp: cliOutput.timestamp,
      cwd: opts.cwd,
      score: cliOutput.score,
      passed: cliOutput.passed,
      summary: cliOutput.summary,
      checks: cliOutput.checks.map((c) => ({
        checkSlug: c.checkSlug,
        passed: c.passed,
        violationCount: c.violationCount,
        findings: c.findings.map((f) => ({
          ruleId: f.ruleId,
          message: f.message,
          severity: f.severity,
          filePath: f.filePath,
          line: f.line,
          column: f.column,
          suggestion: f.suggestion,
        })),
        durationMs: c.durationMs,
      })),
      durationMs: cliOutput.durationMs,
    });
  } catch {
    /* v8 ignore next */
    // best effort; don't fail the run
  }
}

function handleGraphError(label: string, error: unknown, cli: ToolCliContext): void {
  logger.error({
    evt: `graph.cli.${label}.error`,
    module: MODULE_GRAPH_CLI,
    err: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof ConfigurationError) {
    cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  } else {
    /* v8 ignore start */
    if (error instanceof ValidationError) {
      cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    } else if (error instanceof MemoryPressureError) {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    } else if (error instanceof ToolError) {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    } else {
      cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    }
    /* v8 ignore stop */
  }
  process.stderr.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
}

async function runGateMode(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
): Promise<void> {
  const datastore = cli.scope.datastore() as DataStore | undefined;
  if (!datastore) {
    throw new ConfigurationError('Graph gate mode requires a DataStore on ToolCliContext.');
  }
  const repo = new GraphBaselineRepo(datastore);
  if (opts.gateSave === true) {
    saveBaseline(signals, repo);
    process.stdout.write(`Graph baseline saved (${String(signals.length)} signals)\n`);
    cli.setExitCode(EXIT_CODES.SUCCESS);
    return;
  }
  // gate-compare
  const result = compareToBaseline(signals, repo);
  if (result.degraded) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stdout.write(
      `Graph gate FAILED: ${String(result.newSignals.length)} new finding(s) since baseline.\n`,
    );
    for (const s of result.newSignals) {
      process.stdout.write(`  + ${fingerprintSignal(s)}\n`);
    }
  } else {
    cli.setExitCode(EXIT_CODES.SUCCESS);
    process.stdout.write(
      `Graph gate PASS: no regressions (${String(result.resolvedFingerprints.length)} resolved since baseline).\n`,
    );
  }
  // Defer-await is fine; nothing else to do.
  await Promise.resolve();
}

/**
 * Send graph findings to an external reporting endpoint (`--report-to`).
 *
 * @throws {Error} When `opts.reportTo` is unexpectedly undefined — the CLI
 *   dispatcher only routes here when `--report-to` is set, so this is an
 *   invariant violation in the caller, not a user-input error.
 */
async function runReportMode(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
): Promise<void> {
  const cliOutput = buildCliOutput(signals, 'graph');
  // Caller wires runReportMode only when opts.reportTo is set; guard to satisfy
  // the type system without `!`.
  if (!opts.reportTo) {
    throw new Error('runReportMode: opts.reportTo must be defined');
  }
  const url = opts.reportTo;
  // toolVersion tracks @opensip-tools/graph package.json's version. Manually
  // synced — bump alongside any package.json version change. A future
  // build-time constant via tsc plugin or import-assertion would remove this
  // drift risk; not warranted for a single call site.
  const sarif = renderSarif(signals, {
    tool: 'opensip-tools-graph',
    toolVersion: '2.0.0',
  });
  const result = await reportToCloud(cliOutput, url, opts.apiKey);
  if (!result.success) {
    cli.setExitCode(EXIT_CODES.REPORT_FAILED);
    process.stderr.write(`Graph report failed: ${result.error ?? 'unknown error'}\n`);
    return;
  }
  cli.setExitCode(EXIT_CODES.SUCCESS);
  process.stdout.write(
    `Graph report sent to ${url} (${String(signals.length)} signals, ${sarif.length} bytes).\n`,
  );
}

/**
 * Catalog-JSON emission mode (Phase 3 Task 3.4 per opensip DEC-498).
 * Walks the engine's `Catalog` + `Indexes`, derives opensip-compatible
 * symbol/edge IDs, and writes a `CatalogExport` JSON document to the
 * `--catalog-output <path>` file. Phase 6's `EngineSubprocessPort`
 * invokes this mode per commit-sync run.
 *
 * Synchronous file write — catalog payloads are bounded (per-package
 * fan-out limits per-run scope) and we want backpressure if disk is
 * full rather than a deferred-write surprise.
 *
 * @throws {ConfigurationError} When `--catalog-output` is set but a
 *   required provenance flag (`--tenant-id`, `--repo-id`, `--git-sha`)
 *   is missing or empty, or when `opts.catalogOutput` itself is unset.
 * @throws {ToolError} When the engine returned a null catalog/indexes
 *   pair (no parseable input).
 */
function runCatalogJsonMode(
  opts: GraphCommandOptions,
  result: {
    readonly catalog: Catalog | null;
    readonly indexes: Indexes | null;
    readonly signals: readonly Signal[];
    readonly cacheHit: boolean;
  },
  cli: ToolCliContext,
  startedAt: string,
): void {
  if (typeof opts.tenantId !== 'string' || opts.tenantId.length === 0) {
    throw new ConfigurationError('--catalog-output requires --tenant-id <id>.');
  }
  if (typeof opts.repoId !== 'string' || opts.repoId.length === 0) {
    throw new ConfigurationError('--catalog-output requires --repo-id <id>.');
  }
  if (typeof opts.gitSha !== 'string' || opts.gitSha.length === 0) {
    throw new ConfigurationError('--catalog-output requires --git-sha <sha>.');
  }
  if (result.catalog === null || result.indexes === null) {
    throw new ToolError(
      'Cannot emit catalog-json: engine returned null catalog / indexes (no parseable input).',
      'GRAPH.CATALOG_JSON.NULL_CATALOG',
    );
  }

  const runId = opts.runId ?? randomUUID();
  const completedAt = new Date().toISOString();
  // Caller (opensip-side EngineSubprocessPort, Phase 6) inspects the
  // file's existence + completeness field; engine never emits 'partial'
  // from this code path (the engine's pressure-monitor / abort-handling
  // bypass this function entirely on failure). A future task may add
  // partial-completion semantics by catching MemoryPressureError in
  // executeGraph and writing a partial CatalogExport here.
  const provenance = {
    runId,
    completeness: 'complete' as const,
    engineVersion: '2.0.0',
    startedAt,
    completedAt,
    tenantId: opts.tenantId,
  };

  logger.info({
    evt: 'graph.render.catalog_json.start',
    module: MODULE_GRAPH_RENDER,
    runId,
    output: opts.catalogOutput,
  });
  const json = renderCatalogJson({
    catalog: result.catalog,
    indexes: result.indexes,
    provenance,
    repoId: opts.repoId,
    gitSha: opts.gitSha,
  });
  // catalogOutput is required to reach this function (CLI options layer
  // routes to runCatalogJsonMode only when --catalog-output is set). Guard
  // explicitly so the type system tracks the narrowing without `!`.
  if (!opts.catalogOutput) {
    throw new ConfigurationError('--catalog-output is required for catalog-json mode.');
  }
  writeFileSync(opts.catalogOutput, json);
  logger.info({
    evt: 'graph.render.catalog_json.complete',
    module: MODULE_GRAPH_RENDER,
    runId,
    output: opts.catalogOutput,
    bytes: json.length,
    cacheHit: result.cacheHit,
    signalCount: result.signals.length,
  });
  cli.setExitCode(EXIT_CODES.SUCCESS);
}
