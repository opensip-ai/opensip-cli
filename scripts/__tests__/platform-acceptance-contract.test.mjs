/**
 * @fileoverview Phase 6 residual coverage — the closed acceptance CONTRACT.
 *
 * Exercises the pure parsers/constructors in `platform-acceptance/contract.mjs`
 * plus the sealed round trip through `evidence-writer.mjs`: valid v1 profile +
 * evidence round trips, fail-closed rejection of malformed/oversized/hostile
 * records, the verdict matrix, and base-profile composition (success + every
 * weakening path). The tamper/verifier matrix lives in the sibling
 * `verify-platform-acceptance.test.mjs` and `platform-acceptance-verifier.test.mjs`;
 * this file never re-drives the verifier process.
 *
 * Runs under `node --test` (`pnpm test:scripts`). Pure — no CLI, npm, or network.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalize,
  composeProfile,
  computeSummary,
  computeVerdict,
  contractError,
  digestOf,
  evidenceDigest,
  parseAcceptanceEvidence,
  parseAcceptanceProfile,
  PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
  profileDigest,
} from '../platform-acceptance/contract.mjs';
import {
  EvidenceWriteError,
  renderFailureDetailLines,
  renderHumanSummaryLines,
  renderJsonSummary,
  writeAcceptanceEvidence,
} from '../platform-acceptance/evidence-writer.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const COMMON_V1_PATH = join(REPO_ROOT, '.config', 'platform-acceptance', 'common-v1.json');
const COMMON_V1_RAW = JSON.parse(readFileSync(COMMON_V1_PATH, 'utf8'));

function clone(value) {
  return structuredClone(value);
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-contract-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_HOST = Object.freeze({
  platform: 'linux',
  arch: 'x64',
  osRelease: '6.1.0',
  osVersion: { status: 'unavailable', reasonCode: 'os-version-empty' },
  nodeVersion: 'v24.0.0',
  nodeModuleAbi: '137',
  npmVersion: '10.0.0',
  packageManager: 'pnpm',
  cpuModel: 'Test CPU',
  cpuCount: 4,
  totalMemoryBytes: 1024,
  filesystem: { type: 'ext4', caseSensitive: true },
  shell: 'bash',
  capabilities: { pty: true, symlink: true, permissions: true, 'process-tree-rss': true },
});

/** A schema-valid evidence body (WITHOUT the terminal completion record). */
function makeEvidenceBody(profile, overrides = {}) {
  const results = profile.journeys.map((journey) => ({
    id: journey.id,
    category: journey.id.split('.')[0],
    required: journey.required,
    status: 'pass',
    reasonCode: null,
    durationMs: 5,
    rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    diagnostics: [],
  }));
  const cleanup = { status: 'clean', reasonCode: null, removedRoots: 3, residualDescendants: 0 };
  const body = {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: { id: profile.id, version: profile.version, digest: profileDigest(profile) },
    candidate: {
      kind: 'packed-release',
      version: '0.7.0',
      source: 'packed-release@0.7.0 (58 npm tarballs)',
      digest: 'a'.repeat(64),
    },
    harnessGitSha: 'abc1234',
    startedAt: '2026-07-15T00:00:00.000Z',
    completedAt: '2026-07-15T00:05:00.000Z',
    host: clone(VALID_HOST),
    results,
    cleanup,
    summary: computeSummary(profile, results),
    verdict: computeVerdict(profile, results, cleanup),
    ...overrides,
  };
  return body;
}

/** Seal a body by appending the completion record over its digest. */
function seal(body, state = 'completed') {
  return { ...body, completion: { state, evidenceDigest: evidenceDigest(body) } };
}

// ---------------------------------------------------------------------------
// Profile parsing
// ---------------------------------------------------------------------------

test('parses and deep-freezes the committed common-v1 profile', () => {
  const profile = parseAcceptanceProfile(COMMON_V1_RAW);
  assert.equal(profile.id, 'common-v1');
  assert.equal(profile.schemaVersion, PLATFORM_ACCEPTANCE_SCHEMA_VERSION);
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.journeys));
  assert.ok(Object.isFrozen(profile.bounds));
  assert.equal(profile.journeys.length, 46);
});

test('rejects unknown keys at every level', () => {
  for (const mutate of [
    (raw) => {
      raw.extra = true;
    },
    (raw) => {
      raw.bounds.extra = 1;
    },
    (raw) => {
      raw.journeys[0].extra = true;
    },
  ]) {
    const raw = clone(COMMON_V1_RAW);
    mutate(raw);
    assert.throws(() => parseAcceptanceProfile(raw), /unknown key|unknown-key/);
  }
});

test('rejects a wrong schema version', () => {
  const raw = clone(COMMON_V1_RAW);
  raw.schemaVersion = 2;
  assert.throws(() => parseAcceptanceProfile(raw), /schemaVersion/);
});

test('rejects a duplicate journey id', () => {
  const raw = clone(COMMON_V1_RAW);
  raw.journeys.push({ id: raw.journeys[0].id, required: true });
  assert.throws(() => parseAcceptanceProfile(raw), /duplicate/);
});

test('rejects an empty journey selection', () => {
  const raw = clone(COMMON_V1_RAW);
  raw.journeys = [];
  assert.throws(() => parseAcceptanceProfile(raw), /non-empty|empty-journeys/);
});

test('rejects invalid numeric bounds (non-positive, non-integer, too large)', () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const raw = clone(COMMON_V1_RAW);
    raw.bounds.journeyTimeoutMs = value;
    assert.throws(() => parseAcceptanceProfile(raw), /bound|integer/);
  }
});

test('rejects an oversized journey selection and an oversized capability list', () => {
  const many = clone(COMMON_V1_RAW);
  many.journeys = Array.from({ length: 257 }, (_v, i) => ({ id: `x.j${i}`, required: false }));
  assert.throws(() => parseAcceptanceProfile(many), /exceeds|too-many/);

  const caps = clone(COMMON_V1_RAW);
  caps.journeys[0].capabilities = Array.from({ length: 65 }, (_v, i) => `cap${i}`);
  assert.throws(() => parseAcceptanceProfile(caps), /exceeds|array-too-long/);
});

test('rejects a duplicate capability inside one journey selection', () => {
  const raw = clone(COMMON_V1_RAW);
  raw.journeys[0].capabilities = ['pty', 'pty'];
  assert.throws(() => parseAcceptanceProfile(raw), /duplicate/);
});

// ---------------------------------------------------------------------------
// Canonicalization + digest
// ---------------------------------------------------------------------------

test('canonicalize sorts object keys, preserves array order, drops undefined', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalize({ a: undefined, b: 1 }), '{"b":1}');
});

test('canonicalize refuses non-finite numbers and non-JSON values', () => {
  assert.throws(() => canonicalize(Number.NaN), /non-finite/);
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), /non-finite/);
  assert.throws(() => canonicalize(() => 1), /non-json-value/);
});

test('digestOf is stable across key ordering', () => {
  assert.equal(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
  assert.notEqual(digestOf({ a: 1 }), digestOf({ a: 2 }));
});

test('contractError carries a machine-readable reasonCode', () => {
  const error = contractError('some-code', 'a message');
  assert.equal(error.name, 'ContractError');
  assert.equal(error.reasonCode, 'some-code');
});

// ---------------------------------------------------------------------------
// Summary + verdict matrix
// ---------------------------------------------------------------------------

const MATRIX_PROFILE = parseAcceptanceProfile({
  schemaVersion: 1,
  id: 'matrix',
  version: 1,
  requiredCapabilities: [],
  rssRequired: false,
  bounds: {
    journeyTimeoutMs: 1000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    maxDiagnosticTailBytes: 1024,
    rssSampleIntervalMs: 100,
    maxEvidenceBytes: 100_000,
    maxJourneyResults: 16,
  },
  journeys: [
    { id: 'a.required-one', required: true },
    { id: 'a.required-two', required: true },
    { id: 'a.optional-one', required: false },
  ],
});

function matrixResults(statuses) {
  return MATRIX_PROFILE.journeys.map((journey, index) => ({
    id: journey.id,
    category: 'a',
    required: journey.required,
    status: statuses[index],
    reasonCode: statuses[index] === 'pass' ? null : 'forced',
    durationMs: 1,
    rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    diagnostics: [],
  }));
}

const CLEAN = { status: 'clean', reasonCode: null, removedRoots: 1, residualDescendants: 0 };

test('verdict matrix: optional skip preserves a passing required set; any required non-pass fails', () => {
  const rows = [
    { statuses: ['pass', 'pass', 'skipped'], cleanup: CLEAN, verdict: 'pass' },
    { statuses: ['pass', 'pass', 'unavailable'], cleanup: CLEAN, verdict: 'pass' },
    { statuses: ['pass', 'pass', 'fail'], cleanup: CLEAN, verdict: 'pass' },
    { statuses: ['fail', 'pass', 'pass'], cleanup: CLEAN, verdict: 'fail' },
    { statuses: ['pass', 'skipped', 'pass'], cleanup: CLEAN, verdict: 'fail' },
    { statuses: ['pass', 'unavailable', 'pass'], cleanup: CLEAN, verdict: 'fail' },
    {
      statuses: ['pass', 'pass', 'pass'],
      cleanup: {
        status: 'incomplete',
        reasonCode: 'cleanup-residual',
        removedRoots: 0,
        residualDescendants: 0,
      },
      verdict: 'fail',
    },
    {
      statuses: ['pass', 'pass', 'pass'],
      cleanup: { status: 'clean', reasonCode: null, removedRoots: 1, residualDescendants: 2 },
      verdict: 'fail',
    },
  ];
  for (const row of rows) {
    const results = matrixResults(row.statuses);
    assert.equal(
      computeVerdict(MATRIX_PROFILE, results, row.cleanup),
      row.verdict,
      `statuses=${row.statuses.join(',')} cleanup=${row.cleanup.status}/${row.cleanup.residualDescendants}`,
    );
  }
});

test('computeVerdict enforces rssRequired: a run must exhibit real peak-RSS proof', () => {
  const rssProfile = parseAcceptanceProfile({
    schemaVersion: 1,
    id: 'rss-matrix',
    version: 1,
    requiredCapabilities: [],
    rssRequired: true,
    bounds: {
      journeyTimeoutMs: 1000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxDiagnosticTailBytes: 1024,
      rssSampleIntervalMs: 100,
      maxEvidenceBytes: 100_000,
      maxJourneyResults: 16,
    },
    journeys: [
      { id: 'a.required-one', required: true },
      { id: 'a.required-two', required: true },
      { id: 'a.optional-one', required: false },
    ],
  });
  const allPass = (rssByIndex) =>
    rssProfile.journeys.map((journey, index) => ({
      id: journey.id,
      category: 'a',
      required: journey.required,
      status: 'pass',
      reasonCode: null,
      durationMs: 1,
      rss: rssByIndex[index] ?? { status: 'unavailable', reasonCode: 'rss-not-sampled' },
      diagnostics: [],
    }));

  // Every required journey passes, but NONE produced a real RSS sample: an
  // RSS-required profile cannot be satisfied, so the verdict fails.
  assert.equal(computeVerdict(rssProfile, allPass([]), CLEAN), 'fail');
  // At least one required, passing journey exhibits available RSS: satisfied.
  assert.equal(
    computeVerdict(rssProfile, allPass([{ status: 'available', peakBytes: 4096 }]), CLEAN),
    'pass',
  );
  // Available RSS on an OPTIONAL journey alone does not prove capability.
  assert.equal(
    computeVerdict(
      rssProfile,
      allPass([undefined, undefined, { status: 'available', peakBytes: 4096 }]),
      CLEAN,
    ),
    'fail',
  );
  // The identical all-unavailable results pass when the profile does not require RSS.
  assert.equal(computeVerdict(MATRIX_PROFILE, allPass([]), CLEAN), 'pass');
});

test('computeSummary counts each status and the required-passed subset', () => {
  const summary = computeSummary(MATRIX_PROFILE, matrixResults(['pass', 'fail', 'skipped']));
  assert.deepEqual(summary, {
    total: 3,
    passed: 1,
    failed: 1,
    skipped: 1,
    unavailable: 0,
    requiredTotal: 2,
    requiredPassed: 1,
  });
});

test('computeVerdict fails when a required journey result is entirely absent', () => {
  const partial = matrixResults(['pass', 'pass', 'pass']).slice(0, 1);
  assert.equal(computeVerdict(MATRIX_PROFILE, partial, CLEAN), 'fail');
});

// ---------------------------------------------------------------------------
// composeProfile
// ---------------------------------------------------------------------------

const BASE_PROFILE = parseAcceptanceProfile(COMMON_V1_RAW);

function derivedRaw(
  mutate = () => {
    /* no mutation by default */
  },
) {
  const raw = clone(COMMON_V1_RAW);
  raw.id = 'derived-v1';
  raw.base = { id: 'common-v1', digest: profileDigest(BASE_PROFILE) };
  mutate(raw);
  return raw;
}

test('composeProfile succeeds when derived adds a journey, strengthens optional→required, and tightens a bound', () => {
  const composed = composeProfile(
    BASE_PROFILE,
    derivedRaw((raw) => {
      raw.journeys.push({ id: 'darwin.only', required: true });
      const upgrade = raw.journeys.find((j) => j.id === 'lifecycle.upgrade');
      upgrade.required = true;
      raw.bounds.journeyTimeoutMs = BASE_PROFILE.bounds.journeyTimeoutMs - 1;
    }),
  );
  assert.equal(composed.id, 'derived-v1');
  // Base journeys keep base order; new derived journeys append at the end.
  assert.equal(composed.journeys.at(-1).id, 'darwin.only');
  assert.equal(composed.journeys.find((j) => j.id === 'lifecycle.upgrade').required, true);
  assert.ok(Object.isFrozen(composed));
});

test('composeProfile rejects an unknown base id and a self-referential (cyclic) base', () => {
  assert.throws(
    () =>
      composeProfile(
        BASE_PROFILE,
        derivedRaw((raw) => {
          raw.base.id = 'not-known';
        }),
      ),
    /unknown-base/,
  );
  assert.throws(
    () =>
      composeProfile(
        BASE_PROFILE,
        derivedRaw((raw) => {
          raw.id = 'common-v1';
        }),
      ),
    /cyclic-base/,
  );
});

test('composeProfile rejects a base-digest mismatch', () => {
  assert.throws(
    () =>
      composeProfile(
        BASE_PROFILE,
        derivedRaw((raw) => {
          raw.base.digest = 'b'.repeat(64);
        }),
      ),
    /base-digest-mismatch/,
  );
});

test('composeProfile rejects a removed base journey', () => {
  assert.throws(
    () =>
      composeProfile(
        BASE_PROFILE,
        derivedRaw((raw) => {
          raw.journeys = raw.journeys.slice(1);
        }),
      ),
    /removed-journey/,
  );
});

test('composeProfile rejects downgrading a required base journey to optional', () => {
  assert.throws(
    () =>
      composeProfile(
        BASE_PROFILE,
        derivedRaw((raw) => {
          raw.journeys.find((j) => j.id === 'lifecycle.version').required = false;
        }),
      ),
    /downgraded-journey/,
  );
});

test('composeProfile rejects a weakened (larger) bound', () => {
  assert.throws(
    () =>
      composeProfile(
        BASE_PROFILE,
        derivedRaw((raw) => {
          raw.bounds.maxEvidenceBytes = BASE_PROFILE.bounds.maxEvidenceBytes + 1;
        }),
      ),
    /weaker-bound/,
  );
});

test('composeProfile rejects a derived profile that omits its base declaration', () => {
  const raw = clone(COMMON_V1_RAW);
  raw.id = 'derived-v1';
  assert.throws(() => composeProfile(BASE_PROFILE, raw), /missing-base/);
});

// ---------------------------------------------------------------------------
// Evidence round trip + rejection
// ---------------------------------------------------------------------------

test('a sealed evidence body round-trips through parseAcceptanceEvidence and freezes', () => {
  const sealed = seal(makeEvidenceBody(BASE_PROFILE));
  const evidence = parseAcceptanceEvidence(sealed);
  assert.equal(evidence.verdict, 'pass');
  assert.ok(Object.isFrozen(evidence));
  assert.ok(Object.isFrozen(evidence.results));
});

test('parseAcceptanceEvidence rejects a completion digest that does not match the sealed body', () => {
  const sealed = seal(makeEvidenceBody(BASE_PROFILE));
  sealed.completion = { state: 'completed', evidenceDigest: 'f'.repeat(64) };
  assert.throws(() => parseAcceptanceEvidence(sealed), /evidence-digest-mismatch/);
});

test('parseAcceptanceEvidence rejects completedAt before startedAt', () => {
  const body = makeEvidenceBody(BASE_PROFILE, { completedAt: '2025-01-01T00:00:00.000Z' });
  assert.throws(() => parseAcceptanceEvidence(seal(body)), /timestamp-order/);
});

test('parseAcceptanceEvidence rejects a duplicate result id and a missing completion record', () => {
  const body = makeEvidenceBody(BASE_PROFILE);
  body.results[1] = { ...body.results[1], id: body.results[0].id };
  assert.throws(() => parseAcceptanceEvidence(seal(body)), /duplicate-result/);

  const noCompletion = makeEvidenceBody(BASE_PROFILE);
  assert.throws(() => parseAcceptanceEvidence(noCompletion), /completion/);
});

test('parseAcceptanceEvidence rejects unknown top-level keys and non-array results', () => {
  const withUnknown = seal(makeEvidenceBody(BASE_PROFILE));
  withUnknown.rogue = true;
  assert.throws(() => parseAcceptanceEvidence(withUnknown), /unknown-key/);

  const badResults = makeEvidenceBody(BASE_PROFILE);
  badResults.results = 'not-an-array';
  assert.throws(() => parseAcceptanceEvidence(seal(badResults)), /invalid-results/);
});

test('RSS is a tagged measurement: bare zero/undefined sentinels are rejected', () => {
  // An available measurement must carry peakBytes and no reasonCode.
  for (const rss of [
    {},
    { status: 'available' },
    { status: 'available', reasonCode: 'nope' },
    { status: 'unavailable' },
    { status: 'unavailable', peakBytes: 0 },
    { status: 'bogus' },
  ]) {
    const body = makeEvidenceBody(BASE_PROFILE);
    body.results[0] = { ...body.results[0], rss };
    assert.throws(
      () => parseAcceptanceEvidence(seal(body)),
      (error) => error.name === 'ContractError' && typeof error.reasonCode === 'string',
      `rss sentinel ${JSON.stringify(rss)} was not rejected`,
    );
  }
  // A genuine zero-byte available sample is a valid tagged measurement.
  const zero = makeEvidenceBody(BASE_PROFILE);
  zero.results[0] = { ...zero.results[0], rss: { status: 'available', peakBytes: 0 } };
  assert.doesNotThrow(() => parseAcceptanceEvidence(seal(zero)));
});

test('candidate registry must never embed credentials', () => {
  const body = makeEvidenceBody(BASE_PROFILE);
  body.candidate = { ...body.candidate, registry: 'user:pass@registry.example' };
  assert.throws(() => parseAcceptanceEvidence(seal(body)), /invalid-registry/);
  const httpsOk = makeEvidenceBody(BASE_PROFILE);
  httpsOk.candidate = { ...httpsOk.candidate, registry: 'registry.npmjs.org' };
  assert.doesNotThrow(() => parseAcceptanceEvidence(seal(httpsOk)));
});

// ---------------------------------------------------------------------------
// evidence-writer: seal, atomic write, path safety, byte bound, summary purity
// ---------------------------------------------------------------------------

test('writeAcceptanceEvidence writes a verifiable sealed artifact', () => {
  withTempDir((dir) => {
    const outPath = join(dir, 'evidence.json');
    const result = writeAcceptanceEvidence({
      evidence: makeEvidenceBody(BASE_PROFILE),
      completionState: 'completed',
      outPath,
      maxEvidenceBytes: BASE_PROFILE.bounds.maxEvidenceBytes,
    });
    assert.equal(result.ok, true);
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.doesNotThrow(() => parseAcceptanceEvidence(written));
    assert.equal(written.completion.state, 'completed');
  });
});

test('writeAcceptanceEvidence refuses a symlink destination and a path inside the run root', () => {
  withTempDir((dir) => {
    const runRoot = join(dir, 'run');
    const inside = join(runRoot, 'evidence.json');
    assert.throws(
      () =>
        writeAcceptanceEvidence({
          evidence: makeEvidenceBody(BASE_PROFILE),
          completionState: 'completed',
          outPath: inside,
          maxEvidenceBytes: BASE_PROFILE.bounds.maxEvidenceBytes,
          runRoot,
        }),
      (error) => error instanceof EvidenceWriteError && error.reasonCode === 'out-inside-run-root',
    );

    const target = join(dir, 'target.json');
    writeFileSync(target, '{}');
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    assert.throws(
      () =>
        writeAcceptanceEvidence({
          evidence: makeEvidenceBody(BASE_PROFILE),
          completionState: 'completed',
          outPath: link,
          maxEvidenceBytes: BASE_PROFILE.bounds.maxEvidenceBytes,
        }),
      (error) => error instanceof EvidenceWriteError && error.reasonCode === 'out-is-symlink',
    );
  });
});

test('writeAcceptanceEvidence enforces the profile evidence byte bound', () => {
  withTempDir((dir) => {
    assert.throws(
      () =>
        writeAcceptanceEvidence({
          evidence: makeEvidenceBody(BASE_PROFILE),
          completionState: 'completed',
          outPath: join(dir, 'evidence.json'),
          maxEvidenceBytes: 64,
        }),
      (error) => error instanceof EvidenceWriteError && error.reasonCode === 'evidence-too-large',
    );
  });
});

test('renderJsonSummary carries only counts + identity, never stdout/stderr tails', () => {
  const sealed = seal(makeEvidenceBody(BASE_PROFILE));
  const evidence = parseAcceptanceEvidence(sealed);
  const result = {
    outcome: 'completed',
    verdict: 'pass',
    reasonCode: null,
    completionState: 'completed',
    evidence,
  };
  const summary = renderJsonSummary(result, '/out/evidence.json');
  assert.equal(summary.verdict, 'pass');
  assert.deepEqual(Object.keys(summary.candidate).sort(), ['kind', 'source', 'version']);
  // No child-output fields ever appear in the summary shape.
  const serialized = JSON.stringify(summary);
  assert.ok(!/stdout|stderr|diagnostics/.test(serialized), serialized);

  const human = renderHumanSummaryLines(result).join('\n');
  assert.ok(
    human.includes(
      `required: ${evidence.summary.requiredPassed}/${evidence.summary.requiredTotal}`,
    ),
  );
  assert.deepEqual(renderFailureDetailLines(result), []);
});

test('renderJsonSummary of an evidence-less (invalid invocation) result is bounded and null-shaped', () => {
  const summary = renderJsonSummary(
    {
      outcome: 'invalid-invocation',
      verdict: null,
      reasonCode: 'candidate-invalid',
      evidence: null,
    },
    null,
  );
  assert.equal(summary.profile, null);
  assert.equal(summary.candidate, null);
  assert.deepEqual(summary.requiredFailures, []);
});
