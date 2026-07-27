/**
 * @fileoverview Plan 01 Task A.1 — tests for the recall measurement.
 *
 * The measurement's whole value is that it cannot flatter itself, so the tests pin the
 * properties that would let it lie: totality of the bucketing, refusal to attribute an
 * ambiguous join, the human-review cap, and byte-identical output on unchanged input.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUCKETS,
  HUMAN_REVIEW_CAP_RATIO,
  JOIN_WINDOW_LINES,
  capViolation,
  classify,
  digest,
  joinFindingsToSites,
  normalizePath,
  perCheck,
  summarize,
} from './error-resiliency-recall.mjs';

const site = (over = {}) => ({
  siteKey: `${over.path ?? 'p/a.ts'}::${over.kind ?? 'throw'}@${over.line ?? 10}`,
  path: 'p/a.ts',
  line: 10,
  kind: 'throw',
  source: 'structural',
  risk: 'medium',
  boundaryFamily: 'cli-failure-reporting',
  package: '@x/y',
  ...over,
});

const finding = (over = {}) => ({
  ruleId: 'r1',
  filePath: 'p/a.ts',
  line: 10,
  ...over,
});

test('normalizePath reduces absolute repo paths to repo-relative', () => {
  assert.equal(
    normalizePath('/Users/x/code/opensip-ai/opensip-cli/packages/core/src/a.ts'),
    'packages/core/src/a.ts',
  );
  assert.equal(normalizePath('./packages/core/src/a.ts'), 'packages/core/src/a.ts');
  assert.equal(normalizePath('packages/core/src/a.ts'), 'packages/core/src/a.ts');
});

test('a finding within the join window attributes to its site', () => {
  const sites = [site()];
  const { hits, ambiguous, findingsWithoutSite } = joinFindingsToSites(sites, [
    finding({ line: 10 + JOIN_WINDOW_LINES }),
  ]);
  assert.deepEqual([...(hits.get(sites[0].siteKey) ?? [])], ['r1']);
  assert.equal(ambiguous.length, 0);
  assert.equal(findingsWithoutSite.length, 0);
});

test('a finding beyond the window is unmatched, not force-attributed', () => {
  const sites = [site()];
  const { hits, findingsWithoutSite } = joinFindingsToSites(sites, [
    finding({ line: 10 + JOIN_WINDOW_LINES + 1 }),
  ]);
  assert.equal(hits.size, 0);
  assert.equal(findingsWithoutSite.length, 1);
});

test('equidistant candidate sites are recorded ambiguous rather than attributed', () => {
  // An inflated recall number is worse than a measured gap.
  const sites = [site({ line: 8, siteKey: 'a' }), site({ line: 12, siteKey: 'b' })];
  const { hits, ambiguous } = joinFindingsToSites(sites, [finding({ line: 10 })]);
  assert.equal(hits.size, 0, 'no site may be credited when the join is ambiguous');
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].reason, 'multiple-sites-equidistant');
});

test('an unambiguous nearest site still wins', () => {
  const sites = [site({ line: 9, siteKey: 'near' }), site({ line: 13, siteKey: 'far' })];
  const { hits, ambiguous } = joinFindingsToSites(sites, [finding({ line: 10 })]);
  assert.deepEqual([...hits.keys()], ['near']);
  assert.equal(ambiguous.length, 0);
});

test('a file-scoped finding attributes only when the file holds exactly one site', () => {
  const one = [site({ siteKey: 'only' })];
  assert.deepEqual(
    [...joinFindingsToSites(one, [finding({ line: undefined })]).hits.keys()],
    ['only'],
  );

  const many = [site({ siteKey: 'a', line: 5 }), site({ siteKey: 'b', line: 50 })];
  const res = joinFindingsToSites(many, [finding({ line: undefined })]);
  assert.equal(res.hits.size, 0);
  assert.equal(res.ambiguous[0].reason, 'file-scoped-finding-multi-site-file');
});

test('classification is total: every site lands in exactly one known bucket', () => {
  const sites = [site({ siteKey: 'a' }), site({ siteKey: 'b' }), site({ siteKey: 'c' })];
  const hits = new Map([['a', new Set(['r1'])]]);
  const rows = classify({
    sites,
    hits,
    humanReview: new Map([['b', 'requires caller-contract knowledge']]),
    suppressed: new Map(),
  });
  assert.equal(rows.length, 3);
  for (const r of rows) assert.ok(BUCKETS.includes(r.bucket), `unknown bucket ${r.bucket}`);
  assert.equal(rows.find((r) => r.siteKey === 'a').bucket, 'caught');
  assert.equal(rows.find((r) => r.siteKey === 'b').bucket, 'not-mechanically-expressible');
  assert.equal(rows.find((r) => r.siteKey === 'c').bucket, 'missed');
  const summed = BUCKETS.reduce((n, b) => n + rows.filter((r) => r.bucket === b).length, 0);
  assert.equal(summed, rows.length, 'buckets must partition the site set');
});

test('a suppressed site is distinguished from a miss', () => {
  const rows = classify({
    sites: [site({ siteKey: 'a' })],
    hits: new Map(),
    humanReview: new Map(),
    suppressed: new Map([['error-handling-quality::p/a.ts', 'accepted-risk']]),
  });
  assert.equal(rows[0].bucket, 'caught-but-suppressed');
  assert.match(rows[0].detail, /error-handling-quality/);
});

test('human-review entries without a written reason are ignored, never silently bucketed', () => {
  // loadHumanReview drops reasonless entries; classify then treats the site as measured.
  const rows = classify({
    sites: [site({ siteKey: 'a' })],
    hits: new Map(),
    humanReview: new Map(),
    suppressed: new Map(),
  });
  assert.equal(rows[0].bucket, 'missed');
});

test('the not-mechanically-expressible bucket is capped', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    siteKey: String(i),
    bucket: i < 20 ? 'not-mechanically-expressible' : 'missed',
    risk: 'low',
  }));
  const v = capViolation(rows);
  assert.equal(v.cap, Math.floor(100 * HUMAN_REVIEW_CAP_RATIO));
  assert.equal(v.exceeded, true, '20 of 100 must exceed the 15% cap');
  assert.equal(capViolation(rows.map((r) => ({ ...r, bucket: 'missed' }))).exceeded, false);
});

test('summary totals reconcile to the row count and weight by risk', () => {
  const rows = [
    {
      siteKey: 'a',
      bucket: 'caught',
      risk: 'critical',
      boundaryFamily: 'x',
      kind: 'throw',
      source: 'structural',
      package: 'p',
      ruleIds: ['r1'],
    },
    {
      siteKey: 'b',
      bucket: 'missed',
      risk: 'low',
      boundaryFamily: 'x',
      kind: 'catch',
      source: 'human',
      package: 'p',
      ruleIds: [],
    },
  ];
  const s = summarize(rows);
  assert.equal(s.totals.caught + s.totals.missed, rows.length);
  assert.equal(s.weightedRisk.caught, 8, 'critical weighs 8');
  assert.equal(s.weightedRisk.missed, 1, 'low weighs 1');
  assert.equal(s.recall, 0.5);
  assert.deepEqual(Object.keys(s.byBoundaryFamily), ['x']);
});

test('perCheck attributes each catching rule and is ordered by volume', () => {
  const rows = [
    { ruleIds: ['a', 'b'], bucket: 'caught' },
    { ruleIds: ['a'], bucket: 'caught' },
    { ruleIds: [], bucket: 'missed' },
  ];
  assert.deepEqual(perCheck(rows), { a: 2, b: 1 });
});

test('the artifact is deterministic: identical inputs digest identically', () => {
  const build = () => {
    const sites = [site({ siteKey: 'b' }), site({ siteKey: 'a' })];
    const rows = classify({
      sites,
      hits: new Map([['a', new Set(['r2', 'r1'])]]),
      humanReview: new Map(),
      suppressed: new Map(),
    });
    return { rows, summary: summarize(rows), perCheck: perCheck(rows) };
  };
  assert.equal(digest(build()), digest(build()));
  // ...and ordering is normalized, not incidental
  assert.deepEqual(
    build().rows.map((r) => r.siteKey),
    ['a', 'b'],
  );
  assert.deepEqual(build().rows[0].ruleIds, ['r1', 'r2']);
});
