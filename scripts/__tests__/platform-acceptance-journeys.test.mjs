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
import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { boundedDiagnostic, checkScenario, expectEnvelope } from '../cli-acceptance-core.mjs';
import { getJourney, JOURNEY_REGISTRY } from '../platform-acceptance/journey-catalog.mjs';
import {
  readBoundedFileBytes,
  readBoundedOwnedTextFile,
} from '../platform-acceptance/bounded-owned-file.mjs';
import { FIXTURE_REASON_CODES, packFixtures } from '../platform-acceptance/fixture-packages.mjs';
import { runCli } from '../platform-acceptance/journey-kit.mjs';
import { readBoundedOwnedText } from '../platform-acceptance/journeys/output.mjs';
import { boundedDirSize, buildRunsShowArgs } from '../platform-acceptance/journeys/persistence.mjs';

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
  'linux',
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
  const specs = [];
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
        specs.push(spec);
        const next = queue.shift();
        if (next === undefined)
          throw new Error(`unexpected extra port call: ${spec.argv.join(' ')}`);
        return Promise.resolve(next);
      },
    },
    toolchain: {
      node: { argv: [process.execPath] },
      npm: { argv: [process.execPath, '/toolchain/npm-cli.js'] },
    },
    assert: makeAssert(),
  };
  return { context, calls, specs };
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

function publicSessionHistory(id = 'session-1') {
  return jsonResult({
    data: { type: 'history', sessions: [{ id, tool: 'graph' }] },
  });
}

function publicSessionReplay(id = 'session-1') {
  return jsonResult({
    data: {
      session: { id, tool: 'graph' },
      fidelity: 'projection',
      envelope: {
        schemaVersion: 2,
        tool: 'graph',
        verdict: { passed: true },
        signals: [],
      },
    },
  });
}

test('analysis session show/replay validate the public session projection contract', async () => {
  const show = queuedContext([publicSessionHistory(), publicSessionReplay()]);
  const showOutcome = await getJourney('analysis.sessions-show').executor(show.context);
  assert.equal(showOutcome.status, 'pass');

  const replay = queuedContext([
    publicSessionHistory(),
    publicSessionReplay(),
    publicSessionReplay(),
  ]);
  const replayOutcome = await getJourney('analysis.replay').executor(replay.context);
  assert.equal(replayOutcome.status, 'pass');

  const inventedShape = queuedContext([
    publicSessionHistory(),
    jsonResult({ data: { type: 'session-replay', id: 'session-1' } }),
  ]);
  const outcome = await getJourney('analysis.sessions-show').executor(inventedShape.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'sessions-show-failed');
});

test('MCP close errors and bounded stderr overflow are authoritative journey failures', async () => {
  const initialize = getJourney('mcp.initialize');
  for (const [handleOverrides, reasonCode] of [
    [
      {
        close: () => Promise.reject(new Error('synthetic close failure')),
        stderrSummary: () => ({ bytes: 0, truncated: false }),
      },
      'mcp-close-failed',
    ],
    [
      {
        close: () => Promise.resolve(),
        stderrSummary: () => ({ bytes: 8192, truncated: true }),
      },
      'mcp-output-overflow',
    ],
  ]) {
    const { context } = queuedContext([]);
    const handle = {
      serverVersion: () => ({ name: 'opensip', version: '1.0.0' }),
      listTools: () => Promise.resolve({ tools: [] }),
      callTool: () => Promise.resolve({ content: [] }),
      ...handleOverrides,
    };
    context.mcp = { connect: () => Promise.resolve(handle) };
    const outcome = await initialize.executor(context);
    assert.equal(outcome.status, 'fail');
    assert.equal(outcome.reasonCode, reasonCode);
  }
});

function mcpResult(payload, { isError = false, text } = {}) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: text ?? JSON.stringify(payload) }],
  };
}

function mcpContext(responses, processResponses = []) {
  const queue = [...responses];
  const calls = [];
  const { context, calls: processCalls } = queuedContext(processResponses);
  const handle = {
    serverVersion: () => ({ name: 'opensip', version: '1.0.0' }),
    listTools: () => Promise.resolve({ tools: [] }),
    callTool: (request) => {
      calls.push(request);
      const response = queue.shift();
      if (response === undefined) throw new Error(`unexpected MCP call ${request.name}`);
      return Promise.resolve(response);
    },
    close: () => Promise.resolve(),
    stderrSummary: () => ({ bytes: 0, truncated: false }),
  };
  context.mcp = { connect: () => Promise.resolve(handle) };
  return { calls, context, processCalls };
}

function contextStatusPayload(overrides = {}) {
  return {
    status: 'missing',
    fileScope: { status: 'mismatched' },
    steps: [],
    pointers: [],
    reasonCodes: ['context-run-missing', 'context-scope-mismatch'],
    nextActions: ['Run opensip suite run agent-context --files src/bad.ts.'],
    ...overrides,
  };
}

function fileContextPayload(overrides = {}) {
  return {
    status: 'found',
    file: {
      path: 'src/bad.ts',
      size: 22,
      modifiedMs: 1,
      roles: ['production'],
      targets: [],
      languages: ['typescript'],
      evidenceSupport: {
        callable: 'supported',
        declaration: 'supported',
        reference: 'supported',
      },
      provenance: [],
    },
    project: {
      workspacePatterns: [],
      languages: ['typescript'],
      fileCount: 2,
      packageCount: 1,
      configIdentity: 'config-1',
    },
    inventoryIdentity: 'inventory-1',
    coverage: { status: 'complete', reasonCodes: [], observed: 2, total: 2 },
    freshness: {
      fresh: true,
      capturedAt: '2026-07-15T00:00:00.000Z',
      verification: 'complete',
      reasonCodes: [],
    },
    reasonCodes: [],
    nextActions: [],
    ...overrides,
  };
}

function runPointer(overrides = {}) {
  return {
    id: 'run-1',
    tool: 'fit',
    startedAt: '2026-07-15T00:00:00.000Z',
    completedAt: '2026-07-15T00:00:01.000Z',
    durationMs: 1000,
    score: 100,
    passed: true,
    showCommand: 'opensip sessions show run-1 --json',
    ...overrides,
  };
}

function replayEnvelope(overrides = {}) {
  return {
    schemaVersion: 2,
    tool: 'fit',
    runId: 'run-1',
    createdAt: '2026-07-15T00:00:00.000Z',
    verdict: {
      score: 100,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
    baselineIdentity: {
      fingerprintStrategyId: 'fit-v1',
      fingerprintStrategyVersion: '1',
    },
    ...overrides,
  };
}

function replayPayload(overrides = {}) {
  return {
    data: { fidelity: 'projection', envelope: replayEnvelope() },
    session: runPointer(),
    ...overrides,
  };
}

function successfulGitSeed() {
  return [measured(), measured(), measured()];
}

function initializedProject() {
  return jsonResult({ data: { type: 'init' } });
}

test('mcp.context requires structured context status and bounded file facts', async () => {
  const capturedContext = jsonResult({
    data: {
      type: 'suite-run',
      suite: 'agent-context',
      contextManifest: { readiness: 'ready' },
    },
  });
  const availableStatus = contextStatusPayload({
    status: 'available',
    run: { id: 'context-run-1' },
    manifest: { readiness: 'ready' },
    fileScope: { status: 'matched' },
    pointers: [{ status: 'available' }],
    reasonCodes: [],
    nextActions: [],
  });
  const happy = mcpContext(
    [mcpResult(availableStatus), mcpResult(fileContextPayload())],
    [...successfulGitSeed(), capturedContext],
  );
  const happyOutcome = await getJourney('mcp.context').executor(happy.context);
  assert.equal(happyOutcome.status, 'pass');
  assert.deepEqual(
    happy.calls.map((call) => call.name),
    ['get_context_status', 'get_file_context'],
  );

  assert.deepEqual(happy.processCalls.slice(0, 3), [
    ['init', '--quiet'],
    ['add', '--all'],
    [
      '-c',
      'user.name=OpenSIP Acceptance',
      '-c',
      'user.email=acceptance@invalid',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'seed acceptance project',
    ],
  ]);

  const emptyStatus = mcpContext([mcpResult({})], [...successfulGitSeed(), capturedContext]);
  const statusOutcome = await getJourney('mcp.context').executor(emptyStatus.context);
  assert.equal(statusOutcome.status, 'fail');
  assert.equal(statusOutcome.reasonCode, 'context-status-invalid');

  const emptyFile = mcpContext(
    [mcpResult(availableStatus), mcpResult({})],
    [...successfulGitSeed(), capturedContext],
  );
  const fileOutcome = await getJourney('mcp.context').executor(emptyFile.context);
  assert.equal(fileOutcome.status, 'fail');
  assert.equal(fileOutcome.reasonCode, 'file-context-invalid');

  const gitFailure = mcpContext([], [measured({ status: 128, stderrTail: 'git failed' })]);
  const gitOutcome = await getJourney('mcp.context').executor(gitFailure.context);
  assert.equal(gitOutcome.status, 'fail');
  assert.equal(gitOutcome.reasonCode, 'context-git-seed-failed');
  assert.deepEqual(gitFailure.calls, []);
});

test('mcp.result-replay binds show_run identity, projection fidelity, and envelope', async () => {
  const happy = mcpContext([mcpResult({ runs: [runPointer()] }), mcpResult(replayPayload())]);
  const happyOutcome = await getJourney('mcp.result-replay').executor(happy.context);
  assert.equal(happyOutcome.status, 'pass');
  assert.deepEqual(happy.calls[1], {
    name: 'show_run',
    arguments: { ref: 'run-1' },
  });

  const invalidReplays = [
    replayPayload({ session: runPointer({ id: 'other-run' }) }),
    replayPayload({ data: { fidelity: 'exact', envelope: replayEnvelope() } }),
    replayPayload({
      data: {
        fidelity: 'projection',
        envelope: replayEnvelope({ tool: 'graph' }),
      },
    }),
    replayPayload({
      data: {
        fidelity: 'projection',
        envelope: replayEnvelope({ runId: 'other' }),
      },
    }),
    replayPayload({
      data: {
        fidelity: 'projection',
        envelope: { schemaVersion: 2, tool: 'fit' },
      },
    }),
  ];
  for (const payload of invalidReplays) {
    const candidate = mcpContext([mcpResult({ runs: [runPointer()] }), mcpResult(payload)]);
    const outcome = await getJourney('mcp.result-replay').executor(candidate.context);
    assert.equal(outcome.status, 'fail');
    assert.equal(outcome.reasonCode, 'show-run-invalid');
  }

  const malformedList = mcpContext([mcpResult({ runs: [{ id: 'run-1' }] })]);
  const listOutcome = await getJourney('mcp.result-replay').executor(malformedList.context);
  assert.equal(listOutcome.status, 'fail');
  assert.equal(listOutcome.reasonCode, 'list-runs-invalid');
});

test('mcp.stale-evidence accepts only a structured, reasoned non-ready response', async () => {
  const happy = mcpContext([mcpResult(contextStatusPayload())], [initializedProject()]);
  const happyOutcome = await getJourney('mcp.stale-evidence').executor(happy.context);
  assert.equal(happyOutcome.status, 'pass');

  const arbitraryError = mcpContext(
    [
      mcpResult(
        { error: { code: 'internal', message: 'missing internal state' } },
        { isError: true },
      ),
    ],
    [initializedProject()],
  );
  const errorOutcome = await getJourney('mcp.stale-evidence').executor(arbitraryError.context);
  assert.equal(errorOutcome.status, 'fail');
  assert.equal(errorOutcome.reasonCode, 'stale-evidence-read-error');

  const tokenOnly = mcpContext(
    [
      mcpResult(
        contextStatusPayload({
          status: 'unexpected',
          reasonCodes: ['missing'],
        }),
      ),
    ],
    [initializedProject()],
  );
  const tokenOutcome = await getJourney('mcp.stale-evidence').executor(tokenOnly.context);
  assert.equal(tokenOutcome.status, 'fail');
  assert.equal(tokenOutcome.reasonCode, 'stale-evidence-invalid');

  const initFailure = mcpContext([], [measured({ status: 2, stderrTail: 'init failed' })]);
  const initOutcome = await getJourney('mcp.stale-evidence').executor(initFailure.context);
  assert.equal(initOutcome.status, 'fail');
  assert.equal(initOutcome.reasonCode, 'stale-evidence-init-failed');
  assert.deepEqual(initFailure.calls, []);
});

test('side-file inspection is bounded to regular files physically inside the journey root', () => {
  const root = tmpRoot();
  const outside = tmpRoot('pa-side-file-outside-');
  const owned = join(root, 'report.html');
  const escaped = join(outside, 'secret.html');
  const link = join(root, 'escaped-link.html');
  writeFileSync(owned, '<!doctype html>');
  writeFileSync(escaped, '<!doctype html>');
  symlinkSync(escaped, link);

  assert.deepEqual(readBoundedOwnedText(owned, root), {
    ok: true,
    text: '<!doctype html>',
  });
  assert.deepEqual(readBoundedOwnedText('relative.html', root), {
    ok: false,
    reasonCode: 'side-file-path-invalid',
  });
  assert.deepEqual(readBoundedOwnedText(escaped, root), {
    ok: false,
    reasonCode: 'side-file-path-escaped',
  });
  assert.deepEqual(readBoundedOwnedText(link, root), {
    ok: false,
    reasonCode: 'side-file-path-escaped',
  });
  assert.deepEqual(readBoundedOwnedText(root, root), {
    ok: false,
    reasonCode: 'side-file-not-regular',
  });
});

test('bounded owned-file read fails closed when the asserted path is swapped before open', () => {
  const root = tmpRoot();
  const path = join(root, 'candidate.json');
  const replacement = join(root, 'replacement.json');
  writeFileSync(path, '{"trusted":true}');
  writeFileSync(replacement, '{"trusted":false}');
  let swapped = false;

  const result = readBoundedOwnedTextFile(
    { path, root, maxBytes: 1024, reasonPrefix: 'swap-test' },
    {
      openSync(openPath, flags) {
        if (!swapped) {
          swapped = true;
          renameSync(replacement, path);
        }
        return openSync(openPath, flags);
      },
    },
  );

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'swap-test-changed-before-open',
  });
});

test('bounded owned-file read never follows a symlink introduced before open', () => {
  const root = tmpRoot();
  const outside = tmpRoot('pa-side-file-swap-outside-');
  const path = join(root, 'candidate.json');
  const escaped = join(outside, 'escaped.json');
  writeFileSync(path, '{"trusted":true}');
  writeFileSync(escaped, '{"secret":true}');
  let swapped = false;

  const result = readBoundedOwnedTextFile(
    { path, root, maxBytes: 1024, reasonPrefix: 'swap-test' },
    {
      openSync(openPath, flags) {
        if (!swapped) {
          swapped = true;
          rmSync(path);
          symlinkSync(escaped, path);
        }
        return openSync(openPath, flags);
      },
    },
  );

  assert.equal(result.ok, false);
  assert.ok(['swap-test-unreadable', 'swap-test-changed-before-open'].includes(result.reasonCode));
});

test('bounded reads fail closed when the asserted path changes after the descriptor read', () => {
  for (const [kind, read] of [
    [
      'bytes',
      (path, root, dependencies) =>
        readBoundedFileBytes(
          { path, maxBytes: 1024, reasonPrefix: 'post-read-swap' },
          dependencies,
        ),
    ],
    [
      'owned-text',
      (path, root, dependencies) =>
        readBoundedOwnedTextFile(
          { path, root, maxBytes: 1024, reasonPrefix: 'post-read-swap' },
          dependencies,
        ),
    ],
  ]) {
    const root = tmpRoot(`pa-post-read-${kind}-`);
    const path = join(root, 'candidate.json');
    const replacement = join(root, 'replacement.json');
    writeFileSync(path, '{"trusted":true}');
    writeFileSync(replacement, '{"trusted":false}');
    let calls = 0;

    const result = read(path, root, {
      fstatSync(descriptor) {
        const stat = fstatSync(descriptor);
        calls += 1;
        if (calls === 2) renameSync(replacement, path);
        return stat;
      },
    });

    assert.deepEqual(result, {
      ok: false,
      reasonCode: 'post-read-swap-changed-during-read',
    });
  }
});

test('state-bounds measures a real read and rejects a runtime symlink escape', async () => {
  const executor = getJourney('persistence.state-bounds').executor;
  const root = tmpRoot();
  const runtime = join(root, 'opensip-cli', '.runtime');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'datastore.sqlite'), 'state');
  const history = jsonResult({ data: { type: 'history', sessions: [] } });
  const safe = queuedContext([history], { workRoot: root });
  const safeOutcome = await executor(safe.context);
  assert.equal(safeOutcome.status, 'pass');
  assert.deepEqual(safe.calls, [['sessions', 'list', '--json']]);
  assert.deepEqual(boundedDirSize(runtime), {
    bytes: 5,
    truncated: false,
    unsafe: false,
  });

  const escapedRoot = tmpRoot();
  const outside = tmpRoot('pa-runtime-outside-');
  mkdirSync(join(escapedRoot, 'opensip-cli'), { recursive: true });
  symlinkSync(outside, join(escapedRoot, 'opensip-cli', '.runtime'));
  const escaped = queuedContext([history], { workRoot: escapedRoot });
  const outcome = await executor(escaped.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'runtime-state-escaped');
});

test('cache-init replay selects the project by process cwd, not an unsupported runs-show flag', () => {
  assert.deepEqual(buildRunsShowArgs('run_01'), ['runs', 'show', 'run_01', '--json']);
});

// ---------------------------------------------------------------------------
// Command journeys via a fake port
// ---------------------------------------------------------------------------

test('runCli executes a Windows installed descriptor through Node without splitting Unicode paths', async () => {
  const cmdPath = 'C:\\Acceptance Runs\\wörk späce ✓\\node_modules\\.bin\\opensip.cmd';
  const scriptPath = 'C:\\Acceptance Runs\\wörk späce ✓\\node_modules\\opensip-cli\\dist\\index.js';
  let observed;
  const context = {
    installed: {
      installedBin: { kind: 'installed-bin', bin: cmdPath },
      jsEntrypoint: { kind: 'node-script', script: scriptPath },
    },
    paths: { workRoot: 'C:\\Acceptance Runs\\wörk späce ✓' },
    process: {
      run: (spec) => {
        observed = spec;
        return Promise.resolve(measured());
      },
    },
  };

  await runCli(context, { args: ['report', '--title', 'résumé review ✓'] });

  assert.deepEqual(observed.argv, [
    process.execPath,
    scriptPath,
    'report',
    '--title',
    'résumé review ✓',
  ]);
  assert.equal(observed.cwd, context.paths.workRoot);
  assert.ok(!observed.argv.includes(cmdPath));
});

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
  // The first fit-pack step's setup does `mkdirSync(join(workRoot, 'src'), …)`.
  // Route the workRoot THROUGH a regular file so that recursive mkdir fails with
  // ENOTDIR before any port call — deterministically on macOS and Linux, root or
  // non-root. A bare `/proc/…` path is environment-dependent: on Linux the
  // recursive mkdir neither throws nor returns as this test assumed, wedging the
  // executor (the cause of the pre-existing `test:scripts` hang on the Linux CI
  // runner, where `test:scripts` first reaches this file).
  const blockingFile = join(tmpRoot(), 'not-a-directory');
  writeFileSync(blockingFile, 'x');
  const { context } = queuedContext([], {
    workRoot: join(blockingFile, 'deep'),
  });
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
  assert.equal(happy.specs[0].env.npm_config_offline, 'true');
  assert.equal(happy.specs[0].env.npm_config_legacy_peer_deps, 'true');
  assert.ok(happy.specs[0].env.npm_config_cache.startsWith(workRoot));

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
  const { context, specs } = queuedContext([
    measured({ status: 0 }), // init
    jsonResult({ data: { success: true } }), // sim plugin add
    jsonResult({ envelope: { schemaVersion: 2, tool: 'sim', signals: [] } }), // sim --recipe (runs)
    measured({ status: 0 }), // sim plugin remove
    measured({ status: 1 }), // post-removal sim --recipe (recipe gone)
  ]);
  const outcome = await simPackExecutor(context);
  assert.equal(outcome.status, 'pass');
  assert.equal(specs[1].env.npm_config_offline, 'true');
  assert.equal(specs[1].env.npm_config_legacy_peer_deps, 'true');
  assert.ok(specs[1].env.npm_config_cache.startsWith(context.paths.workRoot));
});

test('whole-tool npm mutations use an isolated offline cache', () => {
  const cwd = tmpRoot();
  const steps = getJourney('extensions.whole-tool').commandSteps({
    cwd,
    toolPluginTarball: '/fx/tool.tgz',
  });
  for (const step of steps) {
    assert.equal(step.env.npm_config_offline, 'true');
    assert.equal(step.env.npm_config_legacy_peer_deps, 'true');
    assert.ok(step.env.npm_config_cache.startsWith(cwd));
  }
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
// output executors — exit status and envelope identity remain authoritative
// ---------------------------------------------------------------------------

test('analysis.audit-preinit seeds a source project without initializing OpenSIP', async () => {
  const workRoot = tmpRoot();
  const audit = queuedContext([jsonResult({ data: { type: 'suite-run', suite: 'audit' } })], {
    workRoot,
  });

  const outcome = await getJourney('analysis.audit-preinit').executor(audit.context);

  assert.equal(outcome.status, 'pass');
  assert.equal(existsSync(join(workRoot, 'src', 'index.ts')), true);
  assert.equal(existsSync(join(workRoot, 'tsconfig.json')), true);
  assert.equal(existsSync(join(workRoot, 'opensip-cli.config.yml')), false);
});

test('analysis.fit seeds task-context source and test evidence without extra console findings', () => {
  const workRoot = tmpRoot();
  writeFileSync(
    join(workRoot, 'opensip-cli.config.yml'),
    'schemaVersion: 1\n\ntargets:\n  typescript-source:\n\nfitness:\n  disabledChecks: []\n',
  );
  const fit = getJourney('analysis.fit');
  const firstStep = fit.commandSteps?.({ cwd: workRoot });
  firstStep?.[0]?.setup?.({ cwd: workRoot });

  const source = readFileSync(join(workRoot, 'src', 'bad.ts'), 'utf8');
  const testSource = readFileSync(join(workRoot, 'src', 'bad.test.ts'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(workRoot, 'package.json'), 'utf8'));
  const config = readFileSync(join(workRoot, 'opensip-cli.config.yml'), 'utf8');
  assert.match(source, /export function bad/);
  assert.equal(source.match(/console\.log/g)?.length, 1);
  assert.match(testSource, /import \{ bad \}/);
  assert.match(testSource, /bad\(\)/);
  assert.equal(packageJson.scripts.test, 'vitest run');
  assert.match(config, /typescript-tests:[\s\S]*concerns: \[test\]/);
});

test('output.filters-raw accepts nested filtered data and an unwrapped raw result', async () => {
  const envelope = { schemaVersion: 2, tool: 'fit', signals: [] };
  const filtered = {
    data: {
      type: 'agent-filtered',
      envelope,
      filtersApplied: ['errors-only', 'top:5'],
      originalSignalCount: 1,
      returnedSignalCount: 0,
    },
  };
  const raw = {
    type: 'agent-filtered',
    envelope,
    filtersApplied: [],
    originalSignalCount: 1,
    returnedSignalCount: 1,
  };
  const queued = queuedContext([
    jsonResult(filtered, { status: 1 }),
    jsonResult(raw, { status: 1 }),
  ]);

  const outcome = await getJourney('output.filters-raw').executor(queued.context);

  assert.equal(outcome.status, 'pass');
});

test('output.filters-raw rejects a parseable filtered payload with the wrong exit or tool', async () => {
  const executor = getJourney('output.filters-raw').executor;
  const fitEnvelope = {
    envelope: { schemaVersion: 2, tool: 'fit', signals: [] },
  };

  const wrongExit = queuedContext([jsonResult(fitEnvelope, { status: 0 })]);
  const exitOutcome = await executor(wrongExit.context);
  assert.equal(exitOutcome.status, 'fail');
  assert.equal(exitOutcome.reasonCode, 'filtered-unexpected-exit');

  const wrongTool = queuedContext([
    jsonResult({ envelope: { schemaVersion: 2, tool: 'graph', signals: [] } }, { status: 1 }),
  ]);
  const toolOutcome = await executor(wrongTool.context);
  assert.equal(toolOutcome.status, 'fail');
  assert.equal(toolOutcome.reasonCode, 'filtered-envelope-invalid');
});

test('output.sarif requires both a graph JSON envelope and the SARIF side file', async () => {
  const validRoot = tmpRoot();
  writeFileSync(
    join(validRoot, 'acceptance-graph.sarif'),
    JSON.stringify({ version: '2.1.0', runs: [] }),
  );
  const valid = queuedContext([jsonResult({ schemaVersion: 2, tool: 'graph', signals: [] })], {
    workRoot: validRoot,
  });
  const validOutcome = await getJourney('output.sarif').executor(valid.context);
  assert.equal(validOutcome.status, 'pass');

  const invalidRoot = tmpRoot();
  writeFileSync(
    join(invalidRoot, 'acceptance-graph.sarif'),
    JSON.stringify({ version: '2.1.0', runs: [] }),
  );
  const invalid = queuedContext([jsonResult({ schemaVersion: 2, tool: 'fit', signals: [] })], {
    workRoot: invalidRoot,
  });
  const invalidOutcome = await getJourney('output.sarif').executor(invalid.context);
  assert.equal(invalidOutcome.status, 'fail');
  assert.equal(invalidOutcome.reasonCode, 'sarif-envelope-invalid');
});

test('output side-file journeys cannot pass when the producing command fails', async () => {
  const sarifRoot = tmpRoot();
  const sarif = queuedContext([], { workRoot: sarifRoot });
  sarif.context.process.run = (spec) => {
    const path = spec.argv[spec.argv.indexOf('--sarif') + 1];
    writeFileSync(path, JSON.stringify({ version: '2.1.0', runs: [] }));
    return Promise.resolve(measured({ status: 2 }));
  };
  const sarifOutcome = await getJourney('output.sarif').executor(sarif.context);
  assert.equal(sarifOutcome.status, 'fail');
  assert.equal(sarifOutcome.reasonCode, 'sarif-command-failed');

  const reportRoot = tmpRoot();
  const reportPath = join(reportRoot, 'report.html');
  writeFileSync(reportPath, '<!doctype html><html></html>');
  const report = queuedContext(
    [jsonResult({ data: { type: 'report', path: reportPath } }, { status: 2 })],
    { workRoot: reportRoot },
  );
  const reportOutcome = await getJourney('output.report-html').executor(report.context);
  assert.equal(reportOutcome.status, 'fail');
  assert.equal(reportOutcome.reasonCode, 'report-command-failed');
});

// ---------------------------------------------------------------------------
// resilience executors — cancellation / timeout residue / permission handling
// ---------------------------------------------------------------------------

test('resilience.isolated-home seeds a zero-init project and requires a successful graph run', async () => {
  const workRoot = tmpRoot();
  const valid = queuedContext([], { workRoot });
  valid.context.process.run = (spec) => {
    assert.equal(existsSync(join(workRoot, 'src', 'bad.ts')), true);
    assert.equal(existsSync(join(workRoot, 'tsconfig.json')), true);
    assert.equal(existsSync(join(workRoot, 'opensip-cli.config.yml')), false);
    mkdirSync(spec.env.XDG_CACHE_HOME, { recursive: true });
    writeFileSync(join(spec.env.XDG_CACHE_HOME, 'opensip-state'), 'created');
    return Promise.resolve(jsonResult({ schemaVersion: 2, tool: 'graph', signals: [] }));
  };

  const validOutcome = await getJourney('resilience.isolated-home').executor(valid.context);
  assert.equal(validOutcome.status, 'pass');

  const failed = queuedContext([measured({ status: 2, stderrTail: 'graph failed' })], {
    workRoot: tmpRoot(),
  });
  const failedOutcome = await getJourney('resilience.isolated-home').executor(failed.context);
  assert.equal(failedOutcome.status, 'fail');
  assert.equal(failedOutcome.reasonCode, 'isolated-home-command-failed');
});

test('resilience.signals requires cancellation with zero observed residual descendants', async () => {
  const executor = getJourney('resilience.signals').executor;

  const clean = queuedContext([
    measured({ cancelled: true, cleanup: { residualDescendants: 0 } }),
    measured({ stdoutCapture: '9.9.9\n' }),
  ]);
  const cleanOutcome = await executor(clean.context);
  assert.equal(cleanOutcome.status, 'pass');
  assert.deepEqual(clean.calls[1].slice(-1), ['--version']);

  const residue = queuedContext([
    measured({ cancelled: true, cleanup: { residualDescendants: 3 } }),
  ]);
  const leaky = await executor(residue.context);
  assert.equal(leaky.status, 'fail');
  assert.equal(leaky.reasonCode, 'signal-cancellation-failed');

  const notCancelled = queuedContext([measured({ cancelled: false })]);
  const notCancelledOutcome = await executor(notCancelled.context);
  assert.equal(notCancelledOutcome.status, 'fail');

  const notReusable = queuedContext([
    measured({ cancelled: true }),
    measured({ status: 2, stderrTail: 'version failed' }),
  ]);
  const notReusableOutcome = await executor(notReusable.context);
  assert.equal(notReusableOutcome.status, 'fail');
  assert.equal(notReusableOutcome.reasonCode, 'signal-reuse-failed');
});

test('resilience.timeout-cleanup requires timeout with zero observed residual descendants', async () => {
  const executor = getJourney('resilience.timeout-cleanup').executor;

  const clean = queuedContext([
    measured({ timedOut: true, cleanup: { residualDescendants: 0 } }),
    measured({ stdoutCapture: '9.9.9\n' }),
  ]);
  const cleanOutcome = await executor(clean.context);
  assert.equal(cleanOutcome.status, 'pass');
  assert.deepEqual(clean.calls[1].slice(-1), ['--version']);

  const residue = queuedContext([
    measured({ timedOut: true, cleanup: { residualDescendants: 1 } }),
  ]);
  const leaky = await executor(residue.context);
  assert.equal(leaky.status, 'fail');
  assert.equal(leaky.reasonCode, 'timeout-cleanup-failed');

  const notReusable = queuedContext([
    measured({ timedOut: true }),
    measured({ status: 2, stderrTail: 'version failed' }),
  ]);
  const notReusableOutcome = await executor(notReusable.context);
  assert.equal(notReusableOutcome.status, 'fail');
  assert.equal(notReusableOutcome.reasonCode, 'timeout-reuse-failed');
});

function persistenceBarrierContext({
  exhaustionSucceeds = false,
  exhaustionSettleDelayMs = 20,
  interrupt = false,
  interruptLockOutcome = 'stale',
  ownerLockDelayMs = 0,
  queuedWriterSettlesEarly = false,
  waiterOmitsWaitEvents = false,
  writerSettlesEarly = false,
} = {}) {
  const root = tmpRoot('pa-persistence-barrier-');
  const runtime = join(root, 'opensip-cli', '.runtime');
  const dbPath = join(runtime, 'datastore.sqlite');
  const writeLock = `${dbPath}.write.lock`;
  mkdirSync(runtime, { recursive: true });
  writeFileSync(dbPath, 'initialized');

  const { context } = queuedContext([], { workRoot: root });
  // Fast synthetic-lock hold for unit runs; production default is generous.
  context.timing = { syntheticQueueHoldMs: 50 };
  const calls = [];
  const sessions = [];
  let exhaustionCalls = 0;
  let waiterCalls = 0;
  let graphCalls = 0;
  let sessionGraphCalls = 0;
  let activeReleaseMarker = null;
  let competitorStartedBeforeOwnerLock = false;

  function releaseMarker() {
    return activeReleaseMarker !== null && existsSync(activeReleaseMarker)
      ? activeReleaseMarker
      : null;
  }

  function holdSqlite(spec) {
    const readyMarker = spec.argv.at(-3);
    activeReleaseMarker = spec.argv.at(-2);
    writeFileSync(readyMarker, JSON.stringify({ phase: 'transaction-active', walPresent: true }), {
      flag: 'wx',
    });
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (releaseMarker() !== null) {
          clearInterval(timer);
          resolve(measured());
        }
      }, 5);
      spec.signal?.addEventListener(
        'abort',
        () => {
          clearInterval(timer);
          resolve(measured({ status: null, cancelled: true }));
        },
        { once: true },
      );
    });
  }

  function waiterSuccessJson({ withWaitEvent }) {
    return jsonResult({
      kind: 'graph.run',
      status: 'ok',
      exitCode: 0,
      diagnostics: {
        events: withWaitEvent
          ? [
              {
                phase: 'persist',
                message: 'state.lock.acquire.wait',
                data: { resource: 'datastore', waitMs: 51, ownerPid: process.pid },
              },
            ]
          : [],
      },
    });
  }

  function runGraph(spec) {
    graphCalls += 1;
    const lockWaitMs = spec.env?.OPENSIP_STATE_LOCK_WAIT_MS;
    // The short-wait exhaustion probe runs with the journey's 250ms budget;
    // the queued waiter runs with its generous explicit budget. Classify by
    // value — both are env-overridden writers.
    if (lockWaitMs === '250') {
      exhaustionCalls += 1;
      if (!existsSync(writeLock)) competitorStartedBeforeOwnerLock = true;
      if (exhaustionSucceeds) return Promise.resolve(measured());
      const waitMs = Number(lockWaitMs);
      return new Promise((resolve) => {
        const timer = setTimeout(
          () =>
            resolve(
              jsonResult(
                {
                  kind: 'command.error',
                  status: 'error',
                  exitCode: 1,
                  errors: [{ message: 'state lock acquisition timed out' }],
                  diagnostics: {
                    events: [
                      {
                        phase: 'persist',
                        message: 'state.lock.acquire.timeout',
                        data: { resource: 'datastore', waitMs },
                      },
                    ],
                  },
                },
                { status: 1 },
              ),
            ),
          exhaustionSettleDelayMs,
        );
        spec.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve(measured({ status: null, cancelled: true }));
          },
          { once: true },
        );
      });
    }
    if (lockWaitMs !== undefined) {
      // Queued waiter: settles only after the synthetic lock is removed —
      // unless a knob simulates misbehavior.
      waiterCalls += 1;
      if (!existsSync(writeLock)) competitorStartedBeforeOwnerLock = true;
      if (queuedWriterSettlesEarly) {
        return Promise.resolve(waiterSuccessJson({ withWaitEvent: false }));
      }
      return new Promise((resolve) => {
        const timer = setInterval(() => {
          if (existsSync(writeLock)) return;
          clearInterval(timer);
          sessions.push({ id: 'graph-session-json-waiter', tool: 'graph' });
          resolve(waiterSuccessJson({ withWaitEvent: !waiterOmitsWaitEvents }));
        }, 5);
        spec.signal?.addEventListener(
          'abort',
          () => {
            clearInterval(timer);
            resolve(measured({ status: null, cancelled: true }));
          },
          { once: true },
        );
      });
    }

    sessionGraphCalls += 1;
    const writerNumber = sessionGraphCalls;
    if (writerSettlesEarly && writerNumber === 1) return Promise.resolve(measured());
    // A real interrupted CLI can either remove its outer lock during graceful
    // shutdown or leave the exact lock for the next writer to reclaim.
    if (interrupt && writerNumber > 1) {
      if (interruptLockOutcome === 'stale') {
        assert.equal(existsSync(writeLock), true, 'recovery should observe the stale lock');
        rmSync(writeLock, { force: true });
      } else {
        assert.equal(existsSync(writeLock), false, 'graceful shutdown should remove the lock');
      }
    }
    const lockContents = JSON.stringify({
      ownerToken: `writer-${writerNumber}`,
      pid: 7000 + writerNumber,
      command: 'graph',
    });

    if (interrupt && writerNumber === 1) {
      writeFileSync(writeLock, lockContents, { flag: 'wx' });
      return new Promise((resolve) => {
        spec.signal?.addEventListener(
          'abort',
          () => {
            switch (interruptLockOutcome) {
              case 'clean': {
                rmSync(writeLock, { force: true });
                break;
              }
              case 'foreign': {
                rmSync(writeLock, { force: true });
                writeFileSync(
                  writeLock,
                  JSON.stringify({
                    ownerToken: 'foreign-writer',
                    pid: 9001,
                    command: 'graph',
                  }),
                  { flag: 'wx' },
                );
                break;
              }
              case 'malformed': {
                rmSync(writeLock, { force: true });
                writeFileSync(writeLock, '{}', { flag: 'wx' });
                break;
              }
            }
            resolve(measured({ status: null, cancelled: true }));
          },
          { once: true },
        );
      });
    }

    return new Promise((resolve) => {
      let startTimer;
      let waitTimer;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (startTimer !== undefined) clearTimeout(startTimer);
        if (waitTimer !== undefined) clearInterval(waitTimer);
        rmSync(writeLock, { force: true });
        const id = `graph-session-${writerNumber}`;
        sessions.push({ id, tool: 'graph' });
        resolve(measured());
      };
      const finishWhenReleased = () => {
        if (releaseMarker() !== null) finish();
      };
      const start = () => {
        startTimer = undefined;
        writeFileSync(writeLock, lockContents, { flag: 'wx' });
        if (writerNumber > 1 || releaseMarker() !== null) {
          finish();
          return;
        }
        waitTimer = setInterval(finishWhenReleased, 5);
      };
      if (writerNumber === 1 && ownerLockDelayMs > 0) {
        startTimer = setTimeout(start, ownerLockDelayMs);
      } else {
        start();
      }
      spec.signal?.addEventListener(
        'abort',
        () => {
          if (settled) return;
          settled = true;
          if (startTimer !== undefined) clearTimeout(startTimer);
          if (waitTimer !== undefined) clearInterval(waitTimer);
          if (!interrupt) rmSync(writeLock, { force: true });
          resolve(measured({ status: null, cancelled: true }));
        },
        { once: true },
      );
    });
  }

  context.process.run = (spec) => {
    calls.push(spec);
    if (spec.argv.some((arg) => arg.endsWith('sqlite-acceptance-probe.mjs'))) {
      return holdSqlite(spec);
    }
    if (spec.argv.includes('init')) return Promise.resolve(measured());
    if (spec.argv.includes('graph')) return runGraph(spec);
    if (spec.argv.includes('list')) {
      return Promise.resolve(jsonResult({ data: { type: 'history', sessions: [...sessions] } }));
    }
    if (spec.argv.includes('show')) {
      const id = spec.argv[spec.argv.indexOf('show') + 1];
      return Promise.resolve(
        jsonResult({
          data: {
            session: { id, tool: 'graph' },
            fidelity: 'projection',
            envelope: { schemaVersion: 2, tool: 'graph' },
          },
        }),
      );
    }
    throw new Error(`unexpected persistence port call: ${spec.argv.join(' ')}`);
  };

  return {
    calls,
    context,
    get graphCalls() {
      return graphCalls;
    },
    get exhaustionCalls() {
      return exhaustionCalls;
    },
    get waiterCalls() {
      return waiterCalls;
    },
    get sessionGraphCalls() {
      return sessionGraphCalls;
    },
    get competitorStartedBeforeOwnerLock() {
      return competitorStartedBeforeOwnerLock;
    },
  };
}

test('persistence.contention-retry proves bounded exhaustion, a queued writer, and two public replays', async () => {
  const harness = persistenceBarrierContext();
  const outcome = await getJourney('persistence.contention-retry').executor(harness.context);
  assert.equal(outcome.status, 'pass');
  assert.equal(harness.graphCalls, 3);
  assert.equal(harness.exhaustionCalls, 1);
  assert.equal(harness.waiterCalls, 1);
  assert.equal(harness.sessionGraphCalls, 1);
  // Both direct runs are replayed: the phase-A --json waiter and phase-B owner.
  assert.equal(harness.calls.filter(({ argv }) => argv.includes('show')).length, 2);
  // Every competitor contended against an already-held lock.
  assert.equal(harness.competitorStartedBeforeOwnerLock, false);
  assert.ok(
    harness.calls.some(
      ({ argv, env }) => argv.includes('graph') && env?.OPENSIP_STATE_LOCK_WAIT_MS === '250',
    ),
  );
  assert.ok(
    harness.calls.some(
      ({ argv, env }) => argv.includes('graph') && env?.OPENSIP_STATE_LOCK_WAIT_MS === '15000',
    ),
  );
});

test('persistence contention cannot pass when the phase-B writer settles without locking', async () => {
  const harness = persistenceBarrierContext({ writerSettlesEarly: true });
  const outcome = await getJourney('persistence.contention-retry').executor(harness.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'contention-not-observed');
});

test('persistence contention tolerates a slow phase-B owner lock inside the probe window', async () => {
  const harness = persistenceBarrierContext({ ownerLockDelayMs: 650 });
  const outcome = await getJourney('persistence.contention-retry').executor(harness.context);
  assert.equal(outcome.status, 'pass');
  assert.equal(harness.competitorStartedBeforeOwnerLock, false);
});

test('persistence contention passes deterministically however slow the short-wait writer starts', async () => {
  // The regression that kept the macOS qualification lane red: the old fixed
  // release barrier expired while the short-wait writer was still in Node
  // startup on a slow 3-core VM; it arrived after release, succeeded against
  // a free lock, and the journey misreported the CLI's bounded timeout as
  // broken. Under the synthetic-lock design the lock is held until the
  // writer settles, so a slow start changes nothing.
  const harness = persistenceBarrierContext({ exhaustionSettleDelayMs: 2000 });
  const outcome = await getJourney('persistence.contention-retry').executor(harness.context);
  assert.equal(outcome.status, 'pass');
});

test('persistence contention cannot pass when bounded retry unexpectedly succeeds', async () => {
  const harness = persistenceBarrierContext({ exhaustionSucceeds: true });
  const outcome = await getJourney('persistence.contention-retry').executor(harness.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'contention-retry-not-exhausted');
  // Phase A fails fast: no phase-B writer ever launches.
  assert.equal(harness.sessionGraphCalls, 0);
});

test('persistence contention cannot pass when the queued writer settles before release', async () => {
  const harness = persistenceBarrierContext({ queuedWriterSettlesEarly: true });
  const outcome = await getJourney('persistence.contention-retry').executor(harness.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'contention-waiter-not-observed');
});

test('persistence contention requires the queued writer to record its wait on the owner', async () => {
  const harness = persistenceBarrierContext({ waiterOmitsWaitEvents: true });
  const outcome = await getJourney('persistence.contention-retry').executor(harness.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'contention-queue-not-observed');
});

test('persistence.interrupted-recovery cancels only after persistence and proves a fresh write', async () => {
  const harness = persistenceBarrierContext({ interrupt: true });
  const outcome = await getJourney('persistence.interrupted-recovery').executor(harness.context);
  assert.equal(outcome.status, 'pass');
  assert.equal(harness.graphCalls, 2);
  assert.equal(harness.exhaustionCalls, 0);
  assert.equal(harness.sessionGraphCalls, 2);
  assert.equal(harness.calls.filter(({ argv }) => argv.includes('show')).length, 1);
});

test('persistence.interrupted-recovery accepts graceful lock removal before a fresh write', async () => {
  const harness = persistenceBarrierContext({
    interrupt: true,
    interruptLockOutcome: 'clean',
  });
  const outcome = await getJourney('persistence.interrupted-recovery').executor(harness.context);
  assert.equal(outcome.status, 'pass');
  assert.equal(harness.graphCalls, 2);
  assert.equal(harness.calls.filter(({ argv }) => argv.includes('show')).length, 1);
});

test('persistence.interrupted-recovery rejects a different lock after cancellation', async () => {
  const harness = persistenceBarrierContext({
    interrupt: true,
    interruptLockOutcome: 'foreign',
  });
  const outcome = await getJourney('persistence.interrupted-recovery').executor(harness.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'interrupt-stale-lock-not-observed');
  assert.equal(harness.graphCalls, 1);
});

test('persistence.interrupted-recovery does not mistake an invalid lock for clean removal', async () => {
  const harness = persistenceBarrierContext({
    interrupt: true,
    interruptLockOutcome: 'malformed',
  });
  const outcome = await getJourney('persistence.interrupted-recovery').executor(harness.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'interrupt-stale-lock-not-observed');
  assert.equal(harness.graphCalls, 1);
});

test('resilience.permissions fails when a write into a read-only dir silently succeeds', async () => {
  const executor = getJourney('resilience.permissions').executor;

  // Exit non-zero → the CLI reported a reasoned failure → journey passes.
  const graceful = queuedContext([measured({ status: 1 })], {
    workRoot: tmpRoot(),
  });
  const gracefulOutcome = await executor(graceful.context);
  assert.equal(gracefulOutcome.status, 'pass');

  // Exit zero → init claimed success writing into a read-only dir → journey fails.
  const silent = queuedContext([measured({ status: 0 })], {
    workRoot: tmpRoot(),
  });
  const outcome = await executor(silent.context);
  assert.equal(outcome.status, 'fail');
  assert.equal(outcome.reasonCode, 'permission-denied-silently-succeeded');
});

function installedSmokeReport() {
  const metrics = { callCount: 1, responseBytes: 10, totalWallMs: 1 };
  const arm = (name) => ({
    assertions: { incorrectNone: 0, passed: true, scopes: [] },
    metrics,
    record: {
      arm: name,
      legs: [],
      setup: {},
      strategyVersion: 'test-v1',
      taskId: 'entrypoint-trace.customer-ts',
    },
    recoveryMetrics: metrics,
  });
  return {
    schemaVersion: 1,
    harnessVersion: '1.0.0',
    cliVersion: '9.9.9',
    cliTarget: {
      source: 'installed',
      entrypointName: 'index.js',
      entrypointSha256: `sha256:${'c'.repeat(64)}`,
      packageJsonSha256: `sha256:${'d'.repeat(64)}`,
    },
    completedAt: '2026-07-15T00:00:01.000Z',
    contractFingerprint: `sha256:${'a'.repeat(64)}`,
    gitSha: 'abcdef1',
    nodeVersion: process.version,
    platform: process.platform,
    promotionEligible: true,
    selectedArms: ['control', 'opensip'],
    sourceState: 'clean',
    startedAt: '2026-07-15T00:00:00.000Z',
    tasks: [
      {
        arms: { control: arm('control'), opensip: arm('opensip') },
        completedAt: '2026-07-15T00:00:01.000Z',
        taskId: 'entrypoint-trace.customer-ts',
      },
    ],
  };
}

function agentSmokeContext(writeReport, artifacts) {
  const workRoot = tmpRoot('pa-agent-smoke-');
  return {
    installed: {
      mode: 'packed-release',
      installedBin: { kind: 'installed-bin', bin: '/candidate/bin/opensip' },
      jsEntrypoint: {
        kind: 'node-script',
        script: '/candidate/dist/index.js',
        entrypointSha256: `sha256:${'c'.repeat(64)}`,
        packageJsonSha256: `sha256:${'d'.repeat(64)}`,
      },
      resolvedVersion: '9.9.9',
    },
    paths: { workRoot },
    fixtures: null,
    process: {
      run: (spec) => {
        const jsonIndex = spec.argv.indexOf('--json');
        writeReport?.(spec.argv[jsonIndex + 1]);
        return Promise.resolve(measured());
      },
    },
    assert: makeAssert(),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

test('agent.installed-smoke validates then preserves the complete report', async () => {
  let preserved;
  const context = agentSmokeContext(
    (path) => writeFileSync(path, `${JSON.stringify(installedSmokeReport())}\n`),
    {
      writeInstalledAgentReport: (report) => {
        preserved = report;
        return {
          bytes: 1,
          digest: 'a'.repeat(64),
          path: '/outside/report.json',
        };
      },
    },
  );
  const outcome = await getJourney('agent.installed-smoke').executor(context);
  assert.equal(outcome.status, 'pass');
  assert.equal(preserved.cliTarget.source, 'installed');
  assert.ok(outcome.diagnostics.includes(`sanitized report sha256:${'a'.repeat(64)}`));
});

test('agent.installed-smoke fails for missing, invalid, or unpreservable reports', async () => {
  const executor = getJourney('agent.installed-smoke').executor;
  const missing = await executor(agentSmokeContext());
  assert.equal(missing.status, 'fail');
  assert.equal(missing.reasonCode, 'installed-smoke-report-missing');

  const invalid = await executor(agentSmokeContext((path) => writeFileSync(path, '{}\n')));
  assert.equal(invalid.status, 'fail');
  assert.equal(invalid.reasonCode, 'installed-smoke-report-invalid');

  const writeFailure = await executor(
    agentSmokeContext(
      (path) => writeFileSync(path, `${JSON.stringify(installedSmokeReport())}\n`),
      {
        writeInstalledAgentReport: () => {
          throw Object.assign(new Error('private path'), {
            reasonCode: 'write-failed',
          });
        },
      },
    ),
  );
  assert.equal(writeFailure.status, 'fail');
  assert.equal(writeFailure.reasonCode, 'installed-smoke-report-write-failed');
  assert.doesNotMatch(writeFailure.diagnostics.join(' '), /private path/);
});

// ---------------------------------------------------------------------------
// Fixture packing — input guards (no npm) + one bounded real integration
// ---------------------------------------------------------------------------

test('fixed capability-pack fixtures declare the framework peers they import', () => {
  const fixtures = join(REPO_ROOT, 'packages', 'cli', 'src', '__tests__', 'fixtures');
  const cases = [
    ['fit-pack-plugin', '@opensip-cli/fitness'],
    ['sim-pack-plugin', '@opensip-cli/simulation'],
  ];
  for (const [fixture, framework] of cases) {
    const manifest = JSON.parse(readFileSync(join(fixtures, fixture, 'package.json'), 'utf8'));
    assert.equal(manifest.peerDependencies?.['@opensip-cli/core'], '>=0.1.11 <1');
    assert.equal(manifest.peerDependencies?.[framework], '>=0.1.11 <1');
  }
});

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
    () =>
      packFixtures({
        repoRoot: REPO_ROOT,
        destDir: join(tmpdir(), 'pa-absent-dest-xyz'),
      }),
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
