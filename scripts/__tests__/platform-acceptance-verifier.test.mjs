/**
 * @fileoverview Phase 6 residual coverage — the INDEPENDENT verifier, extended.
 *
 * The base tamper matrix (profile digest, required-journey flip, completion
 * marker removal, journey-order swap, expected version/platform/fs mismatch,
 * invalid-invocation exit 2, non-JSON evidence exit 1, source/registry redaction)
 * already lives in `verify-platform-acceptance.test.mjs`. This file ADDS the
 * remaining mutate-one-field-at-a-time coverage — candidate digest/version,
 * non-required status flip, host arch/node-abi tuple, timing (duration window),
 * evidence byte bound, expected-candidate-digest, and the infrastructure-fault
 * terminal state — each proving an INDEPENDENT verifier failure, plus exit-class
 * purity. It does NOT duplicate the assertions in the sibling file.
 *
 * Runs under `node --test` (`pnpm test:scripts`).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  computeSummary,
  computeVerdict,
  evidenceDigest,
  parseAcceptanceProfile,
  PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
  profileDigest,
} from '../platform-acceptance/contract.mjs';
import { writeAcceptanceEvidence } from '../platform-acceptance/evidence-writer.mjs';
import {
  createRegistryProofFixture,
  writeRegistryProofFixture,
} from './platform-acceptance-registry-proof-fixture.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const VERIFIER = join(REPO_ROOT, 'scripts', 'verify-platform-acceptance.mjs');
const PROFILE_PATH = join(REPO_ROOT, '.config', 'platform-acceptance', 'common-v1.json');
const PROFILE = parseAcceptanceProfile(JSON.parse(readFileSync(PROFILE_PATH, 'utf8')));
const MACOS_PROFILE_PATH = join(
  REPO_ROOT,
  '.config',
  'platform-acceptance',
  'macos-26-arm64-node24-npm11-v1.json',
);
const MACOS_PROFILE = parseAcceptanceProfile(JSON.parse(readFileSync(MACOS_PROFILE_PATH, 'utf8')));
const REGISTRY_FIXTURE = createRegistryProofFixture({
  manifestDigest: 'd'.repeat(64),
});
const INVENTORY_NAME = 'registry-inventory.json';

function runVerifier(args) {
  const evidenceIndex = args.indexOf('--evidence');
  const expectedKindIndex = args.indexOf('--expected-candidate-kind');
  const expectsPacked = expectedKindIndex >= 0 && args[expectedKindIndex + 1] === 'packed-release';
  const inventoryPath =
    evidenceIndex >= 0 ? join(dirname(args[evidenceIndex + 1]), INVENTORY_NAME) : null;
  const effectiveArgs =
    !expectsPacked &&
    !args.includes('--candidate-manifest') &&
    !args.includes('--registry-integrity-inventory') &&
    inventoryPath !== null &&
    existsSync(inventoryPath)
      ? [...args, '--registry-integrity-inventory', inventoryPath]
      : args;
  const proc = spawnSync(process.execPath, [VERIFIER, ...effectiveArgs], {
    encoding: 'utf8',
  });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function publishedCandidate(overrides = {}) {
  const candidate = {
    kind: 'published-version',
    version: '0.7.0',
    source: '/home/secret-user/tarballs (58 npm tarballs)',
    registry: 'https://registry.npmjs.org/',
    registryIntegrityDigest: REGISTRY_FIXTURE.inventoryDigest,
    ...overrides,
  };
  return {
    ...candidate,
    digest: createHash('sha256')
      .update('published\nopensip-cli@')
      .update(candidate.version)
      .update('\n')
      .update(candidate.registry)
      .update('\n')
      .update(candidate.registryIntegrityDigest ?? 'unbound-registry-integrity')
      .update('\n')
      .update(candidate.manifestDigest ?? 'unbound-manifest')
      .digest('hex'),
  };
}

function expectedTerminalReason(intentionalCancellation, intentionalTimeout) {
  if (intentionalCancellation) return 'cancelled';
  if (intentionalTimeout) return 'timed-out';
  return null;
}

function expectedTerminalExit(intentionalCancellation, intentionalTimeout, intentionalNonZero) {
  if (intentionalCancellation || intentionalTimeout) return null;
  return intentionalNonZero ? 1 : 0;
}

function makeValidBody() {
  const results = PROFILE.journeys.map((journey) => {
    const rss = { status: 'unavailable', reasonCode: 'rss-not-sampled' };
    if (journey.id === 'lifecycle.upgrade') {
      return {
        id: journey.id,
        category: 'lifecycle',
        required: false,
        status: 'skipped',
        reasonCode: 'previous-candidate-not-supplied',
        durationMs: 0,
        rss,
        diagnostics: ['no exact previous candidate was supplied'],
        steps: [],
      };
    }
    const intentionalCancellation = journey.id === 'resilience.signals';
    const intentionalTimeout = journey.id === 'resilience.timeout-cleanup';
    const intentionalNonZero = journey.id === 'persistence.contention-retry';
    return {
      id: journey.id,
      category: journey.id.split('.')[0],
      required: journey.required,
      status: 'pass',
      reasonCode: null,
      durationMs: 5,
      rss,
      diagnostics: [],
      steps: [
        {
          label: 'process-1',
          stage: 'process',
          exitCode: expectedTerminalExit(
            intentionalCancellation,
            intentionalTimeout,
            intentionalNonZero,
          ),
          signal: intentionalCancellation || intentionalTimeout ? 'SIGTERM' : null,
          timedOut: intentionalTimeout,
          cancelled: intentionalCancellation,
          outputTruncated: false,
          durationMs: 5,
          rss,
          residualDescendants: 0,
          reasonCode: intentionalNonZero
            ? 'command-failed'
            : expectedTerminalReason(intentionalCancellation, intentionalTimeout),
          diagnostics: [],
        },
      ],
    };
  });
  const cleanup = {
    status: 'clean',
    reasonCode: null,
    removedRoots: 3,
    residualDescendants: 0,
  };
  return {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: {
      id: PROFILE.id,
      version: PROFILE.version,
      digest: profileDigest(PROFILE),
    },
    candidate: publishedCandidate(),
    previousCandidate: null,
    execution: {
      runId: 'local-test',
      runAttempt: 1,
      runnerLabel: 'test-runner',
    },
    lifecycle: {
      installedVersion: '0.7.0',
      upgradedVersion: null,
      versionMigrated: null,
      stateMigrated: null,
      cliStateRemoved: true,
      packageRemoved: true,
      targetInstallChannel: 'npm-direct',
    },
    registryBindings: {
      candidateLifecycle: REGISTRY_FIXTURE.makeProof(),
      canonicalInstaller: null,
    },
    harnessGitSha: 'abc1234',
    startedAt: '2026-07-15T00:00:00.000Z',
    completedAt: '2026-07-15T00:05:00.000Z',
    host: {
      platform: 'linux',
      arch: 'x64',
      osRelease: 'test-release',
      osVersion: 'test-version',
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
        'process-tree-cleanup': true,
      },
    },
    results,
    cleanup,
    summary: computeSummary(PROFILE, results),
    verdict: computeVerdict(PROFILE, results, cleanup),
  };
}

function writeValid(dir) {
  const outPath = join(dir, 'evidence.json');
  writeAcceptanceEvidence({
    evidence: makeValidBody(),
    completionState: 'completed',
    outPath,
    maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
  });
  return outPath;
}

/** Mutate the unsealed body, then RE-SEAL over its (internally consistent) digest. */
function reseal(dir, name, mutate) {
  const body = makeValidBody();
  mutate(body);
  const out = {
    ...body,
    completion: { state: 'completed', evidenceDigest: evidenceDigest(body) },
  };
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  return path;
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-verifier-'));
  try {
    writeRegistryProofFixture(dir, REGISTRY_FIXTURE, INVENTORY_NAME);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function failuresOf(stdout) {
  return JSON.parse(stdout).failures.map((f) => f.code);
}

test('sanity: the shared valid artifact verifies (exit 0)', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    assert.equal(runVerifier(['--evidence', evidence, '--profile', PROFILE_PATH]).code, 0);
  });
});

test('a passing ordinary journey cannot hide a signal behind an expected non-zero exit', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'signal-as-exit-one.json', (body) => {
      const row = body.results.find((entry) => entry.id === 'analysis.fit');
      row.steps[0] = {
        ...row.steps[0],
        exitCode: null,
        signal: 'SIGSEGV',
        reasonCode: 'command-failed',
      };
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('unexpected-abnormal-terminal'));
  });
});

test('a passing ordinary journey cannot hide a non-zero exit', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'ordinary-exit-one.json', (body) => {
      const row = body.results.find((entry) => entry.id === 'analysis.graph');
      row.steps[0] = {
        ...row.steps[0],
        exitCode: 1,
        signal: null,
        reasonCode: 'command-failed',
      };
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('unexpected-abnormal-terminal'));
  });
});

test('contention retry requires exactly one intentional positive exit', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'contention-extra-exit.json', (body) => {
      const row = body.results.find((entry) => entry.id === 'persistence.contention-retry');
      row.steps.push({ ...row.steps[0], label: 'process-2', exitCode: 2 });
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('expected-abnormal-terminal-duplicate'));
  });
});

test('an optional passing journey still requires terminal step evidence', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'optional-pass-without-steps.json', (body) => {
      const row = body.results.find((entry) => entry.id === 'resilience.symlink-root');
      row.steps = [];
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('passing-step-evidence-missing'));
  });
});

test('field mutation: a malformed candidate version fails contract validation', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'candidate-version.json', (body) => {
      body.candidate = { ...body.candidate, version: 'not-a-semver' };
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stdout).failures, [
      { code: 'evidence-schema-invalid', detail: 'malformed-string' },
    ]);
  });
});

test('field mutation: a malformed candidate digest fails contract validation', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'candidate-digest.json', (body) => {
      body.candidate = { ...body.candidate, digest: 'z'.repeat(64) };
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stdout).failures, [
      { code: 'evidence-schema-invalid', detail: 'malformed-string' },
    ]);
  });
});

test('field mutation: --expected-candidate-digest mismatch fails independently', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const { code, stdout } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-candidate-digest',
      'b'.repeat(64),
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('candidate-digest-mismatch'), stdout);
  });
});

test('packed candidate identity is recomputed from the exact bound release manifest', () => {
  withTempDir((dir) => {
    const manifest = {
      schemaVersion: 1,
      releaseVersion: '0.7.0',
      gitTag: 'v0.7.0',
      gitSha: 'a'.repeat(40),
      generatedAt: '2026-07-15T00:00:00.000Z',
      generator: 'opensip-cli-release-artifacts@1',
      artifacts: [
        {
          name: 'opensip-cli',
          kind: 'npm-tarball',
          path: 'opensip-cli-0.7.0.tgz',
          sha256: 'c'.repeat(64),
          sizeBytes: 123,
          packageName: 'opensip-cli',
          packageVersion: '0.7.0',
        },
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = join(dir, 'opensip-cli-release-manifest.v1.json');
    writeFileSync(manifestPath, manifestText);
    const manifestDigest = createHash('sha256').update(manifestText).digest('hex');
    const checksumBody = `${'c'.repeat(64)}  opensip-cli-0.7.0.tgz\n`;
    const digest = createHash('sha256')
      .update('packed\n0.7.0\n')
      .update(checksumBody)
      .digest('hex');
    const body = makeValidBody();
    body.candidate = {
      kind: 'packed-release',
      version: '0.7.0',
      source: 'packed-release@0.7.0 (1 npm tarball)',
      digest,
      manifestDigest,
    };
    body.registryBindings = {
      candidateLifecycle: null,
      canonicalInstaller: null,
    };
    body.lifecycle.targetInstallChannel = 'packed-consumer';
    const evidence = join(dir, 'packed-evidence.json');
    writeAcceptanceEvidence({
      evidence: body,
      completionState: 'completed',
      outPath: evidence,
      maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
    });

    const verified = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--candidate-manifest',
      manifestPath,
      '--json',
    ]);
    assert.equal(verified.code, 0, verified.stdout);

    body.lifecycle.targetInstallChannel = 'npm-direct';
    const wrongChannel = join(dir, 'packed-wrong-channel.json');
    writeAcceptanceEvidence({
      evidence: body,
      completionState: 'completed',
      outPath: wrongChannel,
      maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
    });
    const rejectedChannel = runVerifier([
      '--evidence',
      wrongChannel,
      '--profile',
      PROFILE_PATH,
      '--candidate-manifest',
      manifestPath,
      '--json',
    ]);
    assert.equal(rejectedChannel.code, 1, rejectedChannel.stdout);
    assert.ok(
      failuresOf(rejectedChannel.stdout).includes(
        'lifecycle-install-channel-candidate-kind-mismatch',
      ),
      rejectedChannel.stdout,
    );
    body.lifecycle.targetInstallChannel = 'packed-consumer';

    body.candidate = { ...body.candidate, digest: 'f'.repeat(64) };
    const tampered = join(dir, 'packed-tampered.json');
    writeAcceptanceEvidence({
      evidence: body,
      completionState: 'completed',
      outPath: tampered,
      maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
    });
    const rejected = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--candidate-manifest',
      manifestPath,
      '--json',
    ]);
    assert.equal(rejected.code, 1, rejected.stdout);
    assert.ok(failuresOf(rejected.stdout).includes('candidate-digest-mismatch'), rejected.stdout);
  });
});

test('previous-candidate evidence dynamically requires and independently verifies upgrade', () => {
  withTempDir((dir) => {
    const body = makeValidBody();
    body.previousCandidate = publishedCandidate({
      version: '0.6.9',
      source: 'npm:opensip-cli@0.6.9',
      registryIntegrityDigest: undefined,
    });
    body.lifecycle = {
      ...body.lifecycle,
      installedVersion: '0.6.9',
      upgradedVersion: '0.7.0',
      versionMigrated: true,
      stateMigrated: true,
    };
    const upgradeIndex = PROFILE.journeys.findIndex(
      (journey) => journey.id === 'lifecycle.upgrade',
    );
    body.results[upgradeIndex] = {
      ...body.results[upgradeIndex],
      required: true,
      status: 'pass',
      reasonCode: null,
      durationMs: 5,
      diagnostics: [],
      steps: structuredClone(body.results[0].steps),
    };
    body.summary = computeSummary(PROFILE, body.results);
    body.verdict = computeVerdict(PROFILE, body.results, body.cleanup);
    const path = join(dir, 'previous.json');
    writeAcceptanceEvidence({
      evidence: body,
      completionState: 'completed',
      outPath: path,
      maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
    });

    const verified = runVerifier([
      '--evidence',
      path,
      '--profile',
      PROFILE_PATH,
      '--expected-previous-version',
      '0.6.9',
      '--json',
    ]);
    assert.equal(verified.code, 0, verified.stdout);

    body.previousCandidate = {
      ...body.previousCandidate,
      digest: 'f'.repeat(64),
    };
    const forgedPath = join(dir, 'previous-forged-digest.json');
    writeAcceptanceEvidence({
      evidence: body,
      completionState: 'completed',
      outPath: forgedPath,
      maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
    });
    const forged = runVerifier([
      '--evidence',
      forgedPath,
      '--profile',
      PROFILE_PATH,
      '--expected-previous-version',
      '0.6.9',
      '--json',
    ]);
    assert.equal(forged.code, 1, forged.stdout);
    assert.ok(
      failuresOf(forged.stdout).includes('previous-candidate-digest-mismatch'),
      forged.stdout,
    );

    const rejected = runVerifier([
      '--evidence',
      path,
      '--profile',
      PROFILE_PATH,
      '--expect-no-previous-candidate',
      '--json',
    ]);
    assert.equal(rejected.code, 1);
    assert.ok(failuresOf(rejected.stdout).includes('unexpected-previous-candidate'));
  });
});

test('field mutation: the no-previous upgrade semantic skip cannot be changed into an optional failure', () => {
  withTempDir((dir) => {
    const optionalIndex = PROFILE.journeys.findIndex((j) => j.id === 'lifecycle.upgrade');
    assert.ok(optionalIndex >= 0);
    const tampered = reseal(dir, 'optional-fail.json', (body) => {
      body.results[optionalIndex] = {
        ...body.results[optionalIndex],
        status: 'fail',
        reasonCode: 'forced',
      };
      body.lifecycle = {
        ...body.lifecycle,
        upgradedVersion: null,
        versionMigrated: null,
        stateMigrated: null,
      };
      body.summary = computeSummary(PROFILE, body.results);
      body.verdict = computeVerdict(PROFILE, body.results, body.cleanup);
    });
    const tamperedResult = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(tamperedResult.code, 1, tamperedResult.stdout);
    assert.ok(
      failuresOf(tamperedResult.stdout).includes('previous-candidate-skip-mismatch'),
      tamperedResult.stdout,
    );

    const forged = reseal(dir, 'forged-summary.json', (body) => {
      body.results[optionalIndex] = {
        ...body.results[optionalIndex],
        status: 'fail',
        reasonCode: 'forced',
      };
      // Leave the summary claiming everything passed — the verifier recomputes it.
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      forged,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(stdout).failures, [
      { code: 'evidence-schema-invalid', detail: 'summary-mismatch' },
    ]);
  });
});

test('candidate-kind applicability is recomputed and its no-effect skip rejects tampering', () => {
  withTempDir((dir) => {
    const raw = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
    raw.id = 'candidate-applicability-v1';
    const selected = raw.journeys.find((journey) => journey.id === 'analysis.sim');
    selected.candidateKinds = ['packed-release'];
    const profile = parseAcceptanceProfile(raw);
    const profilePath = join(dir, 'candidate-applicability-profile.json');
    writeFileSync(profilePath, `${JSON.stringify(raw, null, 2)}\n`);

    const body = makeValidBody();
    body.profile = {
      id: profile.id,
      version: profile.version,
      digest: profileDigest(profile),
    };
    const index = profile.journeys.findIndex((journey) => journey.id === 'analysis.sim');
    body.results[index] = {
      ...body.results[index],
      required: false,
      status: 'skipped',
      reasonCode: 'candidate-kind-not-applicable',
      durationMs: 0,
      rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
      diagnostics: ['journey does not apply to the published-version candidate kind'],
      steps: [],
    };
    body.summary = computeSummary(profile, body.results);
    body.verdict = computeVerdict(profile, body.results, body.cleanup);
    const evidencePath = join(dir, 'candidate-applicability.json');
    writeAcceptanceEvidence({
      evidence: body,
      completionState: 'completed',
      outPath: evidencePath,
      maxEvidenceBytes: profile.bounds.maxEvidenceBytes,
    });
    const verified = runVerifier(['--evidence', evidencePath, '--profile', profilePath, '--json']);
    assert.equal(verified.code, 0, verified.stdout);

    body.results[index] = {
      ...body.results[index],
      status: 'pass',
      reasonCode: null,
      durationMs: 5,
      diagnostics: [],
      steps: structuredClone(body.results[0].steps),
    };
    body.summary = computeSummary(profile, body.results);
    body.verdict = computeVerdict(profile, body.results, body.cleanup);
    const tamperedPath = join(dir, 'candidate-applicability-tampered.json');
    writeAcceptanceEvidence({
      evidence: body,
      completionState: 'completed',
      outPath: tamperedPath,
      maxEvidenceBytes: profile.bounds.maxEvidenceBytes,
    });
    const tampered = runVerifier(['--evidence', tamperedPath, '--profile', profilePath, '--json']);
    assert.equal(tampered.code, 1, tampered.stdout);
    assert.ok(failuresOf(tampered.stdout).includes('candidate-kind-skip-mismatch'));
    assert.ok(failuresOf(tampered.stdout).includes('semantic-skip-effects-present'));
  });
});

test('field mutation: host arch and node-ABI tuple mismatches each fail independently', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const arch = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expect-arch',
      'arm64',
      '--json',
    ]);
    assert.equal(arch.code, 1);
    assert.ok(failuresOf(arch.stdout).includes('host-arch-mismatch'), arch.stdout);

    const abi = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expect-node-abi',
      '999',
      '--json',
    ]);
    assert.equal(abi.code, 1);
    assert.ok(failuresOf(abi.stdout).includes('host-node-abi-mismatch'), abi.stdout);
  });
});

test('field mutation: a journey duration exceeding the wall-clock window fails independently', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'duration.json', (body) => {
      // The window is completedAt - startedAt (+ slack). 5 minutes here; blow past it.
      body.results[0] = { ...body.results[0], durationMs: 24 * 60 * 60 * 1000 };
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('duration-exceeds-window'), stdout);
  });
});

test('field mutation: a skipped no-previous upgrade cannot claim lifecycle effects', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'lifecycle.json', (body) => {
      body.lifecycle = {
        ...body.lifecycle,
        upgradedVersion: '9.9.9',
        stateMigrated: false,
      };
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    const failures = failuresOf(stdout);
    assert.ok(failures.includes('unexpected-upgrade-effects-without-previous'), stdout);
  });
});

test('field mutation: evidence exceeding profile maxJourneyResults fails independently', () => {
  withTempDir((dir) => {
    const tampered = reseal(dir, 'too-many-results.json', (body) => {
      const extraCount = PROFILE.bounds.maxJourneyResults - body.results.length + 1;
      for (let index = 0; index < extraCount; index += 1) {
        body.results.push({
          id: `overflow.extra-${index}`,
          category: 'overflow',
          required: false,
          status: 'pass',
          reasonCode: null,
          durationMs: 1,
          rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
          diagnostics: [],
        });
      }
      body.summary = computeSummary(PROFILE, body.results);
      body.verdict = computeVerdict(PROFILE, body.results, body.cleanup);
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('max-journey-results-exceeded'), stdout);
  });
});

test('serialized evidence larger than the profile byte bound fails independently', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const serialized = readFileSync(evidence);
    const paddingBytes = PROFILE.bounds.maxEvidenceBytes - serialized.byteLength + 1;
    assert.ok(paddingBytes > 0, 'the valid fixture must begin below the profile bound');
    writeFileSync(evidence, Buffer.concat([serialized, Buffer.alloc(paddingBytes, 0x20)]));

    const { code, stdout } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('evidence-bound-exceeded'), stdout);
  });
});

test('field mutation: an infrastructure-fault completion state is always a verification failure', () => {
  withTempDir((dir) => {
    // Seal with the infrastructure-fault terminal state + matching verdict.
    const body = makeValidBody();
    body.verdict = 'infrastructure-fault';
    const digest = evidenceDigest(body);
    const path = join(dir, 'infra-fault.json');
    writeFileSync(
      path,
      `${JSON.stringify({ ...body, completion: { state: 'infrastructure-fault', evidenceDigest: digest } }, null, 2)}\n`,
    );
    const { code, stdout } = runVerifier(['--evidence', path, '--profile', PROFILE_PATH, '--json']);
    assert.equal(code, 1);
    const codes = failuresOf(stdout);
    assert.ok(codes.includes('infrastructure-fault'), stdout);
    assert.ok(codes.includes('verdict-not-pass'), stdout);
  });
});

test('exit-class purity: --json prints exactly one JSON object to stdout and nothing to stderr on a clean verify', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const { code, stdout, stderr } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const lines = stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one JSON line on stdout');
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.verified, true);
    // Redaction holds under --json: no source path, no registry credentials.
    assert.ok(!stdout.includes('secret-user'));
  });
});

// ---------------------------------------------------------------------------
// Support-row binding tamper (Plan 02, spec §4/§9). The macOS profile pins the
// platform-support row + contract version; the verifier must reject evidence
// whose profile binding does not match the expected public support claim.
// ---------------------------------------------------------------------------

/** A valid sealed body for the macOS profile (rssRequired → first result available). */
function makeMacosValidBody() {
  const results = MACOS_PROFILE.journeys.map((journey, index) => {
    if (journey.id === 'lifecycle.upgrade') {
      return {
        id: journey.id,
        category: 'lifecycle',
        required: false,
        status: 'skipped',
        reasonCode: 'previous-candidate-not-supplied',
        durationMs: 0,
        rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
        diagnostics: ['no exact previous candidate was supplied'],
        steps: [],
      };
    }
    // The macOS profile requires a real RSS measurement for every required row.
    const rss = journey.required
      ? { status: 'available', peakBytes: 4096 + index }
      : { status: 'unavailable', reasonCode: 'rss-not-sampled' };
    const intentionalCancellation = journey.id === 'resilience.signals';
    const intentionalTimeout = journey.id === 'resilience.timeout-cleanup';
    const intentionalNonZero = journey.id === 'persistence.contention-retry';
    if (journey.id === 'macos.signals') {
      return {
        id: journey.id,
        category: 'macos',
        required: journey.required,
        status: 'pass',
        reasonCode: null,
        durationMs: 5,
        rss,
        diagnostics: [],
        steps: ['SIGINT', 'SIGTERM'].map((deliveredSignal, signalIndex) => ({
          label: `process-${signalIndex + 1}`,
          stage: 'process',
          exitCode: null,
          signal: deliveredSignal,
          deliveredSignal,
          timedOut: false,
          cancelled: false,
          outputTruncated: false,
          durationMs: 5,
          rss,
          residualDescendants: 0,
          reasonCode: 'command-failed',
          diagnostics: [],
        })),
      };
    }
    return {
      id: journey.id,
      category: journey.id.split('.')[0],
      required: journey.required,
      status: 'pass',
      reasonCode: null,
      durationMs: 5,
      rss,
      diagnostics: [],
      steps: [
        {
          label: 'process-1',
          stage: 'process',
          exitCode: expectedTerminalExit(
            intentionalCancellation,
            intentionalTimeout,
            intentionalNonZero,
          ),
          signal: intentionalCancellation || intentionalTimeout ? 'SIGTERM' : null,
          timedOut: intentionalTimeout,
          cancelled: intentionalCancellation,
          outputTruncated: false,
          durationMs: 5,
          rss,
          residualDescendants: 0,
          reasonCode: intentionalNonZero
            ? 'command-failed'
            : expectedTerminalReason(intentionalCancellation, intentionalTimeout),
          diagnostics: [],
        },
      ],
    };
  });
  const cleanup = {
    status: 'clean',
    reasonCode: null,
    removedRoots: 3,
    residualDescendants: 0,
  };
  const body = {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: {
      id: MACOS_PROFILE.id,
      version: MACOS_PROFILE.version,
      digest: profileDigest(MACOS_PROFILE),
    },
    candidate: publishedCandidate({
      source: 'opensip-cli@0.7.0',
      manifestDigest: 'd'.repeat(64),
      registryIntegrityDigest: REGISTRY_FIXTURE.inventoryDigest,
    }),
    previousCandidate: null,
    execution: { runId: '12345', runAttempt: 1, runnerLabel: 'macos-26' },
    lifecycle: {
      installedVersion: '0.7.0',
      upgradedVersion: null,
      versionMigrated: null,
      stateMigrated: null,
      cliStateRemoved: true,
      packageRemoved: true,
      targetInstallChannel: 'canonical-installer',
    },
    registryBindings: {
      candidateLifecycle: REGISTRY_FIXTURE.makeProof(),
      canonicalInstaller: REGISTRY_FIXTURE.makeProof(),
    },
    harnessGitSha: 'abc1234',
    startedAt: '2026-07-15T00:00:00.000Z',
    completedAt: '2026-07-15T00:05:00.000Z',
    host: {
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '25.5.0',
      osVersion: '26.0.1',
      nodeVersion: 'v24.16.0',
      nodeModuleAbi: '137',
      npmVersion: '11.0.0',
      packageManager: 'npm',
      cpuModel: 'Apple M-series',
      cpuCount: 8,
      totalMemoryBytes: 1024,
      filesystem: { type: 'apfs', caseSensitive: false },
      shell: 'zsh',
      swVers: '26.0.1',
      kernelRelease: '25.5.0',
      unameArch: 'arm64',
      capabilities: {
        pty: true,
        symlink: true,
        permissions: true,
        'process-tree-rss': true,
        'process-tree-cleanup': true,
      },
    },
    results,
    cleanup,
    summary: computeSummary(MACOS_PROFILE, results),
    verdict: computeVerdict(MACOS_PROFILE, results, cleanup),
  };
  return {
    ...body,
    completion: { state: 'completed', evidenceDigest: evidenceDigest(body) },
  };
}

function writeMacosEvidence(dir) {
  const path = join(dir, 'macos-evidence.json');
  writeFileSync(path, `${JSON.stringify(makeMacosValidBody(), null, 2)}\n`);
  return path;
}

test('support-row binding: the macOS profile verifies with the exact expected row + contract version', () => {
  withTempDir((dir) => {
    const evidence = writeMacosEvidence(dir);
    const { code, stdout } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      MACOS_PROFILE_PATH,
      '--expected-support-row',
      'macos-26-arm64-node24-npm11-v1',
      '--expected-support-contract-version',
      '1',
      '--expected-manifest-digest',
      'd'.repeat(64),
      '--expect-no-previous-candidate',
      '--expected-git-sha',
      'abc1234',
      '--expected-run-id',
      '12345',
      '--expected-run-attempt',
      '1',
      '--expected-runner-label',
      'macos-26',
      '--expected-sw-vers-major',
      '26',
      '--expected-kernel-major',
      '25',
      '--expect-uname-arch',
      'arm64',
      '--expect-case-sensitive',
      'false',
      '--expect-shell',
      'zsh',
      '--json',
    ]);
    assert.equal(code, 0, stdout);
    assert.equal(JSON.parse(stdout).verified, true);
  });
});

test('macOS signal evidence must prove one exact SIGINT and one exact SIGTERM delivery', () => {
  withTempDir((dir) => {
    const body = structuredClone(makeMacosValidBody());
    delete body.completion;
    const row = body.results.find((entry) => entry.id === 'macos.signals');
    row.steps[1] = {
      ...row.steps[1],
      signal: 'SIGINT',
      deliveredSignal: 'SIGINT',
    };
    const evidence = join(dir, 'macos-duplicate-signal.json');
    writeFileSync(
      evidence,
      `${JSON.stringify({
        ...body,
        completion: {
          state: 'completed',
          evidenceDigest: evidenceDigest(body),
        },
      })}\n`,
    );
    const { code, stdout } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      MACOS_PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1, stdout);
    assert.ok(failuresOf(stdout).includes('native-signal-observations-mismatch'), stdout);
  });
});

test('a passing canonical installer journey requires its separate registry binding proof', () => {
  withTempDir((dir) => {
    const body = structuredClone(makeMacosValidBody());
    delete body.completion;
    body.registryBindings.canonicalInstaller = null;
    const evidence = join(dir, 'macos-installer-proof-missing.json');
    writeFileSync(
      evidence,
      `${JSON.stringify({
        ...body,
        completion: {
          state: 'completed',
          evidenceDigest: evidenceDigest(body),
        },
      })}\n`,
    );
    const checked = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      MACOS_PROFILE_PATH,
      '--json',
    ]);
    assert.equal(checked.code, 1, checked.stdout);
    assert.ok(
      failuresOf(checked.stdout).includes('registry-canonical-installer-binding-missing'),
      checked.stdout,
    );
  });
});

test('macOS published evidence requires the canonical lifecycle channel', () => {
  withTempDir((dir) => {
    const body = structuredClone(makeMacosValidBody());
    delete body.completion;
    body.lifecycle.targetInstallChannel = 'npm-direct';
    const evidence = join(dir, 'macos-wrong-install-channel.json');
    writeFileSync(
      evidence,
      `${JSON.stringify({
        ...body,
        completion: {
          state: 'completed',
          evidenceDigest: evidenceDigest(body),
        },
      })}\n`,
    );

    const checked = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      MACOS_PROFILE_PATH,
      '--json',
    ]);

    assert.equal(checked.code, 1, checked.stdout);
    assert.ok(
      failuresOf(checked.stdout).includes('canonical-installer-channel-unproven'),
      checked.stdout,
    );
  });
});

test('macOS lifecycle and canonical proofs must describe the same installed target', () => {
  withTempDir((dir) => {
    const body = structuredClone(makeMacosValidBody());
    delete body.completion;
    body.registryBindings.canonicalInstaller = REGISTRY_FIXTURE.makeProof([
      '@opensip-cli/core',
      'opensip-cli',
    ]);
    const evidence = join(dir, 'macos-mismatched-install-proofs.json');
    writeFileSync(
      evidence,
      `${JSON.stringify({
        ...body,
        completion: {
          state: 'completed',
          evidenceDigest: evidenceDigest(body),
        },
      })}\n`,
    );

    const checked = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      MACOS_PROFILE_PATH,
      '--json',
    ]);

    assert.equal(checked.code, 1, checked.stdout);
    assert.ok(
      failuresOf(checked.stdout).includes('registry-install-bindings-target-mismatch'),
      checked.stdout,
    );
  });
});

test('published evidence rejects a packed-consumer lifecycle channel', () => {
  withTempDir((dir) => {
    const evidence = reseal(dir, 'published-packed-channel.json', (body) => {
      body.lifecycle.targetInstallChannel = 'packed-consumer';
    });
    const checked = runVerifier(['--evidence', evidence, '--profile', PROFILE_PATH, '--json']);
    assert.equal(checked.code, 1, checked.stdout);
    assert.ok(
      failuresOf(checked.stdout).includes('lifecycle-install-channel-candidate-kind-mismatch'),
      checked.stdout,
    );
  });
});

test('a profile-level native capability must be true in independently verified host evidence', () => {
  withTempDir((dir) => {
    const body = structuredClone(makeMacosValidBody());
    delete body.completion;
    body.host.capabilities['process-tree-rss'] = false;
    const sealed = {
      ...body,
      completion: { state: 'completed', evidenceDigest: evidenceDigest(body) },
    };
    const evidence = join(dir, 'macos-missing-capability.json');
    writeFileSync(evidence, `${JSON.stringify(sealed, null, 2)}\n`);

    const { code, stdout } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      MACOS_PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('required-host-capability-unavailable'), stdout);
  });
});

test('Windows cannot claim process-tree cleanup before Job Object containment exists', () => {
  withTempDir((dir) => {
    const evidence = reseal(dir, 'windows-cleanup-claim.json', (body) => {
      body.host.platform = 'win32';
      body.host.capabilities['process-tree-cleanup'] = true;
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1, stdout);
    assert.ok(failuresOf(stdout).includes('impossible-host-capability-claim'), stdout);
  });
});

test('macOS provenance and raw-host constraints each fail independently on mismatch', () => {
  withTempDir((dir) => {
    const evidence = writeMacosEvidence(dir);
    const cases = [
      ['--expected-manifest-digest', 'e'.repeat(64), 'candidate-manifest-digest-mismatch'],
      ['--expected-git-sha', 'def5678', 'harness-git-sha-mismatch'],
      ['--expected-run-id', '99999', 'execution-run-id-mismatch'],
      ['--expected-run-attempt', '2', 'execution-run-attempt-mismatch'],
      ['--expected-runner-label', 'macos-15', 'execution-runner-label-mismatch'],
      ['--expected-sw-vers-major', '15', 'host-sw-vers-major-mismatch'],
      ['--expected-kernel-major', '24', 'host-kernel-major-mismatch'],
      ['--expect-uname-arch', 'x86_64', 'host-uname-arch-mismatch'],
      ['--expect-case-sensitive', 'true', 'host-case-sensitivity-mismatch'],
      ['--expect-shell', 'bash', 'host-shell-mismatch'],
    ];
    for (const [flag, value, code] of cases) {
      const checked = runVerifier([
        '--evidence',
        evidence,
        '--profile',
        MACOS_PROFILE_PATH,
        flag,
        value,
        '--json',
      ]);
      assert.equal(checked.code, 1, `${flag}: ${checked.stdout}`);
      assert.ok(failuresOf(checked.stdout).includes(code), `${flag}: ${checked.stdout}`);
    }
  });
});

test('support-row binding: a wrong expected row is an independent verifier failure', () => {
  withTempDir((dir) => {
    const evidence = writeMacosEvidence(dir);
    const wrongRow = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      MACOS_PROFILE_PATH,
      '--expected-support-row',
      'macos-26-intel-unsupported',
      '--json',
    ]);
    assert.equal(wrongRow.code, 1);
    assert.ok(
      failuresOf(wrongRow.stdout).includes('support-row-binding-mismatch'),
      wrongRow.stdout,
    );

    const wrongVersion = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      MACOS_PROFILE_PATH,
      '--expected-support-row',
      'macos-26-arm64-node24-npm11-v1',
      '--expected-support-contract-version',
      '2',
      '--json',
    ]);
    assert.equal(wrongVersion.code, 1);
    assert.ok(
      failuresOf(wrongVersion.stdout).includes('support-row-binding-mismatch'),
      wrongVersion.stdout,
    );
  });
});

test('support-row binding: a profile with NO binding fails when a support row is expected', () => {
  withTempDir((dir) => {
    // common-v1 carries no supportRow; expecting one must fail closed (an
    // unbound profile can never satisfy a public support claim).
    const evidence = writeValid(dir);
    const { code, stdout } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-support-row',
      'macos-26-arm64-node24-npm11-v1',
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(failuresOf(stdout).includes('support-row-binding-mismatch'), stdout);
  });
});

test('exit-class purity: bad invocation → 2, content failure → 1, clean → 0', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    // 2: unknown flag.
    assert.equal(
      runVerifier(['--evidence', evidence, '--profile', PROFILE_PATH, '--bogus', 'x']).code,
      2,
    );
    // 1: expected-version mismatch is a content failure, not an invocation error.
    assert.equal(
      runVerifier([
        '--evidence',
        evidence,
        '--profile',
        PROFILE_PATH,
        '--expected-version',
        '9.9.9',
      ]).code,
      1,
    );
    // 0: clean.
    assert.equal(runVerifier(['--evidence', evidence, '--profile', PROFILE_PATH]).code, 0);
  });
});
