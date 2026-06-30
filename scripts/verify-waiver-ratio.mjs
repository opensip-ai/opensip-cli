#!/usr/bin/env node
/**
 * verify-waiver-ratio — freeze safety @fitness-ignore-* suppressions (D3/R10).
 *
 * Counts `@fitness-ignore-file` and `@fitness-ignore-next-line` in production
 * package src trees (excludes tests, fixtures, docs). Fails when any safety
 * slug count exceeds `.config/waiver-budget.json`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUDGET_PATH = join(REPO_ROOT, '.config/waiver-budget.json');
const CATALOG_JSON_PATH = join(REPO_ROOT, '.config/suppression-catalog.json');

const SAFETY_SLUGS = new Set([
  'error-handling-quality',
  'unbounded-memory',
  'detached-promises',
  'toctou-race-condition',
  'performance-anti-patterns',
  'batch-operation-limits',
]);

const COSMETIC_SLUGS = new Set([
  'file-length-limit',
  'module-coupling-fan-out',
  'project-readme-existence',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'coverage', '.git']);
const IGNORE_RE = /@fitness-ignore-(?:file|next-line)\s+([a-z][a-z0-9-]*)(?:\s|$|--)/g;

const log = (msg) => console.error(`[verify-waiver-ratio] ${msg}`);

function walk(dir, counts) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path, counts);
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
    const rel = relative(REPO_ROOT, path);
    if (!rel.includes('/src/')) continue;
    if (rel.includes('/__fixtures__/')) continue;

    const content = readFileSync(path, 'utf8');
    for (const match of content.matchAll(IGNORE_RE)) {
      const slug = match[1];
      counts[slug] = (counts[slug] ?? 0) + 1;
    }
  }
}

function main() {
  const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
  const counts = {};
  walk(join(REPO_ROOT, 'packages'), counts);

  const failures = [];
  for (const [slug, max] of Object.entries(budget.safety ?? {})) {
    const actual = counts[slug] ?? 0;
    if (actual > max) {
      failures.push(`${slug}: ${actual} > budget ${max}`);
    }
  }

  const cosmeticReport = [];
  for (const slug of COSMETIC_SLUGS) {
    const actual = counts[slug] ?? 0;
    const max = budget.cosmetic?.[slug];
    const budgetNote = max === undefined ? '' : ` (budget ${max})`;
    cosmeticReport.push(`${slug}: ${actual}${budgetNote}`);
  }

  const safetyTop = Object.entries(counts)
    .filter(([slug]) => SAFETY_SLUGS.has(slug))
    .sort((a, b) => b[1] - a[1]);

  if (safetyTop.length > 0) {
    log('safety waiver counts:');
    for (const [slug, n] of safetyTop) log(`  ${slug}: ${n}`);
  }
  if (cosmeticReport.length > 0) {
    log('cosmetic waiver counts (report-only):');
    for (const line of cosmeticReport) log(`  ${line}`);
  }

  if (failures.length > 0) {
    log('FAIL — net-new safety waivers above budget:');
    for (const f of failures) log(`  ${f}`);
    process.exit(1);
  }

  log('safety waiver budget OK (no net-new)');
  log('suppression triage matrix: .config/suppression-triage.md');

  try {
    const catalog = JSON.parse(readFileSync(CATALOG_JSON_PATH, 'utf8'));
    const audit = catalog.phase4Audit;
    if (audit) {
      const d = audit.delta;
      log(
        `phase-4 catalog delta: product-runtime combined ${d.productRuntimeCombined} (now ${catalog.summary.productRuntimeCombined})`,
      );
      if (audit.reopenCandidates?.length > 0) {
        log(
          `phase-4 reopen triage: ${audit.reopenCandidates.length} slug(s) >5 without pure (b) disposition`,
        );
      }
      if (audit.successCriteria?.sc6Met === true) {
        log(
          `phase-4 SC6 met: product-runtime safety ${audit.successCriteria.sc6ProductRuntimeSafetyActual} ≤ 143`,
        );
      }
    }
  } catch {
    log('phase-4 catalog summary: run node scripts/catalog-suppressions.mjs to refresh');
  }
}

main();
