/** @fileoverview Focused path-containment and short-write evidence-writer coverage. */

import assert from 'node:assert/strict';
import {
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeSummary,
  computeVerdict,
  parseAcceptanceEvidence,
  parseAcceptanceProfile,
  PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
  profileDigest,
} from '../platform-acceptance/contract.mjs';
import {
  EvidenceWriteError,
  writeAcceptanceEvidence,
} from '../platform-acceptance/evidence-writer.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PROFILE = parseAcceptanceProfile(
  JSON.parse(readFileSync(join(REPO_ROOT, '.config/platform-acceptance/common-v1.json'), 'utf8')),
);
const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opensip-evidence-writer-'));
  roots.push(root);
  const runRoot = join(root, 'run');
  const outRoot = join(root, 'out');
  mkdirSync(runRoot);
  mkdirSync(outRoot);
  return { root, runRoot, outRoot };
}

after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function evidenceBody() {
  const results = PROFILE.journeys.map((journey) => ({
    id: journey.id,
    category: journey.id.split('.')[0],
    required: journey.required,
    status: 'pass',
    reasonCode: null,
    durationMs: 1,
    rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    diagnostics: [],
  }));
  const cleanup = {
    status: 'clean',
    reasonCode: null,
    removedRoots: 1,
    residualDescendants: 0,
  };
  return {
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: {
      id: PROFILE.id,
      version: PROFILE.version,
      digest: profileDigest(PROFILE),
    },
    candidate: {
      kind: 'packed-release',
      version: '1.2.3',
      source: 'packed-release@1.2.3',
      digest: 'a'.repeat(64),
      manifestDigest: 'b'.repeat(64),
    },
    previousCandidate: null,
    execution: {
      runId: 'writer-test',
      runAttempt: 1,
      runnerLabel: 'test-runner',
    },
    lifecycle: {
      installedVersion: '1.2.3',
      upgradedVersion: '1.2.3',
      versionMigrated: false,
      stateMigrated: false,
      cliStateRemoved: true,
      packageRemoved: true,
    },
    harnessGitSha: 'abc1234',
    startedAt: '2026-07-15T00:00:00.000Z',
    completedAt: '2026-07-15T00:01:00.000Z',
    host: {
      platform: 'linux',
      arch: 'x64',
      osRelease: '6.1.0',
      osVersion: { status: 'unavailable', reasonCode: 'os-version-empty' },
      nodeVersion: 'v24.0.0',
      nodeModuleAbi: '137',
      npmVersion: '11.0.0',
      packageManager: 'npm',
      cpuModel: 'Test CPU',
      cpuCount: 2,
      totalMemoryBytes: 1024,
      filesystem: { type: 'apfs', caseSensitive: false },
      shell: 'zsh',
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
    },
    results,
    cleanup,
    summary: computeSummary(PROFILE, results),
    verdict: computeVerdict(PROFILE, results, cleanup),
  };
}

function write(outPath, runRoot, deps) {
  return writeAcceptanceEvidence(
    {
      evidence: evidenceBody(),
      completionState: 'completed',
      outPath,
      maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
      runRoot,
    },
    deps,
  );
}

test('rejects an outside-looking destination whose existing parent resolves inside run root', () => {
  const { root, runRoot } = fixture();
  const linkedParent = join(root, 'linked-parent');
  symlinkSync(runRoot, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');

  assert.throws(
    () => write(join(linkedParent, 'evidence.json'), runRoot),
    (error) => error instanceof EvidenceWriteError && error.reasonCode === 'out-inside-run-root',
  );
});

test('requires an existing output parent and still rejects a destination symlink', () => {
  const { root, outRoot } = fixture();
  assert.throws(
    () => write(join(root, 'missing', 'evidence.json')),
    (error) => error instanceof EvidenceWriteError && error.reasonCode === 'out-invalid',
  );

  const target = join(outRoot, 'target.json');
  const linked = join(outRoot, 'linked.json');
  writeFileSync(target, '{}\n');
  symlinkSync(target, linked);
  assert.throws(
    () => write(linked),
    (error) => error instanceof EvidenceWriteError && error.reasonCode === 'out-is-symlink',
  );
});

test('retries valid short writeSync results until the complete evidence is durable', () => {
  const { outRoot } = fixture();
  const outPath = join(outRoot, 'evidence.json');
  let writes = 0;
  const written = write(outPath, undefined, {
    writeSync(descriptor, buffer, offset, length) {
      writes += 1;
      const bytes = Math.min(length, 17);
      return writeSync(descriptor, buffer, offset, bytes);
    },
  });

  assert.ok(writes > 1);
  assert.equal(written.path, outPath);
  assert.doesNotThrow(() => parseAcceptanceEvidence(JSON.parse(readFileSync(outPath, 'utf8'))));
});

test('serializes the validated projection instead of a caller-owned toJSON substitution', () => {
  const { outRoot } = fixture();
  const outPath = join(outRoot, 'evidence.json');
  const evidence = evidenceBody();
  const candidate = evidence.candidate;
  Object.defineProperty(candidate, 'toJSON', {
    enumerable: false,
    value() {
      return { ...candidate, version: '9.9.9' };
    },
  });

  writeAcceptanceEvidence({
    evidence,
    completionState: 'completed',
    outPath,
    maxEvidenceBytes: PROFILE.bounds.maxEvidenceBytes,
  });

  const parsed = parseAcceptanceEvidence(JSON.parse(readFileSync(outPath, 'utf8')));
  assert.equal(parsed.candidate.version, '1.2.3');
});

test('rejects an invalid evidence-byte bound instead of silently disabling it', () => {
  const { outRoot } = fixture();
  for (const maxEvidenceBytes of [undefined, Number.NaN, 0, '4194304']) {
    assert.throws(
      () =>
        writeAcceptanceEvidence({
          evidence: evidenceBody(),
          completionState: 'completed',
          outPath: join(outRoot, `invalid-bound-${String(maxEvidenceBytes)}.json`),
          maxEvidenceBytes,
        }),
      (error) => error instanceof EvidenceWriteError && error.reasonCode === 'evidence-invalid',
    );
  }
});

test(
  'fsyncs the parent directory after atomically renaming the evidence',
  { skip: process.platform === 'win32' },
  () => {
    const { outRoot } = fixture();
    const outPath = join(outRoot, 'evidence.json');
    let fsyncCalls = 0;

    write(outPath, undefined, {
      fsyncSync(descriptor) {
        fsyncCalls += 1;
        return fsyncSync(descriptor);
      },
    });

    assert.equal(fsyncCalls, 2, 'expected one file fsync and one parent-directory fsync');
    assert.ok(existsSync(outPath));
  },
);

test(
  'rolls back renamed evidence when parent-directory durability cannot be confirmed',
  { skip: process.platform === 'win32' },
  () => {
    const { outRoot } = fixture();
    const outPath = join(outRoot, 'evidence.json');
    let fsyncCalls = 0;

    assert.throws(
      () =>
        write(outPath, undefined, {
          fsyncSync(descriptor) {
            fsyncCalls += 1;
            if (fsyncCalls === 2) throw new Error('injected parent fsync failure');
            return fsyncSync(descriptor);
          },
        }),
      (error) => error instanceof EvidenceWriteError && error.reasonCode === 'write-failed',
    );

    assert.equal(fsyncCalls, 3, 'expected the rollback namespace to be synced best-effort');
    assert.equal(existsSync(outPath), false);
    assert.deepEqual(readdirSync(outRoot), []);
  },
);

test('documents the Windows parent-directory fsync skip while preserving file durability', () => {
  const { outRoot } = fixture();
  const outPath = join(outRoot, 'evidence.json');
  let fsyncCalls = 0;

  write(outPath, undefined, {
    platform: 'win32',
    fsyncSync(descriptor) {
      fsyncCalls += 1;
      return fsyncSync(descriptor);
    },
  });

  assert.equal(fsyncCalls, 1, 'Windows performs the evidence-file fsync only');
  assert.ok(existsSync(outPath));
});
