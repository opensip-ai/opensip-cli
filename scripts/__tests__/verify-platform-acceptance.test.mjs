import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
const REGISTRY_FIXTURE = createRegistryProofFixture({
  registry: 'https://registry.internal.example/',
});
const INVENTORY_NAME = 'registry-inventory.json';

function runVerifierRaw(args) {
  const proc = spawnSync(process.execPath, [VERIFIER, ...args], {
    encoding: 'utf8',
  });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function runVerifier(args) {
  const evidenceIndex = args.indexOf('--evidence');
  const expectedKindIndex = args.indexOf('--expected-candidate-kind');
  const expectsPacked = expectedKindIndex >= 0 && args[expectedKindIndex + 1] === 'packed-release';
  const inventoryPath =
    evidenceIndex >= 0 ? join(dirname(args[evidenceIndex + 1]), INVENTORY_NAME) : null;
  const effectiveArgs =
    !expectsPacked &&
    !args.includes('--registry-integrity-inventory') &&
    inventoryPath !== null &&
    existsSync(inventoryPath)
      ? [...args, '--registry-integrity-inventory', inventoryPath]
      : args;
  return runVerifierRaw(effectiveArgs);
}

function publishedCandidate(overrides = {}) {
  const candidate = {
    kind: 'published-version',
    version: '0.7.0',
    source: '/home/secret-user/tarballs (14 npm tarballs)',
    registry: 'https://registry.internal.example/',
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
          exitCode: intentionalCancellation || intentionalTimeout ? null : 0,
          signal: intentionalCancellation || intentionalTimeout ? 'SIGTERM' : null,
          timedOut: intentionalTimeout,
          cancelled: intentionalCancellation,
          outputTruncated: false,
          durationMs: 5,
          rss,
          residualDescendants: 0,
          reasonCode: expectedTerminalReason(intentionalCancellation, intentionalTimeout),
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

/** Write a valid sealed artifact via the real writer, returning its path. */
function writeValid(dir) {
  const body = makeValidBody();
  const outPath = join(dir, 'evidence.json');
  writeRegistryProofFixture(dir, REGISTRY_FIXTURE, INVENTORY_NAME);
  writeAcceptanceEvidence({
    evidence: body,
    completionState: 'completed',
    outPath,
    maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
  });
  return outPath;
}

/** Mutate the sealed body, RE-SEAL (recompute the completion digest), and write. */
function reseal(srcPath, destPath, mutate) {
  const sealed = JSON.parse(readFileSync(srcPath, 'utf8'));
  const state = sealed.completion.state;
  const body = { ...sealed };
  delete body.completion;
  mutate(body);
  const digest = evidenceDigest(body);
  const out = { ...body, completion: { state, evidenceDigest: digest } };
  writeFileSync(destPath, `${JSON.stringify(out, null, 2)}\n`);
  return destPath;
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-acceptance-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a valid sealed common-v1 artifact verifies (exit 0) and redacts source/registry', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const { code, stdout } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 0, stdout);
    const report = JSON.parse(stdout);
    assert.equal(report.verified, true);
    assert.equal(report.verdict, 'pass');
    assert.equal(report.candidate.version, '0.7.0');
    assert.equal(report.failures.length, 0);
    // Redaction: the candidate source path + registry must never appear.
    assert.ok(!stdout.includes('secret-user'), 'must not echo candidate source path');
    assert.ok(!stdout.includes('registry.internal.example'), 'must not echo candidate registry');
    assert.equal(report.candidate.source, undefined);
    assert.equal(report.candidate.registry, undefined);
  });
});

test('valid artifact passes matching expected version + host constraints', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const { code } = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-version',
      'v0.7.0',
      '--expect-platform',
      'linux',
      '--expect-arch',
      'x64',
      '--expect-node-abi',
      '137',
      '--expect-fs-type',
      'ext4',
    ]);
    assert.equal(code, 0);
  });
});

test('candidate-kind, registry, and registry-integrity expectations are independently enforced', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const matching = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-candidate-kind',
      'published-version',
      '--expected-registry',
      'https://registry.internal.example',
      '--expected-registry-integrity-digest',
      REGISTRY_FIXTURE.inventoryDigest,
      '--json',
    ]);
    assert.equal(matching.code, 0, matching.stdout);

    for (const [args, reason] of [
      [['--expected-candidate-kind', 'packed-release'], 'candidate-kind-mismatch'],
      [['--expected-registry', 'https://other-registry.example/'], 'candidate-registry-mismatch'],
      [
        ['--expected-registry-integrity-digest', 'c'.repeat(64)],
        'candidate-registry-integrity-digest-mismatch',
      ],
    ]) {
      const mismatch = runVerifier([
        '--evidence',
        evidence,
        '--profile',
        PROFILE_PATH,
        ...args,
        '--json',
      ]);
      assert.equal(mismatch.code, 1, mismatch.stdout);
      assert.ok(
        JSON.parse(mismatch.stdout).failures.some((failure) => failure.code === reason),
        mismatch.stdout,
      );
    }
  });
});

test('published proof requires the retained inventory and rejects missing or forged binding facts', () => {
  withTempDir((dir) => {
    const valid = writeValid(dir);
    const withoutInventory = runVerifierRaw([
      '--evidence',
      valid,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(withoutInventory.code, 1, withoutInventory.stdout);
    assert.ok(
      JSON.parse(withoutInventory.stdout).failures.some(
        (failure) => failure.code === 'registry-inventory-required',
      ),
      withoutInventory.stdout,
    );

    const missing = reseal(valid, join(dir, 'binding-missing.json'), (body) => {
      body.registryBindings.candidateLifecycle = null;
    });
    const missingResult = runVerifier(['--evidence', missing, '--profile', PROFILE_PATH, '--json']);
    assert.equal(missingResult.code, 1, missingResult.stdout);
    assert.ok(
      JSON.parse(missingResult.stdout).failures.some(
        (failure) => failure.code === 'registry-candidate-lifecycle-binding-missing',
      ),
      missingResult.stdout,
    );

    const forged = reseal(valid, join(dir, 'binding-forged.json'), (body) => {
      body.registryBindings.candidateLifecycle.packageSetDigest = 'f'.repeat(64);
    });
    const forgedResult = runVerifier(['--evidence', forged, '--profile', PROFILE_PATH, '--json']);
    assert.equal(forgedResult.code, 1, forgedResult.stdout);
    assert.ok(
      JSON.parse(forgedResult.stdout).failures.some(
        (failure) =>
          failure.code === 'registry-candidate-lifecycle-binding-package-set-digest-mismatch',
      ),
      forgedResult.stdout,
    );
  });
});

test('a resealed candidate identity digest is recomputed instead of trusted', () => {
  withTempDir((dir) => {
    const valid = writeValid(dir);
    const tampered = reseal(valid, join(dir, 'candidate-identity.json'), (body) => {
      body.candidate = { ...body.candidate, digest: 'f'.repeat(64) };
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1, stdout);
    assert.ok(
      JSON.parse(stdout).failures.some((failure) => failure.code === 'candidate-digest-mismatch'),
      stdout,
    );
  });
});

test('passing evidence requires a real harness git SHA', () => {
  withTempDir((dir) => {
    const valid = writeValid(dir);
    const tampered = reseal(valid, join(dir, 'unknown-git-sha.json'), (body) => {
      body.harnessGitSha = 'unknown';
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1, stdout);
    assert.ok(
      JSON.parse(stdout).failures.some((failure) => failure.code === 'harness-git-sha-malformed'),
      stdout,
    );
  });
});

test('tamper: profile digest mismatch fails verification', () => {
  withTempDir((dir) => {
    const valid = writeValid(dir);
    const tampered = reseal(valid, join(dir, 'digest.json'), (body) => {
      body.profile = { ...body.profile, digest: 'b'.repeat(64) };
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.verified, false);
    assert.ok(
      report.failures.some((f) => f.code === 'profile-digest-mismatch'),
      stdout,
    );
  });
});

test('tamper: a required journey flipped to fail (internally consistent) fails verification', () => {
  withTempDir((dir) => {
    const valid = writeValid(dir);
    const tampered = reseal(valid, join(dir, 'required-fail.json'), (body) => {
      const requiredIndex = body.results.findIndex((entry) => entry.required);
      body.results[requiredIndex] = {
        ...body.results[requiredIndex],
        status: 'fail',
        reasonCode: 'forced-failure',
      };
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
    const report = JSON.parse(stdout);
    assert.equal(report.verified, false);
    assert.ok(
      report.failures.some((f) => f.code === 'required-journey-not-passed'),
      stdout,
    );
    assert.ok(
      report.failures.some((f) => f.code === 'verdict-not-pass'),
      stdout,
    );
  });
});

test('tamper: removing the completion marker fails verification', () => {
  withTempDir((dir) => {
    const valid = writeValid(dir);
    const sealed = JSON.parse(readFileSync(valid, 'utf8'));
    delete sealed.completion;
    const tampered = join(dir, 'no-completion.json');
    writeFileSync(tampered, `${JSON.stringify(sealed, null, 2)}\n`);
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.verified, false);
    assert.ok(
      report.failures.some((f) => f.code === 'evidence-schema-invalid'),
      stdout,
    );
  });
});

test('tamper: swapping journey order (resealed) fails the canonical-order check', () => {
  withTempDir((dir) => {
    const valid = writeValid(dir);
    const tampered = reseal(valid, join(dir, 'reordered.json'), (body) => {
      const swap = body.results[3];
      body.results[3] = body.results[4];
      body.results[4] = swap;
    });
    const { code, stdout } = runVerifier([
      '--evidence',
      tampered,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.verified, false);
    assert.ok(
      report.failures.some((f) => f.code === 'journey-order-mismatch'),
      stdout,
    );
  });
});

test('expected version / host mismatches fail verification', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const version = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-version',
      '9.9.9',
      '--json',
    ]);
    assert.equal(version.code, 1);
    assert.ok(
      JSON.parse(version.stdout).failures.some((f) => f.code === 'candidate-version-mismatch'),
    );

    const platform = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expect-platform',
      'darwin',
      '--json',
    ]);
    assert.equal(platform.code, 1);
    assert.ok(
      JSON.parse(platform.stdout).failures.some((f) => f.code === 'host-platform-mismatch'),
    );

    const fs = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expect-fs-type',
      'apfs',
      '--json',
    ]);
    assert.equal(fs.code, 1);
    assert.ok(JSON.parse(fs.stdout).failures.some((f) => f.code === 'host-fs-type-mismatch'));
  });
});

test('matching node/npm major constraints pass; mismatches fail with their reason', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    // The fixture host reports Node v24.0.0 + npm 10.0.0.
    const ok = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-node-major',
      '24',
      '--expected-npm-major',
      '10',
    ]);
    assert.equal(ok.code, 0);

    const nodeBad = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-node-major',
      '20',
      '--json',
    ]);
    assert.equal(nodeBad.code, 1);
    assert.ok(
      JSON.parse(nodeBad.stdout).failures.some((f) => f.code === 'host-node-major-mismatch'),
    );

    const npmBad = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-npm-major',
      '11',
      '--json',
    ]);
    assert.equal(npmBad.code, 1);
    assert.ok(JSON.parse(npmBad.stdout).failures.some((f) => f.code === 'host-npm-major-mismatch'));
  });
});

test('a support-row binding expectation fails when the profile carries no binding', () => {
  withTempDir((dir) => {
    const evidence = writeValid(dir);
    // common-v1 has no supportRow binding, so expecting one is a mismatch.
    const rowBad = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-support-row',
      'macos-26-arm64-node24-npm11-v1',
      '--json',
    ]);
    assert.equal(rowBad.code, 1);
    assert.ok(
      JSON.parse(rowBad.stdout).failures.some((f) => f.code === 'support-row-binding-mismatch'),
    );

    const versionBad = runVerifier([
      '--evidence',
      evidence,
      '--profile',
      PROFILE_PATH,
      '--expected-support-contract-version',
      '1',
      '--json',
    ]);
    assert.equal(versionBad.code, 1);
    assert.ok(
      JSON.parse(versionBad.stdout).failures.some((f) => f.code === 'support-row-binding-mismatch'),
    );
  });
});

test('invalid invocation and unreadable inputs exit 2', () => {
  const help = runVerifier(['--help']);
  assert.equal(help.code, 0);

  const dup = runVerifier(['--evidence', 'a', '--evidence', 'b', '--profile', 'p']);
  assert.equal(dup.code, 2);

  const badFlag = runVerifier(['--evidence', 'a', '--profile', 'p', '--nope', 'x']);
  assert.equal(badFlag.code, 2);

  for (const args of [
    ['--expected-candidate-kind', 'source-tree'],
    ['--expected-registry', 'http://registry.example/'],
    ['--expected-registry', 'https://user:secret@registry.example/'],
    [
      '--expected-candidate-kind',
      'packed-release',
      '--expected-registry',
      'https://registry.example/',
    ],
  ]) {
    assert.equal(runVerifier(['--evidence', 'a', '--profile', 'p', ...args]).code, 2);
  }

  const missingProfile = runVerifier([
    '--evidence',
    'a',
    '--profile',
    join(tmpdir(), 'does-not-exist-xyz.json'),
  ]);
  assert.equal(missingProfile.code, 2);

  withTempDir((dir) => {
    const evidence = writeValid(dir);
    const missingEvidence = runVerifier([
      '--evidence',
      join(dir, 'absent.json'),
      '--profile',
      PROFILE_PATH,
    ]);
    assert.equal(missingEvidence.code, 2);
    // Valid inputs still verify from this dir (sanity that the fixture is good).
    assert.equal(runVerifier(['--evidence', evidence, '--profile', PROFILE_PATH]).code, 0);
  });
});

test(
  'verifier input reads reject symbolic links instead of following a substituted path',
  { skip: process.platform === 'win32' },
  () => {
    withTempDir((dir) => {
      const evidence = writeValid(dir);
      const evidenceLink = join(dir, 'evidence-link.json');
      symlinkSync(evidence, evidenceLink);
      const linkedEvidence = runVerifier(['--evidence', evidenceLink, '--profile', PROFILE_PATH]);
      assert.equal(linkedEvidence.code, 2);
      assert.match(linkedEvidence.stderr, /evidence path is not a regular file/);
      assert.ok(!linkedEvidence.stderr.includes(evidenceLink));

      const profileLink = join(dir, 'profile-link.json');
      symlinkSync(PROFILE_PATH, profileLink);
      const linkedProfile = runVerifier(['--evidence', evidence, '--profile', profileLink]);
      assert.equal(linkedProfile.code, 2);
      assert.match(linkedProfile.stderr, /profile path is not a regular file/);
      assert.ok(!linkedProfile.stderr.includes(profileLink));
    });
  },
);

test('present-but-non-JSON evidence is a verification failure (exit 1)', () => {
  withTempDir((dir) => {
    const notJson = join(dir, 'garbage.json');
    writeFileSync(notJson, 'this is not json\n');
    const { code, stdout } = runVerifier([
      '--evidence',
      notJson,
      '--profile',
      PROFILE_PATH,
      '--json',
    ]);
    assert.equal(code, 1);
    assert.ok(JSON.parse(stdout).failures.some((f) => f.code === 'evidence-not-json'));
  });
});
