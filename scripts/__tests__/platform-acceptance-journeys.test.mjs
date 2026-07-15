/**
 * @fileoverview Phase 6 residual coverage — journey EXECUTORS + fixture packing.
 *
 * The registry identity / order / profile-closure / packed-smoke parity checks
 * live in the sibling `journey-catalog.test.mjs`; this file does NOT duplicate
 * them. It adds: journey metadata (category/value/steps/isolation), and the
 * executor behavior of representative command + bespoke journeys driven by a
 * FAKE measured-process port — success plus malformed JSON, wrong exit, envelope
 * mismatch, setup faults, cancellation/timeout residue, and the sim-pack
 * install→run→remove→gone contract. Fixture packing input-guards are covered
 * without npm; one bounded integration packs the three FIXED fixtures.
 *
 * Runs under `node --test` (`pnpm test:scripts`).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { boundedDiagnostic, checkScenario, expectEnvelope } from '../cli-acceptance-core.mjs';
import { getJourney, JOURNEY_REGISTRY } from '../platform-acceptance/journey-catalog.mjs';
import { FIXTURE_REASON_CODES, packFixtures } from '../platform-acceptance/fixture-packages.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const KNOWN_CATEGORIES = new Set([
  'lifecycle',
  'analysis',
  'output',
  'persistence',
  'mcp',
  'agent',
  'extensions',
  'resilience',
  'macos',
]);

const roots = [];
function tmpRoot(prefix = 'pa-journeys-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Mirror the runner's makeAssertHelpers so executors run exactly as in production. */
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

/** A closed MeasuredProcessResult with only the fields executors read. */
function measured(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function jsonResult(value, overrides = {}) {
  return measured({ stdoutCapture: JSON.stringify(value), ...overrides });
}

/** A context whose port consumes a scripted queue of results in call order. */
function queuedContext(responses, { workRoot, resolvedVersion = '9.9.9', fixtures = {} } = {}) {
  const queue = [...responses];
  const calls = [];
  const context = {
    installed: {
      mode: 'packed-release',
      installedBin: { kind: 'installed-bin', bin: '/candidate/bin/opensip' },
      jsEntrypoint: { kind: 'node-script', script: '/candidate/dist/index.js' },
      resolvedVersion,
    },
    paths: { workRoot: workRoot ?? tmpRoot() },
    fixtures: {
      toolPluginTarball: '/fx/tool.tgz',
      fitPackTarball: '/fx/fit.tgz',
      simPackTarball: '/fx/sim.tgz',
      ...fixtures,
    },
    process: {
      run: (spec) => {
        calls.push(spec.argv.slice(1));
        const next = queue.shift();
        if (next === undefined)
          throw new Error(`unexpected extra port call: ${spec.argv.join(' ')}`);
        return Promise.resolve(next);
      },
    },
    assert: makeAssert(),
  };
  return { context, calls };
}

// ---------------------------------------------------------------------------
// Journey metadata (additive to journey-catalog.test.mjs)
// ---------------------------------------------------------------------------

test('every registered journey carries valued, categorized, stepped metadata', () => {
  for (const journey of JOURNEY_REGISTRY.values()) {
    assert.ok(KNOWN_CATEGORIES.has(journey.category), `unknown category ${journey.category}`);
    assert.equal(typeof journey.value.human, 'string');
    assert.ok(journey.value.human.length > 0, `${journey.id} empty value.human`);
    assert.equal(typeof journey.value.agent, 'string');
    assert.ok(journey.value.agent.length > 0, `${journey.id} empty value.agent`);
    assert.ok(
      Array.isArray(journey.steps) && journey.steps.length > 0,
      `${journey.id} has no steps`,
    );
    for (const step of journey.steps) assert.ok(step.label.length > 0);
    assert.equal(typeof journey.isolated, 'boolean');
  }
});

// ---------------------------------------------------------------------------
// Command journeys via a fake port
// ---------------------------------------------------------------------------

test('lifecycle.version passes on a matching version and fails on a wrong exit', async () => {
  const versionExecutor = getJourney('lifecycle.version').executor;

  const ok = queuedContext([measured({ status: 0, stdoutCapture: 'opensip 9.9.9' })]);
  const okOutcome = await versionExecutor(ok.context);
  assert.equal(okOutcome.status, 'pass');

  const wrongExit = queuedContext([measured({ status: 1, stdoutCapture: 'opensip 9.9.9' })]);
  const outcome = await versionExecutor(wrongExit.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'command-step-failed');
});

test('a command journey step whose setup throws fails with command-step-setup-failed', async () => {
  const fitPackExecutor = getJourney('extensions.fit-pack').executor;
  // The first fit-pack step's setup mkdirs under the workRoot; an unwritable root
  // makes it throw before any port call.
  const { context } = queuedContext([], { workRoot: '/proc/nonexistent-acceptance-root/deep' });
  const outcome = await fitPackExecutor(context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'command-step-setup-failed');
});

test('extensions.fit-pack passes on well-formed results and fails on malformed JSON', async () => {
  const fitPackExecutor = getJourney('extensions.fit-pack').executor;

  const workRoot = tmpRoot();
  const happy = queuedContext(
    [
      jsonResult({ data: { success: true } }),
      jsonResult(
        {
          envelope: {
            schemaVersion: 2,
            tool: 'fit',
            signals: [{ source: 'fit-pack-fixture-marker' }],
            verdict: { summary: { total: 1 } },
          },
        },
        { status: 1 },
      ),
    ],
    { workRoot },
  );
  const happyOutcome = await fitPackExecutor(happy.context);
  assert.equal(happyOutcome.status, 'pass');

  const malformed = queuedContext([measured({ status: 0, stdoutCapture: 'not json at all' })], {
    workRoot: tmpRoot(),
  });
  const outcome = await fitPackExecutor(malformed.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'command-step-failed');
});

// ---------------------------------------------------------------------------
// extensions.sim-pack — install → run → remove → prove the capability is gone
// ---------------------------------------------------------------------------

test('extensions.sim-pack passes the install/run/remove/gone contract', async () => {
  const simPackExecutor = getJourney('extensions.sim-pack').executor;
  const { context } = queuedContext([
    measured({ status: 0 }), // init
    jsonResult({ data: { success: true } }), // sim plugin add
    jsonResult({ envelope: { schemaVersion: 2, tool: 'sim', signals: [] } }), // sim --recipe (runs)
    measured({ status: 0 }), // sim plugin remove
    measured({ status: 1 }), // post-removal sim --recipe (recipe gone)
  ]);
  const outcome = await simPackExecutor(context);
  assert.equal(outcome.status, 'pass');
});

test('extensions.sim-pack fails when the recipe still runs after removal', async () => {
  const simPackExecutor = getJourney('extensions.sim-pack').executor;
  const { context } = queuedContext([
    measured({ status: 0 }),
    jsonResult({ data: { success: true } }),
    jsonResult({ envelope: { schemaVersion: 2, tool: 'sim', signals: [] } }),
    measured({ status: 0 }),
    measured({ status: 0 }), // post-removal STILL runs → capability not removed
  ]);
  const outcome = await simPackExecutor(context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'sim-pack-still-present');
});

test('extensions.sim-pack fails fast when init fails', async () => {
  const simPackExecutor = getJourney('extensions.sim-pack').executor;
  const { context } = queuedContext([measured({ status: 1, stderrTail: 'init boom' })]);
  const outcome = await simPackExecutor(context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'init-failed');
});

// ---------------------------------------------------------------------------
// resilience executors — cancellation / timeout residue / permission handling
// ---------------------------------------------------------------------------

test('resilience.signals passes only when the run is cancelled with zero residual descendants', async () => {
  const executor = getJourney('resilience.signals').executor;

  const clean = queuedContext([measured({ cancelled: true, cleanup: { residualDescendants: 0 } })]);
  const cleanOutcome = await executor(clean.context);
  assert.equal(cleanOutcome.status, 'pass');

  const residue = queuedContext([
    measured({ cancelled: true, cleanup: { residualDescendants: 3 } }),
  ]);
  const leaky = await executor(residue.context);
  assert.equal(leaky.status, 'fail');
  assert.equal(leaky.reasonCode, 'signal-cancellation-failed');

  const notCancelled = queuedContext([measured({ cancelled: false })]);
  const notCancelledOutcome = await executor(notCancelled.context);
  assert.equal(notCancelledOutcome.status, 'fail');
});

test('resilience.timeout-cleanup passes only on a timeout with zero residual descendants', async () => {
  const executor = getJourney('resilience.timeout-cleanup').executor;

  const clean = queuedContext([measured({ timedOut: true, cleanup: { residualDescendants: 0 } })]);
  const cleanOutcome = await executor(clean.context);
  assert.equal(cleanOutcome.status, 'pass');

  const residue = queuedContext([
    measured({ timedOut: true, cleanup: { residualDescendants: 1 } }),
  ]);
  const leaky = await executor(residue.context);
  assert.equal(leaky.status, 'fail');
  assert.equal(leaky.reasonCode, 'timeout-cleanup-failed');
});

test('resilience.permissions fails when a write into a read-only dir silently succeeds', async () => {
  const executor = getJourney('resilience.permissions').executor;

  // Exit non-zero → the CLI reported a reasoned failure → journey passes.
  const graceful = queuedContext([measured({ status: 1 })], { workRoot: tmpRoot() });
  const gracefulOutcome = await executor(graceful.context);
  assert.equal(gracefulOutcome.status, 'pass');

  // Exit zero → init claimed success writing into a read-only dir → journey fails.
  const silent = queuedContext([measured({ status: 0 })], { workRoot: tmpRoot() });
  const outcome = await executor(silent.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'permission-denied-silently-succeeded');
});

// ---------------------------------------------------------------------------
// Fixture packing — input guards (no npm) + one bounded real integration
// ---------------------------------------------------------------------------

test('packFixtures rejects non-absolute and missing inputs before spawning npm', () => {
  assert.throws(
    () => packFixtures(null),
    (e) => e.reasonCode === FIXTURE_REASON_CODES.INVALID_INPUT,
  );
  assert.throws(
    () => packFixtures({ repoRoot: 'relative', destDir: tmpRoot() }),
    (e) => e.reasonCode === FIXTURE_REASON_CODES.INVALID_INPUT,
  );
  assert.throws(
    () => packFixtures({ repoRoot: REPO_ROOT, destDir: 'relative' }),
    (e) => e.reasonCode === FIXTURE_REASON_CODES.INVALID_DESTINATION,
  );
  assert.throws(
    () => packFixtures({ repoRoot: REPO_ROOT, destDir: join(tmpdir(), 'pa-absent-dest-xyz') }),
    (e) => e.reasonCode === FIXTURE_REASON_CODES.INVALID_DESTINATION,
  );
});

test('packFixtures rejects a repo root that lacks the fixed fixtures directory', () => {
  const emptyRepo = tmpRoot('pa-emptyrepo-');
  assert.throws(
    () => packFixtures({ repoRoot: emptyRepo, destDir: tmpRoot() }),
    (e) => e.reasonCode === FIXTURE_REASON_CODES.MISSING_FIXTURE,
  );
});

test(
  'packFixtures packs the three FIXED fixtures into a run-owned destination',
  { timeout: 180_000 },
  () => {
    const destDir = tmpRoot('pa-fixtures-');
    const destReal = realpathSync(destDir);
    const packed = packFixtures({ repoRoot: REPO_ROOT, destDir });
    for (const key of ['toolPluginTarball', 'fitPackTarball', 'simPackTarball']) {
      assert.equal(typeof packed[key], 'string', `missing ${key}`);
      assert.ok(packed[key].startsWith(destReal), `${key} landed outside the destination`);
      assert.ok(packed[key].endsWith('.tgz'));
    }
  },
);
