/**
 * REAL-REPO equivalence guardrail — the dogfood gate that catches an
 * edge-resolution regression on a genuine multi-package TypeScript monorepo.
 *
 * WHY THIS EXISTS (the gap it closes):
 *   The in-test equivalence gate (`__tests__/equivalence*.test.ts`) builds BOTH
 *   engines through a SYNTHETIC text adapter that reuses the production
 *   cross-package helpers (`resolveSpecifierToPackage` + `buildExportIndex`), so
 *   the two engines "agree by construction" — it structurally CANNOT model the
 *   real TypeScript `dist/*.d.ts` resolution where the
 *   exact-engine-under-resolution bug actually lived. That is false confidence.
 *
 *   This guardrail instead builds BOTH catalogs on a REAL repo (default: this
 *   one) with the REAL TypeScript adapter — so workspace `@scope/pkg` imports
 *   resolve through Node16 to built `dist/*.d.ts`, exactly the divergence class
 *   the bug occupied. It then diffs (exact ≡ sharded) via `diffCatalogs` and
 *   classifies the residual by OWNER FILE:
 *
 *     - functionsOnly{A,B} MUST be 0 (the function sets are byte-equal
 *       post-reconciliation) — any non-zero is a hard FAILURE.
 *     - TEST/FIXTURE-owned edge divergences are benign (the graph rules skip
 *       test files, so they are gate-invisible) — counted separately, never
 *       gated.
 *     - PRODUCTION edge divergences are the meaningful signal (the residual
 *       re-export cases the sharded V1 linker declines). Compared against a
 *       COMMITTED BUDGET; the guardrail FAILS when production divergence EXCEEDS
 *       the budget (a regression — e.g. reintroduced `dist/*.d.ts`
 *       under-resolution drops many real cross-package edges → spike) and PASSES
 *       (with a tighten hint) on a decrease. A ratchet, mirroring the repo's
 *       net-new SARIF philosophy.
 *
 * Engine-layer + language-agnostic: it drives `runGraph` (exact) and
 * `runShardedGraph` (sharded) through the same shard-resolution the production
 * `graph` command uses (`resolveShardsForCwd`), so there is ONE resolver, never
 * a drifting copy. Cold + no-cache on both sides (a fresh oracle every run).
 */

import { diffCatalogs } from './cross-shard-resolve.js';

import type { EdgeDifference } from './cross-shard-resolve.js';
import type { Shard } from './shard-model.js';
import type { Catalog, ResolutionMode } from '../../types.js';

/** A function-set divergence: one engine discovered a function the other did not. */
export type FunctionSetBreach = readonly string[];

/**
 * Owner-file classification of an edge divergence. Matches the paths the graph
 * rules skip (so the divergence is gate-invisible): any `__tests__/` or
 * `__fixtures__/` tree segment, or a `*.test.*` / `*.spec.*` filename. Operates
 * on project-relative catalog `filePath`s, posix-normalized.
 */
export function isTestOrFixturePath(filePath: string): boolean {
  const p = filePath.replaceAll('\\', '/');
  return (
    p.includes('/__tests__/') ||
    p.startsWith('__tests__/') ||
    p.includes('/__fixtures__/') ||
    p.startsWith('__fixtures__/') ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[A-Za-z0-9]+$/.test(p)
  );
}

/**
 * A RESOLVED-edge divergence is the meaningful signal: a call site where the two
 * engines disagree on a NON-EMPTY resolved target set (one resolved it, the
 * other didn't, or they resolved it differently). A call site that is UNRESOLVED
 * (`to: []`) on one side and simply absent on the other contributes nothing to
 * the resolved call graph — both engines agree there is no target — so it is
 * NOT a resolved divergence (it is reported separately as a structural/
 * unresolved divergence, not gated). This is what isolates the dropped/added
 * REAL cross-package edges the guardrail exists to catch.
 */
function isResolvedDivergence(d: EdgeDifference): boolean {
  return d.toA !== d.toB && (d.toA.length > 0 || d.toB.length > 0);
}

/** A committed budget: accepted divergence counts (the ratchet floor). */
export interface EquivalenceBudget {
  /**
   * Accepted PRODUCTION resolved-edge divergences (test/fixture-owned excluded).
   * A run with MORE than this FAILS (a regression — e.g. reintroduced
   * `dist/*.d.ts` under-resolution drops real cross-package edges → spike);
   * FEWER passes with a tighten hint; equal passes.
   */
  readonly productionResolvedEdgeDivergences: number;
  /**
   * Accepted SCC membership divergences. SCCs are a DOWNSTREAM consequence of the
   * resolved-edge residual (a differing cross-package edge can reshape a
   * component), so on a repo with a non-zero edge residual SCC differences are
   * expected and budgeted, not hard-failed. Same ratchet semantics.
   */
  readonly sccDivergences: number;
  /**
   * Optional human note recorded alongside the numbers (what the residual is).
   * Ignored by the comparison.
   */
  readonly note?: string;
}

/** The classified outcome of one equivalence run. */
export interface EquivalenceReport {
  /** functionsOnlyInA (exact-only) — MUST be empty (a hard failure if not). */
  readonly functionsOnlyInExact: FunctionSetBreach;
  /** functionsOnlyInB (sharded-only) — MUST be empty (a hard failure if not). */
  readonly functionsOnlyInSharded: FunctionSetBreach;
  /** SCC membership divergences (budgeted — a downstream consequence of edges). */
  readonly sccDifferences: readonly string[];
  /** Every differing edge key, owner-attributed (resolved + structural). */
  readonly allEdgeDifferences: readonly EdgeDifference[];
  /**
   * RESOLVED-edge divergences owned by a PRODUCTION file — the gated signal
   * (dropped/added real edges in non-test code).
   */
  readonly productionResolvedDifferences: readonly EdgeDifference[];
  /**
   * RESOLVED-edge divergences owned by a TEST/FIXTURE file — benign
   * (gate-invisible: the graph rules skip test files). Reported, not gated.
   */
  readonly testResolvedDifferences: readonly EdgeDifference[];
  /**
   * STRUCTURAL divergences — a call site recorded as UNRESOLVED (`to: []`) on one
   * engine and absent on the other. Neither resolved a target, so this does not
   * change the resolved call graph; reported for transparency, never gated.
   */
  readonly structuralDifferences: readonly EdgeDifference[];
  /** Catalog function counts, for the report header. */
  readonly exactFunctionCount: number;
  readonly shardedFunctionCount: number;
}

/** Build the exact + sharded catalogs on `cwd`, diff, and classify by owner file. */
export interface BuildEquivalenceInput {
  /** Target repo root (default: process.cwd()). */
  readonly cwd: string;
  /**
   * The resolved shard set for `cwd` (≥2 shards). Resolved by the caller via the
   * production `resolveShardsForCwd` so the guardrail shards the project the
   * SAME way a real `graph` run does. An empty/≤1 set is a usage error (the repo
   * must be shardable for the comparison to be meaningful).
   */
  readonly shards: readonly Shard[];
  /** CLI entry script for spawning shard workers (`process.argv[1]`). */
  readonly cliScript: string;
  /** Exact single-program build (the oracle). */
  readonly buildExact: (cwd: string) => Promise<Catalog | null>;
  /** Sharded build. */
  readonly buildSharded: (input: {
    shards: readonly Shard[];
    projectRoot: string;
    cliScript: string;
    resolutionMode: ResolutionMode;
  }) => Promise<Catalog>;
}

function functionCount(catalog: Catalog): number {
  let n = 0;
  for (const occs of Object.values(catalog.functions)) n += occs?.length ?? 0;
  return n;
}

/**
 * Run the real-repo equivalence comparison and classify the residual. Diffs as
 * `diffCatalogs(exact, sharded)` — so `functionsOnlyInA` is exact-only and
 * `functionsOnlyInB` is sharded-only — then partitions the edge differences by
 * owner file (production vs test/fixture).
 *
 * @throws {Error} If the exact (single-program) build produces no catalog — the
 *   target repo must contain analyzable source for the comparison to be meaningful.
 */
export async function buildEquivalenceReport(
  input: BuildEquivalenceInput,
): Promise<EquivalenceReport> {
  const exact = await input.buildExact(input.cwd);
  if (exact === null) {
    throw new Error(
      'Equivalence check: the exact (single-program) build produced no catalog ' +
        '(no parseable input). The target repo must contain analyzable source.',
    );
  }
  const sharded = await input.buildSharded({
    shards: input.shards,
    projectRoot: input.cwd,
    cliScript: input.cliScript,
    resolutionMode: 'exact',
  });

  const eq = diffCatalogs(exact, sharded);
  const resolved = eq.edgeDifferences.filter(isResolvedDivergence);
  const structuralDifferences = eq.edgeDifferences.filter((d) => !isResolvedDivergence(d));
  const productionResolvedDifferences = resolved.filter(
    (d) => !isTestOrFixturePath(d.ownerFilePath),
  );
  const testResolvedDifferences = resolved.filter((d) => isTestOrFixturePath(d.ownerFilePath));
  return {
    functionsOnlyInExact: eq.functionsOnlyInA,
    functionsOnlyInSharded: eq.functionsOnlyInB,
    sccDifferences: eq.sccDifferences,
    allEdgeDifferences: eq.edgeDifferences,
    productionResolvedDifferences,
    testResolvedDifferences,
    structuralDifferences,
    exactFunctionCount: functionCount(exact),
    shardedFunctionCount: functionCount(sharded),
  };
}

/** The verdict of comparing a report against a budget. */
export interface EquivalenceVerdict {
  /** True ⇒ the guardrail FAILS (non-zero exit). */
  readonly failed: boolean;
  /** True ⇒ a function-set breach (a hard failure regardless of budget). */
  readonly functionSetBreached: boolean;
  /** Observed production resolved-edge divergence count. */
  readonly productionCount: number;
  /** The budget's accepted production count. */
  readonly budgetCount: number;
  /** Observed SCC divergence count. */
  readonly sccCount: number;
  /** The budget's accepted SCC count. */
  readonly sccBudget: number;
  /** Human-readable lines for the CLI output (always populated). */
  readonly lines: readonly string[];
}

/**
 * Compare a report against the committed budget and produce the gate verdict +
 * human-readable lines.
 *
 *   - Any function-set breach (functionsOnly{Exact,Sharded}) ⇒ HARD FAIL: the
 *     function SET must be byte-equal post-reconciliation (a discovery/merge
 *     regression, never an edge gap).
 *   - production RESOLVED-edge divergences > budget ⇒ FAIL (a regression),
 *     printing the offending owner `file:line → exact|sharded` edges.
 *   - SCC divergences > budget ⇒ FAIL (a downstream consequence of the edge
 *     residual — budgeted, not hard-failed, since the real-repo residual is
 *     non-zero).
 *   - any metric < budget ⇒ PASS, with a hint to tighten that number.
 *   - == budget ⇒ PASS.
 *
 * Structural (unresolved-vs-absent) divergences are reported but never gated.
 */
export function judgeEquivalence(
  report: EquivalenceReport,
  budget: EquivalenceBudget,
): EquivalenceVerdict {
  const lines: string[] = [];
  const productionCount = report.productionResolvedDifferences.length;
  const budgetCount = budget.productionResolvedEdgeDivergences;
  const sccCount = report.sccDifferences.length;
  const sccBudget = budget.sccDivergences;
  const functionSetBreached =
    report.functionsOnlyInExact.length > 0 || report.functionsOnlyInSharded.length > 0;

  lines.push(
    `Graph engine equivalence (exact ≡ sharded) on the real repo:`,
    `  functions: exact=${String(report.exactFunctionCount)} sharded=${String(report.shardedFunctionCount)}`,
    `  functionsOnlyInExact=${String(report.functionsOnlyInExact.length)} ` +
      `functionsOnlyInSharded=${String(report.functionsOnlyInSharded.length)}`,
    `  resolved-edge divergences: production=${String(productionCount)} (budget ${String(budgetCount)}) ` +
      `test/fixture=${String(report.testResolvedDifferences.length)} (benign)`,
    `  scc divergences: ${String(sccCount)} (budget ${String(sccBudget)})`,
    `  structural (unresolved-vs-absent) divergences: ${String(report.structuralDifferences.length)} (informational)`,
  );

  if (functionSetBreached) {
    lines.push(
      `  FAIL: function-set divergence — the two engines disagree on the FUNCTION SET.`,
      `        This MUST be 0 (a discovery/merge regression, not an edge gap).`,
    );
    appendSample(lines, 'exact-only function', report.functionsOnlyInExact);
    appendSample(lines, 'sharded-only function', report.functionsOnlyInSharded);
  }

  const productionOverBudget = productionCount > budgetCount;
  judgeMetric(lines, {
    label: 'production resolved-edge divergence',
    key: 'productionResolvedEdgeDivergences',
    count: productionCount,
    budget: budgetCount,
  });
  if (productionOverBudget) {
    lines.push(
      `    A resolver regression dropped/added real edges. Offending production edges ` +
        `(owner file:line  exact=[..] sharded=[..]):`,
    );
    for (const d of report.productionResolvedDifferences) {
      lines.push(
        `      ${d.ownerFilePath}:${String(d.line)}:${String(d.column)}  ` +
          `exact=[${d.toA}] sharded=[${d.toB}]`,
      );
    }
  }

  const sccOverBudget = sccCount > sccBudget;
  judgeMetric(lines, {
    label: 'SCC divergence',
    key: 'sccDivergences',
    count: sccCount,
    budget: sccBudget,
  });

  const failed = functionSetBreached || productionOverBudget || sccOverBudget;
  lines.push(failed ? `  RESULT: FAIL` : `  RESULT: PASS`);
  return { failed, functionSetBreached, productionCount, budgetCount, sccCount, sccBudget, lines };
}

/** Emit the PASS/FAIL/tighten line for one budgeted metric. */
function judgeMetric(
  lines: string[],
  m: { label: string; key: string; count: number; budget: number },
): void {
  if (m.count > m.budget) {
    lines.push(
      `  FAIL: ${m.label} ${String(m.count)} EXCEEDS budget ${String(m.budget)} (+${String(m.count - m.budget)}).`,
    );
  } else if (m.count < m.budget) {
    lines.push(
      `  PASS: ${m.label} ${String(m.count)} is BELOW budget ${String(m.budget)}; ` +
        `tighten the ratchet: set ${m.key}=${String(m.count)} in the budget JSON.`,
    );
  } else {
    lines.push(`  PASS: ${m.label} matches budget (${String(m.budget)}).`);
  }
}

/** Append up to 5 sample identities of a breach list (keeps output bounded). */
function appendSample(lines: string[], label: string, ids: readonly string[]): void {
  for (const id of ids.slice(0, 5)) lines.push(`    ${label}: ${id}`);
  if (ids.length > 5) lines.push(`    … and ${String(ids.length - 5)} more ${label}(s)`);
}
