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
  isJourneyApplicable,
  isJourneyRequired,
  parseAcceptanceEvidence,
  parseAcceptanceProfile,
  PLATFORM_ACCEPTANCE_BOUND_LIMITS,
  PLATFORM_ACCEPTANCE_CAPABILITIES,
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
const MACOS_V1_PATH = join(
  REPO_ROOT,
  '.config',
  'platform-acceptance',
  'macos-26-arm64-node24-npm11-v1.json',
);
const MACOS_V1_RAW = JSON.parse(readFileSync(MACOS_V1_PATH, 'utf8'));

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
  swVers: { status: 'unavailable', reasonCode: 'darwin-only-probe' },
  kernelRelease: { status: 'unavailable', reasonCode: 'darwin-only-probe' },
  unameArch: { status: 'unavailable', reasonCode: 'darwin-only-probe' },
  capabilities: {
    pty: true,
    symlink: true,
    permissions: true,
    'process-tree-rss': true,
    'process-tree-cleanup': true,
  },
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
  const cleanup = {
    status: 'clean',
    reasonCode: null,
    removedRoots: 3,
    residualDescendants: 0,
  };
  const body = {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: {
      id: profile.id,
      version: profile.version,
      digest: profileDigest(profile),
    },
    candidate: {
      kind: 'packed-release',
      version: '0.7.0',
      source: 'packed-release@0.7.0 (58 npm tarballs)',
      digest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
    },
    previousCandidate: null,
    execution: {
      runId: 'local-test',
      runAttempt: 1,
      runnerLabel: 'test-runner',
    },
    lifecycle: {
      installedVersion: '0.7.0',
      upgradedVersion: '0.7.0',
      versionMigrated: false,
      stateMigrated: true,
      cliStateRemoved: true,
      packageRemoved: true,
      targetInstallChannel: 'packed-consumer',
      integrityChecks: {
        count: 45,
        durationMs: 1234,
      },
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

function registryProof(inventoryDigest = 'b'.repeat(64)) {
  return {
    inventoryDigest,
    packageNames: ['opensip-cli'],
    packageCount: 1,
    packageSetDigest: 'c'.repeat(64),
    offlineReplayComplete: true,
  };
}

test('lifecycle install channels are closed while legacy v1 evidence may omit the field', () => {
  for (const channel of ['packed-consumer', 'npm-direct', 'canonical-installer', null]) {
    const body = makeEvidenceBody(BASE_PROFILE);
    body.lifecycle.targetInstallChannel = channel;
    assert.equal(parseAcceptanceEvidence(seal(body)).lifecycle.targetInstallChannel, channel);
  }

  const legacy = makeEvidenceBody(BASE_PROFILE);
  delete legacy.lifecycle.targetInstallChannel;
  const parsedLegacy = parseAcceptanceEvidence(seal(legacy));
  assert.equal(Object.hasOwn(parsedLegacy.lifecycle, 'targetInstallChannel'), false);

  const malformed = makeEvidenceBody(BASE_PROFILE);
  malformed.lifecycle.targetInstallChannel = 'curl-script';
  assert.throws(() => parseAcceptanceEvidence(seal(malformed)), /lifecycle\.targetInstallChannel/);
});

test('candidate-integrity timing is bounded observability and remains additive for v1 evidence', () => {
  const body = makeEvidenceBody(BASE_PROFILE);
  assert.deepEqual(parseAcceptanceEvidence(seal(body)).lifecycle.integrityChecks, {
    count: 45,
    durationMs: 1234,
  });

  const legacy = makeEvidenceBody(BASE_PROFILE);
  delete legacy.lifecycle.integrityChecks;
  const parsedLegacy = parseAcceptanceEvidence(seal(legacy));
  assert.equal(Object.hasOwn(parsedLegacy.lifecycle, 'integrityChecks'), false);

  for (const field of ['count', 'durationMs']) {
    const malformed = makeEvidenceBody(BASE_PROFILE);
    malformed.lifecycle.integrityChecks[field] = -1;
    assert.throws(
      () => parseAcceptanceEvidence(seal(malformed)),
      new RegExp(`lifecycle\\.integrityChecks\\.${field}`),
    );
  }

  const unknown = makeEvidenceBody(BASE_PROFILE);
  unknown.lifecycle.integrityChecks.extra = 1;
  assert.throws(() => parseAcceptanceEvidence(seal(unknown)), /unknown key/);
});

/** Seal a body by appending the completion record over its digest. */
function seal(body, state = 'completed') {
  return {
    ...body,
    completion: { state, evidenceDigest: evidenceDigest(body) },
  };
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

test('profile and journey capability prerequisites use the closed native vocabulary', () => {
  assert.deepEqual(PLATFORM_ACCEPTANCE_CAPABILITIES, [
    'pty',
    'symlink',
    'permissions',
    'process-tree-rss',
    'process-tree-cleanup',
  ]);
  for (const mutate of [
    (raw) => {
      raw.requiredCapabilities = ['typo-capability'];
    },
    (raw) => {
      raw.journeys[0].capabilities = ['typo-capability'];
    },
  ]) {
    const raw = clone(COMMON_V1_RAW);
    mutate(raw);
    assert.throws(() => parseAcceptanceProfile(raw), /unknown-capability/);
  }
});

test('journey candidate applicability is closed, frozen, and fail-closed', () => {
  const raw = clone(COMMON_V1_RAW);
  raw.journeys[0].candidateKinds = ['published-version'];
  const profile = parseAcceptanceProfile(raw);
  const selection = profile.journeys[0];
  assert.deepEqual(selection.candidateKinds, ['published-version']);
  assert.ok(Object.isFrozen(selection.candidateKinds));
  assert.equal(isJourneyApplicable(selection, 'published-version'), true);
  assert.equal(isJourneyApplicable(selection, 'packed-release'), false);
  assert.equal(isJourneyApplicable(profile.journeys[1], 'packed-release'), true);

  for (const candidateKinds of [[], ['source-tree'], ['published-version', 'published-version']]) {
    const malformed = clone(COMMON_V1_RAW);
    malformed.journeys[0].candidateKinds = candidateKinds;
    assert.throws(() => parseAcceptanceProfile(malformed), /candidate|invalid-enum|duplicate/);
  }
});

test('rejects invalid numeric bounds (non-positive, non-integer, too large)', () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const raw = clone(COMMON_V1_RAW);
    raw.bounds.journeyTimeoutMs = value;
    assert.throws(() => parseAcceptanceProfile(raw), /bound|integer/);
  }
});

test('rejects every profile bound above its field-specific hard ceiling', () => {
  for (const [key, limit] of Object.entries(PLATFORM_ACCEPTANCE_BOUND_LIMITS)) {
    const raw = clone(COMMON_V1_RAW);
    raw.bounds[key] = limit.max + 1;
    assert.throws(
      () => parseAcceptanceProfile(raw),
      (error) => error?.reasonCode === 'bound-too-large',
      key,
    );
  }
});

test('rss sampling interval enforces both anti-spin and coverage bounds', () => {
  const limit = PLATFORM_ACCEPTANCE_BOUND_LIMITS.rssSampleIntervalMs;
  for (const value of [limit.min - 1, limit.max + 1]) {
    const raw = clone(COMMON_V1_RAW);
    raw.bounds.rssSampleIntervalMs = value;
    assert.throws(
      () => parseAcceptanceProfile(raw),
      (error) => error?.reasonCode === (value < limit.min ? 'bound-too-small' : 'bound-too-large'),
    );
  }
});

test('rejects a profile whose journey count exceeds bounds.maxJourneyResults', () => {
  const exact = clone(COMMON_V1_RAW);
  exact.bounds.maxJourneyResults = exact.journeys.length;
  assert.doesNotThrow(() => parseAcceptanceProfile(exact));

  const over = clone(exact);
  over.bounds.maxJourneyResults -= 1;
  assert.throws(
    () => parseAcceptanceProfile(over),
    (error) => error?.reasonCode === 'max-journey-results-exceeded',
  );
});

test('rejects an oversized journey selection and an oversized capability list', () => {
  const many = clone(COMMON_V1_RAW);
  many.journeys = Array.from({ length: 257 }, (_v, i) => ({
    id: `x.j${i}`,
    required: false,
  }));
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

const CLEAN = {
  status: 'clean',
  reasonCode: null,
  removedRoots: 1,
  residualDescendants: 0,
};

test('verdict matrix: optional skip preserves a passing required set; any required non-pass fails', () => {
  const rows = [
    { statuses: ['pass', 'pass', 'skipped'], cleanup: CLEAN, verdict: 'pass' },
    {
      statuses: ['pass', 'pass', 'unavailable'],
      cleanup: CLEAN,
      verdict: 'pass',
    },
    { statuses: ['pass', 'pass', 'fail'], cleanup: CLEAN, verdict: 'pass' },
    { statuses: ['fail', 'pass', 'pass'], cleanup: CLEAN, verdict: 'fail' },
    { statuses: ['pass', 'skipped', 'pass'], cleanup: CLEAN, verdict: 'fail' },
    {
      statuses: ['pass', 'unavailable', 'pass'],
      cleanup: CLEAN,
      verdict: 'fail',
    },
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
      cleanup: {
        status: 'clean',
        reasonCode: null,
        removedRoots: 1,
        residualDescendants: 2,
      },
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

test('computeVerdict enforces rssRequired for every required journey', () => {
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
  const allPass = (rssByIndex, stepRssByIndex = rssByIndex) =>
    rssProfile.journeys.map((journey, index) => {
      const rss = rssByIndex[index] ?? {
        status: 'unavailable',
        reasonCode: 'rss-not-sampled',
      };
      return {
        id: journey.id,
        category: 'a',
        required: journey.required,
        status: 'pass',
        reasonCode: null,
        durationMs: 1,
        rss,
        diagnostics: [],
        steps: [
          {
            label: 'process-1',
            stage: 'process',
            exitCode: 0,
            signal: null,
            timedOut: false,
            cancelled: false,
            outputTruncated: false,
            durationMs: 1,
            rss: stepRssByIndex[index] ?? rss,
            residualDescendants: 0,
            reasonCode: null,
            diagnostics: [],
          },
        ],
      };
    });

  // Every required journey passes, but NONE produced a real RSS sample: an
  // RSS-required profile cannot be satisfied, so the verdict fails.
  assert.equal(computeVerdict(rssProfile, allPass([]), CLEAN), 'fail');
  // One sampled required journey cannot green-wash another unavailable one.
  assert.equal(
    computeVerdict(rssProfile, allPass([{ status: 'available', peakBytes: 4096 }]), CLEAN),
    'fail',
  );
  // Every required journey carries a real sample: satisfied.
  assert.equal(
    computeVerdict(
      rssProfile,
      allPass([
        { status: 'available', peakBytes: 4096 },
        { status: 'available', peakBytes: 2048 },
      ]),
      CLEAN,
    ),
    'pass',
  );
  // A second child that exits before the first sample is expected and cannot
  // invalidate the real sample from another step in the same journey.
  const shortChild = allPass([
    { status: 'available', peakBytes: 4096 },
    { status: 'available', peakBytes: 2048 },
  ]);
  shortChild[0].steps.push({
    ...shortChild[0].steps[0],
    label: 'process-2',
    rss: { status: 'unavailable', reasonCode: 'rss-child-too-short' },
  });
  assert.equal(computeVerdict(rssProfile, shortChild, CLEAN), 'pass');
  const samplerFault = allPass(
    [
      { status: 'available', peakBytes: 4096 },
      { status: 'available', peakBytes: 2048 },
    ],
    [
      { status: 'unavailable', reasonCode: 'rss-sampler-fault' },
      { status: 'available', peakBytes: 2048 },
    ],
  );
  assert.equal(computeVerdict(rssProfile, samplerFault, CLEAN), 'fail');
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

test('an exact previous candidate dynamically gates the otherwise-optional upgrade journey', () => {
  const upgrade = BASE_PROFILE.journeys.find((journey) => journey.id === 'lifecycle.upgrade');
  assert.equal(upgrade.required, false);
  assert.equal(isJourneyRequired(upgrade, null), false);
  assert.equal(
    isJourneyRequired(upgrade, {
      kind: 'published-version',
      version: '0.6.9',
      source: 'npm:opensip-cli@0.6.9',
      digest: 'b'.repeat(64),
    }),
    true,
  );

  const results = matrixResults(['pass', 'pass', 'pass']);
  results[2] = {
    ...results[2],
    required: true,
    status: 'fail',
    reasonCode: 'forced',
  };
  assert.equal(computeSummary(MATRIX_PROFILE, results).requiredTotal, 3);
  assert.equal(computeVerdict(MATRIX_PROFILE, results, CLEAN), 'fail');
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
      const cleanupIndex = raw.journeys.findIndex(
        (journey) => journey.id === 'lifecycle.cli-state-uninstall',
      );
      raw.journeys.splice(cleanupIndex, 0, {
        id: 'darwin.only',
        required: true,
      });
      const upgrade = raw.journeys.find((j) => j.id === 'lifecycle.upgrade');
      upgrade.required = true;
      raw.bounds.journeyTimeoutMs = BASE_PROFILE.bounds.journeyTimeoutMs - 1;
    }),
  );
  assert.equal(composed.id, 'derived-v1');
  // Base journeys keep relative order while a platform journey may be inserted
  // before the terminal lifecycle removals.
  assert.ok(
    composed.journeys.findIndex((journey) => journey.id === 'darwin.only') <
      composed.journeys.findIndex((journey) => journey.id === 'lifecycle.cli-state-uninstall'),
  );
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

test('composeProfile rejects reordering base journeys around derived insertions', () => {
  assert.throws(
    () =>
      composeProfile(
        BASE_PROFILE,
        derivedRaw((raw) => {
          const first = raw.journeys[0];
          raw.journeys[0] = raw.journeys[1];
          raw.journeys[1] = first;
        }),
      ),
    /reordered-base-journey/,
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

test('composeProfile rejects narrowing a base journey to fewer candidate kinds', () => {
  assert.throws(
    () =>
      composeProfile(
        BASE_PROFILE,
        derivedRaw((raw) => {
          raw.journeys[0].candidateKinds = ['published-version'];
        }),
      ),
    /narrowed-journey-applicability/,
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
// supportRow binding (Plan 02, spec §4/§9) — a profile pins the exact public
// platform-support row so acceptance evidence can never satisfy a different claim.
// ---------------------------------------------------------------------------

test('parseAcceptanceProfile parses, freezes, and digests a supportRow binding', () => {
  const raw = clone(COMMON_V1_RAW);
  raw.supportRow = {
    contractVersion: 1,
    rowId: 'macos-26-arm64-node24-npm11-v1',
  };
  const profile = parseAcceptanceProfile(raw);
  assert.deepEqual(profile.supportRow, {
    contractVersion: 1,
    rowId: 'macos-26-arm64-node24-npm11-v1',
  });
  assert.ok(Object.isFrozen(profile.supportRow));
  // The binding is part of the profile identity: two profiles that differ ONLY
  // in their supportRow have different digests, so evidence sealed for one can
  // never verify against the other.
  const other = parseAcceptanceProfile({
    ...raw,
    supportRow: { contractVersion: 1, rowId: 'some-other-row-v1' },
  });
  assert.notEqual(profileDigest(profile), profileDigest(other));
  // A profile with no binding digests differently again.
  assert.notEqual(profileDigest(profile), profileDigest(BASE_PROFILE));
});

test('parseAcceptanceProfile rejects a malformed supportRow', () => {
  for (const [mutate, pattern] of [
    [(row) => ({ ...row, rogue: true }), /unknown-key/],
    [(row) => ({ contractVersion: row.contractVersion }), /rowId/],
    [(row) => ({ ...row, contractVersion: 0 }), /contractVersion/],
    [(row) => ({ ...row, contractVersion: 1.5 }), /contractVersion/],
    [(row) => ({ ...row, rowId: 'Not A Row Id' }), /rowId/],
  ]) {
    const raw = clone(COMMON_V1_RAW);
    raw.supportRow = mutate({
      contractVersion: 1,
      rowId: 'macos-26-arm64-node24-npm11-v1',
    });
    assert.throws(() => parseAcceptanceProfile(raw), pattern);
  }
});

test('the committed macOS profile is a legitimate additive extension of common-v1', () => {
  // Drift guard: the committed base.digest must equal the live common-v1 digest,
  // so the derived profile can never point at a stale base.
  assert.equal(MACOS_V1_RAW.base.digest, profileDigest(BASE_PROFILE));

  const composed = composeProfile(BASE_PROFILE, MACOS_V1_RAW);
  assert.deepEqual(composed.requiredCapabilities, [
    'process-tree-cleanup',
    'pty',
    'symlink',
    'permissions',
    'process-tree-rss',
  ]);
  // The composed profile preserves the committed executable order and contains
  // EVERY common-v1 journey exactly once, in relative base order, with no downgrade.
  const composedIds = composed.journeys.map((journey) => journey.id);
  assert.deepEqual(
    composedIds,
    MACOS_V1_RAW.journeys.map((journey) => journey.id),
    'composition must preserve the derived profile executable order',
  );
  const composedIdSet = new Set(composedIds);
  assert.equal(composedIdSet.size, composedIds.length, 'composed journeys must be unique');
  for (const base of BASE_PROFILE.journeys) {
    const carried = composed.journeys.find((journey) => journey.id === base.id);
    assert.ok(carried, `composed profile must carry base journey ${base.id}`);
    assert.equal(
      composedIds.filter((id) => id === base.id).length,
      1,
      `${base.id} must appear exactly once`,
    );
    // A required base journey stays required (never silently downgraded).
    if (base.required) assert.equal(carried.required, true, `${base.id} must stay required`);
  }
  // Base rows remain an ordered subsequence even when macOS rows are interleaved.
  const baseIdSet = new Set(BASE_PROFILE.journeys.map((journey) => journey.id));
  assert.deepEqual(
    composedIds.filter((id) => baseIdSet.has(id)),
    BASE_PROFILE.journeys.map((journey) => journey.id),
  );
  // Every macOS-only journey is required and executes before destructive lifecycle cleanup.
  const macosOnly = composed.journeys.filter((journey) => journey.id.startsWith('macos.'));
  assert.ok(macosOnly.length > 0, 'the macOS profile must add at least one native journey');
  for (const journey of macosOnly) {
    assert.match(journey.id, /^macos\./, `${journey.id} must be a macos.* journey`);
    assert.equal(journey.required, true, `${journey.id} must be required`);
    assert.ok(
      composedIds.indexOf(journey.id) < composedIds.indexOf('lifecycle.cli-state-uninstall'),
      `${journey.id} must execute before lifecycle.cli-state-uninstall`,
    );
  }
  assert.ok(
    composedIds.indexOf('lifecycle.cli-state-uninstall') <
      composedIds.indexOf('lifecycle.package-uninstall'),
    'CLI-state cleanup must remain before final package removal',
  );
  // The support-row binding is carried onto the composed profile + stays frozen.
  assert.deepEqual(composed.supportRow, {
    contractVersion: 1,
    rowId: 'macos-26-arm64-node24-npm11-v1',
  });
  const upgrade = composed.journeys.find((journey) => journey.id === 'lifecycle.upgrade');
  const installer = composed.journeys.find((journey) => journey.id === 'macos.installer-sh');
  assert.equal(upgrade.required, false);
  assert.equal(isJourneyRequired(upgrade, null), false);
  assert.deepEqual(installer.candidateKinds, ['published-version']);
  assert.equal(isJourneyApplicable(installer, 'packed-release'), false);
  assert.equal(isJourneyApplicable(installer, 'published-version'), true);
  assert.ok(Object.isFrozen(composed));
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

test('completed evidence permits a pessimistic profile-dependent fail but never an impossible pass', () => {
  const profileDependentFailure = makeEvidenceBody(BASE_PROFILE, { verdict: 'fail' });
  assert.equal(parseAcceptanceEvidence(seal(profileDependentFailure)).verdict, 'fail');

  const impossiblePass = makeEvidenceBody(BASE_PROFILE);
  const requiredIndex = impossiblePass.results.findIndex((result) => result.required);
  impossiblePass.results[requiredIndex] = {
    ...impossiblePass.results[requiredIndex],
    status: 'fail',
    reasonCode: 'required-journey-failed',
  };
  impossiblePass.summary = computeSummary(BASE_PROFILE, impossiblePass.results);
  impossiblePass.verdict = 'pass';
  assert.throws(() => parseAcceptanceEvidence(seal(impossiblePass)), /completion-verdict-mismatch/);
});

test('parseAcceptanceEvidence rejects a completion digest that does not match the sealed body', () => {
  const sealed = seal(makeEvidenceBody(BASE_PROFILE));
  sealed.completion = { state: 'completed', evidenceDigest: 'f'.repeat(64) };
  assert.throws(() => parseAcceptanceEvidence(sealed), /evidence-digest-mismatch/);
});

test('parseAcceptanceEvidence rejects completedAt before startedAt', () => {
  const body = makeEvidenceBody(BASE_PROFILE, {
    completedAt: '2025-01-01T00:00:00.000Z',
  });
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

test('parseAcceptanceEvidence rejects unknown host capability ids', () => {
  const body = makeEvidenceBody(BASE_PROFILE);
  body.host.capabilities['typo-capability'] = true;
  assert.throws(() => parseAcceptanceEvidence(seal(body)), /unknown-capability/);
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
  zero.results[0] = {
    ...zero.results[0],
    rss: { status: 'available', peakBytes: 0 },
  };
  assert.doesNotThrow(() => parseAcceptanceEvidence(seal(zero)));
});

test('candidate registry must never embed credentials', () => {
  const body = makeEvidenceBody(BASE_PROFILE);
  body.candidate = {
    kind: 'published-version',
    version: '0.7.0',
    source: 'npm:opensip-cli@0.7.0',
    digest: 'a'.repeat(64),
    registry: 'https://user:pass@registry.example/',
    registryIntegrityDigest: 'b'.repeat(64),
  };
  assert.throws(() => parseAcceptanceEvidence(seal(body)), /invalid-registry/);
  const httpsOk = makeEvidenceBody(BASE_PROFILE);
  httpsOk.candidate = {
    kind: 'published-version',
    version: '0.7.0',
    source: 'npm:opensip-cli@0.7.0',
    digest: 'a'.repeat(64),
    registry: 'https://registry.npmjs.org/',
    registryIntegrityDigest: 'b'.repeat(64),
  };
  httpsOk.registryBindings = {
    candidateLifecycle: registryProof(),
    canonicalInstaller: null,
  };
  assert.doesNotThrow(() => parseAcceptanceEvidence(seal(httpsOk)));
});

test('published registry binding evidence is closed, bounded, and fail-closed', () => {
  const missing = makeEvidenceBody(BASE_PROFILE);
  missing.candidate = {
    kind: 'published-version',
    version: '0.7.0',
    source: 'npm:opensip-cli@0.7.0',
    digest: 'a'.repeat(64),
    registry: 'https://registry.npmjs.org/',
    registryIntegrityDigest: 'b'.repeat(64),
  };
  assert.throws(() => parseAcceptanceEvidence(seal(missing)), /registry-binding-evidence-missing/);

  const valid = structuredClone(missing);
  valid.registryBindings = {
    candidateLifecycle: registryProof(),
    canonicalInstaller: null,
  };
  assert.doesNotThrow(() => parseAcceptanceEvidence(seal(valid)));

  for (const mutate of [
    (proof) => {
      proof.packageCount = 2;
    },
    (proof) => {
      proof.packageNames = ['opensip-cli', 'opensip-cli'];
      proof.packageCount = 2;
    },
    (proof) => {
      proof.offlineReplayComplete = false;
    },
    (proof) => {
      proof.inventoryDigest = 'd'.repeat(64);
    },
  ]) {
    const body = structuredClone(valid);
    mutate(body.registryBindings.candidateLifecycle);
    assert.throws(() => parseAcceptanceEvidence(seal(body)));
  }
});

test('evidence requires standalone previous-candidate and execution provenance', () => {
  const missingPrevious = makeEvidenceBody(BASE_PROFILE);
  delete missingPrevious.previousCandidate;
  assert.throws(() => parseAcceptanceEvidence(seal(missingPrevious)), /previousCandidate/);

  const missingExecution = makeEvidenceBody(BASE_PROFILE);
  delete missingExecution.execution;
  assert.throws(() => parseAcceptanceEvidence(seal(missingExecution)), /execution/);

  const malformedManifest = makeEvidenceBody(BASE_PROFILE);
  malformedManifest.candidate = {
    ...malformedManifest.candidate,
    manifestDigest: 'bad',
  };
  assert.throws(() => parseAcceptanceEvidence(seal(malformedManifest)), /manifestDigest/);
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

test('acceptance documentation distinguishes integrity from provenance-backed authenticity', () => {
  const decision = readFileSync(
    join(REPO_ROOT, 'docs/decisions/ADR-0164-installed-artifact-platform-acceptance-evidence.md'),
    'utf8',
  );
  const maintainerGuide = readFileSync(join(REPO_ROOT, 'scripts/README.md'), 'utf8');
  for (const document of [decision, maintainerGuide]) {
    assert.match(document, /unkeyed (?:digest|integrity check)/);
    assert.match(document, /not an authenticity signature/);
    assert.match(document, /trusted workflow(?:-run|\/release)/);
    assert.doesNotMatch(document, /self-verifying|unforgeable/);
  }
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
