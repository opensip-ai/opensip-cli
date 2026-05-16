/**
 * `graph` execution path.
 *
 * Single entry point that the Tool's Commander handler calls. Builds (or
 * incrementally rebuilds) the catalog, runs every active rule, and assembles
 * a CliOutput. The CLI handler decides whether to emit JSON or render via
 * Ink — this module stays I/O-light and returns plain data.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveProjectPaths } from '@opensip-tools/core';
import ts from 'typescript';

import { evaluateAllRules, GRAPH_RULES } from '../analysis/rules-registry.js';
import { buildCatalog } from '../catalog/builder.js';
import { readCatalog, writeCatalog, whyCacheInvalid } from '../catalog/cache.js';

import type { GraphFinding } from '../analysis/types.js';
import type { Catalog } from '../catalog/types.js';
import type { CliOutput, CheckOutput, FindingOutput } from '@opensip-tools/contracts';


/** Options the run path consumes. */
export interface RunOptions {
  readonly cwd: string;
  /** Skip cache reads — always rebuild. Sets cache after the rebuild. */
  readonly noCache: boolean;
  /** Override resolver mode. Default is full polymorphic. */
  readonly resolverMode?: 'unknown' | 'static' | 'full';
}

export interface RunResult {
  readonly output: CliOutput;
  readonly catalog: Catalog;
  readonly findings: readonly GraphFinding[];
  readonly fromCache: boolean;
  readonly cacheInvalidationReason: string | null;
}

// runGraph stays `async` for shape parity with executeFit / executeSim, even
// though every call inside is currently synchronous — the future side-effect
// detector will likely involve async I/O. Marking this `async` now keeps the
// public contract stable across phases.
// eslint-disable-next-line @typescript-eslint/require-await
export async function runGraph(opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const paths = resolveProjectPaths(opts.cwd);
  const tsConfigPath = findTsConfig(opts.cwd);

  const cached = opts.noCache ? null : readCatalog(paths.graphCatalogPath);
  const invalidationReason = whyCacheInvalid(cached, {
    tsCompilerVersion: ts.version,
    tsConfigPath,
  });

  const { catalog, fromCache } = pickOrBuildCatalog({
    cached,
    invalidationReason,
    cwd: opts.cwd,
    tsConfigPath,
    catalogPath: paths.graphCatalogPath,
    resolverMode: opts.resolverMode,
  });

  const findings = evaluateAllRules(catalog);
  const output = buildCliOutput(findings, startedAt);
  return { output, catalog, findings, fromCache, cacheInvalidationReason: invalidationReason };
}

interface PickOrBuildOpts {
  readonly cached: Catalog | null;
  readonly invalidationReason: string | null;
  readonly cwd: string;
  readonly tsConfigPath: string;
  readonly catalogPath: string;
  readonly resolverMode?: 'unknown' | 'static' | 'full';
}

function pickOrBuildCatalog(opts: PickOrBuildOpts): { catalog: Catalog; fromCache: boolean } {
  if (opts.cached && opts.invalidationReason === null) {
    return { catalog: opts.cached, fromCache: true };
  }
  const built = buildCatalog({
    projectDir: opts.cwd,
    tsConfigPath: opts.tsConfigPath,
    ...(opts.resolverMode ? { resolverMode: opts.resolverMode } : {}),
  });
  try {
    writeCatalog(built.catalog, opts.catalogPath);
  } catch {
    // Cache write failures are non-fatal — the run completed and the
    // findings are still valid; the next run just rebuilds.
  }
  return { catalog: built.catalog, fromCache: false };
}

/**
 * Locate the project's tsconfig. Prefers `tsconfig.json` at the project
 * root; falls back to `tsconfig.base.json` (a common monorepo pattern)
 * before failing. Throws when no tsconfig is found because the catalog
 * builder requires the program graph that tsconfig produces.
 */
function findTsConfig(projectDir: string): string {
  const candidates = ['tsconfig.json', 'tsconfig.base.json'];
  for (const c of candidates) {
    const p = join(projectDir, c);
    if (existsSync(p)) return p;
  }
  throw new Error(
    `graph: no tsconfig.json found at ${projectDir}. Pass --cwd to point at the project root.`,
  );
}

/** Convert GraphFinding[] into the cross-tool CliOutput contract. */
function buildCliOutput(findings: readonly GraphFinding[], startedAt: number): CliOutput {
  const byRule = groupFindingsByRule(findings);
  const checks = composeChecks(byRule);
  const { errors, warnings, failed } = tallyChecks(checks);
  const passed = checks.length - failed;
  // CliOutput.tool is currently typed as 'fit' | 'sim'. We tag this output
  // as 'fit' for the cross-tool downstream consumers (gate/SARIF) — the
  // dashboard's tool-tabs panel reads StoredSession.tool, which already
  // accepts 'graph' (see store.ts). The CliOutput contract widening is
  // tracked for the v0.1 cleanup PR alongside the dashboard integration.
  return {
    version: '1.0',
    tool: 'fit',
    timestamp: new Date(startedAt).toISOString(),
    score: scoreOf(errors, warnings),
    passed: errors === 0,
    summary: { total: checks.length, passed, failed, errors, warnings },
    checks,
    durationMs: Date.now() - startedAt,
  };
}

function groupFindingsByRule(findings: readonly GraphFinding[]): Map<string, FindingOutput[]> {
  const byRule = new Map<string, FindingOutput[]>();
  for (const f of findings) {
    const existing = byRule.get(f.ruleId) ?? [];
    existing.push(toFindingOutput(f));
    byRule.set(f.ruleId, existing);
  }
  return byRule;
}

function toFindingOutput(f: GraphFinding): FindingOutput {
  return {
    ruleId: f.ruleId,
    message: f.message,
    severity: f.severity,
    ...(f.filePath ? { filePath: f.filePath } : {}),
    ...(f.line == null ? {} : { line: f.line }),
    ...(f.column == null ? {} : { column: f.column }),
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
  };
}

function composeChecks(byRule: ReadonlyMap<string, readonly FindingOutput[]>): CheckOutput[] {
  const checks: CheckOutput[] = [];
  // Always include every registered rule (active or not) so consumers see
  // the full surface. Inactive rules show 0 findings, passed=true.
  for (const rule of GRAPH_RULES) {
    const list = byRule.get(rule.slug) ?? [];
    checks.push({
      checkSlug: rule.slug,
      passed: list.length === 0,
      violationCount: list.length,
      findings: list,
      durationMs: 0,
    });
  }
  return checks;
}

function tallyChecks(checks: readonly CheckOutput[]): { errors: number; warnings: number; failed: number } {
  let errors = 0;
  let warnings = 0;
  let failed = 0;
  for (const c of checks) {
    if (!c.passed) failed++;
    for (const f of c.findings) {
      if (f.severity === 'error') errors++;
      else warnings++;
    }
  }
  return { errors, warnings, failed };
}

function scoreOf(errors: number, warnings: number): number {
  if (errors === 0 && warnings === 0) return 100;
  return Math.max(0, 100 - errors * 10 - warnings * 2);
}
