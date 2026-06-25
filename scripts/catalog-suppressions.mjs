#!/usr/bin/env node
/**
 * catalog-suppressions — regenerable suppression inventory (suppression triage Phase 0).
 *
 * Walks packages/** and classifies @fitness-ignore-* / @graph-ignore-* directives by
 * layer (budget-gate, product-runtime, check-package, test-support, tests).
 *
 * Usage:
 *   node scripts/catalog-suppressions.mjs              # write docs/internal outputs
 *   node scripts/catalog-suppressions.mjs --check        # exit 1 if committed output is stale
 *   node scripts/catalog-suppressions.mjs --stdout-json  # JSON to stdout (no write)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUDGET_PATH = join(REPO_ROOT, '.config/waiver-budget.json');
const CATALOG_JSON_PATH = join(REPO_ROOT, 'docs/internal/suppression-catalog.json');
const TRIAGE_MD_PATH = join(REPO_ROOT, 'docs/internal/suppression-triage.md');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

const FITNESS_RE = /@fitness-ignore-(?:file|next-line)\s+([a-z][a-z0-9-]*)(?:\s|$|--)/g;
const GRAPH_RE = /@graph-ignore-(?:file|next-line)\s+(\S+)/g;

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

const BUDGETED_SLUGS = new Set([...SAFETY_SLUGS, ...COSMETIC_SLUGS]);

/**
 * Phase 0 baseline (suppression-triage-and-reduction spec, pre-program counts).
 * Used for Phase 4 residual-audit delta reporting.
 */
const PHASE0_BASELINE = {
  productRuntimeFitness: 305,
  productRuntimeGraph: 7,
  productRuntimeCombined: 312,
  budgetGateFitness: 542,
  checkPackageFitness: 234,
  productRuntimeSafetyTotal: 183,
  budgetGateSafetyTotal: 234,
};

/** Primary triage disposition from suppression-triage-and-reduction spec. */
const TRIAGE_DISPOSITION = {
  'error-handling-quality': 'c',
  'detached-promises': 'c',
  'batch-operation-limits': 'b',
  'unbounded-memory': 'b',
  'performance-anti-patterns': 'b/c',
  'toctou-race-condition': 'b',
  'file-length-limit': 'c',
  'module-coupling-fan-out': 'b',
  'project-readme-existence': 'a/c',
  'result-pattern-consistency': 'c',
  'duplicate-utility-functions': 'b',
  'throws-documentation': 'a/b',
  'null-safety': 'b/c',
  'silent-early-returns': 'a/c',
  'async-waterfall-detection': 'c',
  'context-mutation': 'b',
  'no-non-null-assertions': 'a',
  'public-api-jsdoc': 'a',
  'graph:cycle': 'b',
  'graph:always-throws-branch': 'b',
  'graph:near-duplicate-function-body': 'b',
  'concurrency-safety': 'b',
  'env-secret-exposure': 'b',
  'env-via-registry': 'b',
  'error-handling-suite': 'b',
  'module-coupling-metrics': 'b',
  'no-direct-stdout-in-tool-engine': 'b',
  'no-markdown-references': 'b',
  'only-documented-toolcli-seams': 'b',
  'unsafe-secret-comparison': 'b',
  'array-validation': 'b',
  'clean-code-naming-quality': 'b',
  'eslint-backend': 'b',
  'interface-implementation-consistency': 'b',
  'no-raw-fetch': 'b',
  'no-unbounded-concurrency': 'b',
  'one-outcome-shape': 'b',
  'semgrep-scan': 'b',
  'stream-buffer-size-limits': 'b',
  'zod-schema-strictness': 'b',
};

const PHASE4_REOPEN_THRESHOLD = 5;

const log = (msg) => console.error(`[catalog-suppressions] ${msg}`);

const fmtDelta = (n) => (n > 0 ? `+${n}` : String(n));

function isTestPath(rel, fileName) {
  return (
    rel.includes('/__tests__/') ||
    rel.includes('/__fixtures__/') ||
    fileName.endsWith('.test.ts') ||
    fileName.endsWith('.test.tsx')
  );
}

/**
 * @returns {'budget-gate' | 'product-runtime' | 'check-package' | 'test-support' | 'tests' | 'skip'}
 */
function classifyLayer(rel, fileName) {
  if (!rel.startsWith('packages/')) return 'skip';
  if (!rel.includes('/src/')) return 'skip';
  if (isTestPath(rel, fileName)) return 'tests';
  if (rel.startsWith('packages/test-support/src/')) return 'test-support';
  if (/^packages\/fitness\/checks-[^/]+\/src\//.test(rel)) return 'check-package';
  if (/^packages\/graph\/graph-[^/]+\/src\//.test(rel)) return 'product-runtime';
  return 'product-runtime';
}

function packageKey(rel) {
  const parts = rel.split('/');
  if (parts.length < 2) return rel;
  if (parts[1] === 'fitness' || parts[1] === 'graph' || parts[1] === 'languages') {
    return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : parts[1];
  }
  return parts[1];
}

function normalizeGraphId(raw) {
  const trimmed = raw.replace(/['"`;,]+$/, '');
  return trimmed.startsWith('graph:') ? trimmed : `graph:${trimmed}`;
}

function isCommentAnchoredLine(line) {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('/*');
}

function extractFitnessDirectives(content, { commentOnly }) {
  const hits = [];
  if (commentOnly) {
    const lines = content.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!isCommentAnchoredLine(line)) continue;
      for (const match of line.matchAll(FITNESS_RE)) {
        hits.push({ slug: match[1], line: i + 1 });
      }
    }
    return hits;
  }
  for (const match of content.matchAll(FITNESS_RE)) {
    hits.push({ slug: match[1], line: null });
  }
  return hits;
}

function extractGraphDirectives(content, { commentOnly }) {
  const hits = [];
  if (commentOnly) {
    const lines = content.split('\n');
    for (const [i, line] of lines.entries()) {
      if (!isCommentAnchoredLine(line)) continue;
      for (const match of line.matchAll(GRAPH_RE)) {
        hits.push({ ruleId: normalizeGraphId(match[1]), line: i + 1 });
      }
    }
    return hits;
  }
  for (const match of content.matchAll(GRAPH_RE)) {
    hits.push({ ruleId: normalizeGraphId(match[1]), line: null });
  }
  return hits;
}

function emptyLayer() {
  return {
    fitness: { total: 0, bySlug: {}, byPackage: {} },
    graph: { total: 0, byRuleId: {}, byPackage: {} },
  };
}

function bump(bucket, key) {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

function walkPackages(catalog, { commentOnly, collectRecords = false }) {
  const records = collectRecords ? [] : null;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;

      const rel = relative(REPO_ROOT, path);
      const layer = classifyLayer(rel, entry.name);
      if (layer === 'skip') continue;

      const content = readFileSync(path, 'utf8');
      const pkg = packageKey(rel);

      for (const { slug, line } of extractFitnessDirectives(content, { commentOnly })) {
        if (records) records.push({ kind: 'fitness', slug, layer, pkg, file: rel, line });
        const layerBucket = catalog.layers[layer];
        layerBucket.fitness.total += 1;
        bump(layerBucket.fitness.bySlug, slug);
        bump(layerBucket.fitness.byPackage, pkg);

        if (layer !== 'tests') {
          const gate = catalog.layers['budget-gate'];
          gate.fitness.total += 1;
          bump(gate.fitness.bySlug, slug);
          bump(gate.fitness.byPackage, pkg);
        }
      }

      for (const { ruleId, line } of extractGraphDirectives(content, { commentOnly })) {
        if (records) records.push({ kind: 'graph', slug: ruleId, layer, pkg, file: rel, line });
        const layerBucket = catalog.layers[layer];
        layerBucket.graph.total += 1;
        bump(layerBucket.graph.byRuleId, ruleId);
        bump(layerBucket.graph.byPackage, pkg);
      }
    }
  }

  walk(join(REPO_ROOT, 'packages'));
  return records;
}

function countSlugs(bySlug) {
  return Object.keys(bySlug).length;
}

function sumSlugs(bySlug, slugs) {
  return slugs.reduce((n, s) => n + (bySlug[s] ?? 0), 0);
}

function buildCatalog({ collectRecords = false } = {}) {
  const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
  const catalog = {
    generatedAt: new Date().toISOString(),
    repoRef: 'main',
    layerRules: {
      budgetGate:
        'packages/**/src minus __tests__/, *.test.ts, __fixtures__/; excludes dist/; includes checks-* and test-support',
      productRuntime:
        'budget-gate paths minus packages/fitness/checks-*; includes packages/graph/graph-* adapters',
      checkPackage: 'packages/fitness/checks-*/src only',
      testSupport: 'packages/test-support/src',
      tests: '__tests__/, *.test.ts, __fixtures__/',
    },
    layers: {
      'budget-gate': emptyLayer(),
      'product-runtime': emptyLayer(),
      'check-package': emptyLayer(),
      'test-support': emptyLayer(),
      tests: emptyLayer(),
    },
    budget: { safety: {}, cosmetic: {} },
    summary: {},
  };

  const records = walkPackages(catalog, { commentOnly: false, collectRecords });
  if (records) {
    catalog.records = records;
  }

  const pr = catalog.layers['product-runtime'];
  const gate = catalog.layers['budget-gate'];

  for (const [slug, max] of Object.entries(budget.safety ?? {})) {
    catalog.budget.safety[slug] = { budget: max, actual: gate.fitness.bySlug[slug] ?? 0 };
  }
  for (const [slug, max] of Object.entries(budget.cosmetic ?? {})) {
    catalog.budget.cosmetic[slug] = { budget: max, actual: gate.fitness.bySlug[slug] ?? 0 };
  }

  catalog.summary = {
    budgetGateFitness: gate.fitness.total,
    budgetGateFitnessSlugs: countSlugs(gate.fitness.bySlug),
    productRuntimeFitness: pr.fitness.total,
    productRuntimeFitnessSlugs: countSlugs(pr.fitness.bySlug),
    productRuntimeGraph: pr.graph.total,
    productRuntimeGraphRuleIds: countSlugs(pr.graph.byRuleId),
    productRuntimeCombined: pr.fitness.total + pr.graph.total,
    checkPackageFitness: catalog.layers['check-package'].fitness.total,
    testSupportFitness: catalog.layers['test-support'].fitness.total,
    testsFitness: catalog.layers.tests.fitness.total,
    testsGraph: catalog.layers.tests.graph.total,
    budgetGateSafetyTotal: sumSlugs(gate.fitness.bySlug, [...SAFETY_SLUGS]),
    productRuntimeSafetyTotal: sumSlugs(pr.fitness.bySlug, [...SAFETY_SLUGS]),
    unbudgetedProductRuntimeSlugs: countSlugs(
      Object.fromEntries(Object.entries(pr.fitness.bySlug).filter(([s]) => !BUDGETED_SLUGS.has(s))),
    ),
  };

  catalog.phase4Audit = buildPhase4Audit(catalog);

  return catalog;
}

function sortedEntries(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function dispositionForSlug(slug) {
  return TRIAGE_DISPOSITION[slug] ?? 'TBD';
}

function isPureAcceptedDisposition(disp) {
  return disp === 'b';
}

function buildPhase4Audit(catalog) {
  const pr = catalog.layers['product-runtime'];
  const reopenCandidates = [];
  const acceptedHighCount = [];

  const auditSlug = (slug, count, kind) => {
    if (count <= PHASE4_REOPEN_THRESHOLD) return;
    const disposition = dispositionForSlug(slug);
    const row = { slug, count, disposition, kind };
    if (isPureAcceptedDisposition(disposition)) {
      acceptedHighCount.push(row);
    } else {
      reopenCandidates.push(row);
    }
  };

  for (const [slug, count] of Object.entries(pr.fitness.bySlug)) {
    auditSlug(slug, count, 'fitness');
  }
  for (const [ruleId, count] of Object.entries(pr.graph.byRuleId)) {
    auditSlug(ruleId, count, 'graph');
  }

  reopenCandidates.sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug));

  const delta = {
    productRuntimeFitness:
      catalog.summary.productRuntimeFitness - PHASE0_BASELINE.productRuntimeFitness,
    productRuntimeGraph: catalog.summary.productRuntimeGraph - PHASE0_BASELINE.productRuntimeGraph,
    productRuntimeCombined:
      catalog.summary.productRuntimeCombined - PHASE0_BASELINE.productRuntimeCombined,
    budgetGateFitness: catalog.summary.budgetGateFitness - PHASE0_BASELINE.budgetGateFitness,
    checkPackageFitness: catalog.summary.checkPackageFitness - PHASE0_BASELINE.checkPackageFitness,
    productRuntimeSafetyTotal:
      catalog.summary.productRuntimeSafetyTotal - PHASE0_BASELINE.productRuntimeSafetyTotal,
    budgetGateSafetyTotal:
      catalog.summary.budgetGateSafetyTotal - PHASE0_BASELINE.budgetGateSafetyTotal,
  };

  return {
    baseline: PHASE0_BASELINE,
    delta,
    reopenCandidates,
    acceptedHighCount,
    successCriteria: {
      sc6ProductRuntimeSafetyTarget: 143,
      sc6ProductRuntimeSafetyActual: catalog.summary.productRuntimeSafetyTotal,
      sc6Met: catalog.summary.productRuntimeSafetyTotal <= 143,
    },
  };
}

function renderTriageMarkdown(catalog) {
  const pr = catalog.layers['product-runtime'];
  const lines = [
    '# Suppression triage matrix',
    '',
    '<!-- Generated by scripts/catalog-suppressions.mjs — do not hand-edit. -->',
    '',
    `**Generated:** ${catalog.generatedAt}`,
    '',
    'Contributor policy: [CONTRIBUTING.md § Suppressions](../CONTRIBUTING.md#suppressions)',
    '',
    '## Summary',
    '',
    '| Metric | Count |',
    '|--------|------:|',
    `| Budget-gate \`@fitness-ignore\` | ${catalog.summary.budgetGateFitness} (${catalog.summary.budgetGateFitnessSlugs} slugs) |`,
    `| Product-runtime \`@fitness-ignore\` | ${catalog.summary.productRuntimeFitness} (${catalog.summary.productRuntimeFitnessSlugs} slugs) |`,
    `| Product-runtime \`@graph-ignore\` | ${catalog.summary.productRuntimeGraph} (${catalog.summary.productRuntimeGraphRuleIds} rule ids) |`,
    `| Product-runtime combined | ${catalog.summary.productRuntimeCombined} |`,
    `| Check-package | ${catalog.summary.checkPackageFitness} |`,
    `| Test-support | ${catalog.summary.testSupportFitness} |`,
    `| Tests / fixtures (fitness) | ${catalog.summary.testsFitness} |`,
    `| Tests / fixtures (graph) | ${catalog.summary.testsGraph} |`,
    `| Budget-gate safety total | ${catalog.summary.budgetGateSafetyTotal} |`,
    `| Product-runtime safety total | ${catalog.summary.productRuntimeSafetyTotal} |`,
    `| Unbudgeted product-runtime slugs | ${catalog.summary.unbudgetedProductRuntimeSlugs} |`,
    '',
    'Regenerate: `node scripts/catalog-suppressions.mjs`',
    '',
    '## Waiver budget (budget-gate scope)',
    '',
    '| Tier | Slug | Budget | Actual |',
    '|------|------|-------:|-------:|',
  ];

  const budgetRows = [
    ...Object.entries(catalog.budget.safety).map(([slug, row]) => [slug, row]),
    ...Object.entries(catalog.budget.cosmetic).map(([slug, row]) => [slug, row]),
  ];
  for (const [slug, row] of budgetRows) {
    const tier = SAFETY_SLUGS.has(slug) ? 'Safety' : 'Cosmetic';
    lines.push(`| ${tier} | \`${slug}\` | ${row.budget} | ${row.actual} |`);
  }
  lines.push(
    '',
    '## Product-runtime fitness slugs',
    '',
    '| Slug | Count | Budgeted | Disposition |',
    '|------|------:|:--------:|:-----------:|',
  );
  for (const [slug, count] of sortedEntries(pr.fitness.bySlug)) {
    const budgeted = BUDGETED_SLUGS.has(slug) ? 'yes' : 'no';
    const disp = dispositionForSlug(slug);
    lines.push(`| \`${slug}\` | ${count} | ${budgeted} | ${disp} |`);
  }
  lines.push(
    '',
    '## Product-runtime graph rule ids',
    '',
    '| Rule id | Count | Disposition |',
    '|---------|------:|:-----------:|',
  );
  for (const [ruleId, count] of sortedEntries(pr.graph.byRuleId)) {
    const disp = TRIAGE_DISPOSITION[ruleId] ?? 'b';
    lines.push(`| \`${ruleId}\` | ${count} | ${disp} |`);
  }
  lines.push(
    '',
    '## Package hotspots (product-runtime fitness)',
    '',
    '| Package | Count |',
    '|---------|------:|',
  );
  for (const [pkg, count] of sortedEntries(pr.fitness.byPackage).slice(0, 12)) {
    lines.push(`| \`${pkg}\` | ${count} |`);
  }

  const audit = catalog.phase4Audit;
  lines.push(
    '',
    '## Phase 0 → current delta',
    '',
    '| Metric | Phase 0 | Current | Δ |',
    '|--------|--------:|--------:|--:|',
    `| Product-runtime \`@fitness-ignore\` | ${audit.baseline.productRuntimeFitness} | ${catalog.summary.productRuntimeFitness} | ${fmtDelta(audit.delta.productRuntimeFitness)} |`,
    `| Product-runtime \`@graph-ignore\` | ${audit.baseline.productRuntimeGraph} | ${catalog.summary.productRuntimeGraph} | ${fmtDelta(audit.delta.productRuntimeGraph)} |`,
    `| Product-runtime combined | ${audit.baseline.productRuntimeCombined} | ${catalog.summary.productRuntimeCombined} | ${fmtDelta(audit.delta.productRuntimeCombined)} |`,
    `| Budget-gate \`@fitness-ignore\` | ${audit.baseline.budgetGateFitness} | ${catalog.summary.budgetGateFitness} | ${fmtDelta(audit.delta.budgetGateFitness)} |`,
    `| Check-package | ${audit.baseline.checkPackageFitness} | ${catalog.summary.checkPackageFitness} | ${fmtDelta(audit.delta.checkPackageFitness)} |`,
    `| Product-runtime safety total | ${audit.baseline.productRuntimeSafetyTotal} | ${catalog.summary.productRuntimeSafetyTotal} | ${fmtDelta(audit.delta.productRuntimeSafetyTotal)} |`,
    `| Budget-gate safety total | ${audit.baseline.budgetGateSafetyTotal} | ${catalog.summary.budgetGateSafetyTotal} | ${fmtDelta(audit.delta.budgetGateSafetyTotal)} |`,
    '',
    `SC6 (product-runtime safety ≤ 143): **${audit.successCriteria.sc6Met ? 'met' : 'NOT met'}** (actual ${audit.successCriteria.sc6ProductRuntimeSafetyActual})`,
    '',
    '## Phase 4 residual audit',
    '',
    `Slugs with **>${PHASE4_REOPEN_THRESHOLD}** product-runtime suppressions and disposition other than pure **(b)** are reopened for triage:`,
    '',
  );
  if (audit.reopenCandidates.length === 0) {
    lines.push('_None — all high-count buckets are accepted (b) or at/under threshold._', '');
  } else {
    lines.push(
      '| Slug | Count | Disposition | Kind | Next action |',
      '|------|------:|:-----------:|:----:|-------------|',
    );
    for (const row of audit.reopenCandidates) {
      let action = 'Assign disposition in TRIAGE_DISPOSITION';
      if (row.disposition === 'c' || row.disposition === 'b/c') {
        action = 'Further heuristic tightening (future release)';
      } else if (row.disposition === 'a/b') {
        action = 'Spot-fix @throws / docs where cheap; keep remainder waived';
      }
      lines.push(
        `| \`${row.slug}\` | ${row.count} | ${row.disposition} | ${row.kind} | ${action} |`,
      );
    }
    lines.push('');
  }
  if (audit.acceptedHighCount.length > 0) {
    lines.push(
      '**Accepted high-count buckets (disposition b, no reopen):**',
      '',
      audit.acceptedHighCount.map((r) => `- \`${r.slug}\` (${r.count})`).join('\n'),
      '',
    );
  }

  lines.push(
    '',
    '## Disposition key',
    '',
    '| Code | Meaning |',
    '|------|---------|',
    '| **a** | Fix — code or docs should change |',
    '| **b** | Accept — waiver is correct; document |',
    '| **c** | Heuristic — improve check logic |',
    '',
    'Full program spec: `docs/plans/specs/suppression-triage-and-reduction.md` (local).',
    '',
  );

  return `${lines.join('\n')}\n`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function catalogFingerprint(catalog) {
  const rest = Object.fromEntries(Object.entries(catalog).filter(([key]) => key !== 'generatedAt'));
  return digest(stableJson(rest));
}

function markdownFingerprint(md) {
  const normalized = md.replace(
    /\*\*Generated:\*\* [^\n]+/,
    '**Generated:** <regenerated-at-commit-time>',
  );
  return digest(normalized);
}

function writeOutputs(catalog) {
  mkdirSync(dirname(CATALOG_JSON_PATH), { recursive: true });
  const json = stableJson(catalog);
  const md = renderTriageMarkdown(catalog);
  writeFileSync(CATALOG_JSON_PATH, json);
  writeFileSync(TRIAGE_MD_PATH, md);
  log(`wrote ${relative(REPO_ROOT, CATALOG_JSON_PATH)}`);
  log(`wrote ${relative(REPO_ROOT, TRIAGE_MD_PATH)}`);
}

function checkStale(catalog) {
  const expectedJsonFp = catalogFingerprint(catalog);
  const expectedMdFp = markdownFingerprint(renderTriageMarkdown(catalog));
  let stale = false;

  try {
    const onDiskCatalog = JSON.parse(readFileSync(CATALOG_JSON_PATH, 'utf8'));
    if (catalogFingerprint(onDiskCatalog) !== expectedJsonFp) {
      log(`stale: ${relative(REPO_ROOT, CATALOG_JSON_PATH)}`);
      stale = true;
    }
    if (markdownFingerprint(readFileSync(TRIAGE_MD_PATH, 'utf8')) !== expectedMdFp) {
      log(`stale: ${relative(REPO_ROOT, TRIAGE_MD_PATH)}`);
      stale = true;
    }
  } catch (error) {
    log(`missing committed output: ${error instanceof Error ? error.message : String(error)}`);
    stale = true;
  }

  if (stale) {
    log('run: node scripts/catalog-suppressions.mjs');
    process.exit(1);
  }
  log('suppression catalog outputs OK (fresh)');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const catalog = buildCatalog({ collectRecords: args.has('--include-records') });

  if (args.has('--stdout-json')) {
    process.stdout.write(stableJson(catalog));
    return;
  }

  if (args.has('--check')) {
    checkStale(catalog);
    return;
  }

  writeOutputs(catalog);
  log(
    `product-runtime: ${catalog.summary.productRuntimeFitness} fitness + ${catalog.summary.productRuntimeGraph} graph = ${catalog.summary.productRuntimeCombined}`,
  );
  log(
    `phase-4 delta: product-runtime combined ${catalog.phase4Audit.delta.productRuntimeCombined} (baseline ${catalog.phase4Audit.baseline.productRuntimeCombined})`,
  );
  if (catalog.phase4Audit.reopenCandidates.length > 0) {
    log(
      `phase-4 reopen: ${catalog.phase4Audit.reopenCandidates.length} slug(s) >${PHASE4_REOPEN_THRESHOLD} without pure (b) — see docs/internal/suppression-triage.md`,
    );
    for (const row of catalog.phase4Audit.reopenCandidates) {
      log(`  ${row.slug}: ${row.count} (${row.disposition})`);
    }
  } else {
    log('phase-4 reopen: none (all high-count buckets accepted or under threshold)');
  }
}

main();
