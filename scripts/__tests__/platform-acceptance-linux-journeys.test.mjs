/**
 * @fileoverview Phase 5 coverage — the Linux-specific journeys (Plan 12).
 *
 * The registry union / profile-composition checks live in the sibling
 * `journey-catalog.test.mjs`; this file covers the Linux module directly: its
 * registered rows (category/capabilities), the PURE tuple-crosscheck logic
 * against the REAL core support policy (host-independent), the observed-host
 * mapper, and the executor fail-closed contract on a non-Linux host (an
 * `unavailable('non-linux-host')` that never throws and never false-passes,
 * keeping `pnpm test:scripts` green on any host). Runs under `node --test`.
 *
 * The `evaluateLinuxTupleCrosscheck` cases include the Ubuntu calendar-version
 * regression: `24.04`'s leading-zero minor must NOT read as an os-version
 * mismatch (the defect OrbStack surfaced; fixed in core `majorOf`). This is the
 * crosscheck-level guard; the core-level guard is in `platform-support.test.ts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boundedDiagnostic } from '../cli-acceptance-core.mjs';
import { getJourney, LINUX_JOURNEY_IDS } from '../platform-acceptance/journey-catalog.mjs';
import { KNOWN_CAPABILITIES } from '../platform-acceptance/journey-kit.mjs';
import {
  buildLinuxObservedHost,
  evaluateLinuxTupleCrosscheck,
  UBUNTU_PREVIEW_ROW_ID,
} from '../platform-acceptance/journeys/linux.mjs';
import { assessHostSupport } from '../../packages/core/dist/index-lib.js';

/** Facts for the EXACT qualified Ubuntu tuple (kernel 6, calendar os 24.04). */
const OK_FACTS = Object.freeze({
  osVersion: '24.04',
  kernelName: 'Linux',
  kernelRelease: '6.8.0-1017-azure',
  unameMachine: 'x86_64',
  npmVersion: '11.13.0',
  nodeArch: 'x64',
  nodeVersion: 'v24.16.0',
  nodeAbi: '137',
});

test('every Linux journey is registered under the linux category with known capabilities', () => {
  assert.equal(LINUX_JOURNEY_IDS.length, 3);
  for (const id of LINUX_JOURNEY_IDS) {
    const journey = getJourney(id);
    assert.equal(journey.category, 'linux', `${id} is not in the linux category`);
    assert.ok(journey.id.startsWith('linux.'), `${id} is not namespaced`);
    assert.equal(typeof journey.executor, 'function');
    assert.ok(journey.steps.length > 0, `${id} has no steps`);
    for (const capability of journey.capabilities) {
      assert.ok(KNOWN_CAPABILITIES.has(capability), `${id} declares unknown capability ${capability}`);
    }
  }
});

test('evaluateLinuxTupleCrosscheck passes for the exact Ubuntu tuple via the real core policy', () => {
  const verdict = evaluateLinuxTupleCrosscheck(OK_FACTS, assessHostSupport);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.reasonCode, null);
  assert.ok(verdict.lines.at(-1).includes(UBUNTU_PREVIEW_ROW_ID));
});

test("evaluateLinuxTupleCrosscheck accepts Ubuntu's leading-zero calendar version (majorOf regression)", () => {
  // The ONLY difference from OK_FACTS is making the calendar minor explicit; a
  // semver-strict major parser used to reject "24.04" → os-version-mismatch.
  const verdict = evaluateLinuxTupleCrosscheck({ ...OK_FACTS, osVersion: '24.04' }, assessHostSupport);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.doesNotMatch(verdict.lines.join('\n'), /os-version-mismatch/);
});

test('evaluateLinuxTupleCrosscheck fails a missing required source (never a silent pass)', () => {
  const verdict = evaluateLinuxTupleCrosscheck({ ...OK_FACTS, npmVersion: null }, assessHostSupport);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-source-unavailable');
  assert.ok(verdict.lines.at(-1).includes('npm'));
});

test('evaluateLinuxTupleCrosscheck fails when the two architecture sources disagree', () => {
  // uname reports aarch64 (→ arm64) but Node reports x64: contradictory sources
  // fail EVEN before the row policy, regardless of the tuple.
  const verdict = evaluateLinuxTupleCrosscheck(
    { ...OK_FACTS, unameMachine: 'aarch64' },
    assessHostSupport,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'arch-source-mismatch');
});

test('evaluateLinuxTupleCrosscheck fails a contradictory tuple (wrong kernel major)', () => {
  const verdict = evaluateLinuxTupleCrosscheck(
    { ...OK_FACTS, kernelRelease: '7.0.11-orbstack' },
    assessHostSupport,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-not-supported-row');
});

test('evaluateLinuxTupleCrosscheck fails a non-ubuntu row selection (injected policy)', () => {
  // A deterministic stub proves the row-identity guard independent of the live
  // registry: contradiction-free, but the selected row is not the ubuntu row.
  const stub = () => ({ reasonCodes: [], row: { id: 'some-other-row' }, status: 'preview' });
  const verdict = evaluateLinuxTupleCrosscheck(OK_FACTS, stub);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-row-unselected');
});

test('evaluateLinuxTupleCrosscheck fails an unsupported row status (injected policy)', () => {
  const stub = () => ({ reasonCodes: [], row: { id: UBUNTU_PREVIEW_ROW_ID }, status: 'unqualified' });
  const verdict = evaluateLinuxTupleCrosscheck(OK_FACTS, stub);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-status-unsupported');
});

test('buildLinuxObservedHost omits unavailable sources (never a guessed value)', () => {
  const observed = buildLinuxObservedHost({ ...OK_FACTS, npmVersion: null, kernelRelease: null });
  assert.equal(observed.osPlatform, 'linux');
  assert.equal(observed.osVersion, '24.04');
  assert.ok(!('npmVersion' in observed), 'an unavailable source must be unobserved, not null');
  assert.ok(!('kernelRelease' in observed), 'an unavailable source must be unobserved, not null');
});

test('each Linux journey is fail-closed (unavailable, never a throw) on a non-Linux host', async () => {
  // This suite runs on the developer/CI host (darwin here); the executors must
  // short-circuit BEFORE touching any port and return a tagged unavailable.
  const context = { assert: { diagnostic: (text) => boundedDiagnostic(text, 4096) } };
  for (const id of LINUX_JOURNEY_IDS) {
    const outcome = await getJourney(id).executor(context);
    if (process.platform === 'linux') {
      // On a real Linux host the executor runs for real; we only assert it did
      // not throw and produced a structured outcome.
      assert.ok(outcome && typeof outcome.status === 'string', `${id} produced no outcome`);
    } else {
      assert.equal(outcome.status, 'unavailable', `${id} did not short-circuit off-Linux`);
      assert.equal(outcome.reasonCode, 'non-linux-host', `${id} used the wrong unavailable reason`);
    }
  }
});
