import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACCEPTED_DISPOSITIONS,
  BOUNDS,
  DISPOSITIONS,
  SCHEMA_VERSION,
  assertSafeRepoRelativePath,
  canonicalStringify,
  compareByCodePoint,
  defaultDetectorCoverage,
  digestCanonical,
  findDuplicates,
  formatInventoryDiagnostic,
  loadRubricVersion,
  loadSchemaDocument,
  parseJsonSafe,
  sortByKey,
  validateFileRecord,
  validateSiteRecord,
  InventoryError,
} from '../lib/error-resiliency-inventory.mjs';
import {
  DETECTOR_VERSION,
  extractStructuralSites,
  getDetectorCoverageManifest,
  isStructurallySupportedPath,
  makeStructuralSiteId,
} from '../lib/error-resiliency-sites.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('schema.json declares schemaVersion const 1', () => {
  const schema = loadSchemaDocument(REPO_ROOT);
  assert.equal(schema.properties.schemaVersion.const, SCHEMA_VERSION);
  assert.ok(schema.definitions.fileRecord);
  assert.ok(schema.definitions.siteRecord);
});

test('rubric version is readable and matches library constant shape', () => {
  const version = loadRubricVersion(REPO_ROOT);
  assert.match(version, /^\d+\.\d+\.\d+$/u);
});

test('parseJsonSafe rejects oversized and deep payloads', () => {
  assert.throws(() => parseJsonSafe('{', { label: 'bad' }), /not valid JSON/);
  assert.throws(
    () => parseJsonSafe('{"a":1}', { maxBytes: 2, label: 'tiny' }),
    /exceeds/,
  );
  let deep = '0';
  for (let i = 0; i < 40; i++) deep = `[${deep}]`;
  assert.throws(() => parseJsonSafe(deep, { maxDepth: 8, label: 'deep' }), /nesting depth/);
});

test('canonicalStringify sorts keys and digest is stable', () => {
  const left = { b: 1, a: { z: 2, y: 3 } };
  const right = { a: { y: 3, z: 2 }, b: 1 };
  assert.equal(canonicalStringify(left), canonicalStringify(right));
  assert.equal(digestCanonical(left), digestCanonical(right));
  assert.equal(compareByCodePoint('a', 'b'), -1);
  assert.deepEqual(
    sortByKey(
      [
        { path: 'b' },
        { path: 'a' },
      ],
      (x) => x.path,
    ).map((x) => x.path),
    ['a', 'b'],
  );
});

test('assertSafeRepoRelativePath rejects escapes and absolutes', () => {
  assert.equal(assertSafeRepoRelativePath('packages/core/src/lib/errors.ts'), 'packages/core/src/lib/errors.ts');
  assert.throws(() => assertSafeRepoRelativePath('../secret'), /escape/i);
  assert.throws(() => assertSafeRepoRelativePath('/etc/passwd'), /relative/i);
  assert.throws(() => assertSafeRepoRelativePath('a\\b'), /POSIX/);
});

test('validateFileRecord enforces closed enums and needs-decision policy', () => {
  const base = {
    path: 'packages/core/src/lib/errors.ts',
    blobOid: 'deadbeef',
    classification: 'production',
    packageName: '@opensip-cli/core',
    fullFileRead: true,
    disposition: 'migrate',
    reviewers: [],
    sites: [],
  };
  const ok = validateFileRecord(base, { allowNeedsDecision: false });
  assert.equal(ok.path, base.path);

  assert.throws(
    () => validateFileRecord({ ...base, disposition: 'needs-decision' }, { allowNeedsDecision: false }),
    (error) => error instanceof InventoryError && error.code === 'INVENTORY.FILE.NEEDS_DECISION',
  );

  const pending = validateFileRecord(
    { ...base, disposition: 'needs-decision' },
    { allowNeedsDecision: true },
  );
  assert.equal(pending.disposition, 'needs-decision');

  assert.throws(
    () => validateFileRecord({ ...base, extra: true }),
    /unknown field/,
  );
  assert.throws(
    () => validateFileRecord({ ...base, classification: 'nope' }),
    /unknown value/,
  );
});

test('validateSiteRecord and findDuplicates catch collisions', () => {
  const site = validateSiteRecord(
    {
      siteId: 's1:0123456789abcdef',
      kind: 'throw',
      source: 'structural',
      disposition: 'migrate',
      fingerprint: 'abc',
    },
    { allowNeedsDecision: false },
  );
  assert.equal(site.kind, 'throw');

  const dups = findDuplicates([
    {
      path: 'a.ts',
      sites: [
        { siteId: 'same-id-xx' },
        { siteId: 'same-id-xx' },
      ],
    },
    { path: 'a.ts', sites: [] },
  ]);
  assert.deepEqual(dups.duplicatePaths, ['a.ts']);
  assert.deepEqual(dups.duplicateSiteIds, ['same-id-xx']);
});

test('accepted dispositions exclude needs-decision', () => {
  assert.ok(DISPOSITIONS.includes('needs-decision'));
  assert.equal(ACCEPTED_DISPOSITIONS.includes('needs-decision'), false);
});

test('structural extractor finds throw/catch/retry/timer without using regex on source kinds', () => {
  assert.equal(isStructurallySupportedPath('pkg/x.ts'), true);
  assert.equal(isStructurallySupportedPath('pkg/x.py'), false);

  const source = `
export function demo(signal) {
  try {
    if (!signal) throw new Error('missing');
    withRetry(() => fetch('https://example.invalid'));
    setTimeout(() => {}, 10);
  } catch (error) {
    return error;
  }
}
`;
  const { sites, coverage, truncated } = extractStructuralSites('packages/demo/src/demo.ts', source);
  assert.equal(truncated, false);
  const kinds = new Set(sites.map((s) => s.kind));
  assert.ok(kinds.has('throw'));
  assert.ok(kinds.has('catch'));
  assert.ok(kinds.has('retry'));
  assert.ok(kinds.has('timer'));
  assert.ok(kinds.has('error-construction'));
  for (const site of sites) {
    assert.equal(site.source, 'structural');
    assert.match(site.siteId, /^s1:[0-9a-f]{24}$/u);
    assert.equal(site.disposition, 'needs-decision');
  }
  // Same source => stable site ids
  const again = extractStructuralSites('packages/demo/src/demo.ts', source);
  assert.deepEqual(
    sites.map((s) => s.siteId).sort(),
    again.sites.map((s) => s.siteId).sort(),
  );
  assert.equal(coverage.detectorVersion, DETECTOR_VERSION);
  assert.ok(coverage.humanReviewOnly.some((row) => row.language === 'python'));
});

test('site ids ignore line movement for identical structure ordinals', () => {
  const a = `
function f() {
  throw new Error('x');
}
`;
  const b = `
function f() {


  throw new Error('x');
}
`;
  const sitesA = extractStructuralSites('pkg/a.ts', a).sites.filter((s) => s.kind === 'throw');
  const sitesB = extractStructuralSites('pkg/a.ts', b).sites.filter((s) => s.kind === 'throw');
  assert.equal(sitesA.length, 1);
  assert.equal(sitesB.length, 1);
  // fingerprints may differ if snippet includes whitespace-normalized text still same
  assert.equal(sitesA[0].siteId, sitesB[0].siteId);
  assert.notEqual(sitesA[0].line, sitesB[0].line);
});

test('makeStructuralSiteId is deterministic', () => {
  const id1 = makeStructuralSiteId('a.ts', 'throw', 'fp1');
  const id2 = makeStructuralSiteId('a.ts', 'throw', 'fp1');
  const id3 = makeStructuralSiteId('a.ts', 'catch', 'fp1');
  assert.equal(id1, id2);
  assert.notEqual(id1, id3);
});

test('detector coverage manifest is honest about non-TS languages', () => {
  const coverage = getDetectorCoverageManifest();
  assert.deepEqual(coverage, defaultDetectorCoverage());
  assert.ok(coverage.humanReviewOnly.length >= 1);
  assert.ok(BOUNDS.maxSourceFileBytes > 0);
});

test('formatInventoryDiagnostic includes repair hints', () => {
  const diagnostic = formatInventoryDiagnostic(
    new InventoryError('INVENTORY.FILE.NEEDS_DECISION', 'needs decision', { path: 'x' }),
  );
  assert.equal(diagnostic.code, 'INVENTORY.FILE.NEEDS_DECISION');
  assert.match(diagnostic.repair, /C3/);
});

test('schema file is valid JSON and present on disk', () => {
  const text = readFileSync(
    join(REPO_ROOT, '.config/error-resiliency-inventory/schema.json'),
    'utf8',
  );
  const parsed = parseJsonSafe(text);
  assert.equal(typeof parsed, 'object');
});
