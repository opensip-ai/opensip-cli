/**
 * @fileoverview Closed CLI grammar coverage for the platform-acceptance entry point.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createParentSignalCoordinator, runMeasuredCommand } from '../lib/measured-process.mjs';
import { main as runAcceptanceCli } from '../run-platform-acceptance.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ENTRYPOINT = join(REPO_ROOT, 'scripts', 'run-platform-acceptance.mjs');

function run(args, env = {}) {
  const child = spawnSync(process.execPath, [ENTRYPOINT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

function validShapeArgs(outPath = join(tmpdir(), 'acceptance-evidence.json')) {
  return [
    '--profile',
    'does-not-exist.json',
    '--packed-release',
    'does-not-exist',
    '--expected-version',
    '1.2.3',
    '--out',
    outPath,
  ];
}

test('help documents --expected-version as required for packed releases', () => {
  const result = run(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--packed-release <dir> --expected-version <semver>/);
  assert.doesNotMatch(result.stdout, /--packed-release <dir> \[--expected-version/);
  assert.match(result.stdout, /--agent-report-out <path>/);
  assert.match(result.stdout, /--expected-registry-integrity-digest <sha256>/);
  assert.match(result.stdout, /--registry-integrity-inventory <path>/);
});

test('published candidates require one valid primary-only registry integrity digest', () => {
  const base = [
    '--profile',
    'does-not-exist.json',
    '--published-version',
    '1.2.3',
    '--out',
    join(tmpdir(), 'published-evidence.json'),
  ];
  const missing = run(base);
  assert.equal(missing.code, 2);
  assert.match(
    missing.stderr,
    /--expected-registry-integrity-digest is required with --published-version/,
  );

  const malformed = run([...base, '--expected-registry-integrity-digest', 'A'.repeat(64)]);
  assert.equal(malformed.code, 2);
  assert.match(malformed.stderr, /64-character lowercase SHA-256 digest/);

  const missingInventory = run([...base, '--expected-registry-integrity-digest', 'a'.repeat(64)]);
  assert.equal(missingInventory.code, 2);
  assert.match(
    missingInventory.stderr,
    /--registry-integrity-inventory is required with --published-version/,
  );

  const relativeInventory = run([
    ...base,
    '--expected-registry-integrity-digest',
    'a'.repeat(64),
    '--registry-integrity-inventory',
    'inventory.json',
  ]);
  assert.equal(relativeInventory.code, 2);
  assert.match(relativeInventory.stderr, /--registry-integrity-inventory must be an absolute path/);

  const packed = run([...validShapeArgs(), '--expected-registry-integrity-digest', 'a'.repeat(64)]);
  assert.equal(packed.code, 2);
  assert.match(packed.stderr, /only valid with --published-version/);

  const packedInventory = run([
    ...validShapeArgs(),
    '--registry-integrity-inventory',
    join(tmpdir(), 'inventory.json'),
  ]);
  assert.equal(packedInventory.code, 2);
  assert.match(packedInventory.stderr, /only valid with --published-version/);
});

test('--agent-report-out is a closed absolute destination distinct from sealed evidence', () => {
  const base = validShapeArgs();
  const relative = run([...base, '--agent-report-out', 'agent-report.json']);
  assert.equal(relative.code, 2);
  assert.match(relative.stderr, /--agent-report-out must be an absolute path/);

  const same = run([...base, '--agent-report-out', join(tmpdir(), 'acceptance-evidence.json')]);
  assert.equal(same.code, 2);
  assert.match(same.stderr, /--agent-report-out must differ from --out/);
});

test('--out must be absolute at the argv boundary', () => {
  const result = run(validShapeArgs('relative-evidence.json'));
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--out must be an absolute path/);
  assert.doesNotMatch(result.stderr, /could not write evidence/);
});

test('explicit execution identity values are bounded before runner I/O', () => {
  for (const [extraArgs, expected] of [
    [['--run-id', 'r'.repeat(129)], /--run-id must be 1-128 characters/],
    [['--runner-label', 'l'.repeat(129)], /--runner-label must be 1-128 characters/],
    [['--run-attempt', '9007199254740992'], /--run-attempt must be a positive safe integer/],
  ]) {
    const result = run([...validShapeArgs(), ...extraArgs]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
  }
});

test('malformed environment-derived execution identity fails closed', () => {
  for (const [env, expected] of [
    [{ GITHUB_RUN_ID: '' }, /GITHUB_RUN_ID must be 1-128 characters/],
    [
      { GITHUB_RUN_ATTEMPT: 'not-an-integer' },
      /GITHUB_RUN_ATTEMPT must be a positive safe integer/,
    ],
    [
      { GITHUB_RUN_ATTEMPT: '9007199254740992' },
      /GITHUB_RUN_ATTEMPT must be a positive safe integer/,
    ],
    [{ ImageOS: `bad${String.fromCodePoint(10)}label` }, /ImageOS must be 1-128 characters/],
  ]) {
    const result = run(validShapeArgs(), env);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, expected);
  }
});

test('an unresolved harness git revision is an infrastructure fault before a run can pass', async () => {
  let runnerCalled = false;
  let stderr = '';
  const code = await runAcceptanceCli(validShapeArgs(), {
    harnessGitSha: 'unknown',
    stdout: { write: () => true },
    stderr: { write: (value) => (stderr += value) },
    runPlatformAcceptance: async () => {
      runnerCalled = true;
      throw new Error('must not run');
    },
  });
  assert.equal(code, 3);
  assert.equal(runnerCalled, false);
  assert.match(stderr, /harness-git-sha-unavailable/);
});

test('packed-release invocation without --expected-version is rejected before candidate I/O', () => {
  const result = run([
    '--profile',
    'does-not-exist.json',
    '--packed-release',
    'does-not-exist',
    '--out',
    join(tmpdir(), 'must-not-be-written.json'),
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--expected-version is required with --packed-release/);
});

test('SIGINT/SIGTERM defer native re-raise until the active child, cleanup, and evidence finish', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    // eslint-disable-next-line unicorn/prefer-event-target -- the coordinator accepts the process EventEmitter contract.
    const signalSource = new EventEmitter();
    const order = [];
    const coordinator = createParentSignalCoordinator({
      signalSource,
      cleanupTimeoutMs: 5000,
      reraiseSignal: (observed) => order.push(`reraised:${observed}`),
    });
    const code = await runAcceptanceCli([...validShapeArgs(), '--json-summary'], {
      parentSignalCoordinator: coordinator,
      harnessGitSha: 'abc1234',
      stdout: { write: () => true },
      stderr: { write: () => true },
      runPlatformAcceptance: async (options) => {
        const timer = setTimeout(() => signalSource.emit(signal), 50);
        try {
          const child = await runMeasuredCommand({
            command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
            cwd: process.cwd(),
            env: {},
            timeoutMs: 5000,
            sampleIntervalMs: 25,
            stdoutTailBytes: 128,
            stderrTailBytes: 128,
            abortSignal: options.signal,
            trackResidualDescendants: true,
            parentSignalCoordinator: options.parentSignalCoordinator,
          });
          assert.equal(child.cancelled, true);
          assert.equal(child.residualDescendants, 0);
          order.push('child-settled');
        } finally {
          clearTimeout(timer);
        }
        order.push('runner-cleanup-finished');
        return {
          outcome: 'infrastructure-fault',
          reasonCode: 'run-cancelled',
          evidence: {},
          verdict: 'infrastructure-fault',
          completionState: 'infrastructure-fault',
          runRoot: null,
          maxEvidenceBytes: 1024,
          progress: [],
        };
      },
      writeAcceptanceEvidence: () => {
        order.push('evidence-written');
        return { path: join(tmpdir(), 'synthetic-platform-evidence.json') };
      },
      emitSummary: () => order.push('summary-emitted'),
    });
    assert.equal(code, 3);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [
      'child-settled',
      'runner-cleanup-finished',
      'evidence-written',
      'summary-emitted',
      `reraised:${signal}`,
    ]);
  }
});
