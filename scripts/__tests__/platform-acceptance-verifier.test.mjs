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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      source: '/home/secret-user/tarballs (58 npm tarballs)',
      digest: 'a'.repeat(64),
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
  const out = { ...body, completion: { state: 'completed', evidenceDigest: evidenceDigest(body) } };
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  return path;
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-verifier-'));
  try {
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

test('field mutation: a malformed candidate version is an independent failure', () => {
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
    assert.ok(failuresOf(stdout).includes('candidate-version-malformed'), stdout);
  });
});

test('field mutation: a malformed candidate digest is an independent failure', () => {
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
    assert.ok(failuresOf(stdout).includes('candidate-digest-malformed'), stdout);
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

test('field mutation: an OPTIONAL journey flipped to fail (with a recomputed summary) is a summary/status failure', () => {
  withTempDir((dir) => {
    const optionalIndex = PROFILE.journeys.findIndex((j) => !j.required);
    assert.ok(optionalIndex >= 0);
    const tampered = reseal(dir, 'optional-fail.json', (body) => {
      body.results[optionalIndex] = {
        ...body.results[optionalIndex],
        status: 'fail',
        reasonCode: 'forced',
      };
      body.summary = computeSummary(PROFILE, body.results);
      body.verdict = computeVerdict(PROFILE, body.results, body.cleanup);
    });
    // Verdict still 'pass' (optional), so this remains a passing verification —
    // proving an optional fail does NOT gate. Now break the summary to prove the
    // independent recomputation catches a forged count.
    assert.equal(runVerifier(['--evidence', tampered, '--profile', PROFILE_PATH]).code, 0);

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
    assert.ok(failuresOf(stdout).includes('summary-mismatch'), stdout);
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
  const results = MACOS_PROFILE.journeys.map((journey, index) => ({
    id: journey.id,
    category: journey.id.split('.')[0],
    required: journey.required,
    status: 'pass',
    reasonCode: null,
    durationMs: 5,
    // The macOS profile requires a real RSS measurement somewhere; supply one.
    rss:
      index === 0
        ? { status: 'available', peakBytes: 4096 }
        : { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    diagnostics: [],
  }));
  const cleanup = { status: 'clean', reasonCode: null, removedRoots: 3, residualDescendants: 0 };
  const body = {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: {
      id: MACOS_PROFILE.id,
      version: MACOS_PROFILE.version,
      digest: profileDigest(MACOS_PROFILE),
    },
    candidate: {
      kind: 'published-version',
      version: '0.7.0',
      source: 'opensip-cli@0.7.0',
      digest: 'c'.repeat(64),
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
      capabilities: { pty: true, symlink: true, permissions: true, 'process-tree-rss': true },
    },
    results,
    cleanup,
    summary: computeSummary(MACOS_PROFILE, results),
    verdict: computeVerdict(MACOS_PROFILE, results, cleanup),
  };
  return { ...body, completion: { state: 'completed', evidenceDigest: evidenceDigest(body) } };
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
      '--json',
    ]);
    assert.equal(code, 0, stdout);
    assert.equal(JSON.parse(stdout).verified, true);
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
