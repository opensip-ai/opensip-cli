/**
 * `opensip-tools graph` — main subcommand handler.
 *
 * Runs the full pipeline and prints a comprehensive report covering
 * rules, entry points, and catalog summary in one invocation. Per
 * DEC-8, a switch in this handler dispatches to the right renderer.
 *
 * CLI shape (language-neutral):
 *   - `graph` — whole project, auto-detected language(s)
 *   - `graph <path> [<path>...]` — scope to one or more subtrees
 *   - `graph --workspace` — fan out across detected workspace units
 *     (polyglot: aggregates every adapter's units per spec D8b)
 *   - `graph --language <name>` — force a single adapter
 *
 * History: v0.2 originally split this into three subcommands (`graph`,
 * `graph-orphans`, `graph-entry-points`). The two filtered views are
 * now sections in this unified report. The TS-flavored `--package` /
 * `--packages` flags were retired in favor of the polyglot surface
 * above; see docs/plans/graph-cli-language-neutral-scoping/.
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

import { detectLanguages } from './detect.js';
import { runGraph } from './orchestrate.js';
import { positionalPathLabel, resolvePositionalPaths } from './positional-paths.js';
import { MemoryPressureError } from './pressure-monitor.js';
import {
  discoverPolyglotUnits,
  runWorkspaceUnitsInParallel,
  type WorkspaceUnitRunResult,
} from './workspace-runner.js';

import type { EntryPoint } from '../rules/_entry-points.js';
import type { Catalog, Indexes } from '../types.js';
import type { FindingOutput } from '@opensip-tools/contracts';
import type { LanguageAdapter, Signal, ToolCliContext } from '@opensip-tools/core';
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
   * Positional `[paths...]`. Empty/undefined means whole-project scope.
   * Each path must be an existing directory (absolute or relative to
   * `cwd`). Multiple paths run sequentially in-process and aggregate
   * into one session (D12).
   */
  readonly paths?: readonly string[];
  /**
   * `--workspace`: fan the run across every workspace unit returned by
   * each detected adapter's `discoverWorkspaceUnits`. Polyglot per
   * spec D8b: in a multi-language repo all adapters' units are
   * aggregated into one combined fan-out.
   */
  readonly workspace?: boolean;
  /**
   * `--language <name>`: force a single language adapter. Suppresses
   * marker-based detection. Errors if the name is not registered.
   */
  readonly language?: string;
  /**
   * Optional concurrency cap for `--workspace`. Defaults to
   * `os.cpus().length - 1`. Exposed primarily for tests.
   */
  readonly concurrency?: number;
  /**
   * Path to the CLI entry script. `--workspace` children invoke
   * `node <cliScript> graph <rootDir> --json`. Tools wiring
   * `executeGraph` should pass `process.argv[1]`.
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
    if (opts.workspace === true) {
      await executeWorkspaceGraph(opts, cli);
      return;
    }
    const positionalPaths = resolvePositionalScope(opts);
    if (positionalPaths.length > 1) {
      await executeMultiPathGraph(opts, positionalPaths, cli, startedAt);
      return;
    }
    const runCwd = positionalPaths[0] ?? opts.cwd;
    const result = await runGraph({
      cwd: runCwd,
      noCache: opts.noCache,
      datastore: cli.scope.datastore() as DataStore | undefined,
    });
    enforceLanguageMismatchPolicy(opts, result.catalog, [runCwd]);
    await dispatchGraphResult(opts, result, cli, startedAt);
  } catch (error) {
    handleGraphError('graph', error, cli);
  }
}

function validateMutuallyExclusiveFlags(opts: GraphCommandOptions): void {
  if (opts.gateSave === true && opts.gateCompare === true) {
    throw new ConfigurationError('--gate-save and --gate-compare are mutually exclusive.');
  }
  if (opts.workspace === true && (opts.paths?.length ?? 0) > 0) {
    throw new ConfigurationError(
      '--workspace and positional paths are mutually exclusive. Use one or the other.',
    );
  }
}

function resolvePositionalScope(opts: GraphCommandOptions): readonly string[] {
  if (!opts.paths || opts.paths.length === 0) return [];
  return resolvePositionalPaths(opts.paths, opts.cwd);
}

/**
 * D14 mixed policy. When `--language X` was specified and the run
 * discovered zero files matching that adapter, exit 2 with the
 * canonical error. Auto-detection paths (no `--language`) do NOT
 * trigger this check — a "zero files" outcome there is a valid
 * (non-error) state.
 */
function enforceLanguageMismatchPolicy(
  opts: GraphCommandOptions,
  catalog: Catalog | null,
  paths: readonly string[],
): void {
  if (typeof opts.language !== 'string' || opts.language.length === 0) return;
  const fileCount = catalog === null ? 0 : countFiles(catalog);
  if (fileCount > 0) return;
  const pathLabel = paths.map((p) => positionalPathLabel(p, opts.cwd)).join(', ');
  throw new ConfigurationError(
    `--language ${opts.language} matched 0 files under ${pathLabel}; check the flag or paths.`,
  );
}

async function executeMultiPathGraph(
  opts: GraphCommandOptions,
  paths: readonly string[],
  cli: ToolCliContext,
  startedAt: string,
): Promise<void> {
  const allSignals: Signal[] = [];
  let combinedFiles = 0;
  let lastResult: Awaited<ReturnType<typeof runGraph>> | null = null;
  for (const p of paths) {
    const r = await runGraph({
      cwd: p,
      noCache: opts.noCache,
      datastore: cli.scope.datastore() as DataStore | undefined,
    });
    lastResult = r;
    allSignals.push(...r.signals);
    if (r.catalog !== null) combinedFiles += countFiles(r.catalog);
  }
  // D14: count files across every analyzed path. Zero files + a
  // `--language` override → exit 2 with the canonical message.
  if (
    typeof opts.language === 'string'
    && opts.language.length > 0
    && combinedFiles === 0
  ) {
    throw new ConfigurationError(
      `--language ${opts.language} matched 0 files under ${paths.map((p) => positionalPathLabel(p, opts.cwd)).join(', ')}; check the flag or paths.`,
    );
  }
  /* v8 ignore next */
  if (lastResult === null) return;
  const combined = {
    catalog: lastResult.catalog,
    indexes: lastResult.indexes,
    signals: allSignals as readonly Signal[],
    resolutionStats: lastResult.resolutionStats,
    cacheHit: lastResult.cacheHit,
  };
  await dispatchGraphResult(opts, combined, cli, startedAt);
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
  // `executeWorkspaceGraph` (which always run with --json) don't each
  // write a row — the parent persists exactly one aggregate session
  // for the whole `--workspace` invocation.
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
 * `graph --workspace` — fan a graph run out across every workspace
 * unit returned by the adapters' `discoverWorkspaceUnits` hook. Per
 * spec D8b, polyglot repos aggregate units from EVERY detected
 * adapter (or the single adapter named by `--language`).
 */
async function executeWorkspaceGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  const cliScript = opts.cliScript ?? process.argv[1];
  if (typeof cliScript !== 'string' || cliScript.length === 0) {
    throw new ConfigurationError(
      '--workspace: could not determine the CLI entry script (process.argv[1] is empty).',
    );
  }
  const adapters = resolveAdaptersForRun(opts, cli);
  const units = await discoverPolyglotUnits(opts.cwd, adapters);
  if (units.length === 0) {
    const adapterLabel =
      adapters.map((a) => a.id).join(', ') || '(no language adapters available)';
    throw new ConfigurationError(
      `--workspace: no workspace units detected for [${adapterLabel}]. Use 'opensip-tools graph' for whole-project analysis.`,
    );
  }

  const startedAt = Date.now();
  const result = await runWorkspaceUnitsInParallel({
    cwd: opts.cwd,
    units,
    cliScript,
    concurrency: opts.concurrency,
    noCache: opts.noCache,
  });
  const durationMs = Date.now() - startedAt;

  const allFindings: FindingOutput[] = [];
  for (const r of result.perUnit) allFindings.push(...r.findings);

  if (opts.json === true) {
    process.stdout.write(`${renderWorkspaceJson(result.perUnit, durationMs)}\n`);
  } else {
    writeWorkspaceReport(result.perUnit, durationMs);
    // Persist exactly one aggregate session for the whole --workspace
    // invocation. Matches the contract "one human-facing CLI invocation
    // = one session" that fitness/sim already follow; the per-unit
    // child processes don't persist because they always run with --json
    // (see dispatchGraphResult).
    persistWorkspaceSession(opts, allFindings, durationMs, cli);
  }

  // If any child failed to spawn or exited with an error, surface it
  // as a runtime error. The parent itself succeeded if every child
  // returned exit 0.
  if (result.anyChildFailed) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
    process.stderr.write(
      `graph --workspace: at least one unit run failed; see per-unit output above.\n`,
    );
  } else {
    cli.setExitCode(EXIT_CODES.SUCCESS);
  }
  logger.info({
    evt: EVT_GRAPH_COMPLETE,
    module: MODULE_GRAPH_CLI,
    units: result.perUnit.length,
    findings: allFindings.length,
    failed: result.anyChildFailed,
    durationMs,
  });
}

/**
 * Resolve which language adapters apply to this run. With `--language`
 * set, returns exactly that adapter (errors if unregistered). Without
 * it, runs marker-based detection and returns every adapter the repo
 * exposes a marker for (polyglot per spec D6).
 */
function resolveAdaptersForRun(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): readonly LanguageAdapter[] {
  const registry = cli.scope.languages;
  if (typeof opts.language === 'string' && opts.language.length > 0) {
    const canonical = registry.canonicalize(opts.language) ?? opts.language;
    const adapter = registry.get(canonical);
    if (!adapter) {
      throw new ConfigurationError(
        `--language '${opts.language}' is not a registered adapter.`,
      );
    }
    return [adapter];
  }
  const detection = detectLanguages(opts.cwd, registry);
  const adapters: LanguageAdapter[] = [];
  for (const id of detection.adapterIds) {
    const adapter = registry.get(id);
    /* v8 ignore next */
    if (adapter) adapters.push(adapter);
  }
  return adapters;
}

function writeWorkspaceReport(
  perUnit: readonly WorkspaceUnitRunResult[],
  durationMs: number,
): void {
  const totalFindings = perUnit.reduce((n, r) => n + r.findings.length, 0);
  const lines: string[] = [
    'opensip-tools graph --workspace',
    '',
    `== Units (${String(perUnit.length)}) ==`,
    ...renderWorkspaceStatusLines(perUnit),
    '',
    '== Findings ==',
    ...renderWorkspaceFindingsLines(perUnit),
    '== Summary ==',
    `${String(totalFindings)} total finding(s) across ${String(perUnit.length)} unit(s) in ${String(durationMs)} ms.`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function renderWorkspaceStatusLines(
  perUnit: readonly WorkspaceUnitRunResult[],
): readonly string[] {
  const out: string[] = [];
  for (const r of perUnit) {
    const status = r.exitCode === 0 ? 'ok' : `FAILED (exit ${String(r.exitCode)})`;
    const display = unitDisplay(r);
    out.push(`  ${display}: ${String(r.findings.length)} finding(s) — ${status}`);
    if (r.exitCode !== 0 && r.stderr.length > 0) {
      const stderrPreview = r.stderr.split('\n').slice(0, 3).join('\n    ');
      out.push(`    stderr: ${stderrPreview}`);
    }
  }
  return out;
}

function renderWorkspaceFindingsLines(
  perUnit: readonly WorkspaceUnitRunResult[],
): readonly string[] {
  const out: string[] = [];
  for (const r of perUnit) {
    if (r.findings.length === 0) continue;
    out.push(`[${unitDisplay(r)}]`, ...renderUnitFindingPreview(r), '');
  }
  return out;
}

function renderUnitFindingPreview(r: WorkspaceUnitRunResult): readonly string[] {
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

function unitDisplay(r: WorkspaceUnitRunResult): string {
  return r.displayPath.length > 0 ? r.displayPath : r.rootDir;
}

function renderWorkspaceJson(
  perUnit: readonly WorkspaceUnitRunResult[],
  durationMs: number,
): string {
  return JSON.stringify(
    {
      version: '1.0',
      tool: 'graph',
      command: 'graph',
      mode: 'workspace',
      timestamp: new Date().toISOString(),
      durationMs,
      units: perUnit.map((r) => ({
        unitId: r.unitId,
        rootDir: r.rootDir,
        displayPath: r.displayPath,
        exitCode: r.exitCode,
        findings: r.findings,
      })),
      totalFindings: perUnit.reduce((n, r) => n + r.findings.length, 0),
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

function persistWorkspaceSession(
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

async function runReportMode(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
): Promise<void> {
  const cliOutput = buildCliOutput(signals, 'graph');
  const url = opts.reportTo!;
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
  writeFileSync(opts.catalogOutput!, json);
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
