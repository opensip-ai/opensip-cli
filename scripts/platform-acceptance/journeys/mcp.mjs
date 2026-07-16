/**
 * @fileoverview MCP journeys — the agent protocol surface over stdio.
 *
 * Every MCP session is driven through the injected `context.mcp` client port,
 * which launches the child via the installed `jsEntrypoint`
 * (`node <jsEntrypoint> mcp --cwd <cwd>`) and performs the initialize handshake.
 * A journey NEVER spawns the server itself and NEVER parses stderr as protocol
 * data (the port exposes stderr only as a bounded summary). The initialize /
 * catalog-parity / context / graph-reads / result-replay journeys read the
 * shared, already-populated project (`isolated: false`); stale-evidence uses a
 * fresh, evidence-less project (`isolated: true`) to prove a reasoned fallback.
 *
 * The SDK client pattern mirrors `packages/agent-eval/src/adapters/opensip-mcp*`
 * — but the transport lives in the Phase 3 port, not here.
 */

import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expectEnvelope } from '../../cli-acceptance-core.mjs';
import {
  assertCommand,
  assertUniqueJourneyIds,
  defineJourney,
  fail,
  pass,
  runCli,
  unavailable,
} from '../journey-kit.mjs';
import { MAX_INSTALLED_AGENT_REPORT_BYTES } from '../agent-report-writer.mjs';
import { readBoundedOwnedTextFile } from '../bounded-owned-file.mjs';

const CONTEXT_STATUSES = new Set(['available', 'missing', 'unavailable']);
const FILE_SCOPE_STATUSES = new Set(['matched', 'mismatched', 'not-requested']);
const FILE_CONTEXT_STATUSES = new Set(['found', 'excluded', 'unknown', 'unavailable']);
const COVERAGE_STATUSES = new Set(['complete', 'partial', 'unavailable']);
const FRESHNESS_VERIFICATIONS = new Set(['complete', 'partial', 'missing']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Validate the public ContextStatusDto shape, including reasoned non-ready states. */
function contextStatusFailures(payload) {
  if (!isRecord(payload)) return ['context status payload is not an object'];
  const failures = [];
  if (!CONTEXT_STATUSES.has(payload.status)) {
    failures.push(`context status is invalid: ${JSON.stringify(payload.status)}`);
  }
  if (!isRecord(payload.fileScope) || !FILE_SCOPE_STATUSES.has(payload.fileScope.status)) {
    failures.push('context fileScope.status is missing or invalid');
  }
  if (!Array.isArray(payload.steps)) failures.push('context steps is not an array');
  if (!Array.isArray(payload.pointers)) failures.push('context pointers is not an array');
  if (!isStringArray(payload.reasonCodes))
    failures.push('context reasonCodes is not a string array');
  if (!isStringArray(payload.nextActions))
    failures.push('context nextActions is not a string array');
  if (payload.status === 'available') {
    if (!isRecord(payload.run)) failures.push('available context is missing run provenance');
    if (!isRecord(payload.manifest)) failures.push('available context is missing its manifest');
    if (!['ready', 'degraded', 'unavailable'].includes(payload.manifest?.readiness)) {
      failures.push('available context manifest has no valid readiness');
    }
  } else if (payload.status === 'missing' || payload.status === 'unavailable') {
    if (!Array.isArray(payload.reasonCodes) || payload.reasonCodes.length === 0) {
      failures.push('non-ready context did not provide a reason code');
    }
    if (!Array.isArray(payload.nextActions) || payload.nextActions.length === 0) {
      failures.push('non-ready context did not provide a next action');
    }
  }
  return failures;
}

/** Validate the bounded FileContextDto returned for the seeded acceptance file. */
function fileContextFailures(payload, expectedPath) {
  if (!isRecord(payload)) return ['file context payload is not an object'];
  const failures = [];
  if (!FILE_CONTEXT_STATUSES.has(payload.status)) {
    failures.push(`file context status is invalid: ${JSON.stringify(payload.status)}`);
  }
  if (payload.status !== 'found') {
    failures.push(`seeded file context was not found (status=${JSON.stringify(payload.status)})`);
  }
  if (!isRecord(payload.file) || payload.file.path !== expectedPath) {
    failures.push(`file context did not identify ${JSON.stringify(expectedPath)}`);
  }
  if (!isRecord(payload.project)) failures.push('file context is missing project facts');
  if (!isNonEmptyString(payload.inventoryIdentity)) {
    failures.push('file context is missing its inventory identity');
  }
  if (!isRecord(payload.coverage) || !COVERAGE_STATUSES.has(payload.coverage.status)) {
    failures.push('file context coverage is missing or invalid');
  }
  if (
    !isRecord(payload.freshness) ||
    typeof payload.freshness.fresh !== 'boolean' ||
    !isNonEmptyString(payload.freshness.capturedAt) ||
    !FRESHNESS_VERIFICATIONS.has(payload.freshness.verification) ||
    !isStringArray(payload.freshness.reasonCodes)
  ) {
    failures.push('file context freshness is missing or invalid');
  }
  if (!isStringArray(payload.reasonCodes)) failures.push('file context reasonCodes is invalid');
  if (!isStringArray(payload.nextActions)) failures.push('file context nextActions is invalid');
  return failures;
}

/** Validate one show_run response against the exact list_runs pointer selected. */
function replayFailures(payload, selectedRun) {
  if (!isRecord(payload)) return ['show_run payload is not an object'];
  const failures = [];
  if (!isRecord(payload.session) || payload.session.id !== selectedRun.id) {
    failures.push(`show_run session id does not match ${JSON.stringify(selectedRun.id)}`);
  }
  if (!isRecord(payload.session) || payload.session.tool !== selectedRun.tool) {
    failures.push(`show_run session tool does not match ${JSON.stringify(selectedRun.tool)}`);
  }
  if (!isRecord(payload.data) || payload.data.fidelity !== 'projection') {
    failures.push('show_run fidelity is not "projection"');
  }
  const envelope = isRecord(payload.data) ? payload.data.envelope : undefined;
  failures.push(...expectEnvelope({ tool: selectedRun.tool })(envelope));
  if (!isRecord(envelope) || envelope.runId !== selectedRun.id) {
    failures.push(`replayed envelope runId does not match ${JSON.stringify(selectedRun.id)}`);
  }
  if (!isRecord(envelope?.verdict)) failures.push('replayed envelope verdict is missing');
  if (!Array.isArray(envelope?.units)) failures.push('replayed envelope units is not an array');
  if (!isRecord(envelope?.baselineIdentity)) {
    failures.push('replayed envelope baselineIdentity is missing');
  }
  return failures;
}

/**
 * Decode one MCP tool result into `{ isError, text, payload }`. The single text
 * content item carries the JSON payload; stderr is never consulted.
 */
function decodeMcp(result) {
  const record = result !== null && typeof result === 'object' ? result : {};
  const isError = record.isError === true;
  const content = Array.isArray(record.content) ? record.content : [];
  const textItem = content.find(
    (item) => item !== null && typeof item === 'object' && item.type === 'text',
  );
  const text = typeof textItem?.text === 'string' ? textItem.text : '';
  let payload;
  try {
    payload = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  return { isError, text, payload };
}

/** Connect through the injected port, run `fn(client)`, and always close. */
async function withMcp(context, cwd, fn) {
  if (context.mcp === undefined) {
    return unavailable('mcp-port-missing', [
      context.assert.diagnostic('no MCP client port was injected for an mcp journey'),
    ]);
  }
  let client;
  try {
    client = await context.mcp.connect({ cwd });
  } catch (error) {
    return fail('mcp-connect-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
  let outcome;
  try {
    outcome = await fn(client);
  } catch (error) {
    outcome = fail('mcp-call-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
  try {
    await client.close();
  } catch (error) {
    return fail('mcp-close-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
  const stderr = client.stderrSummary();
  if (stderr.truncated) {
    return fail('mcp-output-overflow', [
      context.assert.diagnostic(
        `MCP stderr exceeded its bounded capture after ${stderr.bytes} byte(s)`,
      ),
    ]);
  }
  return outcome;
}

const CONTEXT_GIT_STEPS = Object.freeze([
  Object.freeze({ label: 'git init', argv: Object.freeze(['git', 'init', '--quiet']) }),
  Object.freeze({ label: 'git add', argv: Object.freeze(['git', 'add', '--all']) }),
  Object.freeze({
    label: 'git commit',
    argv: Object.freeze([
      'git',
      '-c',
      'user.name=OpenSIP Acceptance',
      '-c',
      'user.email=acceptance@invalid',
      'commit',
      '--quiet',
      '--no-gpg-sign',
      '-m',
      'seed acceptance project',
    ]),
    env: Object.freeze({
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    }),
  }),
]);

/** Commit the shared fixture so task-context source identity is real and stable. */
async function commitContextFixture(context) {
  for (const step of CONTEXT_GIT_STEPS) {
    const result = await context.process.run({
      argv: step.argv,
      cwd: context.paths.workRoot,
      ...(step.env === undefined ? {} : { env: step.env }),
    });
    const outcome = assertCommand(
      context,
      result,
      { exitCode: 0 },
      'context-git-seed-failed',
      step.label,
    );
    if (outcome.status !== 'pass') return outcome;
  }
  return pass();
}

const initializeExecutor = (context) =>
  withMcp(context, context.paths.workRoot, async (client) => {
    const version = client.serverVersion();
    if (
      version === undefined ||
      typeof version.name !== 'string' ||
      typeof version.version !== 'string'
    ) {
      return fail('no-server-version', [
        context.assert.diagnostic('MCP server did not report a version after initialize'),
      ]);
    }
    return pass();
  });

const catalogParityExecutor = (context) =>
  withMcp(context, context.paths.workRoot, async (client) => {
    const [catalogResult, listed] = await Promise.all([
      client.callTool({ name: 'get_agent_catalog', arguments: {} }),
      client.listTools(),
    ]);
    const catalog = decodeMcp(catalogResult);
    if (catalog.isError || catalog.payload === undefined) {
      return fail('catalog-unavailable', [
        context.assert.diagnostic(
          catalog.text || 'get_agent_catalog returned no decodable payload',
        ),
      ]);
    }
    const catalogNames = catalog.payload?.mcp?.toolNames;
    if (!Array.isArray(catalogNames)) {
      return fail('catalog-missing-tool-names', [
        context.assert.diagnostic('agent catalog did not advertise mcp.toolNames'),
      ]);
    }
    const listedNames = Array.isArray(listed?.tools)
      ? listed.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
      : [];
    const catalogSet = new Set(catalogNames);
    const listedSet = new Set(listedNames);
    const failures = [];
    if (listedSet.size === 0) failures.push('listTools returned no tools');
    if (catalogSet.size !== listedSet.size)
      failures.push(
        `tool count mismatch: catalog ${catalogSet.size} vs listTools ${listedSet.size}`,
      );
    for (const name of listedSet) {
      if (!catalogSet.has(name))
        failures.push(`listTools tool ${JSON.stringify(name)} is absent from the catalog`);
    }
    return failures.length === 0
      ? pass()
      : fail(
          'catalog-parity-mismatch',
          failures.map((f) => context.assert.diagnostic(f)),
        );
  });

const contextExecutor = async (context) => {
  const committed = await commitContextFixture(context);
  if (committed.status !== 'pass') return committed;

  const captured = await runCli(context, {
    args: ['suite', 'run', 'agent-context', '--files', 'src/bad.ts', '--json'],
  });
  const captureOutcome = assertCommand(
    context,
    captured,
    {
      exitCode: 0,
      json: (parsed) => {
        const data = parsed?.data ?? parsed;
        const failures = [];
        if (data?.type !== 'suite-run') failures.push('agent-context did not return a suite-run');
        if (data?.suite !== 'agent-context') failures.push('agent-context suite identity is wrong');
        if (data?.contextManifest?.readiness !== 'ready') {
          failures.push(
            `agent-context readiness is ${JSON.stringify(data?.contextManifest?.readiness)}, expected "ready"`,
          );
        }
        return failures;
      },
    },
    'context-capture-failed',
  );
  if (captureOutcome.status !== 'pass') return captureOutcome;

  return withMcp(context, context.paths.workRoot, async (client) => {
    const status = decodeMcp(
      await client.callTool({
        name: 'get_context_status',
        arguments: { files: ['src/bad.ts'] },
      }),
    );
    if (status.isError || status.payload === undefined) {
      return fail('context-status-error', [
        context.assert.diagnostic(status.text || 'get_context_status returned no payload'),
      ]);
    }
    const statusFailures = contextStatusFailures(status.payload);
    if (statusFailures.length > 0) {
      return fail(
        'context-status-invalid',
        statusFailures.map((failure) => context.assert.diagnostic(failure)),
      );
    }
    if (
      status.payload.status !== 'available' ||
      status.payload.fileScope?.status !== 'matched' ||
      status.payload.manifest?.readiness !== 'ready' ||
      status.payload.pointers.length === 0 ||
      !status.payload.pointers.every((pointer) => pointer?.status === 'available')
    ) {
      return fail('context-status-not-ready', [
        context.assert.diagnostic(
          'captured task context was not available, scope-matched, ready, and pointer-backed',
        ),
      ]);
    }
    const fileContext = decodeMcp(
      await client.callTool({
        name: 'get_file_context',
        arguments: { file: 'src/bad.ts' },
      }),
    );
    if (fileContext.isError || fileContext.payload === undefined) {
      return fail('file-context-error', [
        context.assert.diagnostic(fileContext.text || 'get_file_context returned no payload'),
      ]);
    }
    const fileFailures = fileContextFailures(fileContext.payload, 'src/bad.ts');
    if (fileFailures.length > 0) {
      return fail(
        'file-context-invalid',
        fileFailures.map((failure) => context.assert.diagnostic(failure)),
      );
    }
    return pass();
  });
};

const graphReadsExecutor = (context) =>
  withMcp(context, context.paths.workRoot, async (client) => {
    const arch = decodeMcp(await client.callTool({ name: 'get_architecture', arguments: {} }));
    if (arch.isError || arch.payload === undefined) {
      return fail('graph-read-failed', [
        context.assert.diagnostic(arch.text || 'get_architecture returned no payload'),
      ]);
    }
    return pass();
  });

const resultReplayExecutor = (context) =>
  withMcp(context, context.paths.workRoot, async (client) => {
    const runs = decodeMcp(await client.callTool({ name: 'list_runs', arguments: {} }));
    if (runs.isError || runs.payload === undefined) {
      return fail('list-runs-error', [
        context.assert.diagnostic(runs.text || 'list_runs returned no payload'),
      ]);
    }
    if (!isRecord(runs.payload) || !Array.isArray(runs.payload.runs)) {
      return fail('list-runs-invalid', [
        context.assert.diagnostic('list_runs payload did not contain a runs array'),
      ]);
    }
    if (runs.payload.runs.length === 0) {
      return fail('no-stored-run', [
        context.assert.diagnostic('list_runs returned no run id to replay'),
      ]);
    }
    const malformedIndex = runs.payload.runs.findIndex(
      (run) => !isRecord(run) || !isNonEmptyString(run.id) || !isNonEmptyString(run.tool),
    );
    if (malformedIndex >= 0) {
      return fail('list-runs-invalid', [
        context.assert.diagnostic(`list_runs row ${malformedIndex} is missing id/tool identity`),
      ]);
    }
    const selectedRun = runs.payload.runs[0];
    const shown = decodeMcp(
      await client.callTool({
        name: 'show_run',
        arguments: { ref: selectedRun.id },
      }),
    );
    if (shown.isError || shown.payload === undefined) {
      return fail('show-run-failed', [
        context.assert.diagnostic(shown.text || 'show_run returned no payload'),
      ]);
    }
    const failures = replayFailures(shown.payload, selectedRun);
    if (failures.length > 0) {
      return fail(
        'show-run-invalid',
        failures.map((failure) => context.assert.diagnostic(failure)),
      );
    }
    return pass();
  });

const staleEvidenceExecutor = async (context) => {
  // A file that exists but has NO recorded context / built catalog is the
  // stale-or-missing-evidence probe.
  const probe = join(context.paths.workRoot, 'probe.ts');
  try {
    writeFileSync(probe, 'export const probe = 1;\n');
  } catch (error) {
    return fail('probe-setup-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }

  // MCP is a project-scoped command. Initialize only the config surface so the
  // server can start, while deliberately leaving context and graph evidence absent.
  const initialized = await runCli(context, {
    args: ['init', '--language', 'typescript', '--json'],
  });
  const initOutcome = assertCommand(
    context,
    initialized,
    {
      exitCode: 0,
      json: (parsed) =>
        (parsed?.data ?? parsed)?.type === 'init'
          ? []
          : ['isolated project init did not return type "init"'],
    },
    'stale-evidence-init-failed',
  );
  if (initOutcome.status !== 'pass') return initOutcome;

  return withMcp(context, context.paths.workRoot, async (client) => {
    const status = decodeMcp(
      await client.callTool({
        name: 'get_context_status',
        arguments: { files: ['probe.ts'] },
      }),
    );
    if (status.isError || status.payload === undefined) {
      return fail('stale-evidence-read-error', [
        context.assert.diagnostic(
          status.text || 'stale-evidence read returned no decodable status payload',
        ),
      ]);
    }
    const failures = contextStatusFailures(status.payload);
    if (status.payload.status !== 'missing' && status.payload.status !== 'unavailable') {
      failures.push(
        `evidence-less context status is ${JSON.stringify(status.payload.status)}, expected missing/unavailable`,
      );
    }
    if (status.payload.fileScope?.status !== 'mismatched') {
      failures.push('evidence-less requested file scope was not reported as mismatched');
    }
    if (!Array.isArray(status.payload.steps) || status.payload.steps.length > 0) {
      failures.push('evidence-less context unexpectedly returned stored steps');
    }
    if (!Array.isArray(status.payload.pointers) || status.payload.pointers.length > 0) {
      failures.push('evidence-less context unexpectedly returned stored pointers');
    }
    if (
      !Array.isArray(status.payload.reasonCodes) ||
      !status.payload.reasonCodes.some(
        (reason) => reason === 'context-run-missing' || reason === 'context-run-pre-feature',
      )
    ) {
      failures.push('evidence-less context omitted its context-run reason code');
    }
    return failures.length === 0
      ? pass()
      : fail(
          'stale-evidence-invalid',
          failures.map((failure) => context.assert.diagnostic(failure)),
        );
  });
};

export const mcpJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'mcp.initialize',
    category: 'mcp',
    value: {
      human: 'Agents can connect',
      agent: 'the MCP stdio server completes initialize and reports a version',
    },
    steps: [{ label: 'connect over stdio' }, { label: 'assert serverVersion is present' }],
    executor: initializeExecutor,
  }),
  defineJourney({
    id: 'mcp.catalog-parity',
    category: 'mcp',
    value: {
      human: 'The tool surface is consistent',
      agent: 'get_agent_catalog toolNames match listTools exactly',
    },
    steps: [{ label: 'call get_agent_catalog + listTools' }, { label: 'assert name/count parity' }],
    executor: catalogParityExecutor,
  }),
  defineJourney({
    id: 'mcp.context',
    category: 'mcp',
    value: {
      human: 'Agents get task context',
      agent: 'captured task context replays as ready/matched and the seeded file is found',
    },
    steps: [
      { label: 'commit the seeded source and test fixture' },
      { label: 'capture agent-context for src/bad.ts' },
      { label: 'require ready, scope-matched pointer replay' },
      { label: 'require bounded file context for src/bad.ts' },
    ],
    executor: contextExecutor,
  }),
  defineJourney({
    id: 'mcp.graph-reads',
    category: 'mcp',
    value: {
      human: 'Agents can read the graph',
      agent: 'get_architecture returns a decodable payload',
    },
    steps: [{ label: 'call get_architecture' }, { label: 'assert a non-error payload' }],
    executor: graphReadsExecutor,
  }),
  defineJourney({
    id: 'mcp.result-replay',
    category: 'mcp',
    value: {
      human: 'Agents replay stored results',
      agent: 'list_runs → show_run replays a persisted run',
    },
    steps: [{ label: 'call list_runs → id' }, { label: 'call show_run { ref: id }' }],
    executor: resultReplayExecutor,
  }),
  defineJourney({
    id: 'mcp.stale-evidence',
    category: 'mcp',
    value: {
      human: 'Missing evidence is honest',
      agent: 'an evidence-less read returns a reason/fallback, never a false ready',
    },
    isolated: true,
    steps: [
      { label: 'write a probe file (no recorded context)' },
      { label: 'initialize the isolated project without producing evidence' },
      { label: 'call get_context_status' },
      { label: 'assert a reasoned fallback, no green-wash' },
    ],
    executor: staleEvidenceExecutor,
  }),
]);

// ---------------------------------------------------------------------------
// Agent-surface journey — the private agent-eval gold-task smoke against the
// installed candidate. Direct MCP journeys prove protocol behaviour; this proves
// an agent can USE the installed CLI's catalog/graph evidence to satisfy a fixed
// gold task. The executor shells ONLY to the repo's built private harness
// (packages/agent-eval/dist/cli.js) and hands it the installed entrypoint via
// `--opensip-entrypoint`; the harness itself targets the installed CLI path.
// ---------------------------------------------------------------------------

/** The repo root, resolved from this module's fixed location (scripts/platform-acceptance/journeys/). */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const AGENT_EVAL_CLI = join(REPO_ROOT, 'packages', 'agent-eval', 'dist', 'cli.js');
const AGENT_EVAL_MODEL = join(REPO_ROOT, 'packages', 'agent-eval', 'dist', 'report', 'model.js');
/** Bound the private harness run (fixture init + graph + two MCP arms). */
const INSTALLED_SMOKE_TIMEOUT_MS = 300_000;
const INSTALLED_SMOKE_TASK_ID = 'entrypoint-trace.customer-ts';

/** Load the agent-eval schema validator from its built dist (ESM caches the module). */
async function loadReportValidator() {
  const module = await import(pathToFileURL(AGENT_EVAL_MODEL).href);
  const validate = module.validateEvalReport;
  if (typeof validate !== 'function') {
    throw new TypeError('agent-eval dist did not export validateEvalReport');
  }
  return validate;
}

/** A one-line, bounded human/agent summary of the installed smoke report. */
function summarizeInstalledSmoke(report) {
  const arms = Array.isArray(report.selectedArms) ? report.selectedArms.join('+') : 'none';
  const opensipPassed = report.tasks?.[0]?.arms?.opensip?.assertions?.passed === true;
  return `installed agent smoke: cliVersion=${report.cliVersion} targetSource=${report.cliTarget?.source} arms=${arms} opensip.passed=${opensipPassed} sourceState=${report.sourceState}`;
}

/** Collect every acceptance requirement the installed smoke report fails, if any. */
function collectInstalledSmokeFailures(report, installed) {
  const failures = [];
  const selected = new Set(Array.isArray(report.selectedArms) ? report.selectedArms : []);
  if (selected.size !== 2 || !selected.has('control') || !selected.has('opensip')) {
    failures.push(
      `report did not run exactly both arms (selectedArms=${[...selected].join(',') || 'none'})`,
    );
  }
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  if (tasks.length !== 1) {
    failures.push(`the smoke report contains ${tasks.length} task(s), expected exactly one`);
  }
  const smokeTask = tasks[0];
  if (smokeTask?.taskId !== INSTALLED_SMOKE_TASK_ID) {
    failures.push(
      `the smoke task is ${JSON.stringify(smokeTask?.taskId)}, expected ${JSON.stringify(INSTALLED_SMOKE_TASK_ID)}`,
    );
  }
  const taskArms = smokeTask?.arms ?? {};
  if (taskArms.control === undefined || taskArms.opensip === undefined) {
    failures.push('the smoke task is missing a control or opensip arm result');
  }
  for (const arm of ['control', 'opensip']) {
    if (taskArms[arm]?.record?.taskId !== INSTALLED_SMOKE_TASK_ID) {
      failures.push(`${arm} arm did not execute the fixed smoke task`);
    }
  }
  if (taskArms.opensip?.assertions?.passed !== true) {
    failures.push('the OpenSIP arm assertions did not pass on the installed candidate');
  }
  if (report.cliTarget?.source !== 'installed') {
    failures.push(
      `report target source is ${JSON.stringify(report.cliTarget?.source)}, expected "installed"`,
    );
  }
  const expectedEntrypointSha256 = installed?.jsEntrypoint?.entrypointSha256;
  const expectedPackageJsonSha256 = installed?.jsEntrypoint?.packageJsonSha256;
  if (
    typeof expectedEntrypointSha256 !== 'string' ||
    typeof expectedPackageJsonSha256 !== 'string'
  ) {
    failures.push('the installed candidate identity omitted its pinned package digests');
  } else {
    if (report.cliTarget?.entrypointSha256 !== expectedEntrypointSha256) {
      failures.push('report entrypoint digest does not match the installed candidate identity');
    }
    if (report.cliTarget?.packageJsonSha256 !== expectedPackageJsonSha256) {
      failures.push('report package.json digest does not match the installed candidate identity');
    }
  }
  const expectedVersion = installed?.resolvedVersion;
  if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
    failures.push('the installed candidate identity has no resolved version to match');
  } else if (report.cliVersion !== expectedVersion) {
    failures.push(
      `report cliVersion ${JSON.stringify(report.cliVersion)} does not match installed ${JSON.stringify(expectedVersion)}`,
    );
  }
  if (report.sourceState !== 'clean') {
    failures.push(
      `the report sourceState is ${JSON.stringify(report.sourceState)}, expected "clean"`,
    );
  }
  if (report.promotionEligible !== true) {
    failures.push('the report is not promotion-eligible');
  }
  return failures;
}

const installedAgentSmokeExecutor = async (context) => {
  const script = context.installed?.jsEntrypoint?.script;
  if (typeof script !== 'string' || script.length === 0) {
    return unavailable('installed-entrypoint-missing', [
      context.assert.diagnostic('no installed jsEntrypoint was available for the agent-eval smoke'),
    ]);
  }
  // A missing built private harness is an infrastructure fault, not a journey fail.
  if (!existsSync(AGENT_EVAL_CLI) || !existsSync(AGENT_EVAL_MODEL)) {
    return unavailable('agent-eval-harness-missing', [
      context.assert.diagnostic(
        'the built agent-eval harness (packages/agent-eval/dist) is not present',
      ),
    ]);
  }
  let validateEvalReport;
  try {
    validateEvalReport = await loadReportValidator();
  } catch (error) {
    return unavailable('agent-eval-harness-unloadable', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }

  const reportPath = join(context.paths.workRoot, 'agent-eval-installed-smoke.json');
  const result = await context.process.run({
    argv: [
      process.execPath,
      AGENT_EVAL_CLI,
      '--smoke',
      '--opensip-entrypoint',
      script,
      '--json',
      reportPath,
    ],
    cwd: REPO_ROOT,
    timeoutMs: INSTALLED_SMOKE_TIMEOUT_MS,
  });

  if (result.timedOut) {
    return fail('installed-smoke-timed-out', [context.assert.diagnostic(result.stderrTail)]);
  }
  // A non-zero exit is an installed-candidate MCP/task/prerequisite failure → fail.
  if (result.status !== 0) {
    return fail('installed-smoke-run-failed', [
      context.assert.diagnostic(
        `agent-eval exited status=${result.status ?? 'null'} signal=${result.signal ?? 'null'}`,
      ),
      context.assert.diagnostic(result.stderrTail),
    ]);
  }

  const reportFile = readBoundedOwnedTextFile({
    path: reportPath,
    root: context.paths.workRoot,
    maxBytes: MAX_INSTALLED_AGENT_REPORT_BYTES,
    reasonPrefix: 'installed-smoke-report',
    requireNonEmpty: true,
  });
  if (!reportFile.ok) {
    if (
      reportFile.reasonCode === 'installed-smoke-report-too-large' ||
      reportFile.reasonCode === 'installed-smoke-report-empty'
    ) {
      return fail('installed-smoke-report-too-large', [
        context.assert.diagnostic('the smoke report is empty or exceeds its byte bound'),
      ]);
    }
    if (
      reportFile.reasonCode === 'installed-smoke-report-not-regular' ||
      reportFile.reasonCode === 'installed-smoke-report-path-escaped' ||
      reportFile.reasonCode === 'installed-smoke-report-changed-before-open' ||
      reportFile.reasonCode === 'installed-smoke-report-changed-during-read'
    ) {
      return fail('installed-smoke-report-invalid', [
        context.assert.diagnostic('the smoke report was not a stable run-owned regular file'),
      ]);
    }
    return fail('installed-smoke-report-missing', [
      context.assert.diagnostic('the smoke report could not be opened safely'),
    ]);
  }
  const raw = reportFile.text;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return fail('installed-smoke-report-unparseable', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
  if (!validateEvalReport(parsed)) {
    return fail('installed-smoke-report-invalid', [
      context.assert.diagnostic('the smoke report did not satisfy the agent-eval schema contract'),
    ]);
  }

  let preservedDigest;
  if (context.artifacts !== undefined) {
    try {
      const preserved = context.artifacts.writeInstalledAgentReport(parsed);
      if (!/^[a-f0-9]{64}$/u.test(preserved.digest)) {
        throw new TypeError('agent report writer returned an invalid digest');
      }
      preservedDigest = preserved.digest;
    } catch (error) {
      const reason =
        error !== null && typeof error === 'object' && 'reasonCode' in error
          ? String(error.reasonCode)
          : 'write-failed';
      return fail('installed-smoke-report-write-failed', [
        context.assert.diagnostic(`agent report preservation failed (${reason})`),
      ]);
    }
  }

  // Store ONLY a bounded summary + report digest in evidence; the full private
  // report is optional sanitized auxiliary output; sealed evidence is authoritative.
  const digest = createHash('sha256').update(raw).digest('hex');
  const evidence = [
    context.assert.diagnostic(summarizeInstalledSmoke(parsed)),
    context.assert.diagnostic(
      preservedDigest === undefined
        ? `ephemeral raw report sha256:${digest}`
        : `sanitized report sha256:${preservedDigest}`,
    ),
  ];
  const failures = collectInstalledSmokeFailures(parsed, context.installed);
  if (failures.length > 0) {
    return fail('installed-smoke-unmet', [
      ...evidence,
      ...failures.map((f) => context.assert.diagnostic(f)),
    ]);
  }
  return pass(evidence);
};

export const agentJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'agent.installed-smoke',
    category: 'agent',
    value: {
      human: 'An agent can use the installed CLI',
      agent:
        'the private agent-eval gold-task smoke passes against the installed candidate’s catalog/graph evidence',
    },
    isolated: true,
    steps: [
      {
        label: 'launch the private agent-eval smoke against the installed entrypoint',
      },
      { label: 'validate the report through the agent-eval schema contract' },
      {
        label: 'assert both arms, an OpenSIP pass, the installed identity, and an unchanged source',
      },
    ],
    executor: installedAgentSmokeExecutor,
  }),
]);
