/**
 * @fileoverview Phase 1 coverage — the macOS-specific journeys.
 *
 * The registry union / profile-composition checks live in the sibling
 * `journey-catalog.test.mjs`; this file covers the macOS module directly: its
 * registered rows (category/capabilities), the PURE tuple-crosscheck logic
 * against the REAL core support policy (host-independent), and the executor
 * fail-closed contract on a non-darwin host (an `unavailable('non-darwin-host')`
 * that never throws and never false-passes, keeping `pnpm test:scripts` green on
 * any host). Runs under `node --test` (`pnpm test:scripts`).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { boundedDiagnostic, checkScenario, expectEnvelope } from '../cli-acceptance-core.mjs';
import { getJourney, MACOS_JOURNEY_IDS } from '../platform-acceptance/journey-catalog.mjs';
import { KNOWN_CAPABILITIES } from '../platform-acceptance/journey-kit.mjs';
import {
  buildTupleObservedHost,
  evaluateBrowserCommandResult,
  evaluateInterruptedRecoveryResult,
  evaluateNativeSignalResult,
  evaluateNativeSqliteProvenance,
  evaluatePermissionFailure,
  evaluatePtyFindingResult,
  evaluateTupleCrosscheck,
  MACOS_PREVIEW_ROW_ID,
  normalizeUnameArch,
  parseDfDevice,
} from '../platform-acceptance/journeys/macos.mjs';
import { assessHostSupport } from '../../packages/core/dist/index-lib.js';

const roots = [];
function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), 'pa-macos-'));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Mirror the runner's assert helpers so executors run exactly as in production. */
function makeAssert(maxDiagnosticTailBytes = 4096) {
  const toAssertable = (result) => ({
    stdout: result.stdoutCapture ?? '',
    stderr: result.stderrTail ?? '',
    exitCode: result.status ?? 1,
  });
  return Object.freeze({
    toAssertable,
    check: (result, expect) => checkScenario(toAssertable(result), expect),
    envelope: (opts) => expectEnvelope(opts ?? {}),
    diagnostic: (text) => boundedDiagnostic(text, maxDiagnosticTailBytes),
  });
}

/** A permissive measured-process port — never called on a non-darwin host. */
function permissiveContext() {
  const context = {
    installed: {
      mode: 'packed-release',
      installedBin: { kind: 'installed-bin', bin: '/candidate/bin/opensip' },
      jsEntrypoint: { kind: 'node-script', script: '/candidate/dist/index.js' },
      resolvedVersion: '9.9.9',
    },
    paths: { workRoot: tmpRoot() },
    fixtures: null,
    process: {
      run: () =>
        Promise.resolve({
          status: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          deliveredSignal: null,
          outputTruncated: false,
          durationMs: 1,
          rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
          stdoutTail: '',
          stderrTail: '',
          stdoutCapture: '',
          cleanup: { residualDescendants: 0 },
        }),
    },
    toolchain: {
      node: { argv: [process.execPath] },
      npm: { argv: [process.execPath, '/toolchain/npm/bin/npm-cli.js'] },
    },
    assert: makeAssert(),
  };
  return context;
}

function processResult(overrides = {}) {
  return {
    status: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    deliveredSignal: null,
    outputTruncated: false,
    durationMs: 1,
    rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    stdoutTail: '',
    stderrTail: '',
    stdoutCapture: '',
    cleanup: { residualDescendants: 0 },
    ...overrides,
  };
}

const OK_TUPLE = Object.freeze({
  swVers: '26.0.1',
  kernelName: 'Darwin',
  kernelRelease: '25.5.0',
  unameMachine: 'arm64',
  npmVersion: '11.0.0',
  nodeArch: 'arm64',
  nodeVersion: 'v24.16.0',
  nodeAbi: '137',
});

// ---------------------------------------------------------------------------
// Registry rows
// ---------------------------------------------------------------------------

test('every macOS journey is registered under the macos category with known capabilities', () => {
  assert.equal(MACOS_JOURNEY_IDS.length, 12);
  for (const id of MACOS_JOURNEY_IDS) {
    const journey = getJourney(id);
    assert.equal(journey.category, 'macos', `${id} is not in the macos category`);
    assert.ok(journey.id.startsWith('macos.'), `${id} is not namespaced`);
    assert.equal(typeof journey.executor, 'function');
    assert.ok(journey.steps.length > 0, `${id} has no steps`);
    for (const capability of journey.capabilities) {
      assert.ok(
        KNOWN_CAPABILITIES.has(capability),
        `${id} declares unknown capability ${capability}`,
      );
    }
  }
});

test('installer journey smoke-tests the lifecycle-owned canonical target without reinstalling', async () => {
  if (process.platform !== 'darwin') return;
  const context = permissiveContext();
  context.installed = {
    ...context.installed,
    mode: 'published-version',
    installChannel: 'canonical-installer',
  };
  const invocations = [];
  context.process.run = async (spec) => {
    invocations.push(spec);
    return {
      status: 0,
      timedOut: false,
      stdoutCapture: '9.9.9\n',
      stderrTail: '',
    };
  };

  const outcome = await getJourney('macos.installer-sh').executor(context);

  assert.equal(outcome.status, 'pass', JSON.stringify(outcome));
  assert.deepEqual(
    invocations.map((spec) => spec.argv),
    [[context.installed.installedBin.bin, '--version']],
  );

  context.installed = { ...context.installed, installChannel: 'npm-direct' };
  invocations.length = 0;
  const rejected = await getJourney('macos.installer-sh').executor(context);
  assert.equal(rejected.status, 'fail');
  assert.equal(rejected.reasonCode, 'installer-channel-unproven');
  assert.equal(invocations.length, 0);
});

// ---------------------------------------------------------------------------
// Pure tuple helpers (host-independent — driven by the REAL core policy)
// ---------------------------------------------------------------------------

test('normalizeUnameArch folds machine strings to Node arch tokens', () => {
  assert.equal(normalizeUnameArch('arm64'), 'arm64');
  assert.equal(normalizeUnameArch('aarch64'), 'arm64');
  assert.equal(normalizeUnameArch('x86_64'), 'x64');
  assert.equal(normalizeUnameArch('amd64'), 'x64');
  assert.equal(normalizeUnameArch('i386'), 'ia32');
  assert.equal(normalizeUnameArch('  ARM64 '), 'arm64');
});

test('parseDfDevice extracts only a safe device from POSIX df output', () => {
  assert.equal(
    parseDfDevice(
      'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s1 100 20 80 20% /private/var/folders\n',
    ),
    '/dev/disk3s1',
  );
  assert.equal(parseDfDevice('Filesystem 512-blocks Used Available Capacity Mounted on\n'), null);
  assert.equal(
    parseDfDevice(
      'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s1;touch 100 20 80 20% /\n',
    ),
    null,
  );
  assert.equal(parseDfDevice('map auto_home 0 0 100% /System/Volumes/Data/home\n'), null);
});

test('browser command classification rejects nonzero seed and report exits', () => {
  assert.deepEqual(evaluateBrowserCommandResult({ status: 0, timedOut: false }, 'seed'), {
    ok: true,
    reasonCode: null,
  });
  assert.deepEqual(evaluateBrowserCommandResult({ status: 1, timedOut: false }, 'seed'), {
    ok: false,
    reasonCode: 'browser-open-seed-failed',
  });
  assert.deepEqual(evaluateBrowserCommandResult({ status: 2, timedOut: false }, 'report'), {
    ok: false,
    reasonCode: 'report-open-failed',
  });
});

test('native SQLite provenance requires the loaded addon to remain in the install tree', () => {
  const installed = '/isolated/node_modules/opensip-cli/dist/index.js';
  const valid = {
    queryOk: true,
    installedEntrypoint: installed,
    datastoreEntrypoint: '/isolated/node_modules/@opensip-cli/datastore/dist/index.js',
    sqliteEntrypoint: '/isolated/node_modules/better-sqlite3/lib/index.js',
    nativeAddon: '/isolated/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  };
  assert.deepEqual(evaluateNativeSqliteProvenance(valid), {
    ok: true,
    reasonCode: null,
  });
  assert.deepEqual(evaluateNativeSqliteProvenance({ ...valid, queryOk: false }), {
    ok: false,
    reasonCode: 'native-sqlite-query-failed',
  });
  assert.deepEqual(
    evaluateNativeSqliteProvenance({
      ...valid,
      nativeAddon: '/workspace/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    }),
    { ok: false, reasonCode: 'native-sqlite-outside-install' },
  );
  assert.deepEqual(
    evaluateNativeSqliteProvenance({
      ...valid,
      nativeAddon: valid.sqliteEntrypoint,
    }),
    { ok: false, reasonCode: 'native-sqlite-provenance-invalid' },
  );
});

test('PTY result classification enforces exit, cleanup, NO_COLOR, and JSON shape', () => {
  const envelope = {
    kind: 'fit.run',
    status: 'ok',
    exitCode: 1,
    envelope: {
      schemaVersion: 2,
      tool: 'fit',
      verdict: { passed: false },
    },
  };
  const valid = {
    status: 1,
    timedOut: false,
    outputTruncated: false,
    stdoutCapture: JSON.stringify(envelope),
    cleanup: { residualDescendants: 0 },
  };

  assert.deepEqual(evaluatePtyFindingResult(valid, 'json'), []);
  assert.deepEqual(
    evaluatePtyFindingResult({ ...valid, stdoutCapture: 'human output' }, 'no-color'),
    [],
  );
  assert.ok(
    evaluatePtyFindingResult(
      {
        ...valid,
        stdoutCapture: `human ${String.fromCodePoint(27)}[31moutput`,
      },
      'no-color',
    ).some((failure) => failure.includes('ANSI')),
  );
  assert.ok(
    evaluatePtyFindingResult({ ...valid, status: 0 }, 'json').some((failure) =>
      failure.includes('expected exit 1'),
    ),
  );
  assert.ok(
    evaluatePtyFindingResult({ ...valid, stdoutCapture: '{"kind":"fit.run"}' }, 'json').some(
      (failure) => failure.includes('envelope shape'),
    ),
  );
  assert.ok(
    evaluatePtyFindingResult({ ...valid, cleanup: { residualDescendants: 1 } }, 'json').some(
      (failure) => failure.includes('residual descendants'),
    ),
  );
});

test('PTY journey seeds a zero-init source project before all three terminal probes', async () => {
  if (process.platform !== 'darwin') return;
  const context = permissiveContext();
  const invocations = [];
  context.process.run = async (spec) => {
    invocations.push(spec);
    assert.equal(existsSync(join(context.paths.workRoot, 'src', 'bad.ts')), true);
    assert.equal(existsSync(join(context.paths.workRoot, 'tsconfig.json')), true);
    if (invocations.length < 3) {
      return processResult({ status: 1, stdoutCapture: 'human finding\n' });
    }
    return processResult({
      status: 1,
      stdoutCapture: JSON.stringify({
        kind: 'fit.run',
        status: 'ok',
        exitCode: 1,
        envelope: {
          schemaVersion: 2,
          tool: 'fit',
          verdict: { passed: false },
          signals: [],
        },
      }),
    });
  };

  const outcome = await getJourney('macos.pty-human-view').executor(context);

  assert.equal(outcome.status, 'pass', JSON.stringify(outcome));
  assert.equal(invocations.length, 3);
  assert.ok(invocations.every((spec) => spec.pty === true));
  assert.deepEqual(
    invocations.map((spec) => spec.argv.slice(spec.argv.indexOf('fit'))),
    [
      ['fit', '--check', 'no-console-log'],
      ['fit', '--check', 'no-console-log'],
      ['fit', '--json', '--check', 'no-console-log'],
    ],
  );
  assert.equal(invocations[1].env?.NO_COLOR, '1');
});

test('browser journey invokes the default-opening report command through its safe shim', async () => {
  if (process.platform !== 'darwin') return;
  const context = permissiveContext();
  const invocations = [];
  context.process.run = async (spec) => {
    invocations.push(spec);
    const reportIndex = spec.argv.indexOf('report');
    if (reportIndex !== -1) {
      const target = join(
        context.paths.workRoot,
        'opensip-cli',
        '.runtime',
        'reports',
        'latest.html',
      );
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '<!doctype html>\n');
      writeFileSync(join(context.paths.workRoot, 'open-capture.log'), `${target}\n`);
    }
    return processResult();
  };

  const outcome = await getJourney('macos.browser-open').executor(context);

  assert.equal(outcome.status, 'pass', JSON.stringify(outcome));
  assert.equal(invocations.length, 4);
  const report = invocations[3];
  assert.deepEqual(report.argv.slice(report.argv.indexOf('report')), ['report']);
  assert.equal(report.pty, true);
  assert.equal(report.env?.CI, '');
  assert.ok(report.env?.PATH.startsWith(`${join(context.paths.workRoot, 'shim-bin')}:`));
});

test('native SQLite journey seeds a zero-init project before opening its cached store', async () => {
  if (process.platform !== 'darwin') return;
  const context = permissiveContext();
  const installRoot = join(context.paths.workRoot, 'install', 'node_modules');
  const paths = {
    installedEntrypoint: join(installRoot, 'opensip-cli', 'dist', 'index.js'),
    datastoreEntrypoint: join(installRoot, '@opensip-cli', 'datastore', 'dist', 'index.js'),
    sqliteEntrypoint: join(installRoot, 'better-sqlite3', 'lib', 'index.js'),
    nativeAddon: join(installRoot, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  };
  for (const path of Object.values(paths)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'fixture\n');
  }
  context.installed = {
    ...context.installed,
    jsEntrypoint: { kind: 'node-script', script: paths.installedEntrypoint },
  };
  const invocations = [];
  context.process.run = async (spec) => {
    invocations.push(spec);
    if (invocations.length === 1) {
      assert.equal(existsSync(join(context.paths.workRoot, 'src', 'bad.ts')), true);
      assert.equal(existsSync(join(context.paths.workRoot, 'tsconfig.json')), true);
      assert.equal(existsSync(join(context.paths.workRoot, 'package.json')), true);
      return processResult({
        stdoutCapture: JSON.stringify({
          kind: 'history',
          status: 'ok',
          exitCode: 0,
          data: { type: 'history', sessions: [] },
        }),
      });
    }
    return processResult({
      stdoutCapture: JSON.stringify({
        ok: true,
        datastoreEntrypoint: paths.datastoreEntrypoint,
        sqliteEntrypoint: paths.sqliteEntrypoint,
        nativeAddon: paths.nativeAddon,
      }),
    });
  };

  const outcome = await getJourney('macos.native-sqlite').executor(context);

  assert.equal(outcome.status, 'pass', JSON.stringify(outcome));
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].argv.slice(-3), ['sessions', 'list', '--json']);
  assert.equal(
    invocations.some((spec) => spec.argv.includes('init')),
    false,
  );
});

test('native signal classification requires exact identity, bounded exit, and zero descendants', () => {
  const valid = {
    deliveredSignal: 'SIGINT',
    signal: 'SIGINT',
    status: null,
    timedOut: false,
    cancelled: false,
    durationMs: 125,
    cleanup: { residualDescendants: 0 },
  };
  assert.deepEqual(evaluateNativeSignalResult(valid, 'SIGINT', 1000), []);
  assert.ok(
    evaluateNativeSignalResult({ ...valid, deliveredSignal: 'SIGTERM' }, 'SIGINT', 1000).some(
      (failure) => failure.includes('was not delivered'),
    ),
  );
  assert.ok(
    evaluateNativeSignalResult({ ...valid, signal: 'SIGKILL' }, 'SIGINT', 1000).some((failure) =>
      failure.includes('SIGKILL'),
    ),
  );
  assert.ok(
    evaluateNativeSignalResult(
      { ...valid, cleanup: { residualDescendants: 1 } },
      'SIGINT',
      1000,
    ).some((failure) => failure.includes('residual descendants')),
  );
  assert.ok(
    evaluateNativeSignalResult({ ...valid, durationMs: 1000 }, 'SIGINT', 1000).some((failure) =>
      failure.includes('within the bound'),
    ),
  );
});

test('interrupted recovery requires cancellation with zero observed residual descendants', () => {
  const valid = {
    cancelled: true,
    timedOut: false,
    cleanup: { residualDescendants: 0 },
  };
  assert.equal(evaluateInterruptedRecoveryResult(valid), null);
  assert.equal(
    evaluateInterruptedRecoveryResult({ ...valid, cancelled: false }),
    'interruption-not-observed',
  );
  assert.equal(
    evaluateInterruptedRecoveryResult({ ...valid, timedOut: true }),
    'interruption-fell-through-to-timeout',
  );
  assert.equal(
    evaluateInterruptedRecoveryResult({
      ...valid,
      cleanup: { residualDescendants: 1 },
    }),
    'interruption-left-descendants',
  );
});

test('permission classification requires structured actionable errors for the exact target', () => {
  const resultForKind = (kind) => ({
    status: 1,
    timedOut: false,
    stdoutCapture: JSON.stringify({
      kind,
      status: 'error',
      exitCode: 1,
      errors: [
        {
          message: 'EACCES writing opensip-cli.config.yml',
          suggestion: 'Choose a writable directory.',
        },
      ],
    }),
  });
  for (const kind of ['command.error', 'bootstrap.error']) {
    assert.deepEqual(evaluatePermissionFailure(resultForKind(kind), 'opensip-cli.config.yml'), {
      ok: true,
      reasonCode: null,
    });
  }
  const result = resultForKind('command.error');
  assert.deepEqual(evaluatePermissionFailure({ ...result, status: 0 }, 'opensip-cli.config.yml'), {
    ok: false,
    reasonCode: 'permission-denied-silently-succeeded',
  });
  assert.deepEqual(evaluatePermissionFailure(result, '.runtime/datastore.sqlite'), {
    ok: false,
    reasonCode: 'permission-error-target-missing',
  });
  assert.deepEqual(
    evaluatePermissionFailure(
      {
        ...result,
        stdoutCapture: JSON.stringify({
          kind: 'command.error',
          status: 'error',
          exitCode: 1,
          errors: [{ message: 'opensip-cli.config.yml could not be written' }],
        }),
      },
      'opensip-cli.config.yml',
    ),
    { ok: false, reasonCode: 'permission-error-not-actionable' },
  );
  assert.deepEqual(
    evaluatePermissionFailure(resultForKind('unstructured.error'), 'opensip-cli.config.yml'),
    { ok: false, reasonCode: 'permission-error-shape-invalid' },
  );
});

test('buildTupleObservedHost omits unavailable sources (never a guessed value)', () => {
  const observed = buildTupleObservedHost({ ...OK_TUPLE, npmVersion: null });
  assert.equal(observed.osPlatform, 'darwin');
  assert.equal(observed.kernelName, 'Darwin');
  assert.equal(observed.osVersion, '26.0.1');
  assert.equal(observed.arch, 'arm64');
  assert.ok(!('npmVersion' in observed), 'an unavailable source must be unobserved, not null');
});

test('a consistent macOS 26 tuple selects the preview support row', () => {
  const verdict = evaluateTupleCrosscheck(OK_TUPLE, assessHostSupport);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.reasonCode, null);
  assert.ok(verdict.lines.some((line) => line.includes(MACOS_PREVIEW_ROW_ID)));
});

test('contradictory architecture sources fail even when one matches the tuple', () => {
  const verdict = evaluateTupleCrosscheck(
    { ...OK_TUPLE, unameMachine: 'x86_64' },
    assessHostSupport,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'arch-source-mismatch');
});

test('a missing required source fails as tuple-source-unavailable', () => {
  for (const patch of [{ swVers: null }, { kernelName: null }]) {
    const verdict = evaluateTupleCrosscheck({ ...OK_TUPLE, ...patch }, assessHostSupport);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reasonCode, 'tuple-source-unavailable');
  }
});

test('a contradicted OS version fails as tuple-not-supported-row', () => {
  const verdict = evaluateTupleCrosscheck({ ...OK_TUPLE, swVers: '15.0.0' }, assessHostSupport);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-not-supported-row');
});

test('an Intel tuple (both arch sources agree on x64) is rejected', () => {
  const verdict = evaluateTupleCrosscheck(
    { ...OK_TUPLE, unameMachine: 'x86_64', nodeArch: 'x64' },
    assessHostSupport,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-not-supported-row');
});

// ---------------------------------------------------------------------------
// Executor fail-closed contract (host-adaptive: green on darwin AND non-darwin)
// ---------------------------------------------------------------------------

const STATUSES = new Set(['pass', 'fail', 'unavailable', 'skipped']);

test('every macOS executor returns a valid bounded outcome and never throws', async () => {
  for (const id of MACOS_JOURNEY_IDS) {
    const executor = getJourney(id).executor;
    const outcome = await executor(permissiveContext());
    assert.ok(STATUSES.has(outcome.status), `${id} produced an invalid status ${outcome.status}`);
    assert.ok(Array.isArray(outcome.diagnostics), `${id} outcome has no diagnostics array`);
    if (outcome.status !== 'pass') {
      assert.match(outcome.reasonCode ?? '', /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, `${id} reasonCode`);
    }
    // On a non-darwin host the journeys are inapplicable and MUST short-circuit
    // to unavailable('non-darwin-host') without spawning anything.
    if (process.platform !== 'darwin') {
      assert.equal(outcome.status, 'unavailable', `${id} must be unavailable off darwin`);
      assert.equal(outcome.reasonCode, 'non-darwin-host', `${id} reason off darwin`);
    }
  }
});
