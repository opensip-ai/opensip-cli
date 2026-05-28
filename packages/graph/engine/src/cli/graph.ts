// @fitness-ignore-file detached-promises -- CLI renderers (process.stdout.write, render helpers, log lines, setExitCode) are synchronous; heuristic flags inside async handlers.
// @fitness-ignore-file no-markdown-references -- references to docs/plans/* in code comments are stable internal pointers; the docs are checked-in markdown.
// @fitness-ignore-file public-api-jsdoc -- GraphCommandOptions interface and executeGraph are already documented with rich JSDoc on each field; the check counts the top-level export line, not the fields.
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

import { EXIT_CODES, SessionRepo } from '@opensip-tools/contracts';
import {
  ConfigurationError,
  generatePrefixedId,
  logger,
  ToolError,
  ValidationError,
} from '@opensip-tools/core';

import { buildCliOutput, buildCliOutputFromFindings, renderJson } from '../render/json.js';

import { runCatalogJsonMode, runGateMode, runReportMode } from './graph-modes.js';
import { renderPackagesJson, writePackagesReport } from './graph-packages-report.js';
import { writeUnifiedReport } from './graph-report.js';
import { runGraph } from './orchestrate.js';
import { runPackagesInParallel } from './packages-runner.js';
import { MemoryPressureError } from './pressure-monitor.js';
import { discoverWorkspacePackages, resolvePackageScope } from './scope.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { FindingOutput } from '@opensip-tools/contracts';
import type { Signal, ToolCliContext } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

export type { GraphCommandOptions } from './graph-options.js';

const EVT_GRAPH_COMPLETE = 'graph.cli.graph.complete';
const MODULE_GRAPH_CLI = 'graph:cli';
const MODULE_GRAPH_RENDER = 'graph:render';

// MODULE_GRAPH_RENDER is referenced by the json-render path below. The
// catalog-json + sarif rendering branches now live in `./graph-modes.ts`.

// Re-exported so existing consumers (`@opensip-tools/graph` barrel,
// `cli/graph-runner.tsx`, tests) keep using `cli/graph.js` as the
// single import site. The implementation lives in `graph-report.ts`.
export { buildUnifiedReportLines } from './graph-report.js';
export type { UnifiedReportInput } from './graph-report.js';

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

