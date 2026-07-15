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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { boundedDiagnostic, checkScenario, expectEnvelope } from '../cli-acceptance-core.mjs';
import { getJourney, MACOS_JOURNEY_IDS } from '../platform-acceptance/journey-catalog.mjs';
import { KNOWN_CAPABILITIES } from '../platform-acceptance/journey-kit.mjs';
import {
  buildTupleObservedHost,
  evaluateTupleCrosscheck,
  MACOS_PREVIEW_ROW_ID,
  normalizeUnameArch,
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
          outputTruncated: false,
          durationMs: 1,
          rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
          stdoutTail: '',
          stderrTail: '',
          stdoutCapture: '',
          cleanup: { residualDescendants: 0 },
        }),
    },
    assert: makeAssert(),
  };
  return context;
}

const OK_TUPLE = Object.freeze({
  swVers: '26.0.1',
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
  const verdict = evaluateTupleCrosscheck({ ...OK_TUPLE, swVers: null }, assessHostSupport);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-source-unavailable');
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
