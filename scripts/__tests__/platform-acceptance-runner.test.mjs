/**
 * @fileoverview Phase 6 residual coverage — the journey ORCHESTRATOR + the
 * measured-process substrate it drives.
 *
 * `runPlatformAcceptance` is exercised with FULLY FAKE seams (clock, fs, host
 * collector, candidate lifecycle, process port, mcp connector, fixtures, profile
 * reader) over a small profile of REAL registered journey ids. It proves:
 * profile-order execution + one-result-per-id; capability gating (optional →
 * unavailable, still present); continue-after-ordinary-fail; the closed stage
 * vocabulary; and every fail-closed STOP — candidate loss, evidence-bound
 * exhaustion, cleanup-integrity failure, and caller cancellation — turning the
 * remaining journeys into `unavailable` rows with the causal reason. The
 * measured-process section proves RSS `available` on a valid process table and
 * `unavailable` on Windows / a short-lived child / a sampler fault, never
 * accepting a peak of zero, plus tree-RSS and outcome classification.
 *
 * Runs under `node --test` (`pnpm test:scripts`). No CLI, npm, or network.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import {
  classifyMeasuredOutcome,
  createMeasuredProcessPort,
  MEASURED_PROCESS_REASON_CODES,
  parseProcessTable,
  RSS_REASON_CODES,
  sumProcessTreeRss,
} from '../lib/measured-process.mjs';
import { defineJourney } from '../platform-acceptance/journey-kit.mjs';
import {
  ACCEPTANCE_STAGES,
  RUN_OUTCOMES,
  RUNNER_REASON_CODES,
  runPlatformAcceptance,
} from '../platform-acceptance/runner.mjs';

const STAGE_VALUES = new Set(Object.values(ACCEPTANCE_STAGES));
const BIN_PATH = '/fake/runroot/bin/opensip';

const RUNNER_PROFILE = {
  schemaVersion: 1,
  id: 'runner-mini',
  version: 1,
  requiredCapabilities: [],
  rssRequired: false,
  bounds: {
    journeyTimeoutMs: 1000,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    maxDiagnosticTailBytes: 1024,
    rssSampleIntervalMs: 100,
    maxEvidenceBytes: 4_194_304,
    maxJourneyResults: 16,
  },
  journeys: [
    { id: 'lifecycle.install', required: true },
    { id: 'lifecycle.version', required: true },
    { id: 'lifecycle.help', required: true },
    { id: 'resilience.symlink-root', required: false, capabilities: ['symlink'] },
    { id: 'lifecycle.cli-state-uninstall', required: true },
    { id: 'lifecycle.package-uninstall', required: true },
  ],
};
const PROFILE_IDS = RUNNER_PROFILE.journeys.map((j) => j.id);

function fakeClock() {
  let t = 0;
  return { now: () => (t += 1), wallIso: () => '2026-07-15T00:00:00.000Z', wallOrigin: () => 0 };
}

function fakeFs(binExists = () => true) {
  // Stateful: an rmSync'd path stops existing (so cleanup accounting is honest).
  const removed = new Set();
  return {
    mkdtempSync: () => '/fake/runroot',
    mkdirSync: () => {
      /* run-root dirs are virtual in this harness */
    },
    existsSync: (p) => {
      if (removed.has(p)) return false;
      return p === BIN_PATH ? binExists() : true;
    },
    realpathSync: (p) => p,
    rmSync: (p) => removed.add(p),
  };
}

function fakeHost({ symlink = false } = {}) {
  return {
    platform: 'linux',
    arch: 'x64',
    osRelease: 'x',
    osVersion: { status: 'unavailable', reasonCode: 'os-version-empty' },
    nodeVersion: 'v24.0.0',
    nodeModuleAbi: '137',
    npmVersion: '10.0.0',
    packageManager: 'pnpm',
    cpuModel: 'x',
    cpuCount: 1,
    totalMemoryBytes: 0,
    filesystem: { type: 'ext4', caseSensitive: true },
    shell: 'bash',
    swVers: { status: 'unavailable', reasonCode: 'darwin-only-probe' },
    kernelRelease: { status: 'unavailable', reasonCode: 'darwin-only-probe' },
    unameArch: { status: 'unavailable', reasonCode: 'darwin-only-probe' },
    capabilities: { pty: true, symlink, permissions: true, 'process-tree-rss': true },
  };
}

function fakeLifecycle(options = {}) {
  let state = 'empty';
  const installed = {
    mode: 'packed-release',
    installedBin: { kind: 'installed-bin', bin: BIN_PATH },
    jsEntrypoint: { kind: 'node-script', script: '/fake/runroot/pkg/dist/index.js' },
    resolvedVersion: '9.9.9',
  };
  const event = (type, transition) => {
    if (transition) state = transition;
    return { type, ok: true, state, reasonCode: null, diagnostics: [], facts: {} };
  };
  return {
    get installed() {
      return installed;
    },
    get state() {
      return state;
    },
    childEnv: () => ({}),
    install: () => event('install', 'installed'),
    createRepresentativeState: () => event('representative-state'),
    upgrade: () => event('upgrade', 'upgraded'),
    removeCliState: () => event('cli-state-removed', 'cli-state-removed'),
    removePackage: () => event('package-removed', 'package-removed'),
    cleanup:
      options.cleanup ??
      (() => ({ status: 'clean', reasonCode: null, removedRoots: 1, residualDescendants: 0 })),
  };
}

const OK_STDOUT = 'Commands:\n  fit\nopensip 9.9.9';
function portResult(overrides = {}) {
  return {
    status: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    durationMs: 1,
    stdoutTail: '',
    stderrTail: '',
    stdoutCapture: OK_STDOUT,
    cleanup: { residualDescendants: 0 },
    ...overrides,
  };
}

function fakePort({ scriptByArgv, rss } = {}) {
  const port = {
    run: (spec) => {
      const args = spec.argv.slice(1);
      return Promise.resolve(scriptByArgv ? scriptByArgv(args) : portResult());
    },
  };
  if (rss) port.rssMeasurement = () => rss;
  return port;
}

function runWith(overrides = {}) {
  const port = overrides.port ?? fakePort();
  const deps = {
    clock: fakeClock(),
    fs: fakeFs(overrides.binExists),
    collectHostProfile: () => fakeHost(overrides.host),
    resolveCandidateSource: () =>
      Promise.resolve({
        ok: true,
        identity: {
          kind: 'packed-release',
          version: '0.7.0',
          source: 'packed@0.7.0',
          digest: 'a'.repeat(64),
        },
      }),
    createLifecycle: () => fakeLifecycle(overrides.lifecycle ?? {}),
    createProcessPort: () => port,
    createMcpConnector: () => ({}),
    packFixtures: () => ({
      toolPluginTarball: '/fx/t.tgz',
      fitPackTarball: '/fx/f.tgz',
      simPackTarball: '/fx/s.tgz',
    }),
    readProfile: () => structuredClone(overrides.profile ?? RUNNER_PROFILE),
    journeyRegistry: overrides.journeyRegistry, // undefined ⇒ runner falls back to JOURNEY_REGISTRY
    platform: 'linux',
  };
  const options = {
    profilePath: 'profile.json',
    candidate: { primary: { kind: 'packed-release', directory: '/x', expectedVersion: '0.7.0' } },
    repoRoot: '/repo',
    harnessGitSha: 'abc1234',
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
  return runPlatformAcceptance(options, deps);
}

function byId(result) {
  return new Map(result.evidence.results.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Happy path — order, one-result-per-id, capability gating, stages, RSS
// ---------------------------------------------------------------------------

test('runs journeys in profile order, one result per id, and passes with an optional gated journey', async () => {
  const result = await runWith({
    port: fakePort({ rss: { status: 'available', peakBytes: 12_345 } }),
  });

  assert.equal(result.outcome, RUN_OUTCOMES.COMPLETED);
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(
    result.evidence.results.map((r) => r.id),
    PROFILE_IDS,
  );
  assert.equal(new Set(result.evidence.results.map((r) => r.id)).size, PROFILE_IDS.length);

  const results = byId(result);
  // The optional symlink journey is capability-gated → unavailable, still present.
  assert.equal(results.get('resilience.symlink-root').status, 'unavailable');
  assert.equal(results.get('resilience.symlink-root').reasonCode, 'capability-symlink-unavailable');
  // Required journeys all pass.
  for (const id of [
    'lifecycle.install',
    'lifecycle.version',
    'lifecycle.help',
    'lifecycle.cli-state-uninstall',
    'lifecycle.package-uninstall',
  ]) {
    assert.equal(results.get(id).status, 'pass', id);
  }
  // Executor journeys surface the port RSS measurement; lifecycle rows are not sampled.
  assert.equal(results.get('lifecycle.version').rss.status, 'available');
  assert.equal(results.get('lifecycle.version').rss.peakBytes, 12_345);
  assert.equal(results.get('lifecycle.install').rss.status, 'unavailable');

  // Every progress stage is in the closed vocabulary.
  for (const event of result.progress) assert.ok(STAGE_VALUES.has(event.stage), event.stage);
});

test('a port without an RSS measurement yields rss-not-sampled', async () => {
  // The fake port here intentionally omits `rssMeasurement` to exercise the
  // runner's `rss-not-sampled` fallback. The production measured-process port DOES
  // expose it — that path is covered by `platform-acceptance-measured-process.test.mjs`.
  const result = await runWith();
  const version = byId(result).get('lifecycle.version');
  assert.equal(version.rss.status, 'unavailable');
  assert.equal(version.rss.reasonCode, 'rss-not-sampled');
});

// ---------------------------------------------------------------------------
// Continue after an ordinary failure
// ---------------------------------------------------------------------------

test('an ordinary journey failure does not stop the run', async () => {
  const port = fakePort({
    scriptByArgv: (args) => (args.includes('--version') ? portResult({ status: 1 }) : portResult()),
  });
  const result = await runWith({ port });
  const results = byId(result);
  assert.equal(results.get('lifecycle.version').status, 'fail');
  // Downstream journeys still executed.
  assert.equal(results.get('lifecycle.help').status, 'pass');
  assert.equal(results.get('lifecycle.package-uninstall').status, 'pass');
  assert.equal(result.evidence.results.length, PROFILE_IDS.length);
  // A required failure fails the verdict, but the run still COMPLETED.
  assert.equal(result.outcome, RUN_OUTCOMES.COMPLETED);
  assert.equal(result.verdict, 'fail');
});

// ---------------------------------------------------------------------------
// Fail-closed STOP conditions
// ---------------------------------------------------------------------------

test('candidate loss after install stops the run: remaining journeys are unavailable/candidate-lost', async () => {
  const result = await runWith({ binExists: () => false });
  const results = byId(result);
  assert.equal(results.get('lifecycle.install').status, 'pass');
  for (const id of [
    'lifecycle.version',
    'lifecycle.help',
    'resilience.symlink-root',
    'lifecycle.cli-state-uninstall',
    'lifecycle.package-uninstall',
  ]) {
    assert.equal(results.get(id).status, 'unavailable', id);
    assert.equal(results.get(id).reasonCode, RUNNER_REASON_CODES.CANDIDATE_LOST, id);
  }
  assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
  assert.equal(result.reasonCode, RUNNER_REASON_CODES.CANDIDATE_LOST);
  assert.equal(result.verdict, 'infrastructure-fault');
});

test('evidence-bound exhaustion stops the run with a causal reason and fails the verdict', async () => {
  const profile = structuredClone(RUNNER_PROFILE);
  profile.bounds.maxEvidenceBytes = 300; // exceeded after the second appended result
  const result = await runWith({ profile });
  const results = byId(result);
  assert.equal(results.get('lifecycle.install').status, 'pass');
  assert.equal(results.get('lifecycle.version').status, 'pass');
  assert.equal(results.get('lifecycle.help').status, 'unavailable');
  assert.equal(
    results.get('lifecycle.help').reasonCode,
    RUNNER_REASON_CODES.EVIDENCE_BOUND_EXHAUSTED,
  );
  // An evidence-bound stop is not an infrastructure fault, but the required
  // unavailable rows fail the verdict.
  assert.equal(result.outcome, RUN_OUTCOMES.COMPLETED);
  assert.equal(result.verdict, 'fail');
});

test('a cleanup-integrity failure is reported as an incomplete, causal cleanup and fails the verdict', async () => {
  const result = await runWith({
    lifecycle: {
      cleanup: () => {
        throw new Error('cleanup exploded');
      },
    },
  });
  assert.equal(result.evidence.cleanup.status, 'incomplete');
  assert.equal(result.evidence.cleanup.reasonCode, RUNNER_REASON_CODES.CLEANUP_INTEGRITY_FAILED);
  assert.equal(result.verdict, 'fail');
});

test('caller cancellation aborts the run: every journey is unavailable/run-cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runWith({ signal: controller.signal });
  for (const id of PROFILE_IDS) {
    const row = byId(result).get(id);
    assert.equal(row.status, 'unavailable', id);
    assert.equal(row.reasonCode, RUNNER_REASON_CODES.RUN_CANCELLED, id);
  }
  assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
  assert.equal(result.reasonCode, RUNNER_REASON_CODES.RUN_CANCELLED);
});

// ---------------------------------------------------------------------------
// Harness-prerequisite escalation (a missing agent-eval build is an INFRA fault)
// ---------------------------------------------------------------------------

/**
 * A one-entry fake registry holding a single non-lifecycle executor journey
 * (`agent.installed-smoke`) whose executor returns `outcome`. The row is built
 * through the real `defineJourney`, so it carries the exact canonical shape the
 * runner's `runOneJourney`/`runExecutorJourney` read (id, category, capabilities,
 * isolated, steps, executor …) — the journey-registry seam is injected end to end.
 */
function fakeAgentRegistry(outcome) {
  const journey = defineJourney({
    id: 'agent.installed-smoke',
    category: 'agent',
    value: {
      human: 'the installed agent smoke journey runs',
      agent: 'the installed agent-eval harness answers',
    },
    steps: [{ label: 'run the installed agent-eval smoke journey' }],
    executor: () => Promise.resolve(outcome),
  });
  return new Map([[journey.id, journey]]);
}

// A profile that selects ONLY the single required agent journey above.
const AGENT_SMOKE_PROFILE = {
  ...RUNNER_PROFILE,
  journeys: [{ id: 'agent.installed-smoke', required: true }],
};

test('a missing built agent-eval harness escalates the run to an infrastructure fault (reserved reasons only)', async () => {
  // A required agent journey that reports a reserved HARNESS_INFRA_REASONS code
  // (the private agent-eval build is missing) escalates the WHOLE run to an
  // infrastructure fault (exit-3 class) instead of a candidate `fail` (exit 1).
  const infra = await runWith({
    profile: AGENT_SMOKE_PROFILE,
    journeyRegistry: fakeAgentRegistry({
      status: 'unavailable',
      reasonCode: 'agent-eval-harness-missing',
      diagnostics: [],
    }),
  });
  assert.equal(infra.verdict, 'infrastructure-fault');
  assert.equal(infra.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
  assert.equal(infra.reasonCode, 'agent-eval-harness-missing');
  // The journey's OWN row stays a faithful `unavailable` with the reserved reason —
  // escalation pins the run verdict without rewriting the per-journey evidence.
  const infraRow = byId(infra).get('agent.installed-smoke');
  assert.equal(infraRow.status, 'unavailable');
  assert.equal(infraRow.reasonCode, 'agent-eval-harness-missing');

  // Control: the SAME fake journey returning an ordinary `fail` (a non-reserved
  // reason) is a candidate defect, NOT an infrastructure fault — proving only the
  // reserved reason codes escalate.
  const ordinary = await runWith({
    profile: AGENT_SMOKE_PROFILE,
    journeyRegistry: fakeAgentRegistry({
      status: 'fail',
      reasonCode: 'installed-cli-unusable',
      diagnostics: [],
    }),
  });
  assert.equal(ordinary.verdict, 'fail');
  assert.equal(ordinary.outcome, RUN_OUTCOMES.COMPLETED);
  assert.equal(ordinary.reasonCode, null);
  assert.equal(byId(ordinary).get('agent.installed-smoke').status, 'fail');
});

// ---------------------------------------------------------------------------
// Invalid invocation paths
// ---------------------------------------------------------------------------

test('an unreadable profile is an invalid invocation (no evidence)', async () => {
  const result = await runPlatformAcceptance(
    { profilePath: '', candidate: {}, repoRoot: '/repo', harnessGitSha: 'abc1234' },
    {
      readProfile: () => {
        throw new Error('nope');
      },
    },
  );
  assert.equal(result.outcome, RUN_OUTCOMES.INVALID_INVOCATION);
  assert.equal(result.evidence, null);
});

test('an invalid candidate is an invalid invocation with a redacted message', async () => {
  const result = await runWith({});
  assert.equal(result.outcome, RUN_OUTCOMES.COMPLETED); // sanity: the happy resolver is valid
  const bad = await runPlatformAcceptance(
    { profilePath: 'p', candidate: { primary: {} }, repoRoot: '/repo', harnessGitSha: 'abc1234' },
    {
      readProfile: () => structuredClone(RUNNER_PROFILE),
      resolveCandidateSource: () =>
        Promise.resolve({ ok: false, reasonCode: 'unknown-kind', message: 'bad' }),
    },
  );
  assert.equal(bad.outcome, RUN_OUTCOMES.INVALID_INVOCATION);
  assert.equal(bad.reasonCode, RUNNER_REASON_CODES.CANDIDATE_INVALID);
});

// ---------------------------------------------------------------------------
// measured-process substrate — RSS tagging + outcome classification
// ---------------------------------------------------------------------------

test('parseProcessTable parses valid rows (KiB→bytes) and drops malformed lines', () => {
  const rows = parseProcessTable('100 1 2048\n bad line \n200 100 1024\n');
  assert.deepEqual(rows, [
    { pid: 100, ppid: 1, rssBytes: 2048 * 1024 },
    { pid: 200, ppid: 100, rssBytes: 1024 * 1024 },
  ]);
  assert.deepEqual(parseProcessTable(''), []);
});

test('sumProcessTreeRss sums a process subtree and tolerates cycles/missing parents', () => {
  const rows = [
    { pid: 1, ppid: 0, rssBytes: 10 },
    { pid: 2, ppid: 1, rssBytes: 20 },
    { pid: 3, ppid: 2, rssBytes: 30 },
    { pid: 4, ppid: 99, rssBytes: 40 }, // unrelated
  ];
  assert.equal(sumProcessTreeRss(rows, 1), 60);
  assert.equal(sumProcessTreeRss(rows, 2), 50);
  assert.equal(sumProcessTreeRss(rows, 12_345), 0);
});

test('classifyMeasuredOutcome maps every terminal shape to its stable reason code', () => {
  const M = MEASURED_PROCESS_REASON_CODES;
  const base = {
    timedOut: false,
    cancelled: false,
    status: 0,
    signal: null,
    cleanup: { residualDescendants: 0 },
    outputTruncated: false,
  };
  assert.equal(classifyMeasuredOutcome({ ...base, timedOut: true }), M.TIMED_OUT);
  assert.equal(classifyMeasuredOutcome({ ...base, cancelled: true }), M.CANCELLED);
  assert.equal(
    classifyMeasuredOutcome({ ...base, status: null, signal: null }),
    M.SPAWN_UNAVAILABLE,
  );
  assert.equal(
    classifyMeasuredOutcome({ ...base, cleanup: { residualDescendants: 2 } }),
    M.CLEANUP_FAILED,
  );
  assert.equal(classifyMeasuredOutcome({ ...base, outputTruncated: true }), M.OUTPUT_OVERFLOW);
  assert.equal(classifyMeasuredOutcome({ ...base, status: 3 }), M.COMMAND_FAILED);
  assert.equal(classifyMeasuredOutcome(base), null);
});

/** A minimal fake child process the measured runner can drive. */
function fakeStream() {
  // The measured runner uses the Node EventEmitter stream API (.on/.off/.destroy).
  // eslint-disable-next-line unicorn/prefer-event-target
  const stream = new EventEmitter();
  stream.destroy = () => {
    /* no real stream to tear down */
  };
  return stream;
}

function fakeChild(pid = 4242) {
  // The measured runner drives child processes via the EventEmitter (.once/.emit) API.
  // eslint-disable-next-line unicorn/prefer-event-target
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.stdin = undefined;
  child.kill = () => {
    /* no real process to signal */
  };
  return child;
}

function measuredDeps({ platform = 'linux', readProcessTable } = {}) {
  return {
    platform,
    bounds: {
      journeyTimeoutMs: 2000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxDiagnosticTailBytes: 1024,
      rssSampleIntervalMs: 1000,
    },
    deps: {
      spawnChild: () => {
        const child = fakeChild();
        setTimeout(() => child.emit('close', 0, null), 15);
        return child;
      },
      readProcessTable,
      captureProcessDescendants: () => Promise.resolve([]),
      killProcess: () => {
        /* no real process to signal */
      },
      killProcessTree: () => Promise.resolve(true),
      parentSignalCoordinator: {
        register: () => () => {
          /* no unregister needed */
        },
      },
      rssSampleTimeoutMs: 500,
    },
  };
}

async function runMeasured(depsOptions) {
  const port = createMeasuredProcessPort(measuredDeps(depsOptions));
  return port.run({ argv: ['/fake/bin', '--version'], cwd: '/tmp' });
}

test('RSS is available when the process table reports a positive tree total', async () => {
  const result = await runMeasured({
    readProcessTable: () => Promise.resolve([{ pid: 4242, ppid: 1, rssBytes: 5 * 1024 * 1024 }]),
  });
  assert.equal(result.rss.status, 'available');
  assert.ok(result.rss.peakBytes >= 5 * 1024 * 1024);
});

test('RSS is unavailable (child-too-short) when the tree total is zero — a peak of zero is never available', async () => {
  const result = await runMeasured({
    readProcessTable: () => Promise.resolve([{ pid: 4242, ppid: 1, rssBytes: 0 }]),
  });
  assert.equal(result.rss.status, 'unavailable');
  assert.equal(result.rss.reasonCode, RSS_REASON_CODES.CHILD_TOO_SHORT);
});

test('RSS is unavailable (process-table-unavailable) when the process-table read rejects', async () => {
  const result = await runMeasured({
    readProcessTable: () => Promise.reject(new Error('ps failed')),
  });
  assert.equal(result.rss.status, 'unavailable');
  assert.equal(result.rss.reasonCode, RSS_REASON_CODES.PROCESS_TABLE_UNAVAILABLE);
});

test('RSS is unavailable (sampler-fault) when the process-table read yields a malformed (non-array) sample', async () => {
  const result = await runMeasured({ readProcessTable: () => Promise.resolve('not-a-table') });
  assert.equal(result.rss.status, 'unavailable');
  assert.equal(result.rss.reasonCode, RSS_REASON_CODES.SAMPLER_FAULT);
});

test('RSS is unavailable (unsupported-platform) on Windows', async () => {
  const result = await runMeasured({
    platform: 'win32',
    readProcessTable: () => Promise.resolve([]),
  });
  assert.equal(result.rss.status, 'unavailable');
  assert.equal(result.rss.reasonCode, RSS_REASON_CODES.UNSUPPORTED_PLATFORM);
});
