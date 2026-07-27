#!/usr/bin/env node
/**
 * @fileoverview Plan 01 Task A.5 — reconcile the two descriptions of the same defect
 * population: the human-reviewed ledger and the executable check set.
 *
 * Where they disagree, exactly one of them is wrong, and the disagreement is only
 * discoverable WHILE BOTH DESCRIBE A TREE THAT STILL CONTAINS THE DEFECTS. After
 * migration, a check firing where the ledger has no site is indistinguishable from a
 * regression, and a ledger site no check can express is indistinguishable from completed
 * work.
 *
 * Two directions, each with a terminal disposition — `unknown` is not one:
 *
 *   check fires, ledger has no site  -> the INVENTORY missed something. Recorded as a
 *                                       versioned addendum. The C5-frozen shards are NOT
 *                                       edited: acceptance binds plan01LedgerDigest at a
 *                                       commit, so additions carry their own digest and
 *                                       reference the frozen parent.
 *   ledger site no check expresses   -> the CHECK has a gap. Either widened (subject to
 *                                       the precision bar) or assigned to a recorded
 *                                       human-review CLASS naming the semantic judgement
 *                                       that blocks mechanisation.
 *
 * Assignment is by CLASS, not per site: with 4,610 unexpressed sites, a per-site list
 * would be an unreadable bucket that hides the structure. Each class states the specific
 * judgement a static rule cannot make, so an absent check stays a decision on the record.
 *
 * Usage:
 *   node scripts/error-resiliency-reconcile-corpora.mjs [--json] [--recall <path>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');

const LEDGER_DIR = 'docs/internal/coop/error-resiliency-inventory/plan-01';
const RECALL_PATH = join(LEDGER_DIR, 'recall/recall.json');
const ADDENDA_DIR = join(LEDGER_DIR, 'addenda');
const HUMAN_REVIEW = '.config/error-migration-human-review.json';

/**
 * Assign a site to the first human-review class whose matcher accepts it.
 * Order is significant: the classes are listed most-specific first.
 *
 * Returns the class id, or nothing when no class matched — the caller records that as
 * UNASSIGNED and fails the run, because a site with no terminal disposition must block
 * Wave 1 rather than default into a bucket.
 *
 * @param {{kind?:string, boundaryFamily?:string, source?:string}} site
 * @param {readonly {id:string, match:{kinds?:string[], families?:string[], sources?:string[]}}[]} classes
 * @returns {string | undefined}
 */
export function classifySite(site, classes) {
  for (const c of classes) {
    const m = c.match ?? {};
    if (m.sources?.includes(site.source)) return c.id;
    if (m.kinds?.includes(site.kind)) return c.id;
    if (m.families?.includes(site.boundaryFamily)) return c.id;
  }
}

/**
 * Reconcile a recall artifact against the human-review classes.
 * Pure, so totality can be tested without running the CLI.
 *
 * @param {{sites:readonly object[], unmatchedFindings?:readonly object[], ambiguous?:readonly object[]}} recall
 * @param {readonly object[]} classes
 */
export function reconcile(recall, classes) {
  const rows = recall.sites ?? [];
  const caught = rows.filter((r) => r.bucket === 'caught');
  const suppressed = rows.filter((r) => r.bucket === 'caught-but-suppressed');
  const declared = rows.filter((r) => r.bucket === 'not-mechanically-expressible');
  const missed = rows.filter((r) => r.bucket === 'missed');

  const byClass = {};
  const unassigned = [];
  for (const site of missed) {
    const id = classifySite(site, classes);
    if (id === undefined) unassigned.push(site);
    else byClass[id] = (byClass[id] ?? 0) + 1;
  }

  // Findings with no ledger site become inventory addenda (deduped on path+rule+line).
  const addenda = [];
  const seen = new Set();
  for (const f of recall.unmatchedFindings ?? []) {
    const key = `${f.filePath}::${f.ruleId}::${f.line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    addenda.push({
      path: f.filePath,
      ruleId: f.ruleId,
      line: f.line,
      origin: 'check-fired-outside-ledger',
    });
  }

  const accountedFor =
    caught.length +
    suppressed.length +
    declared.length +
    Object.values(byClass).reduce((n, v) => n + v, 0) +
    unassigned.length;

  return {
    total: rows.length,
    caught: caught.length,
    suppressed: suppressed.length,
    declaredHumanReview: declared.length,
    missedAssignedToClass: Object.values(byClass).reduce((n, v) => n + v, 0),
    unassigned: unassigned.length,
    byClass: Object.fromEntries(Object.entries(byClass).sort(([a], [b]) => a.localeCompare(b))),
    addenda,
    ambiguousJoins: (recall.ambiguous ?? []).length,
    // The reconciliation must be TOTAL: every site accounted for exactly once.
    total_accounted: accountedFor,
    complete: accountedFor === rows.length && unassigned.length === 0,
    unassignedSample: unassigned
      .slice(0, 10)
      .map((s) => ({ path: s.path, kind: s.kind, family: s.boundaryFamily })),
  };
}

function main(argv = process.argv.slice(2)) {
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const recallPath = flag('--recall') ?? join(REPO_ROOT, RECALL_PATH);
  if (!existsSync(recallPath)) {
    console.error(
      `[reconcile-corpora] missing recall artifact at ${RECALL_PATH} — run error-inventory:recall first.`,
    );
    process.exitCode = 2;
    return;
  }
  const recall = JSON.parse(readFileSync(recallPath, 'utf8'));
  const hr = JSON.parse(readFileSync(join(REPO_ROOT, HUMAN_REVIEW), 'utf8'));
  const result = reconcile(recall, hr.classes ?? []);

  // Addenda carry their own digest and reference the frozen parent; the C5 shards are
  // never rewritten, so the acceptance record stays intact.
  const index = JSON.parse(readFileSync(join(REPO_ROOT, LEDGER_DIR, 'index.json'), 'utf8'));
  const addendaDoc = {
    schemaVersion: 1,
    parentLedgerDigest: index.plan01LedgerDigest,
    parentCommit: index.frozenAt,
    origin: 'A.5 corpus reconciliation — checks fired where the inventory had no site',
    count: result.addenda.length,
    sites: result.addenda,
  };
  addendaDoc.digest = createHash('sha256')
    .update(JSON.stringify(addendaDoc.sites), 'utf8')
    .digest('hex');
  mkdirSync(join(REPO_ROOT, ADDENDA_DIR), { recursive: true });
  writeFileSync(
    join(REPO_ROOT, ADDENDA_DIR, 'a5-check-fired-outside-ledger.json'),
    `${JSON.stringify(addendaDoc, null, 2)}\n`,
  );

  const report = { ok: result.complete, ...result, addenda: result.addenda.length };
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[reconcile-corpora] ${result.total} actionable sites`);
    console.log(
      `  caught ${result.caught} · suppressed ${result.suppressed} · declared-human-review ${result.declaredHumanReview}`,
    );
    console.log(`  assigned to a human-review class: ${result.missedAssignedToClass}`);
    for (const [id, n] of Object.entries(result.byClass))
      console.log(`    ${String(n).padStart(5)}  ${id}`);
    console.log(`  inventory addenda (check fired, no ledger site): ${result.addenda.length}`);
    console.log(`  ambiguous joins (credited to nobody): ${result.ambiguousJoins}`);
    const totality = result.complete
      ? 'complete — every site accounted for exactly once'
      : `INCOMPLETE — ${result.unassigned} unassigned`;
    console.log(`  TOTAL: ${totality}`);
  }
  if (!result.complete) {
    console.error(
      `[reconcile-corpora] ${result.unassigned} site(s) have no terminal disposition — 'unknown' is not a disposition and blocks Wave 1.`,
    );
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirect) main();
