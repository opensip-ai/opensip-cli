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

import { EXIT_CODES, saveSession } from '@opensip-tools/contracts';
import {
  ConfigurationError,
  generatePrefixedId,
  logger,
  resolveProjectPaths,
  ToolError,
  ValidationError,
} from '@opensip-tools/core';

import { compareToBaseline, fingerprintSignal, saveBaseline } from '../gate.js';
import { buildCliOutput, renderJson } from '../render/json.js';
import { renderSarif, reportToCloud } from '../render/sarif.js';
import { inferEntryPoints } from '../rules/_entry-points.js';
import { rules as defaultRules } from '../rules/registry.js';

import { runGraph } from './orchestrate.js';
import { resolvePackageScope } from './scope.js';

import type { EntryPoint } from '../rules/_entry-points.js';
import type { Catalog, Indexes } from '../types.js';
import type { Signal, ToolCliContext } from '@opensip-tools/core';

const ENTRY_POINTS_PREVIEW = 10;
const FINDINGS_PREVIEW = 10;

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
}

export async function executeGraph(
  opts: GraphCommandOptions,
  cli: ToolCliContext,
): Promise<void> {
  logger.info({ evt: 'graph.cli.graph.start', module: 'graph:cli', cwd: opts.cwd });
  try {
    if (opts.gateSave === true && opts.gateCompare === true) {
      throw new ConfigurationError('--gate-save and --gate-compare are mutually exclusive.');
    }
    let runCwd = opts.cwd;
    let runTsConfig: string | undefined;
    if (typeof opts.packageScope === 'string' && opts.packageScope.length > 0) {
      const scope = resolvePackageScope({ cwd: opts.cwd, packageArg: opts.packageScope });
      runCwd = scope.packageDirAbs;
      runTsConfig = scope.tsConfigPathAbs;
      logger.info({
        evt: 'graph.cli.graph.scope',
        module: 'graph:cli',
        package: opts.packageScope,
        packageDir: scope.packageDirAbs,
      });
    }
    const result = await runGraph({
      cwd: runCwd,
      noCache: opts.noCache,
      tsConfigPath: runTsConfig,
    });
    if (opts.gateSave === true || opts.gateCompare === true) {
      await runGateMode(opts, result.signals, cli);
      logger.info({ evt: 'graph.cli.graph.complete', module: 'graph:cli' });
      return;
    }
    if (typeof opts.reportTo === 'string' && opts.reportTo.length > 0) {
      await runReportMode(opts, result.signals, cli);
      logger.info({ evt: 'graph.cli.graph.complete', module: 'graph:cli' });
      return;
    }
    if (opts.json === true) {
      logger.info({ evt: 'graph.render.json.start', module: 'graph:render' });
      const out = renderJson(result.signals, { cwd: opts.cwd, tool: 'graph', command: 'graph' });
      process.stdout.write(`${out}\n`);
      logger.info({ evt: 'graph.render.json.complete', module: 'graph:render' });
    } else {
      logger.info({ evt: 'graph.render.table.start', module: 'graph:render' });
      writeUnifiedReport({
        catalog: result.catalog,
        indexes: result.indexes,
        signals: result.signals,
        cacheHit: result.cacheHit,
      });
      logger.info({ evt: 'graph.render.table.complete', module: 'graph:render' });
    }
    persistSession(opts, result.signals);
    cli.setExitCode(EXIT_CODES.SUCCESS);
    logger.info({
      evt: 'graph.cli.graph.complete',
      module: 'graph:cli',
      signals: result.signals.length,
    });
  } catch (error) {
    handleGraphError('graph', error, cli);
  }
}

interface UnifiedReportInput {
  readonly catalog: Catalog | null;
  readonly indexes: Indexes | null;
  readonly signals: readonly Signal[];
  readonly cacheHit: boolean;
}

/**
 * Render the unified terminal report: catalog summary, findings grouped
 * by rule, top-N entry points, and a single-line summary.
 *
 * Each section is a small pure helper returning string[]; this function
 * just sequences them.
 */
function writeUnifiedReport(input: UnifiedReportInput): void {
  const knownRuleIds = defaultRules.map((r) => r.slug);
  const byRule = groupSignalsByRule(input.signals);
  const eps = input.catalog && input.indexes
    ? enrichEntryPoints(input.catalog, input.indexes)
    : [];

  const sections: readonly string[] = [
    'opensip-tools graph',
    '',
    ...renderCatalogSection(input.catalog, input.cacheHit),
    '',
    ...renderFindingsSection(input.signals.length, byRule, knownRuleIds),
    ...renderEntryPointsSection(eps),
    '',
    ...renderSummarySection(byRule, knownRuleIds, input.signals.length),
  ];

  process.stdout.write(`${sections.join('\n')}\n`);
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

function persistSession(opts: GraphCommandOptions, signals: readonly Signal[]): void {
  try {
    const cliOutput = buildCliOutput(signals, 'graph');
    saveSession({
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
      durationMs: 0,
    });
  } catch {
    // best effort; don't fail the run
  }
}

function handleGraphError(label: string, error: unknown, cli: ToolCliContext): void {
  logger.error({
    evt: `graph.cli.${label}.error`,
    module: 'graph:cli',
    err: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof ConfigurationError) {
    cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  } else if (error instanceof ValidationError) {
    cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
  } else if (error instanceof ToolError) {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
  } else {
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
  }
  process.stderr.write(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
}

async function runGateMode(
  opts: GraphCommandOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
): Promise<void> {
  const paths = resolveProjectPaths(opts.cwd);
  const baselinePath = opts.baseline ?? paths.graphBaselinePath;
  if (opts.gateSave === true) {
    saveBaseline(signals, baselinePath);
    process.stdout.write(`Graph baseline saved to ${baselinePath} (${String(signals.length)} signals)\n`);
    cli.setExitCode(EXIT_CODES.SUCCESS);
    return;
  }
  // gate-compare
  const result = compareToBaseline(signals, baselinePath);
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
  const sarif = renderSarif(cliOutput);
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
