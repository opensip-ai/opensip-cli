/**
 * @fileoverview Phase 4 guardrail — the `agent.installed-smoke` journey executor.
 *
 * Exercises the executor's outcome classification with a stubbed measured-process
 * port and a run-owned report path: a valid installed-candidate report passes; an
 * identity/target/source mismatch is a journey `fail`; a non-zero harness run is a
 * journey `fail`; a missing built harness is an infrastructure fault
 * (`unavailable`). Runs under `node --test` (`pnpm test:scripts`).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { getJourney } from '../platform-acceptance/journey-catalog.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AGENT_EVAL_MODEL = join(REPO_ROOT, 'packages', 'agent-eval', 'dist', 'report', 'model.js');
// The executor imports the built agent-eval schema validator; without it the whole
// suite would only ever observe the infrastructure-fault branch, so skip cleanly.
const SKIP = !existsSync(AGENT_EVAL_MODEL);

const INSTALLED_VERSION = '9.9.9';
const executor = getJourney('agent.installed-smoke').executor;

const roots = [];
function tempWorkRoot() {
  const root = mkdtempSync(join(tmpdir(), 'agent-installed-smoke-'));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function armResult(arm, passed) {
  return {
    assertions: { incorrectNone: passed ? 0 : 1, passed, scopes: [] },
    metrics: { callCount: 1, responseBytes: 10, totalWallMs: 2 },
    recoveryMetrics: { callCount: 0, responseBytes: 0, totalWallMs: 0 },
    record: {
      arm,
      legs: [
        {
          leg: 'main',
          steps: [
            {
              facts: [],
              responseBytes: 10,
              stepId: `${arm}-main`,
              tool: 'search_symbols',
              wallMs: 2,
            },
          ],
        },
      ],
      setup: { mode: 'fixture', stages: [] },
      strategyVersion: `${arm}-v1`,
      taskId: 'entrypoint-trace.customer-ts',
    },
  };
}

/** A schema-valid installed smoke report; overrides tune the acceptance-relevant fields. */
function makeReport(overrides = {}) {
  const source = overrides.source ?? 'installed';
  const sourceState = overrides.sourceState ?? 'clean';
  return {
    cliTarget: { entrypointName: 'index.js', source },
    cliVersion: overrides.cliVersion ?? INSTALLED_VERSION,
    completedAt: '2026-07-14T20:01:00.000Z',
    contractFingerprint: `sha256:${'a'.repeat(64)}`,
    gitSha: 'abc1234',
    harnessVersion: '0.7.0',
    nodeVersion: 'v24.0.0',
    platform: 'darwin-arm64',
    promotionEligible: sourceState === 'clean',
    schemaVersion: 1,
    selectedArms: ['control', 'opensip'],
    sourceState,
    startedAt: '2026-07-14T20:00:00.000Z',
    tasks: [
      {
        arms: {
          control: armResult('control', overrides.controlPassed ?? true),
          opensip: armResult('opensip', overrides.opensipPassed ?? true),
        },
        completedAt: '2026-07-14T20:00:30.000Z',
        taskId: 'entrypoint-trace.customer-ts',
      },
    ],
  };
}

/** Build a journey context whose measured-process port runs `handleRun(spec)`. */
function makeContext(handleRun, installedOverrides = {}) {
  const workRoot = tempWorkRoot();
  return {
    installed: {
      installedBin: { bin: '/candidate/bin/opensip', kind: 'installed-bin' },
      jsEntrypoint: { kind: 'node-script', script: '/candidate/dist/index.js' },
      mode: 'packed-release',
      resolvedVersion: INSTALLED_VERSION,
      ...installedOverrides,
    },
    paths: { workRoot },
    process: { run: (spec) => Promise.resolve(handleRun(spec, workRoot)) },
    assert: { diagnostic: (text) => String(text).slice(0, 4096) },
  };
}

/** A default measured result; only the fields the executor reads matter. */
function measuredResult(overrides = {}) {
  return {
    cancelled: false,
    cleanup: { residualDescendants: 0 },
    durationMs: 5,
    outputTruncated: false,
    rss: { reasonCode: 'rss-not-sampled', status: 'unavailable' },
    signal: null,
    status: 0,
    stderrTail: '',
    stdoutCapture: '',
    stdoutTail: '',
    timedOut: false,
    ...overrides,
  };
}

/** Extract the `--json` report path the executor asked the port to write. */
function reportPathOf(spec) {
  const index = spec.argv.indexOf('--json');
  return index >= 0 ? spec.argv[index + 1] : undefined;
}

test(
  'passes when the installed candidate smoke report satisfies every requirement',
  { skip: SKIP },
  async () => {
    const context = makeContext((spec) => {
      // The harness targets the installed entrypoint and writes a valid report.
      assert.deepEqual(spec.argv.slice(2, 5), [
        '--smoke',
        '--opensip-entrypoint',
        '/candidate/dist/index.js',
      ]);
      writeFileSync(reportPathOf(spec), JSON.stringify(makeReport()));
      return measuredResult();
    });
    const outcome = await executor(context);
    assert.equal(outcome.status, 'pass');
    assert.ok(outcome.diagnostics.some((d) => d.includes('targetSource=installed')));
    assert.ok(outcome.diagnostics.some((d) => d.includes('report sha256:')));
  },
);

test(
  'keeps the full report as a run-owned artifact and stores only a bounded summary',
  { skip: SKIP },
  async () => {
    let writtenPath;
    const context = makeContext((spec) => {
      writtenPath = reportPathOf(spec);
      writeFileSync(writtenPath, JSON.stringify(makeReport()));
      return measuredResult();
    });
    const outcome = await executor(context);
    assert.equal(outcome.status, 'pass');
    // The auxiliary artifact survives at the run-owned path; evidence stays bounded.
    assert.ok(existsSync(writtenPath));
    assert.ok(writtenPath.startsWith(context.paths.workRoot));
    assert.ok(outcome.diagnostics.length <= 4);
  },
);

test('fails when the report target source is not installed', { skip: SKIP }, async () => {
  const context = makeContext((spec) => {
    writeFileSync(reportPathOf(spec), JSON.stringify(makeReport({ source: 'workspace' })));
    return measuredResult();
  });
  const outcome = await executor(context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'installed-smoke-unmet');
});

test(
  'fails when the report cliVersion does not match the installed identity',
  { skip: SKIP },
  async () => {
    const context = makeContext((spec) => {
      writeFileSync(reportPathOf(spec), JSON.stringify(makeReport({ cliVersion: '0.0.0' })));
      return measuredResult();
    });
    const outcome = await executor(context);
    assert.equal(outcome.status, 'fail');
    assert.equal(outcome.reasonCode, 'installed-smoke-unmet');
  },
);

test('fails when the OpenSIP arm assertions did not pass', { skip: SKIP }, async () => {
  const context = makeContext((spec) => {
    writeFileSync(reportPathOf(spec), JSON.stringify(makeReport({ opensipPassed: false })));
    return measuredResult();
  });
  const outcome = await executor(context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'installed-smoke-unmet');
});

test('fails when the workspace source changed during the run', { skip: SKIP }, async () => {
  const context = makeContext((spec) => {
    writeFileSync(
      reportPathOf(spec),
      JSON.stringify(makeReport({ sourceState: 'changed-during-run' })),
    );
    return measuredResult();
  });
  const outcome = await executor(context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'installed-smoke-unmet');
});

test(
  'classifies a non-zero harness run as a journey fail (installed-candidate failure)',
  { skip: SKIP },
  async () => {
    const context = makeContext(() =>
      measuredResult({ status: 2, stderrTail: 'prerequisite: MCP unavailable' }),
    );
    const outcome = await executor(context);
    assert.equal(outcome.status, 'fail');
    assert.equal(outcome.reasonCode, 'installed-smoke-run-failed');
  },
);

test('classifies a harness timeout as a journey fail', { skip: SKIP }, async () => {
  const context = makeContext(() => measuredResult({ status: null, timedOut: true }));
  const outcome = await executor(context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'installed-smoke-timed-out');
});

test('fails when the harness exits zero but writes no report', { skip: SKIP }, async () => {
  const context = makeContext(() => measuredResult());
  const outcome = await executor(context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'installed-smoke-report-missing');
});

test(
  'fails when the report does not satisfy the agent-eval schema contract',
  { skip: SKIP },
  async () => {
    const context = makeContext((spec) => {
      writeFileSync(
        reportPathOf(spec),
        JSON.stringify({ schemaVersion: 1, not: 'a valid report' }),
      );
      return measuredResult();
    });
    const outcome = await executor(context);
    assert.equal(outcome.status, 'fail');
    assert.equal(outcome.reasonCode, 'installed-smoke-report-invalid');
  },
);

test(
  'is an infrastructure fault (unavailable) when no installed entrypoint is present',
  { skip: SKIP },
  async () => {
    const context = makeContext(() => measuredResult(), {
      jsEntrypoint: { kind: 'node-script', script: '' },
    });
    const outcome = await executor(context);
    assert.equal(outcome.status, 'unavailable');
    assert.equal(outcome.reasonCode, 'installed-entrypoint-missing');
  },
);
