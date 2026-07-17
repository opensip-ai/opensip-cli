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
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  classifyMeasuredOutcome,
  createChildProcessTerminator,
  createMeasuredProcessPort,
  MEASURED_PROCESS_REASON_CODES,
  parseProcessTable,
  RSS_REASON_CODES,
  signalCapturedProcesses,
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
    {
      id: 'resilience.symlink-root',
      required: false,
      capabilities: ['symlink'],
    },
    { id: 'lifecycle.cli-state-uninstall', required: true },
    { id: 'lifecycle.package-uninstall', required: true },
  ],
};
const PROFILE_IDS = RUNNER_PROFILE.journeys.map((j) => j.id);

function fakeClock() {
  let t = 0;
  return {
    now: () => (t += 1),
    wallIso: () => '2026-07-15T00:00:00.000Z',
    wallOrigin: () => 0,
  };
}

function fakeFs(binExists = () => true) {
  let nextInode = 2;
  const directories = new Map([['/fake/runroot', 1]]);
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const addDirectory = (path) => {
    directories.set(path, nextInode);
    nextInode += 1;
  };
  return {
    mkdtempSync: () => '/fake/runroot',
    mkdirSync: (path, options = {}) => {
      if (directories.has(path)) {
        if (options.recursive === true) return;
        throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
      }
      if (options.recursive === true) {
        const pending = [];
        for (let cursor = path; !directories.has(cursor); cursor = dirname(cursor)) {
          if (dirname(cursor) === cursor) throw missing(path);
          pending.push(cursor);
        }
        for (const entry of pending.toReversed()) addDirectory(entry);
        return;
      }
      if (!directories.has(dirname(path))) throw missing(dirname(path));
      addDirectory(path);
    },
    existsSync: (p) => {
      return p === BIN_PATH ? binExists() : directories.has(p);
    },
    lstatSync: (p) => {
      const ino = directories.get(p);
      if (ino === undefined) throw missing(p);
      return {
        dev: 1,
        ino,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
    realpathSync: (p) => {
      if (!directories.has(p)) throw missing(p);
      return p;
    },
    rmSync: (p) => {
      for (const entry of directories.keys()) {
        if (entry === p || entry.startsWith(`${p}/`)) directories.delete(entry);
      }
    },
  };
}

function fakeHost({ symlink = false, processTreeRss = true, processTreeCleanup = true } = {}) {
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
    capabilities: {
      pty: true,
      symlink,
      permissions: true,
      'process-tree-rss': processTreeRss,
      'process-tree-cleanup': processTreeCleanup,
    },
  };
}

function fakeLifecycle(options = {}) {
  let state = 'empty';
  const installed = {
    mode: 'packed-release',
    installedBin: { kind: 'installed-bin', bin: BIN_PATH },
    jsEntrypoint: {
      kind: 'node-script',
      script: '/fake/runroot/pkg/dist/index.js',
    },
    resolvedVersion: '9.9.9',
  };
  const event = (type, transition) => {
    if (transition) state = transition;
    return {
      type,
      ok: true,
      state,
      reasonCode: null,
      diagnostics: [],
      facts: {},
    };
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
    ...(typeof options.verifyInstalledIntegrity === 'function'
      ? { verifyInstalledIntegrity: options.verifyInstalledIntegrity }
      : {}),
    cleanup:
      options.cleanup ??
      (() => ({
        status: 'clean',
        reasonCode: null,
        removedRoots: 1,
        residualDescendants: 0,
      })),
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
    fs: overrides.fs ?? fakeFs(overrides.binExists),
    collectHostProfile: () => fakeHost(overrides.host),
    resolveCandidateSource:
      overrides.resolveCandidateSource ??
      (() =>
        Promise.resolve({
          ok: true,
          identity: {
            kind: 'packed-release',
            version: '0.7.0',
            source: 'packed@0.7.0',
            digest: 'a'.repeat(64),
          },
        })),
    createLifecycle: overrides.createLifecycle ?? (() => fakeLifecycle(overrides.lifecycle ?? {})),
    createProcessPort: () => port,
    createMcpConnector: () => ({}),
    writeAgentReport: overrides.writeAgentReport,
    packFixtures: () => ({
      toolPluginTarball: '/fx/t.tgz',
      fitPackTarball: '/fx/f.tgz',
      simPackTarball: '/fx/s.tgz',
    }),
    readProfile: () => structuredClone(overrides.profile ?? RUNNER_PROFILE),
    readRegistryInventory: overrides.readRegistryInventory,
    resolveRegistryInventory: overrides.resolveRegistryInventory,
    journeyRegistry: overrides.journeyRegistry, // undefined ⇒ runner falls back to JOURNEY_REGISTRY
    platform: overrides.platform ?? 'linux',
  };
  const options = {
    profilePath: 'profile.json',
    candidate: overrides.candidate ?? {
      primary: {
        kind: 'packed-release',
        directory: '/x',
        expectedVersion: '0.7.0',
      },
    },
    repoRoot: '/repo',
    harnessGitSha: 'abc1234',
    ...(overrides.agentReportOutPath ? { agentReportOutPath: overrides.agentReportOutPath } : {}),
    ...(overrides.registryInventoryPath
      ? { registryInventoryPath: overrides.registryInventoryPath }
      : {}),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
  return runPlatformAcceptance(options, deps);
}

function byId(result) {
  return new Map(result.evidence.results.map((r) => [r.id, r]));
}

function runFilesystemJourneys(journeys) {
  const profile = {
    ...RUNNER_PROFILE,
    journeys: journeys.map((journey) => ({ id: journey.id, required: true })),
  };
  return runPlatformAcceptance(
    {
      profilePath: 'profile.json',
      candidate: {
        primary: {
          kind: 'packed-release',
          directory: '/x',
          expectedVersion: '0.7.0',
        },
      },
      repoRoot: '/repo',
      harnessGitSha: 'abc1234',
    },
    {
      clock: fakeClock(),
      collectHostProfile: () => fakeHost(),
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
      createLifecycle: () => fakeLifecycle(),
      createProcessPort: () => fakePort(),
      createMcpConnector: () => ({}),
      packFixtures: () => null,
      readProfile: () => structuredClone(profile),
      journeyRegistry: new Map(journeys.map((journey) => [journey.id, journey])),
      platform: 'linux',
    },
  );
}

// ---------------------------------------------------------------------------
// Happy path — order, one-result-per-id, capability gating, stages, RSS
// ---------------------------------------------------------------------------

test('runs journeys in profile order, one result per id, and passes with an optional gated journey', async () => {
  let integrityCalls = 0;
  const result = await runWith({
    port: fakePort({ rss: { status: 'available', peakBytes: 12_345 } }),
    lifecycle: {
      verifyInstalledIntegrity: () => {
        integrityCalls += 1;
        return { ok: true, reasonCode: null };
      },
    },
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
  assert.equal(integrityCalls, 4, 'one preflight per executable post-install journey');
  assert.deepEqual(result.evidence.lifecycle.integrityChecks, {
    count: 4,
    durationMs: 4,
  });

  // Every progress stage is in the closed vocabulary.
  for (const event of result.progress) assert.ok(STAGE_VALUES.has(event.stage), event.stage);
});

test('lifecycle journey RSS aggregates the maximum child step instead of only the final child', async () => {
  const result = await runWith({
    createLifecycle: () => {
      const lifecycle = fakeLifecycle();
      lifecycle.removeCliState = () => ({
        type: 'cli-state-removed',
        ok: true,
        state: 'cli-state-removed',
        reasonCode: null,
        diagnostics: [],
        facts: { runtimeRemoved: true },
        // Reproduce the real ordering: the final command used less memory than
        // an earlier project-session command retained in the step evidence.
        rss: { status: 'available', peakBytes: 100 },
        steps: [
          {
            ...portResult(),
            label: 'project-session-seed',
            rss: { status: 'available', peakBytes: 200 },
          },
          {
            ...portResult(),
            label: 'cli-state-remove',
            rss: { status: 'available', peakBytes: 100 },
          },
        ],
      });
      return lifecycle;
    },
  });

  const removed = byId(result).get('lifecycle.cli-state-uninstall');
  assert.equal(removed.status, 'pass');
  assert.deepEqual(removed.rss, { status: 'available', peakBytes: 200 });
  assert.equal(Math.max(...removed.steps.map((step) => step.rss.peakBytes)), 200);
});

test('a missing profile-level native capability gates every journey before lifecycle effects', async () => {
  const profile = structuredClone(RUNNER_PROFILE);
  profile.requiredCapabilities = ['process-tree-cleanup'];
  const result = await runWith({
    profile,
    host: { processTreeCleanup: false },
  });

  assert.equal(result.outcome, RUN_OUTCOMES.COMPLETED);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.evidence.lifecycle.installedVersion, null);
  for (const row of result.evidence.results) {
    assert.equal(row.status, 'unavailable', row.id);
    assert.equal(row.reasonCode, 'capability-process-tree-cleanup-unavailable', row.id);
  }
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

test('upgrades from the distinct previous version before every ordinary and macOS journey', async () => {
  const previousVersion = '1.2.3';
  const primaryVersion = '2.0.0';
  const events = [];

  const lifecycleRow = (id) =>
    defineJourney({
      id,
      category: 'lifecycle',
      value: { human: `${id} runs`, agent: `${id} is evidenced` },
      steps: [{ label: id }],
      lifecycleDriven: true,
      executor: () =>
        Promise.resolve({
          status: 'unavailable',
          reasonCode: 'lifecycle-runner-required',
          diagnostics: [],
        }),
    });
  const observedVersionJourney = (id, category) =>
    defineJourney({
      id,
      category,
      value: {
        human: `${id} sees the target`,
        agent: `${id} observes primary bytes`,
      },
      steps: [{ label: `observe ${id} installed version` }],
      executor: (context) => {
        events.push(`${id}:${context.installed.resolvedVersion}`);
        const matches = context.installed.resolvedVersion === primaryVersion;
        return Promise.resolve({
          status: matches ? 'pass' : 'fail',
          reasonCode: matches ? null : 'wrong-installed-version',
          diagnostics: [],
        });
      },
    });

  const rows = [
    lifecycleRow('lifecycle.install'),
    lifecycleRow('lifecycle.upgrade'),
    observedVersionJourney('analysis.primary-probe', 'analysis'),
    observedVersionJourney('macos.primary-probe', 'macos'),
    lifecycleRow('lifecycle.cli-state-uninstall'),
    lifecycleRow('lifecycle.package-uninstall'),
  ];
  const profile = {
    ...structuredClone(RUNNER_PROFILE),
    id: 'upgrade-before-customer-journeys',
    journeys: rows.map((row) => ({ id: row.id, required: true })),
  };

  let installedVersion = null;
  const installed = () => ({
    mode: 'packed-release',
    installChannel: 'packed-consumer',
    installedBin: { kind: 'installed-bin', bin: BIN_PATH },
    jsEntrypoint: {
      kind: 'node-script',
      script: '/fake/runroot/pkg/dist/index.js',
    },
    resolvedVersion: installedVersion,
  });
  const lifecycleEvent = (type, state, facts = {}) => ({
    type,
    ok: true,
    state,
    reasonCode: null,
    diagnostics: [],
    facts,
  });

  const result = await runWith({
    profile,
    journeyRegistry: new Map(rows.map((row) => [row.id, row])),
    candidate: {
      previous: {
        kind: 'packed-release',
        directory: '/previous',
        expectedVersion: previousVersion,
      },
      primary: {
        kind: 'packed-release',
        directory: '/primary',
        expectedVersion: primaryVersion,
      },
    },
    resolveCandidateSource: (source) =>
      Promise.resolve({
        ok: true,
        identity: {
          kind: 'packed-release',
          version: source.expectedVersion,
          source: `packed@${source.expectedVersion}`,
          digest: source.expectedVersion === primaryVersion ? 'b'.repeat(64) : 'a'.repeat(64),
        },
        install: { kind: 'packed-release', version: source.expectedVersion },
      }),
    createLifecycle: () => ({
      get installed() {
        return installed();
      },
      childEnv: () => ({}),
      install: (resolved) => {
        installedVersion = resolved.identity.version;
        events.push(`install:${installedVersion}`);
        return lifecycleEvent('install', 'installed', {
          resolvedVersion: installedVersion,
          installChannel: 'packed-consumer',
        });
      },
      createRepresentativeState: () => {
        events.push(`representative:${installedVersion}`);
        return lifecycleEvent('representative-state', 'installed', {
          configCreated: true,
          runtimeSeeded: true,
        });
      },
      upgrade: (resolved) => {
        const previousInstalledVersion = installedVersion;
        installedVersion = resolved.identity.version;
        events.push(`upgrade:${installedVersion}`);
        return lifecycleEvent('upgrade', 'upgraded', {
          previousVersion: previousInstalledVersion,
          newVersion: installedVersion,
          versionMigrated: previousInstalledVersion !== installedVersion,
          stateMigrated: true,
          installChannel: 'packed-consumer',
        });
      },
      removeCliState: () => {
        events.push(`cli-state-remove:${installedVersion}`);
        return lifecycleEvent('cli-state-removed', 'cli-state-removed', {
          runtimeRemoved: true,
          configPreserved: true,
          packageIntact: true,
        });
      },
      removePackage: () => {
        events.push(`package-remove:${installedVersion}`);
        return lifecycleEvent('package-removed', 'package-removed', {
          shimAbsent: true,
          entrypointAbsent: true,
          ambientInvocations: 0,
        });
      },
      cleanup: () => ({
        status: 'clean',
        reasonCode: null,
        removedRoots: 1,
        residualDescendants: 0,
      }),
    }),
  });

  assert.equal(result.outcome, RUN_OUTCOMES.COMPLETED);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.evidence.previousCandidate.version, previousVersion);
  assert.equal(result.evidence.candidate.version, primaryVersion);
  assert.deepEqual(result.evidence.lifecycle, {
    installedVersion: previousVersion,
    upgradedVersion: primaryVersion,
    versionMigrated: true,
    stateMigrated: true,
    cliStateRemoved: true,
    packageRemoved: true,
    targetInstallChannel: 'packed-consumer',
    integrityChecks: {
      count: 5,
      durationMs: 5,
    },
  });
  assert.deepEqual(result.evidence.registryBindings, {
    candidateLifecycle: null,
    canonicalInstaller: null,
  });
  assert.deepEqual(events, [
    `install:${previousVersion}`,
    `representative:${previousVersion}`,
    `upgrade:${primaryVersion}`,
    `analysis.primary-probe:${primaryVersion}`,
    `macos.primary-probe:${primaryVersion}`,
    `cli-state-remove:${primaryVersion}`,
    `package-remove:${primaryVersion}`,
  ]);
  for (const id of ['analysis.primary-probe', 'macos.primary-probe']) {
    assert.equal(byId(result).get(id).status, 'pass');
  }
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

test('an expected exit 1 cannot turn a signal-terminated command into a pass', async () => {
  // eslint-disable-next-line sonarjs/no-identical-functions -- lifecycle rows intentionally share the runner-owned fallback contract
  const lifecycleRow = (id) =>
    defineJourney({
      id,
      category: 'lifecycle',
      value: { human: `${id} runs`, agent: `${id} is evidenced` },
      steps: [{ label: id }],
      lifecycleDriven: true,
      executor: () =>
        Promise.resolve({
          status: 'unavailable',
          reasonCode: 'lifecycle-runner-required',
          diagnostics: [],
        }),
    });
  const probe = defineJourney({
    id: 'analysis.exit-one-probe',
    category: 'analysis',
    value: {
      human: 'A finding exit is distinct from a crash',
      agent: 'Signals never masquerade as exit code 1',
    },
    steps: [{ label: 'run a command expected to find issues' }],
    executor: async (context) => {
      const measured = await context.process.run({
        argv: [process.execPath, 'probe.js'],
      });
      const failures = context.assert.check(measured, { exitCode: 1 });
      return failures.length === 0
        ? { status: 'pass', diagnostics: [] }
        : {
            status: 'fail',
            reasonCode: 'abnormal-terminal-accepted',
            diagnostics: failures.map((failure) => context.assert.diagnostic(failure)),
          };
    },
  });
  const rows = [
    lifecycleRow('lifecycle.install'),
    probe,
    lifecycleRow('lifecycle.cli-state-uninstall'),
    lifecycleRow('lifecycle.package-uninstall'),
  ];
  const profile = {
    ...structuredClone(RUNNER_PROFILE),
    id: 'signal-is-not-exit-one',
    journeys: rows.map((row) => ({ id: row.id, required: true })),
  };
  const result = await runWith({
    profile,
    journeyRegistry: new Map(rows.map((row) => [row.id, row])),
    port: fakePort({
      scriptByArgv: () =>
        portResult({
          status: null,
          signal: 'SIGSEGV',
          stdoutCapture: '{"kind":"signal"}\n',
        }),
    }),
  });

  const row = byId(result).get(probe.id);
  assert.equal(row.status, 'fail');
  assert.match(row.diagnostics.join(' '), /terminated by SIGSEGV/u);
});

test('a measured child cannot pass without explicit descendant-cleanup evidence', async () => {
  const result = await runWith({
    port: fakePort({
      scriptByArgv: () => portResult({ cleanup: undefined }),
    }),
  });

  assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
  assert.equal(result.verdict, 'infrastructure-fault');
  assert.equal(result.reasonCode, 'cleanup-integrity-failed');
  const firstMeasured = result.evidence.results
    .flatMap((entry) => entry.steps)
    .find((step) => step.stage === 'process');
  assert.equal(firstMeasured?.reasonCode, 'cleanup-failed');
  assert.equal(firstMeasured?.residualDescendants, 1);
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

test('candidate mutation after a journey stops every remaining customer run', async () => {
  let intact = true;
  const port = fakePort({
    scriptByArgv: (args) => {
      if (args.includes('--version')) intact = false;
      return portResult();
    },
  });
  const result = await runWith({
    port,
    lifecycle: {
      verifyInstalledIntegrity: () => ({
        ok: intact,
        reasonCode: intact ? null : 'installed-candidate-changed',
      }),
    },
  });
  const results = byId(result);
  assert.equal(results.get('lifecycle.install').status, 'pass');
  assert.equal(results.get('lifecycle.version').status, 'pass');
  for (const id of [
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
  assert.deepEqual(result.evidence.lifecycle.integrityChecks, {
    count: 2,
    durationMs: 2,
  });
});

test('the package-removal preflight is the terminal integrity check after CLI-state removal', async () => {
  let intact = true;
  const result = await runWith({
    createLifecycle: () => {
      const lifecycle = fakeLifecycle({
        verifyInstalledIntegrity: () => ({
          ok: intact,
          reasonCode: intact ? null : 'installed-candidate-changed',
        }),
      });
      return {
        ...lifecycle,
        removeCliState: () => {
          const event = lifecycle.removeCliState();
          intact = false;
          return event;
        },
      };
    },
  });
  const results = byId(result);
  assert.equal(results.get('lifecycle.cli-state-uninstall').status, 'pass');
  assert.equal(results.get('lifecycle.package-uninstall').status, 'unavailable');
  assert.equal(
    results.get('lifecycle.package-uninstall').reasonCode,
    RUNNER_REASON_CODES.CANDIDATE_LOST,
  );
  assert.equal(result.reasonCode, RUNNER_REASON_CODES.CANDIDATE_LOST);
  assert.deepEqual(result.evidence.lifecycle.integrityChecks, {
    count: 4,
    durationMs: 4,
  });
});

test('a short profile performs a final integrity check after its last candidate journey', async () => {
  const profile = structuredClone(RUNNER_PROFILE);
  profile.id = 'runner-terminal-integrity';
  profile.journeys = profile.journeys.slice(0, 2);
  let intact = true;
  let integrityCalls = 0;
  const result = await runWith({
    profile,
    port: fakePort({
      scriptByArgv: (args) => {
        if (args.includes('--version')) intact = false;
        return portResult();
      },
    }),
    lifecycle: {
      verifyInstalledIntegrity: () => {
        integrityCalls += 1;
        return {
          ok: intact,
          reasonCode: intact ? null : 'installed-candidate-changed',
        };
      },
    },
  });

  assert.equal(byId(result).get('lifecycle.version').status, 'pass');
  assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
  assert.equal(result.reasonCode, RUNNER_REASON_CODES.CANDIDATE_LOST);
  assert.equal(integrityCalls, 2, 'one preflight plus one terminal observation');
  assert.deepEqual(result.evidence.lifecycle.integrityChecks, {
    count: 2,
    durationMs: 2,
  });
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
  // Exhausting the evidence budget makes the run untrustworthy, so it is an
  // infrastructure fault rather than an ordinary candidate failure.
  assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
  assert.equal(result.reasonCode, RUNNER_REASON_CODES.EVIDENCE_BOUND_EXHAUSTED);
  assert.equal(result.verdict, 'infrastructure-fault');
});

test('a cleanup-integrity failure is reported as an infrastructure fault', async () => {
  const result = await runWith({
    lifecycle: {
      cleanup: () => {
        throw new Error('cleanup exploded');
      },
    },
  });
  assert.equal(result.evidence.cleanup.status, 'incomplete');
  assert.equal(result.evidence.cleanup.reasonCode, RUNNER_REASON_CODES.CLEANUP_INTEGRITY_FAILED);
  assert.equal(result.verdict, 'infrastructure-fault');
  assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
});

test(
  'cleanup rejects a renamed run root replaced by a symlink without deleting the target',
  { skip: process.platform === 'win32' },
  async () => {
    let outside;
    let originalRoot;
    let substitutedRoot;
    const journey = defineJourney({
      id: 'resilience.root-substitution-probe',
      category: 'resilience',
      value: {
        human: 'root substitution probe',
        agent: 'root substitution probe',
      },
      isolated: true,
      steps: [{ label: 'replace the runner root' }],
      executor: (context) => {
        substitutedRoot = dirname(dirname(context.paths.workRoot));
        originalRoot = `${substitutedRoot}-original`;
        outside = mkdtempSync(join(tmpdir(), 'opensip-cleanup-outside-'));
        mkdirSync(join(outside, 'journeys'), { recursive: true });
        writeFileSync(join(outside, 'journeys', 'must-survive.txt'), 'outside');
        renameSync(substitutedRoot, originalRoot);
        symlinkSync(outside, substitutedRoot, 'dir');
        return { status: 'pass', diagnostics: [] };
      },
    });
    const profile = {
      ...RUNNER_PROFILE,
      journeys: [{ id: journey.id, required: true }],
    };

    try {
      const result = await runPlatformAcceptance(
        {
          profilePath: 'profile.json',
          candidate: {
            primary: {
              kind: 'packed-release',
              directory: '/x',
              expectedVersion: '0.7.0',
            },
          },
          repoRoot: '/repo',
          harnessGitSha: 'abc1234',
        },
        {
          clock: fakeClock(),
          collectHostProfile: () => fakeHost(),
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
          createLifecycle: () => fakeLifecycle(),
          createProcessPort: () => fakePort(),
          createMcpConnector: () => ({}),
          packFixtures: () => null,
          readProfile: () => structuredClone(profile),
          journeyRegistry: new Map([[journey.id, journey]]),
          platform: 'linux',
        },
      );

      assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
      assert.equal(result.evidence.cleanup.reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
      assert.equal(existsSync(join(outside, 'journeys', 'must-survive.txt')), true);
    } finally {
      if (substitutedRoot) rmSync(substitutedRoot, { force: true });
      if (originalRoot) rmSync(originalRoot, { recursive: true, force: true });
      if (outside) rmSync(outside, { recursive: true, force: true });
    }
  },
);

test(
  'a shared work-root substitution is rejected before the next journey executes',
  { skip: process.platform === 'win32' },
  async () => {
    let outside;
    let sharedRoot;
    let secondExecuted = false;
    const first = defineJourney({
      id: 'resilience.shared-root-substitute',
      category: 'resilience',
      value: {
        human: 'substitute shared root',
        agent: 'substitute shared root',
      },
      steps: [{ label: 'replace the shared root' }],
      executor: (context) => {
        sharedRoot = context.paths.workRoot;
        const original = `${sharedRoot}-original`;
        outside = mkdtempSync(join(tmpdir(), 'opensip-shared-root-outside-'));
        writeFileSync(join(outside, 'must-survive.txt'), 'outside');
        renameSync(sharedRoot, original);
        symlinkSync(outside, sharedRoot, 'dir');
        return { status: 'pass', diagnostics: [] };
      },
    });
    const second = defineJourney({
      id: 'resilience.shared-root-consumer',
      category: 'resilience',
      value: { human: 'consume shared root', agent: 'consume shared root' },
      steps: [{ label: 'must not execute' }],
      executor: () => {
        secondExecuted = true;
        return { status: 'pass', diagnostics: [] };
      },
    });
    const profile = {
      ...RUNNER_PROFILE,
      journeys: [
        { id: first.id, required: true },
        { id: second.id, required: true },
      ],
    };

    try {
      const result = await runPlatformAcceptance(
        {
          profilePath: 'profile.json',
          candidate: {
            primary: {
              kind: 'packed-release',
              directory: '/x',
              expectedVersion: '0.7.0',
            },
          },
          repoRoot: '/repo',
          harnessGitSha: 'abc1234',
        },
        {
          clock: fakeClock(),
          collectHostProfile: () => fakeHost(),
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
          createLifecycle: () => fakeLifecycle(),
          createProcessPort: () => fakePort(),
          createMcpConnector: () => ({}),
          packFixtures: () => null,
          readProfile: () => structuredClone(profile),
          journeyRegistry: new Map([
            [first.id, first],
            [second.id, second],
          ]),
          platform: 'linux',
        },
      );

      assert.equal(secondExecuted, false);
      assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
      assert.equal(result.reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
      assert.equal(byId(result).get(second.id).reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
      assert.equal(existsSync(join(outside, 'must-survive.txt')), true);
    } finally {
      if (outside) rmSync(outside, { recursive: true, force: true });
      if (sharedRoot && existsSync(sharedRoot)) rmSync(sharedRoot, { force: true });
    }
  },
);

test(
  'work-root creation rejects a substituted journeys ancestor before creating an outside leaf',
  { skip: process.platform === 'win32' },
  async () => {
    let outside;
    let journeysRoot;
    let secondExecuted = false;
    const secondId = 'resilience.outside-leaf-consumer';
    const expectedOutsideLeaf = secondId.replace(/[^a-z0-9]+/gi, '-');
    const first = defineJourney({
      id: 'resilience.journeys-ancestor-substitute',
      category: 'resilience',
      value: {
        human: 'substitute journeys ancestor',
        agent: 'substitute journeys ancestor',
      },
      steps: [{ label: 'replace the journeys ancestor' }],
      executor: (context) => {
        journeysRoot = dirname(context.paths.workRoot);
        outside = mkdtempSync(join(tmpdir(), 'opensip-journeys-outside-'));
        renameSync(journeysRoot, `${journeysRoot}-original`);
        symlinkSync(outside, journeysRoot, 'dir');
        return { status: 'pass', diagnostics: [] };
      },
    });
    const second = defineJourney({
      id: secondId,
      category: 'resilience',
      value: { human: 'consume isolated root', agent: 'consume isolated root' },
      isolated: true,
      steps: [{ label: 'must not create the outside leaf' }],
      executor: () => {
        secondExecuted = true;
        return { status: 'pass', diagnostics: [] };
      },
    });
    const profile = {
      ...RUNNER_PROFILE,
      journeys: [
        { id: first.id, required: true },
        { id: second.id, required: true },
      ],
    };

    try {
      const result = await runPlatformAcceptance(
        {
          profilePath: 'profile.json',
          candidate: {
            primary: {
              kind: 'packed-release',
              directory: '/x',
              expectedVersion: '0.7.0',
            },
          },
          repoRoot: '/repo',
          harnessGitSha: 'abc1234',
        },
        {
          clock: fakeClock(),
          collectHostProfile: () => fakeHost(),
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
          createLifecycle: () => fakeLifecycle(),
          createProcessPort: () => fakePort(),
          createMcpConnector: () => ({}),
          packFixtures: () => null,
          readProfile: () => structuredClone(profile),
          journeyRegistry: new Map([
            [first.id, first],
            [second.id, second],
          ]),
          platform: 'linux',
        },
      );

      assert.equal(secondExecuted, false);
      assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
      assert.equal(result.reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
      assert.equal(byId(result).get(second.id).reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
      assert.equal(existsSync(join(outside, expectedOutsideLeaf)), false);
    } finally {
      if (outside) rmSync(outside, { recursive: true, force: true });
      if (journeysRoot && existsSync(journeysRoot)) rmSync(journeysRoot, { force: true });
    }
  },
);

test(
  'a concrete shared work-root replacement is rejected before the next journey executes',
  { skip: process.platform === 'win32' },
  async () => {
    let secondExecuted = false;
    const first = defineJourney({
      id: 'resilience.shared-root-concrete-replacement',
      category: 'resilience',
      value: { human: 'replace shared root', agent: 'replace shared root' },
      steps: [{ label: 'replace the shared root with a new directory' }],
      executor: (context) => {
        renameSync(context.paths.workRoot, `${context.paths.workRoot}-original`);
        mkdirSync(context.paths.workRoot);
        return { status: 'pass', diagnostics: [] };
      },
    });
    const second = defineJourney({
      id: 'resilience.shared-root-after-concrete-replacement',
      category: 'resilience',
      value: { human: 'reuse shared root', agent: 'reuse shared root' },
      steps: [{ label: 'must not execute' }],
      executor: () => {
        secondExecuted = true;
        return { status: 'pass', diagnostics: [] };
      },
    });
    const profile = {
      ...RUNNER_PROFILE,
      journeys: [
        { id: first.id, required: true },
        { id: second.id, required: true },
      ],
    };

    const result = await runPlatformAcceptance(
      {
        profilePath: 'profile.json',
        candidate: {
          primary: {
            kind: 'packed-release',
            directory: '/x',
            expectedVersion: '0.7.0',
          },
        },
        repoRoot: '/repo',
        harnessGitSha: 'abc1234',
      },
      {
        clock: fakeClock(),
        collectHostProfile: () => fakeHost(),
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
        createLifecycle: () => fakeLifecycle(),
        createProcessPort: () => fakePort(),
        createMcpConnector: () => ({}),
        packFixtures: () => null,
        readProfile: () => structuredClone(profile),
        journeyRegistry: new Map([
          [first.id, first],
          [second.id, second],
        ]),
        platform: 'linux',
      },
    );

    assert.equal(secondExecuted, false);
    assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
    assert.equal(result.reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
    assert.equal(byId(result).get(second.id).reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
  },
);

test('an earlier journey cannot preseed a later isolated work root', async () => {
  let secondExecuted = false;
  const secondId = 'resilience.preseeded-isolated-consumer';
  const secondDirName = secondId.replace(/[^a-z0-9]+/gi, '-');
  const first = defineJourney({
    id: 'resilience.preseed-isolated-root',
    category: 'resilience',
    value: { human: 'preseed isolated root', agent: 'preseed isolated root' },
    steps: [{ label: 'create the later isolated root' }],
    executor: (context) => {
      mkdirSync(join(dirname(context.paths.workRoot), secondDirName));
      return { status: 'pass', diagnostics: [] };
    },
  });
  const second = defineJourney({
    id: secondId,
    category: 'resilience',
    value: { human: 'use isolated root', agent: 'use isolated root' },
    isolated: true,
    steps: [{ label: 'must not execute in the preseeded root' }],
    executor: () => {
      secondExecuted = true;
      return { status: 'pass', diagnostics: [] };
    },
  });

  const result = await runFilesystemJourneys([first, second]);

  assert.equal(secondExecuted, false);
  assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
  assert.equal(result.reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
  assert.equal(byId(result).get(second.id).reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
});

test('an earlier isolated journey cannot preseed the initial shared work root', async () => {
  let secondExecuted = false;
  const first = defineJourney({
    id: 'resilience.preseed-shared-root',
    category: 'resilience',
    value: { human: 'preseed shared root', agent: 'preseed shared root' },
    isolated: true,
    steps: [{ label: 'create the future shared root' }],
    executor: (context) => {
      mkdirSync(join(dirname(context.paths.workRoot), 'shared'));
      return { status: 'pass', diagnostics: [] };
    },
  });
  const second = defineJourney({
    id: 'resilience.preseeded-shared-consumer',
    category: 'resilience',
    value: { human: 'use shared root', agent: 'use shared root' },
    steps: [{ label: 'must not execute in the preseeded shared root' }],
    executor: () => {
      secondExecuted = true;
      return { status: 'pass', diagnostics: [] };
    },
  });

  const result = await runFilesystemJourneys([first, second]);

  assert.equal(secondExecuted, false);
  assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
  assert.equal(result.reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
  assert.equal(byId(result).get(second.id).reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
});

test(
  'a concrete journeys-root replacement is rejected before another isolated journey executes',
  { skip: process.platform === 'win32' },
  async () => {
    let secondExecuted = false;
    const first = defineJourney({
      id: 'resilience.replace-journeys-root',
      category: 'resilience',
      value: { human: 'replace journeys root', agent: 'replace journeys root' },
      isolated: true,
      steps: [{ label: 'replace the runner-owned journeys directory' }],
      executor: (context) => {
        const journeysRoot = dirname(context.paths.workRoot);
        renameSync(journeysRoot, `${journeysRoot}-original`);
        mkdirSync(journeysRoot);
        return { status: 'pass', diagnostics: [] };
      },
    });
    const second = defineJourney({
      id: 'resilience.after-journeys-root-replacement',
      category: 'resilience',
      value: {
        human: 'use fresh isolated root',
        agent: 'use fresh isolated root',
      },
      isolated: true,
      steps: [{ label: 'must not execute beneath a substituted ancestor' }],
      executor: () => {
        secondExecuted = true;
        return { status: 'pass', diagnostics: [] };
      },
    });

    const result = await runFilesystemJourneys([first, second]);

    assert.equal(secondExecuted, false);
    assert.equal(result.outcome, RUN_OUTCOMES.INFRASTRUCTURE_FAULT);
    assert.equal(result.reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
    assert.equal(byId(result).get(second.id).reasonCode, RUNNER_REASON_CODES.ROOT_ESCAPE);
  },
);

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
    executor: (context) =>
      Promise.resolve(typeof outcome === 'function' ? outcome(context) : outcome),
  });
  return new Map([[journey.id, journey]]);
}

// A profile that selects ONLY the single required agent journey above.
const AGENT_SMOKE_PROFILE = {
  ...RUNNER_PROFILE,
  journeys: [{ id: 'agent.installed-smoke', required: true }],
};

test('the requested agent artifact uses its one-shot runner seam before cleanup', async () => {
  let writeInput;
  const result = await runWith({
    profile: AGENT_SMOKE_PROFILE,
    agentReportOutPath: '/outside/agent-report.json',
    journeyRegistry: fakeAgentRegistry((context) => {
      assert.ok(context.artifacts);
      context.artifacts.writeInstalledAgentReport({ schemaVersion: 1 });
      return { status: 'pass', diagnostics: [] };
    }),
    writeAgentReport: (input) => {
      writeInput = input;
      return { bytes: 10, digest: 'a'.repeat(64), path: input.outPath };
    },
  });
  assert.equal(byId(result).get('agent.installed-smoke').status, 'pass');
  assert.equal(writeInput.outPath, '/outside/agent-report.json');
  assert.equal(writeInput.runRoot, '/fake/runroot');
  assert.equal(writeInput.maxBytes, AGENT_SMOKE_PROFILE.bounds.maxEvidenceBytes);
});

test('a passing agent executor cannot omit a requested auxiliary report', async () => {
  const result = await runWith({
    profile: AGENT_SMOKE_PROFILE,
    agentReportOutPath: '/outside/agent-report.json',
    journeyRegistry: fakeAgentRegistry({ status: 'pass', diagnostics: [] }),
    writeAgentReport: () => {
      throw new Error('must not be called');
    },
  });
  const row = byId(result).get('agent.installed-smoke');
  assert.equal(row.status, 'fail');
  assert.equal(row.reasonCode, 'installed-smoke-report-not-preserved');
  assert.equal(result.verdict, 'fail');
});

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

test('sealed journey diagnostics redact run roots, workspace paths, homes, and credentials', async () => {
  const result = await runWith({
    profile: AGENT_SMOKE_PROFILE,
    journeyRegistry: fakeAgentRegistry({
      status: 'fail',
      reasonCode: 'diagnostic-probe',
      diagnostics: [
        '/fake/runroot/private /repo/source ' +
          `${process.env.HOME}/.npmrc https://person:basic-user-secret@example.test/x?token=abc123 ` +
          'npm_token=topsecret api_key=plain-api-secret client_secret: plain-client-secret ' +
          // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- deliberate credential-redaction fixture
          'password=plain-password-secret secret="quoted secret value"',
      ],
    }),
  });
  const diagnostic = byId(result).get('agent.installed-smoke').diagnostics.join(' ');
  assert.ok(diagnostic.includes('<path>'));
  for (const secret of [
    '/fake/runroot',
    '/repo/source',
    process.env.HOME,
    'person',
    'basic-user-secret',
    'abc123',
    'topsecret',
    'plain-api-secret',
    'plain-client-secret',
    'plain-password-secret',
    'quoted secret value',
  ]) {
    if (secret) assert.ok(!diagnostic.includes(secret), `diagnostic leaked ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// Invalid invocation paths
// ---------------------------------------------------------------------------

test('an unreadable profile is an invalid invocation (no evidence)', async () => {
  const result = await runPlatformAcceptance(
    {
      profilePath: '',
      candidate: {},
      repoRoot: '/repo',
      harnessGitSha: 'abc1234',
    },
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
    {
      profilePath: 'p',
      candidate: { primary: {} },
      repoRoot: '/repo',
      harnessGitSha: 'abc1234',
    },
    {
      readProfile: () => structuredClone(RUNNER_PROFILE),
      resolveCandidateSource: () =>
        Promise.resolve({
          ok: false,
          reasonCode: 'unknown-kind',
          message: 'bad',
        }),
    },
  );
  assert.equal(bad.outcome, RUN_OUTCOMES.INVALID_INVOCATION);
  assert.equal(bad.reasonCode, RUNNER_REASON_CODES.CANDIDATE_INVALID);
});

test('a published candidate cannot reach install without its exact canonical inventory', async () => {
  const identity = {
    kind: 'published-version',
    version: '0.7.0',
    source: 'npm:opensip-cli@0.7.0',
    digest: 'a'.repeat(64),
    registry: 'https://registry.npmjs.org/',
    manifestDigest: 'b'.repeat(64),
    registryIntegrityDigest: 'c'.repeat(64),
  };
  let lifecycleCreated = false;
  const result = await runWith({
    candidate: {
      primary: {
        kind: 'published-version',
        version: '0.7.0',
        registryIntegrityDigest: 'c'.repeat(64),
      },
    },
    registryInventoryPath: '/inventory.json',
    resolveCandidateSource: () => Promise.resolve({ ok: true, identity, install: {} }),
    readRegistryInventory: () => ({
      ok: false,
      reasonCode: 'registry-inventory-unreadable',
    }),
    createLifecycle: () => {
      lifecycleCreated = true;
      return fakeLifecycle();
    },
  });
  assert.equal(result.outcome, RUN_OUTCOMES.INVALID_INVOCATION);
  assert.equal(result.reasonCode, RUNNER_REASON_CODES.REGISTRY_INVENTORY_INVALID);
  assert.equal(lifecycleCreated, false);

  const mismatch = await runWith({
    candidate: {
      primary: {
        kind: 'published-version',
        version: '0.7.0',
        registryIntegrityDigest: 'c'.repeat(64),
      },
    },
    registryInventoryPath: '/inventory.json',
    resolveCandidateSource: () => Promise.resolve({ ok: true, identity, install: {} }),
    readRegistryInventory: () => ({ ok: true, buffer: Buffer.from('{}') }),
    resolveRegistryInventory: () => {
      throw new TypeError('digest mismatch');
    },
  });
  assert.equal(mismatch.outcome, RUN_OUTCOMES.INVALID_INVOCATION);
  assert.equal(mismatch.reasonCode, RUNNER_REASON_CODES.REGISTRY_INVENTORY_INVALID);
});

test('a published macOS run binds bootstrap and every later journey to one canonical target', async () => {
  const version = '0.7.0';
  const digest = 'a'.repeat(64);
  const inventoryDigest = 'c'.repeat(64);
  const identity = {
    kind: 'published-version',
    version,
    source: `npm:opensip-cli@${version}`,
    digest,
    registry: 'https://registry.npmjs.org/',
    manifestDigest: 'b'.repeat(64),
    registryIntegrityDigest: inventoryDigest,
  };
  const proof = {
    inventoryDigest,
    packageNames: ['opensip-cli'],
    packageCount: 1,
    packageSetDigest: 'd'.repeat(64),
    offlineReplayComplete: true,
  };
  const lifecycleRow = (id) =>
    defineJourney({
      id,
      category: 'lifecycle',
      value: { human: id, agent: id },
      steps: [{ label: id }],
      lifecycleDriven: true,
      executor: async () => ({
        status: 'unavailable',
        reasonCode: 'lifecycle-runner-required',
        diagnostics: [],
      }),
    });
  const macInstallerRow = defineJourney({
    id: 'macos.installer-sh',
    category: 'macos',
    value: { human: 'canonical', agent: 'canonical' },
    steps: [{ label: 'assert canonical descriptor' }],
    executor: async (context) => ({
      status: context.installed.installChannel === 'canonical-installer' ? 'pass' : 'fail',
      reasonCode:
        context.installed.installChannel === 'canonical-installer' ? null : 'wrong-install-channel',
      diagnostics: [],
    }),
  });
  const rows = [
    lifecycleRow('lifecycle.install'),
    lifecycleRow('lifecycle.upgrade'),
    macInstallerRow,
    lifecycleRow('lifecycle.cli-state-uninstall'),
    lifecycleRow('lifecycle.package-uninstall'),
  ];
  const profile = {
    ...structuredClone(RUNNER_PROFILE),
    id: 'published-mac-canonical',
    journeys: rows.map((row) => ({
      id: row.id,
      required: row.id !== 'lifecycle.upgrade',
      ...(row.id === 'macos.installer-sh' ? { candidateKinds: ['published-version'] } : {}),
    })),
  };
  const installed = {
    mode: 'published-version',
    installChannel: 'canonical-installer',
    installedBin: { kind: 'installed-bin', bin: BIN_PATH },
    jsEntrypoint: {
      kind: 'node-script',
      script: '/fake/runroot/pkg/dist/index.js',
    },
    resolvedVersion: version,
  };
  let lifecycleOptions;
  const lifecycleEvent = (type, facts) => ({
    type,
    ok: true,
    state: type,
    reasonCode: null,
    diagnostics: [],
    facts,
  });

  const result = await runWith({
    profile,
    platform: 'darwin',
    journeyRegistry: new Map(rows.map((row) => [row.id, row])),
    candidate: {
      primary: { kind: 'published-version', version },
    },
    registryInventoryPath: '/inventory.json',
    resolveCandidateSource: async () => ({
      ok: true,
      identity,
      install: {
        kind: 'published-version',
        spec: `opensip-cli@${version}`,
        registry: identity.registry,
      },
    }),
    readRegistryInventory: () => ({ ok: true, buffer: Buffer.from('{}') }),
    resolveRegistryInventory: () => ({
      inventory: {
        schemaVersion: 1,
        registry: identity.registry,
        releaseVersion: version,
        manifestDigest: identity.manifestDigest,
        packages: [],
      },
    }),
    createLifecycle: (options) => {
      lifecycleOptions = options;
      return {
        get installed() {
          return installed;
        },
        childEnv: () => ({}),
        install: async () =>
          lifecycleEvent('install', {
            resolvedVersion: version,
            installChannel: 'canonical-installer',
            registryBinding: proof,
          }),
        createRepresentativeState: async () =>
          lifecycleEvent('representative-state', {
            configCreated: true,
            runtimeSeeded: true,
          }),
        upgrade: async () =>
          lifecycleEvent('upgrade', {
            previousVersion: version,
            newVersion: version,
            versionMigrated: false,
            stateMigrated: true,
            installChannel: 'canonical-installer',
            registryBinding: proof,
          }),
        removeCliState: async () => lifecycleEvent('cli-state-removed', { runtimeRemoved: true }),
        removePackage: async () =>
          lifecycleEvent('package-removed', {
            shimAbsent: true,
            entrypointAbsent: true,
          }),
        cleanup: () => ({
          status: 'clean',
          reasonCode: null,
          removedRoots: 1,
          residualDescendants: 0,
        }),
      };
    },
  });

  assert.equal(result.verdict, 'pass', JSON.stringify(result.evidence));
  assert.deepEqual(lifecycleOptions.canonicalInstaller, {
    scriptPath: '/repo/scripts/install.sh',
    shellPath: '/bin/sh',
    targetCandidateDigest: digest,
  });
  assert.equal(result.evidence.lifecycle.targetInstallChannel, 'canonical-installer');
  assert.equal(result.evidence.lifecycle.upgradedVersion, null);
  assert.equal(byId(result).get('lifecycle.upgrade').status, 'skipped');
  assert.equal(byId(result).get('lifecycle.upgrade').reasonCode, 'previous-candidate-not-supplied');
  assert.deepEqual(
    result.evidence.registryBindings.candidateLifecycle,
    result.evidence.registryBindings.canonicalInstaller,
  );
  assert.equal(byId(result).get('macos.installer-sh').status, 'pass');
});

test('the scheduled packed macOS shape skips published-only installer and absent upgrade without effects', async () => {
  const calls = { representative: 0, upgrade: 0, installer: 0 };
  // eslint-disable-next-line sonarjs/no-identical-functions -- mirrors the published/packed lifecycle profile boundary deliberately
  const lifecycleRow = (id) =>
    defineJourney({
      id,
      category: 'lifecycle',
      value: { human: id, agent: id },
      steps: [{ label: id }],
      lifecycleDriven: true,
      executor: async () => ({
        status: 'unavailable',
        reasonCode: 'lifecycle-runner-required',
        diagnostics: [],
      }),
    });
  const installerRow = defineJourney({
    id: 'macos.installer-sh',
    category: 'macos',
    value: { human: 'canonical', agent: 'canonical' },
    steps: [{ label: 'must not execute for packed bytes' }],
    executor: async () => {
      calls.installer += 1;
      return {
        status: 'fail',
        reasonCode: 'unexpected-execution',
        diagnostics: [],
      };
    },
  });
  const rows = [
    lifecycleRow('lifecycle.install'),
    lifecycleRow('lifecycle.upgrade'),
    installerRow,
    lifecycleRow('lifecycle.cli-state-uninstall'),
    lifecycleRow('lifecycle.package-uninstall'),
  ];
  const profile = {
    ...structuredClone(RUNNER_PROFILE),
    id: 'packed-mac-applicability',
    journeys: [
      { id: 'lifecycle.install', required: true },
      { id: 'lifecycle.upgrade', required: false },
      {
        id: 'macos.installer-sh',
        required: true,
        candidateKinds: ['published-version'],
      },
      { id: 'lifecycle.cli-state-uninstall', required: true },
      { id: 'lifecycle.package-uninstall', required: true },
    ],
  };
  const installed = {
    mode: 'packed-release',
    installChannel: 'packed-consumer',
    installedBin: { kind: 'installed-bin', bin: BIN_PATH },
    jsEntrypoint: {
      kind: 'node-script',
      script: '/fake/runroot/pkg/dist/index.js',
    },
    resolvedVersion: '0.7.0',
  };
  let lifecycleOptions;
  // eslint-disable-next-line sonarjs/no-identical-functions -- event shape is the lifecycle seam under test
  const event = (type, facts = {}) => ({
    type,
    ok: true,
    state: type,
    reasonCode: null,
    diagnostics: [],
    facts,
  });
  const result = await runWith({
    profile,
    platform: 'darwin',
    journeyRegistry: new Map(rows.map((row) => [row.id, row])),
    createLifecycle: (options) => {
      lifecycleOptions = options;
      return {
        get installed() {
          return installed;
        },
        childEnv: () => ({}),
        install: async () =>
          event('install', {
            resolvedVersion: '0.7.0',
            installChannel: 'packed-consumer',
          }),
        createRepresentativeState: async () => {
          calls.representative += 1;
          return event('representative-state');
        },
        upgrade: async () => {
          calls.upgrade += 1;
          return event('upgrade');
        },
        removeCliState: async () => event('cli-state-removed', { runtimeRemoved: true }),
        removePackage: async () =>
          event('package-removed', {
            shimAbsent: true,
            entrypointAbsent: true,
          }),
        cleanup: () => ({
          status: 'clean',
          reasonCode: null,
          removedRoots: 1,
          residualDescendants: 0,
        }),
      };
    },
  });

  assert.equal(result.verdict, 'pass', JSON.stringify(result.evidence));
  assert.equal(Object.hasOwn(lifecycleOptions, 'canonicalInstaller'), false);
  assert.deepEqual(calls, { representative: 0, upgrade: 0, installer: 0 });
  const upgrade = byId(result).get('lifecycle.upgrade');
  assert.deepEqual(
    {
      required: upgrade.required,
      status: upgrade.status,
      reasonCode: upgrade.reasonCode,
      durationMs: upgrade.durationMs,
      steps: upgrade.steps,
    },
    {
      required: false,
      status: 'skipped',
      reasonCode: 'previous-candidate-not-supplied',
      durationMs: 0,
      steps: [],
    },
  );
  const installer = byId(result).get('macos.installer-sh');
  assert.equal(installer.required, false);
  assert.equal(installer.status, 'skipped');
  assert.equal(installer.reasonCode, 'candidate-kind-not-applicable');
  assert.equal(installer.durationMs, 0);
  assert.deepEqual(installer.steps, []);
});

// ---------------------------------------------------------------------------
// measured-process substrate — RSS tagging + outcome classification
// ---------------------------------------------------------------------------

test('parseProcessTable keeps relevant rows, skips kernel/malformed rows, rejects unusable tables', () => {
  const rows = parseProcessTable(
    '100 1 100 100 Wed Jul 15 10:00:00 2026 2048 /usr/bin/node\n' +
      '200 100 100 100 Wed Jul 15 10:00:01 2026 1024 /Applications/OpenSIP CLI/node\n',
  );
  assert.deepEqual(rows, [
    {
      pid: 100,
      ppid: 1,
      processGroupId: 100,
      sessionToken: '100',
      startedAt: 'Wed Jul 15 10:00:00 2026',
      command: '/usr/bin/node',
      rssBytes: 2048 * 1024,
    },
    {
      pid: 200,
      ppid: 100,
      processGroupId: 100,
      sessionToken: '100',
      startedAt: 'Wed Jul 15 10:00:01 2026',
      command: '/Applications/OpenSIP CLI/node',
      rssBytes: 1024 * 1024,
    },
  ]);

  // A system-wide `ps -e` snapshot legitimately mixes relevant rows with kernel
  // threads (process-group id 0, e.g. Linux `kthreadd`/`kworker`) and transient
  // half-written lines. Those are SKIPPED, not fatal — the valid rows still
  // parse. Regression guard: throwing on pgid-0 kernel threads is exactly what
  // broke RSS measurement on Linux CI (`maxRssBytes was not measured`).
  const mixed = parseProcessTable(
    '2 0 0 0 Wed Jul 15 09:59:00 2026 0 kthreadd\n' + // kernel thread: pgid 0 -> skipped
      '100 1 100 100 Wed Jul 15 10:00:00 2026 2048 /usr/bin/node\n' + // relevant -> kept
      'bad line\n' + // transient malformed -> skipped
      '200 100 100 100 Wed Jul 15 10:00:01 2026 1024 /usr/bin/node\n', // relevant -> kept
  );
  assert.deepEqual(
    mixed.map((row) => row.pid),
    [100, 200],
  );

  // Inputs that leave NOTHING parseable are a table-level fault — this surfaces a
  // real `ps`-format regression instead of silently measuring an empty tree.
  for (const unusable of [
    'bad line\nno rows\n',
    '-1 0 1 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '1 -1 1 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '0 0 1 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '1 0 0 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '1 0 1 1 Wed Jul 15 10:00:00 2026 -10 /usr/bin/node\n',
    '1.0 0 1 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '1e2 0 1 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '9007199254740992 0 1 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '1 9007199254740992 1 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '1 0 9007199254740992 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n',
    '1 0 1 1 Wed Jul 15 10:00:00 2026 8796093022208 /usr/bin/node\n',
    '1 0 1 1 Wed Jul 15 10:00:00 2026 10\n',
    '1 0 1 10\n',
    '',
  ]) {
    assert.throws(() => parseProcessTable(unusable), /process table/);
  }
  assert.throws(
    () => parseProcessTable(Buffer.from('1 0 1 1 Wed Jul 15 10:00:00 2026 10 /usr/bin/node\n')),
    /must be a string/,
  );
});

test('PTY native signalling targets the wrapper direct-child CLI group, not its worker', async () => {
  const killed = [];
  const processRows = [
    {
      pid: 100,
      ppid: 1,
      processGroupId: 100,
      sessionToken: '100',
      startedAt: 'root',
      command: '/usr/bin/script',
      rssBytes: 1,
    },
    {
      pid: 200,
      ppid: 100,
      processGroupId: 200,
      sessionToken: '200',
      startedAt: 'cli',
      command: '/usr/bin/node',
      rssBytes: 1,
    },
    {
      pid: 300,
      ppid: 200,
      processGroupId: 200,
      sessionToken: '200',
      startedAt: 'worker',
      command: '/usr/bin/node',
      rssBytes: 1,
    },
  ];
  const terminator = createChildProcessTerminator({
    child: { pid: 100, kill: () => true },
    platform: 'darwin',
    useProcessGroup: true,
    readProcessTable: () => Promise.resolve(processRows),
    killProcess: (pid, signal) => killed.push([pid, signal]),
  });
  terminator.observeProcessTable(processRows);
  assert.equal(await terminator.signalHostedChild('SIGINT'), true);
  assert.deepEqual(killed, [[-200, 'SIGINT']]);
});

test('retained descendant identity prevents PID-reuse collateral signals and residuals', async () => {
  const killed = [];
  const initialRows = [
    {
      pid: 100,
      ppid: 1,
      processGroupId: 100,
      sessionToken: '100',
      startedAt: 'same-second',
      command: '/usr/bin/node',
      rssBytes: 1,
    },
    {
      pid: 200,
      ppid: 100,
      processGroupId: 200,
      sessionToken: '100',
      startedAt: 'same-second',
      command: '/owned/node',
      rssBytes: 1,
    },
  ];
  const reusedRows = [
    {
      pid: 100,
      ppid: 1,
      processGroupId: 100,
      sessionToken: '100',
      startedAt: 'same-second',
      command: '/usr/bin/node',
      rssBytes: 1,
    },
    {
      pid: 200,
      ppid: 1,
      processGroupId: 201,
      sessionToken: '201',
      startedAt: 'same-second',
      command: '/unrelated/node',
      rssBytes: 1,
    },
    {
      pid: 300,
      ppid: 200,
      processGroupId: 201,
      sessionToken: '201',
      startedAt: 'same-second',
      command: '/unrelated/node',
      rssBytes: 1,
    },
  ];
  const terminator = createChildProcessTerminator({
    child: { pid: 100, kill: () => true },
    platform: 'darwin',
    useProcessGroup: true,
    readProcessTable: () => Promise.resolve(reusedRows),
    killProcess: (pid, signal) => killed.push([pid, signal]),
  });
  terminator.observeProcessTable(initialRows);
  assert.equal(await terminator.signal('SIGKILL'), true);
  assert.deepEqual(killed, [[-100, 'SIGKILL']]);
  terminator.markRootClosed();
  assert.equal(await terminator.verifyResiduals(), 0);
  terminator.dispose();
});

test('a reused root PID after close is not reported as an owned residual', async () => {
  const originalRoot = {
    pid: 100,
    ppid: 1,
    processGroupId: 100,
    sessionToken: '100',
    startedAt: 'same-second',
    command: '/owned/node',
    rssBytes: 1,
  };
  const reusedRoot = {
    ...originalRoot,
    processGroupId: 101,
    sessionToken: '101',
    command: '/usr/bin/ps',
  };
  const terminator = createChildProcessTerminator({
    child: { pid: originalRoot.pid, kill: () => true },
    platform: 'darwin',
    readProcessTable: () => Promise.resolve([reusedRoot]),
    killProcess: () => {
      assert.fail('a reused root identity must not be signalled');
    },
  });
  terminator.observeProcessTable([originalRoot]);
  terminator.markRootClosed();
  assert.equal(await terminator.verifyResiduals(), 0);
  terminator.dispose();
});

test('retained identity signalling and residual counts require every stable sampled fact', async () => {
  const root = {
    pid: 100,
    ppid: 1,
    processGroupId: 100,
    sessionToken: '100',
    startedAt: 'Wed Jul 15 10:00:00 2026',
    command: '/root/node',
    rssBytes: 1,
  };
  const retained = {
    pid: 200,
    ppid: 100,
    processGroupId: 200,
    sessionToken: '100',
    startedAt: 'Wed Jul 15 10:00:00 2026',
    command: '/owned/node',
    rssBytes: 1,
  };
  const mismatches = [
    { pid: 201 },
    { processGroupId: 201 },
    { sessionToken: '201' },
    { startedAt: 'Wed Jul 15 10:00:01 2026' },
  ];

  for (const mismatch of mismatches) {
    const killed = [];
    const delivered = signalCapturedProcesses([retained], 'SIGKILL', {
      currentRows: [{ ...retained, ...mismatch }],
      killProcess: (pid, signal) => killed.push([pid, signal]),
    });
    assert.equal(delivered, false, JSON.stringify(mismatch));
    assert.deepEqual(killed, [], JSON.stringify(mismatch));

    const terminator = createChildProcessTerminator({
      child: { pid: root.pid, kill: () => true },
      platform: 'darwin',
      readProcessTable: () => Promise.resolve([{ ...retained, ...mismatch }]),
      killProcess: () => {
        assert.fail('a mismatched identity must not be signalled');
      },
    });
    terminator.observeProcessTable([root, retained]);
    terminator.markRootClosed();
    assert.equal(await terminator.verifyResiduals(), 0, JSON.stringify(mismatch));
    terminator.dispose();
  }

  const killed = [];
  assert.equal(
    signalCapturedProcesses([retained], 'SIGKILL', {
      currentRows: [{ ...retained, command: '/owned/npm install', ppid: 1, rssBytes: 2 }],
      killProcess: (pid, signal) => killed.push([pid, signal]),
    }),
    true,
  );
  assert.deepEqual(killed, [[-200, 'SIGKILL']]);

  const terminator = createChildProcessTerminator({
    child: { pid: root.pid, kill: () => true },
    platform: 'darwin',
    readProcessTable: () =>
      Promise.resolve([{ ...retained, command: '/owned/npm install', ppid: 1, rssBytes: 2 }]),
    killProcess: () => true,
  });
  terminator.observeProcessTable([root, retained]);
  terminator.markRootClosed();
  assert.equal(await terminator.verifyResiduals(), 1);
  terminator.dispose();
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
    readProcessTable: () =>
      Promise.resolve([
        {
          pid: 4242,
          ppid: 1,
          processGroupId: 4242,
          sessionToken: '4242',
          startedAt: 'root',
          command: '/fake/bin',
          rssBytes: 5 * 1024 * 1024,
        },
      ]),
  });
  assert.equal(result.rss.status, 'available');
  assert.ok(result.rss.peakBytes >= 5 * 1024 * 1024);
});

test('RSS is unavailable (child-too-short) when the tree total is zero — a peak of zero is never available', async () => {
  const result = await runMeasured({
    readProcessTable: () =>
      Promise.resolve([
        {
          pid: 4242,
          ppid: 1,
          processGroupId: 4242,
          sessionToken: '4242',
          startedAt: 'root',
          command: '/fake/bin',
          rssBytes: 0,
        },
      ]),
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
  assert.equal(result.cleanup.residualDescendants, 1);
  assert.equal(classifyMeasuredOutcome(result), MEASURED_PROCESS_REASON_CODES.CLEANUP_FAILED);
});

test('RSS is unavailable (sampler-fault) when the process-table read yields a malformed (non-array) sample', async () => {
  const result = await runMeasured({
    readProcessTable: () => Promise.resolve('not-a-table'),
  });
  assert.equal(result.rss.status, 'unavailable');
  assert.equal(result.rss.reasonCode, RSS_REASON_CODES.SAMPLER_FAULT);
  assert.equal(result.cleanup.residualDescendants, 1);
});

test('RSS is unavailable (unsupported-platform) on Windows', async () => {
  const result = await runMeasured({
    platform: 'win32',
    readProcessTable: () => Promise.resolve([]),
  });
  assert.equal(result.rss.status, 'unavailable');
  assert.equal(result.rss.reasonCode, RSS_REASON_CODES.UNSUPPORTED_PLATFORM);
});
