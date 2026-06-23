/**
 * `graph-equivalence-check` — the REAL-REPO sharded≡exact equivalence guardrail
 * command handler.
 *
 * Builds BOTH catalogs on the target repo (default: cwd) with the REAL language
 * adapter — so workspace `@scope/pkg` imports resolve through Node16 to built
 * `dist/*.d.ts`, the exact divergence class the exact-engine-under-resolution
 * bug lived in (which the SYNTHETIC in-test harness cannot model):
 *   - EXACT single-program catalog via `runGraph` (the `--exact` path), and
 *   - SHARDED catalog via `runShardedGraph`, sharded the SAME way a production
 *     `graph` run shards (`resolveShardsForCwd`).
 * Both COLD + no-cache + no datastore (a fresh in-memory oracle every run), and
 * with an EMPTY rule set (the catalog — functions + edges + SCCs — is the diff
 * currency; rules only produce signals, so skipping them keeps the run lean).
 *
 * It then diffs (`diffCatalogs`), classifies the residual by OWNER FILE
 * (test/fixture-owned ⇒ gate-invisible/benign; production ⇒ the meaningful
 * signal), and compares the PRODUCTION count to the committed budget
 * (`.config/graph-equivalence-budget.json`). Exits non-zero on a budget breach
 * (a regression) or any function-set / SCC divergence. A decrease passes with a
 * tighten hint. `--update-budget` rewrites the budget to the observed production
 * count (capture the initial residual / tighten the ratchet).
 *
 * Heap: the exact build over ~1500 files needs adequate heap; the CI step runs
 * the compiled engine under `NODE_OPTIONS=--max-old-space-size=...` (see
 * `.github/workflows/ci.yml`). This command does NOT run heap-preflight (that is
 * the interactive `graph` path); it relies on the CI step's NODE_OPTIONS.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { EXIT_CODES } from '@opensip-cli/contracts';
import { logger } from '@opensip-cli/core';

import { pickAdapter } from '../lang-adapter/registry.js';

import { resolveShardsForCwd } from './graph.js';
import {
  buildEquivalenceReport,
  judgeEquivalence,
  type EquivalenceBudget,
  type EquivalenceVerdict,
} from './orchestrate/equivalence-check.js';
import { runGraph, runShardedGraph } from './orchestrate.js';

import type { Catalog } from '../types.js';
import type { ToolCliContext } from '@opensip-cli/core';

const MODULE = 'graph:cli';

/** Default committed budget path, relative to the target repo root. */
const DEFAULT_BUDGET_REL = '.config/graph-equivalence-budget.json';

export interface EquivalenceCheckOptions {
  readonly cwd: string;
  /** Override the budget file path (relative to cwd or absolute). */
  readonly budget?: string;
  /** Rewrite the budget file to the observed production divergence count. */
  readonly updateBudget?: boolean;
}

const BUDGET_NOTE =
  'Accepted PRODUCTION (non-test/fixture) sharded≡exact RESOLVED-edge divergences ' +
  'on this repo, classified by DIRECTION on the unified model (ADR-0033): phantom ' +
  '(sharded-only / exact-declined), decline (exact-only / sharded-declined), and ' +
  'conflict (both resolved, different targets — the same-name disambiguation class). ' +
  'functionsOnly{Exact,Sharded} MUST be 0 (a hard failure). A run EXCEEDING any ' +
  'direction’s floor fails graph-equivalence-check (a NEW divergence on the ' +
  'unified model — direction tells you which bound is insufficient). This is a ' +
  'ratchet: a decrease passes and prints a hint to tighten that number. The pinned-' +
  'corpus resolution-completeness floor lives in resolution-completeness-floor.test.ts.';

/** Numeric divergence keys every budget file must carry. */
const BUDGET_KEYS = [
  'phantomDivergences',
  'declineDivergences',
  'conflictDivergences',
  'sccDivergences',
] as const;

/** Read + validate the committed budget. A missing file is a configuration error
 *  (the budget is committed; CI must compare against it), unless --update-budget
 *  is set (then a missing file is seeded).
 *  @throws {Error} If the budget file is missing/unreadable, is not valid JSON, or
 *    does not carry every numeric key in {@link BUDGET_KEYS}. */
function loadBudget(path: string): EquivalenceBudget {
  // Structured-doc load: the budget is a small committed JSON file parsed
  // immediately — bounded by nature, not a streamed blob.
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const rec = parsed as Record<string, unknown> | null;
  if (
    typeof rec !== 'object' ||
    rec === null ||
    BUDGET_KEYS.some((k) => typeof rec[k] !== 'number')
  ) {
    const keyList = BUDGET_KEYS.map((k) => `"${k}"`).join(', ');
    throw new Error(`Invalid budget file ${path}: expected numeric { ${keyList} }.`);
  }
  const obj = parsed as Record<(typeof BUDGET_KEYS)[number], number> & { note?: string };
  return {
    phantomDivergences: obj.phantomDivergences,
    declineDivergences: obj.declineDivergences,
    conflictDivergences: obj.conflictDivergences,
    sccDivergences: obj.sccDivergences,
    ...(typeof obj.note === 'string' ? { note: obj.note } : {}),
  };
}

function writeBudget(path: string, verdict: EquivalenceVerdict): void {
  const budget = {
    phantomDivergences: verdict.phantomCount,
    declineDivergences: verdict.declineCount,
    conflictDivergences: verdict.conflictCount,
    sccDivergences: verdict.sccCount,
    note: BUDGET_NOTE,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(budget, null, 2)}\n`, 'utf8');
}

/** Build the exact single-program catalog (the oracle): cold, no cache, no
 *  datastore, empty rule set. */
async function buildExactCatalog(cwd: string): Promise<Catalog | null> {
  const result = await runGraph({ cwd, noCache: true, resolution: 'exact', rules: [] });
  return result.catalog;
}

/** Build the sharded catalog: cold, no cache, no datastore, empty rule set. */
async function buildShardedCatalog(input: {
  shards: Parameters<typeof runShardedGraph>[0]['shards'];
  projectRoot: string;
  cliScript: string;
  resolutionMode: 'exact' | 'fast';
}): Promise<Catalog> {
  const result = await runShardedGraph({
    shards: input.shards,
    projectRoot: input.projectRoot,
    cliScript: input.cliScript,
    adapter: pickAdapter(input.projectRoot),
    resolutionMode: input.resolutionMode,
    useCache: false,
    catalogRepo: null,
    rules: [],
  });
  return result.catalog;
}

/**
 * Run the real-repo sharded≡exact equivalence guardrail and set the process
 * exit code via `cli.setExitCode`. Never propagates: every error raised in the
 * body (no CLI entry script, non-shardable repo, a failed catalog build, a
 * missing/invalid budget) is caught locally and converted to
 * `EXIT_CODES.RUNTIME_ERROR` — so this function does not throw to its caller.
 */
export async function executeEquivalenceCheck(
  opts: EquivalenceCheckOptions,
  cli: ToolCliContext,
): Promise<void> {
  const cwd = resolve(opts.cwd);
  const budgetPath = opts.budget ? resolve(cwd, opts.budget) : resolve(cwd, DEFAULT_BUDGET_REL);
  logger.info({ evt: 'graph.cli.equivalence_check.start', module: MODULE, cwd, budgetPath });
  try {
    const cliScript = process.argv[1] ?? '';
    if (cliScript.length === 0) {
      throw new Error(
        'graph-equivalence-check: no CLI entry script (process.argv[1]) to spawn shard workers.',
      );
    }
    const shards = await resolveShardsForCwd(cwd, cliScript, cli);
    if (shards.length <= 1) {
      throw new Error(
        `graph-equivalence-check: ${cwd} is not shardable (${String(shards.length)} shard(s)). ` +
          'The comparison requires a multi-package (shardable) repo so the sharded and ' +
          'exact engines actually diverge through real dist/*.d.ts resolution.',
      );
    }

    const report = await buildEquivalenceReport({
      cwd,
      shards,
      cliScript,
      buildExact: buildExactCatalog,
      buildSharded: buildShardedCatalog,
    });

    const seedMissing = opts.updateBudget === true && !existsSync(budgetPath);
    const budget: EquivalenceBudget = seedMissing
      ? {
          phantomDivergences: report.productionPhantom.length,
          declineDivergences: report.productionDecline.length,
          conflictDivergences: report.productionConflict.length,
          sccDivergences: report.sccDifferences.length,
        }
      : loadBudget(budgetPath);
    const verdict = judgeEquivalence(report, budget);

    for (const line of verdict.lines) process.stdout.write(`${line}\n`);

    if (opts.updateBudget === true) {
      writeBudget(budgetPath, verdict);
      process.stdout.write(
        `Wrote budget phantom=${String(verdict.phantomCount)} ` +
          `decline=${String(verdict.declineCount)} conflict=${String(verdict.conflictCount)} ` +
          `scc=${String(verdict.sccCount)} to ${budgetPath}\n`,
      );
      // --update-budget is a capture/tighten action, not a gate run: always
      // exit 0 so a maintainer can record the new floor without the (now-stale)
      // budget failing the same invocation.
      cli.setExitCode(EXIT_CODES.SUCCESS);
      logEnd(report, verdict, false);
      return;
    }

    cli.setExitCode(verdict.failed ? EXIT_CODES.RUNTIME_ERROR : EXIT_CODES.SUCCESS);
    logEnd(report, verdict, verdict.failed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ evt: 'graph.cli.equivalence_check.error', module: MODULE, err: message });
    process.stderr.write(`graph-equivalence-check: ${message}\n`);
    cli.setExitCode(EXIT_CODES.RUNTIME_ERROR);
  }
}

function logEnd(
  report: {
    readonly productionResolvedDifferences: readonly unknown[];
    readonly testResolvedDifferences: readonly unknown[];
    readonly structuralDifferences: readonly unknown[];
    readonly sccDifferences: readonly unknown[];
  },
  verdict: EquivalenceVerdict,
  failed: boolean,
): void {
  logger.info({
    evt: 'graph.cli.equivalence_check.complete',
    module: MODULE,
    failed,
    productionResolved: report.productionResolvedDifferences.length,
    phantom: verdict.phantomCount,
    decline: verdict.declineCount,
    conflict: verdict.conflictCount,
    testResolved: report.testResolvedDifferences.length,
    structural: report.structuralDifferences.length,
    scc: report.sccDifferences.length,
    sccBudget: verdict.sccBudget,
  });
}
