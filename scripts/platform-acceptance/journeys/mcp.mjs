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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertUniqueJourneyIds, defineJourney, fail, pass, unavailable } from '../journey-kit.mjs';

/** Reason/fallback tokens a graceful stale-or-missing-evidence response surfaces. */
const STALE_EVIDENCE_TOKENS = [
  'unavailable',
  'stale',
  'partial',
  'not_ready',
  'notready',
  'missing',
  'reason',
  'fallback',
  'readiness',
];

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
  try {
    return await fn(client);
  } catch (error) {
    return fail('mcp-call-failed', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  } finally {
    try {
      await client.close();
    } catch {
      /* a close error is not a journey failure */
    }
  }
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

const contextExecutor = (context) =>
  withMcp(context, context.paths.workRoot, async (client) => {
    const status = decodeMcp(
      await client.callTool({ name: 'get_context_status', arguments: { files: ['src/bad.ts'] } }),
    );
    if (status.isError)
      return fail('context-status-error', [context.assert.diagnostic(status.text)]);
    const fileContext = decodeMcp(
      await client.callTool({ name: 'get_file_context', arguments: { file: 'src/bad.ts' } }),
    );
    if (fileContext.isError)
      return fail('file-context-error', [context.assert.diagnostic(fileContext.text)]);
    return pass();
  });

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
    if (runs.isError) return fail('list-runs-error', [context.assert.diagnostic(runs.text)]);
    const id = (runs.payload?.runs ?? []).find((run) => typeof run?.id === 'string')?.id;
    if (id === undefined)
      return fail('no-stored-run', [
        context.assert.diagnostic('list_runs returned no run id to replay'),
      ]);
    const shown = decodeMcp(await client.callTool({ name: 'show_run', arguments: { ref: id } }));
    if (shown.isError || shown.payload === undefined) {
      return fail('show-run-failed', [
        context.assert.diagnostic(shown.text || 'show_run returned no payload'),
      ]);
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
  return withMcp(context, context.paths.workRoot, async (client) => {
    const status = decodeMcp(
      await client.callTool({ name: 'get_context_status', arguments: { files: ['probe.ts'] } }),
    );
    if (status.payload === undefined && !status.isError) {
      return fail('stale-evidence-undecodable', [
        context.assert.diagnostic('stale-evidence read returned neither an error nor a payload'),
      ]);
    }
    if (typeof status.payload?.status === 'string' && status.payload.status === 'available') {
      return fail('stale-evidence-greenwash', [
        context.assert.diagnostic(
          'context status claimed "available" for an evidence-less project',
        ),
      ]);
    }
    const reasoned =
      status.isError ||
      STALE_EVIDENCE_TOKENS.some((token) => status.text.toLowerCase().includes(token));
    return reasoned
      ? pass()
      : fail('stale-evidence-not-reasoned', [
          context.assert.diagnostic('stale/missing evidence did not surface a reason or fallback'),
        ]);
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
      agent: 'get_context_status + get_file_context return without error',
    },
    steps: [{ label: 'call get_context_status' }, { label: 'call get_file_context' }],
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
  if (!selected.has('control') || !selected.has('opensip')) {
    failures.push(
      `report did not run both arms (selectedArms=${[...selected].join(',') || 'none'})`,
    );
  }
  const taskArms = report.tasks?.[0]?.arms ?? {};
  if (taskArms.control === undefined || taskArms.opensip === undefined) {
    failures.push('the smoke task is missing a control or opensip arm result');
  }
  if (taskArms.opensip?.assertions?.passed !== true) {
    failures.push('the OpenSIP arm assertions did not pass on the installed candidate');
  }
  if (report.cliTarget?.source !== 'installed') {
    failures.push(
      `report target source is ${JSON.stringify(report.cliTarget?.source)}, expected "installed"`,
    );
  }
  const expectedVersion = installed?.resolvedVersion;
  if (typeof expectedVersion !== 'string' || expectedVersion.length === 0) {
    failures.push('the installed candidate identity has no resolved version to match');
  } else if (report.cliVersion !== expectedVersion) {
    failures.push(
      `report cliVersion ${JSON.stringify(report.cliVersion)} does not match installed ${JSON.stringify(expectedVersion)}`,
    );
  }
  if (report.sourceState === 'changed-during-run') {
    failures.push('the report was produced while the workspace source changed during the run');
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

  let raw;
  try {
    raw = readFileSync(reportPath, 'utf8');
  } catch (error) {
    return fail('installed-smoke-report-missing', [
      context.assert.diagnostic(error instanceof Error ? error.message : String(error)),
    ]);
  }
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

  // Store ONLY a bounded summary + report digest in evidence; the full private
  // report stays at reportPath as a run-owned auxiliary artifact.
  const digest = createHash('sha256').update(raw).digest('hex');
  const evidence = [
    context.assert.diagnostic(summarizeInstalledSmoke(parsed)),
    context.assert.diagnostic(`report sha256:${digest}`),
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
      { label: 'launch the private agent-eval smoke against the installed entrypoint' },
      { label: 'validate the report through the agent-eval schema contract' },
      {
        label: 'assert both arms, an OpenSIP pass, the installed identity, and an unchanged source',
      },
    ],
    executor: installedAgentSmokeExecutor,
  }),
]);
