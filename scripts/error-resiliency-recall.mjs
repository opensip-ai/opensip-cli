#!/usr/bin/env node
/**
 * @fileoverview Plan 01 Task A.1 — measure the recall of the checks this repository
 * ALREADY ships against the frozen Plan 01 migration ledger.
 *
 * "Our checks probably miss this" is an assumption. This turns it into a number, before
 * a single new check is written, while the defects are still in the tree.
 *
 * Every actionable ledger site lands in exactly one terminal bucket:
 *   caught                        a finding from an enabled check joins to the site
 *   caught-but-suppressed         a finding exists but a directive/disabledChecks removes it
 *   missed                        a MEASURED false negative — the output this task exists for
 *   not-mechanically-expressible  a recorded human-review decision (never a default)
 *
 * A finding that joins to NO ledger site is reported separately: that is the other half of
 * the Task A.5 reconciliation (the inventory, not the check, may be what is wrong).
 *
 * Determinism is a hard requirement: the artifact is keyed on
 * {ledgerDigest, checkInventoryDigest, commit} and every collection is sorted, so two runs
 * over an unchanged tree are byte-identical.
 *
 * Usage:
 *   node scripts/error-resiliency-recall.mjs [--out <path>] [--findings <fit-json>] [--quiet]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');

const CAMPAIGN = 'docs/internal/coop/error-resiliency-inventory';
const LEDGER_DIR = join(CAMPAIGN, 'plan-01');
const RECALL_DIR = join(LEDGER_DIR, 'recall');
const HUMAN_REVIEW = '.config/error-migration-human-review.json';
const SUPPRESSION_CATALOG = '.config/suppression-catalog.json';

/** Terminal buckets. A site is in exactly one. */
export const BUCKETS = [
  'caught',
  'caught-but-suppressed',
  'missed',
  'not-mechanically-expressible',
];

/**
 * Lines a finding may sit away from its ledger site and still be the same defect.
 * Findings report the statement they flag; a ledger site records the construct's opening
 * line. A few lines of slack absorbs that without letting unrelated sites collide.
 */
export const JOIN_WINDOW_LINES = 4;

/** Risk weighting used to rank remediation work (matches the Plan 01 phase docs). */
export const RISK_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 };

const stableStringify = (value) => JSON.stringify(value, null, 2);

/** @param {unknown} value */
export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

/**
 * Load every actionable site from the frozen per-package ledger shards.
 * @param {string} root
 */
export function loadLedgerSites(root = REPO_ROOT) {
  const pkgDir = join(root, LEDGER_DIR, 'packages');
  if (!existsSync(pkgDir)) {
    throw new Error(
      `Plan 01 ledger not found at ${LEDGER_DIR}/packages — this measurement requires the C5-frozen ledger.`,
    );
  }
  const sites = [];
  for (const name of readdirSync(pkgDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const shard = JSON.parse(readFileSync(join(pkgDir, name), 'utf8'));
    for (const site of shard.sites ?? []) sites.push({ ...site, shardFile: `packages/${name}` });
  }
  sites.sort((a, b) => (a.siteKey ?? '').localeCompare(b.siteKey ?? ''));
  return sites;
}

/**
 * Run the shipped check surface and return its findings.
 * @param {string} root
 * @param {string | undefined} findingsPath pre-captured `fit --json` output (skips the run)
 */
export function collectFindings(root = REPO_ROOT, findingsPath) {
  let raw;
  if (findingsPath) {
    raw = readFileSync(findingsPath, 'utf8');
  } else {
    // The documented machine seam. `fit` exits non-zero when findings exist, which is the
    // expected state here — capture stdout and let the exit code be.
    try {
      raw = execFileSync(
        process.execPath,
        [join('packages', 'cli', 'dist', 'index.js'), 'fit', '--json'],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 512 * 1024 * 1024,
        },
      );
    } catch (error) {
      if (typeof error?.stdout !== 'string' || error.stdout.length === 0) throw error;
      raw = error.stdout;
    }
  }
  const outcome = JSON.parse(raw);
  const envelope = outcome.envelope ?? outcome;
  const signals = envelope.signals ?? [];
  return signals
    .map((s) => ({
      ruleId: s.ruleId ?? s.checkSlug ?? 'unknown',
      filePath: normalizePath(s.filePath ?? s.file ?? ''),
      line: typeof s.line === 'number' ? s.line : undefined,
      severity: s.severity,
      fingerprint: s.fingerprint,
    }))
    .filter((s) => s.filePath.length > 0)
    .sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        a.ruleId.localeCompare(b.ruleId),
    );
}

/** Ledger paths are repo-relative; findings may be absolute. */
export function normalizePath(p) {
  const s = String(p).replaceAll('\\', '/');
  const i = s.indexOf('/opensip-cli/');
  if (s.startsWith('/') && i >= 0) return s.slice(i + '/opensip-cli/'.length);
  return s.replace(/^\.\//, '');
}

/**
 * Join findings to ledger sites. Ambiguity is recorded, never silently attributed —
 * an inflated recall number is worse than a gap.
 * @param {ReturnType<typeof loadLedgerSites>} sites
 * @param {ReturnType<typeof collectFindings>} findings
 */
export function joinFindingsToSites(sites, findings) {
  const byPath = new Map();
  for (const site of sites) {
    if (!byPath.has(site.path)) byPath.set(site.path, []);
    byPath.get(site.path).push(site);
  }

  /** @type {Map<string, Set<string>>} siteKey -> ruleIds */
  const hits = new Map();
  const ambiguous = [];
  const findingsWithoutSite = [];

  for (const finding of findings) {
    const candidates = byPath.get(finding.filePath) ?? [];
    if (candidates.length === 0) {
      findingsWithoutSite.push(finding);
      continue;
    }
    if (finding.line === undefined) {
      // File-scoped finding: attribute to every site in the file only when the file has
      // exactly one, otherwise it cannot be resolved to a specific defect.
      if (candidates.length === 1) addHit(hits, candidates[0].siteKey, finding.ruleId);
      else
        ambiguous.push({
          ...finding,
          candidateCount: candidates.length,
          reason: 'file-scoped-finding-multi-site-file',
        });
      continue;
    }
    const near = candidates.filter(
      (s) => typeof s.line === 'number' && Math.abs(s.line - finding.line) <= JOIN_WINDOW_LINES,
    );
    if (near.length === 1) {
      addHit(hits, near[0].siteKey, finding.ruleId);
    } else if (near.length === 0) {
      findingsWithoutSite.push(finding);
    } else {
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const s of near) {
        const d = Math.abs(s.line - finding.line);
        if (d < bestDistance) bestDistance = d;
      }
      const tie = near.filter((s) => Math.abs(s.line - finding.line) === bestDistance);
      const best = tie[0];
      if (tie.length === 1) addHit(hits, best.siteKey, finding.ruleId);
      else
        ambiguous.push({
          ...finding,
          candidateCount: near.length,
          reason: 'multiple-sites-equidistant',
        });
    }
  }
  return {
    hits,
    ambiguous: sortByPathLine(ambiguous),
    findingsWithoutSite: sortByPathLine(findingsWithoutSite),
  };
}

function addHit(hits, siteKey, ruleId) {
  if (!hits.has(siteKey)) hits.set(siteKey, new Set());
  hits.get(siteKey).add(ruleId);
}

const sortByPathLine = (rows) =>
  [...rows].sort((a, b) => a.filePath.localeCompare(b.filePath) || (a.line ?? 0) - (b.line ?? 0));

/**
 * Sites explicitly recorded as human-review-only. Never a default bucket: a site lands
 * here only because someone wrote down which semantic judgement blocks mechanization.
 * @param {string} root
 */
export function loadHumanReview(root = REPO_ROOT) {
  const p = join(root, HUMAN_REVIEW);
  if (!existsSync(p)) return new Map();
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  const out = new Map();
  for (const entry of doc.sites ?? []) {
    if (entry?.siteKey && typeof entry.reason === 'string' && entry.reason.trim().length > 0) {
      out.set(entry.siteKey, entry.reason.trim());
    }
  }
  return out;
}

/**
 * Suppression evidence. A waived site was CAUGHT and then silenced — a third outcome that
 * must not be conflated with a miss.
 * @param {string} root
 */
export function loadSuppressedPaths(root = REPO_ROOT) {
  const p = join(root, SUPPRESSION_CATALOG);
  if (!existsSync(p)) return new Map();
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  const bySlugPath = new Map();
  for (const rec of doc.records ?? []) {
    const path = normalizePath(rec.path ?? rec.file ?? '');
    const slug = rec.slug ?? rec.ruleId;
    if (!path || !slug) continue;
    const key = `${slug}::${path}`;
    bySlugPath.set(key, rec.disposition ?? 'suppressed');
  }
  return bySlugPath;
}

/**
 * Classify every actionable site into exactly one terminal bucket.
 */
export function classify({ sites, hits, humanReview, suppressed }) {
  const rows = [];
  for (const site of sites) {
    const ruleIds = [...(hits.get(site.siteKey) ?? [])].sort();
    let bucket;
    let detail;
    if (humanReview.has(site.siteKey)) {
      bucket = 'not-mechanically-expressible';
      detail = humanReview.get(site.siteKey);
    } else if (ruleIds.length > 0) {
      bucket = 'caught';
      detail = ruleIds.join(',');
    } else {
      const suppressedBy = [...suppressed.entries()].find(([key]) =>
        key.endsWith(`::${site.path}`),
      );
      if (suppressedBy) {
        bucket = 'caught-but-suppressed';
        detail = `${suppressedBy[0].split('::')[0]} (${suppressedBy[1]})`;
      } else {
        bucket = 'missed';
        detail = '';
      }
    }
    rows.push({
      siteKey: site.siteKey,
      path: site.path,
      line: site.line,
      kind: site.kind,
      source: site.source,
      risk: site.risk ?? 'unset',
      boundaryFamily: site.boundaryFamily ?? 'unset',
      package: site.package,
      bucket,
      detail,
      ruleIds,
    });
  }
  rows.sort((a, b) => a.siteKey.localeCompare(b.siteKey));
  return rows;
}

/** Aggregate counts, all keys sorted so the artifact is stable. */
export function summarize(rows) {
  const tally = (keyOf) => {
    const out = {};
    for (const r of rows) {
      const k = keyOf(r);
      out[k] ??= Object.fromEntries(BUCKETS.map((b) => [b, 0]));
      out[k][r.bucket] += 1;
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const totals = Object.fromEntries(
    BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b).length]),
  );
  const weighted = Object.fromEntries(
    BUCKETS.map((b) => {
      let sum = 0;
      for (const r of rows) if (r.bucket === b) sum += RISK_WEIGHT[r.risk] ?? 1;
      return [b, sum];
    }),
  );
  const denom = rows.length || 1;
  return {
    totals,
    weightedRisk: weighted,
    recall: Number((totals.caught / denom).toFixed(4)),
    recallExcludingHumanReview: Number(
      (totals.caught / Math.max(1, denom - totals['not-mechanically-expressible'])).toFixed(4),
    ),
    byBoundaryFamily: tally((r) => r.boundaryFamily),
    byKind: tally((r) => r.kind ?? 'unset'),
    byRisk: tally((r) => r.risk),
    bySource: tally((r) => r.source ?? 'unset'),
    byPackage: tally((r) => r.package ?? 'unset'),
  };
}

/** Per-check attribution: which shipped checks actually caught ledger sites. */
export function perCheck(rows) {
  const out = {};
  for (const r of rows) for (const id of r.ruleIds) out[id] = (out[id] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([, a], [, b]) => b - a || 0));
}

/**
 * The `not-mechanically-expressible` bucket is capped: an unbounded "unmechanizable"
 * bucket is how a recall measurement lies to itself.
 */
export const HUMAN_REVIEW_CAP_RATIO = 0.15;

export function capViolation(rows) {
  const n = rows.filter((r) => r.bucket === 'not-mechanically-expressible').length;
  const cap = Math.floor(rows.length * HUMAN_REVIEW_CAP_RATIO);
  return n > cap ? { exceeded: true, count: n, cap } : { exceeded: false, count: n, cap };
}

export function buildArtifact({ root = REPO_ROOT, findingsPath } = {}) {
  const sites = loadLedgerSites(root);
  const index = JSON.parse(readFileSync(join(root, LEDGER_DIR, 'index.json'), 'utf8'));
  const findings = collectFindings(root, findingsPath);
  const { hits, ambiguous, findingsWithoutSite } = joinFindingsToSites(sites, findings);
  const rows = classify({
    sites,
    hits,
    humanReview: loadHumanReview(root),
    suppressed: loadSuppressedPaths(root),
  });
  const checkInventory = [...new Set(findings.map((f) => f.ruleId))].sort();

  return {
    schemaVersion: 1,
    measurement: 'plan-01-recall',
    commit: index.frozenAt,
    ledgerDigest: index.plan01LedgerDigest,
    checkInventoryDigest: digest(checkInventory),
    joinWindowLines: JOIN_WINDOW_LINES,
    actionableSiteCount: rows.length,
    ledgerActionableSiteCount: index.actionableSiteCount,
    summary: summarize(rows),
    perCheck: perCheck(rows),
    humanReviewCap: capViolation(rows),
    ambiguousJoins: ambiguous.length,
    findingsWithoutLedgerSite: findingsWithoutSite.length,
    checkInventory,
    // Full detail so A.2 can rank and A.5 can reconcile without re-running the join.
    sites: rows,
    ambiguous,
    unmatchedFindings: findingsWithoutSite,
  };
}

function main(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const artifact = buildArtifact({ findingsPath: flag('--findings') });
  const outPath = flag('--out') ?? join(REPO_ROOT, RECALL_DIR, 'recall.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${stableStringify(artifact)}\n`);

  if (!argv.includes('--quiet')) {
    const s = artifact.summary;
    console.log(
      stableStringify({
        ok: true,
        out: outPath.replace(`${REPO_ROOT}/`, ''),
        actionableSites: artifact.actionableSiteCount,
        totals: s.totals,
        recall: s.recall,
        ambiguousJoins: artifact.ambiguousJoins,
        findingsWithoutLedgerSite: artifact.findingsWithoutLedgerSite,
        humanReviewCap: artifact.humanReviewCap,
        topChecks: Object.fromEntries(Object.entries(artifact.perCheck).slice(0, 10)),
      }),
    );
  }
  if (artifact.humanReviewCap.exceeded) {
    console.error(
      `[recall] not-mechanically-expressible (${artifact.humanReviewCap.count}) exceeds the ${HUMAN_REVIEW_CAP_RATIO * 100}% cap (${artifact.humanReviewCap.cap}) — coordinator sign-off required.`,
    );
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirect) main();
