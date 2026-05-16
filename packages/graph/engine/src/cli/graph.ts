/**
 * `opensip-tools graph` — main subcommand handler.
 *
 * Runs the full pipeline; renders Signals as table or JSON; surfaces
 * exit code via cli.setExitCode. Per DEC-8, a switch in this handler
 * dispatches to the right renderer.
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
import { renderTable } from '../render/table.js';

import { runGraph } from './orchestrate.js';

import type { Catalog } from '../types.js';
import type { Signal, ToolCliContext } from '@opensip-tools/core';

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
    const result = await runGraph({ cwd: opts.cwd, noCache: opts.noCache });
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
      if (result.catalog) {
        const fileCount = countFiles(result.catalog);
        const fnCount = countOccurrences(result.catalog);
        process.stdout.write(
          `graph: inventory built (${String(fnCount)} functions across ${String(fileCount)} files); cacheHit=${String(result.cacheHit)}\n`,
        );
      }
      const out = renderTable(result.signals, { cwd: opts.cwd, tool: 'graph', command: 'graph' });
      process.stdout.write(out);
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
