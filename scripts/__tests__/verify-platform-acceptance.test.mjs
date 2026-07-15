import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const VERIFIER = join(REPO_ROOT, 'scripts', 'verify-platform-acceptance.mjs');
const PROFILE_PATH = join(REPO_ROOT, '.config', 'platform-acceptance', 'common-v1.json');
const PROFILE = parseAcceptanceProfile(JSON.parse(readFileSync(PROFILE_PATH, 'utf8')));

function runVerifier(args) {
  const proc = spawnSync(process.execPath, [VERIFIER, ...args], { encoding: 'utf8' });
  return { code: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

function makeValidBody() {
  const results = PROFILE.journeys.map((journey) => ({
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
  return {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: { id: PROFILE.id, version: PROFILE.version, digest: profileDigest(PROFILE) },
    candidate: {
      kind: 'packed-release',
      version: '0.7.0',
      source: '/home/secret-user/tarballs (14 npm tarballs)',
      digest: 'a'.repeat(64),
      registry: 'registry.internal.example',
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
      capabilities: { pty: true, symlink: true, permissions: true },
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
      body.results[1] = { ...body.results[1], status: 'fail', reasonCode: 'forced-failure' };
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
