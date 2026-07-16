/**
 * @fileoverview Output journeys — human vs machine rendering contracts.
 *
 * These share the initialized project the analysis journeys produced (declared
 * `isolated: false`): they run `fit --check no-console-log` (which the analysis
 * `fit` journey seeded a finding for) and `graph` under different output modes
 * and assert the PUBLIC surface — human render vs pure JSON, no ANSI under
 * NO_COLOR, agent filters + `--raw` unwrapping, a well-formed SARIF side file,
 * and a written HTML report. Machine modes must keep stdout clean and
 * deterministic (the whole stdout must parse); no full-output snapshots.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expectEnvelope } from '../../cli-acceptance-core.mjs';
import {
  assertCommand,
  assertUniqueJourneyIds,
  defineJourney,
  fail,
  pass,
  readJson,
  runCli,
} from '../journey-kit.mjs';
import { readBoundedOwnedTextFile } from '../bounded-owned-file.mjs';

const cmdData = (parsed) => parsed?.data ?? parsed;
const ANSI_ESCAPE = '\u001B';
const MAX_SIDE_FILE_BYTES = 16 * 1024 * 1024;

/** Read a bounded regular file through a no-follow, ownership-checked descriptor. */
export function readBoundedOwnedText(path, root) {
  return readBoundedOwnedTextFile({
    path,
    root,
    maxBytes: MAX_SIDE_FILE_BYTES,
    reasonPrefix: 'side-file',
  });
}

/** The finding the analysis `fit` journey seeded; exit 1 under either mode. */
const FIT_FINDING_ARGS = ['fit', '--check', 'no-console-log'];

/** Validate the stable agent-filter wrapper without snapshotting its envelope. */
function agentFilteredFailures(result, expectedFilters) {
  const failures = [];
  if (result?.type !== 'agent-filtered') {
    failures.push(
      `agent-filtered.type: expected "agent-filtered", got ${JSON.stringify(result?.type)}`,
    );
  }
  if (
    !Array.isArray(result?.filtersApplied) ||
    result.filtersApplied.join('\u0000') !== expectedFilters.join('\u0000')
  ) {
    failures.push(
      `agent-filtered.filtersApplied: expected ${JSON.stringify(expectedFilters)}, got ${JSON.stringify(result?.filtersApplied)}`,
    );
  }
  if (!Number.isInteger(result?.originalSignalCount) || result.originalSignalCount < 0) {
    failures.push('agent-filtered.originalSignalCount: expected a non-negative integer');
  }
  if (
    !Number.isInteger(result?.returnedSignalCount) ||
    result.returnedSignalCount < 0 ||
    result.returnedSignalCount > result.originalSignalCount
  ) {
    failures.push(
      'agent-filtered.returnedSignalCount: expected an integer within the original count',
    );
  }
  return failures;
}

const humanNonTtyExecutor = async (context) => {
  const result = await runCli(context, {
    args: FIT_FINDING_ARGS,
    env: { NO_COLOR: '1' },
  });
  if (result.timedOut) return fail('timed-out', [context.assert.diagnostic(result.stderrTail)]);
  if ((result.status ?? 1) !== 1) {
    return fail('unexpected-exit', [
      context.assert.diagnostic(`expected exit 1 (seeded finding), got ${result.status}`),
    ]);
  }
  if (result.stdoutCapture.trim().length === 0) {
    return fail('empty-human-output', [
      context.assert.diagnostic('human non-TTY run produced empty stdout'),
    ]);
  }
  // Human mode must NOT emit the machine envelope on stdout.
  if (readJson(result).ok) {
    return fail('human-output-is-json', [
      context.assert.diagnostic(
        'human non-TTY stdout parsed as JSON (machine leaked into human mode)',
      ),
    ]);
  }
  return pass();
};

const ptyExecutor = async (context) => {
  // Capability-gated (`pty`): the runner only invokes this on a pty-capable host,
  // and honours `pty: true` on the measured-process port there.
  const result = await runCli(context, { args: FIT_FINDING_ARGS, pty: true });
  if (result.timedOut) return fail('timed-out', [context.assert.diagnostic(result.stderrTail)]);
  if ((result.status ?? 1) !== 1) {
    return fail('unexpected-exit', [
      context.assert.diagnostic(`expected exit 1 under a TTY, got ${result.status}`),
    ]);
  }
  if (result.stdoutCapture.trim().length === 0) {
    return fail('empty-tty-output', [context.assert.diagnostic('TTY run produced empty stdout')]);
  }
  return pass();
};

const noColorExecutor = async (context) => {
  const result = await runCli(context, {
    args: FIT_FINDING_ARGS,
    env: { NO_COLOR: '1' },
  });
  if (result.timedOut) return fail('timed-out', [context.assert.diagnostic(result.stderrTail)]);
  if (result.stdoutCapture.includes(ANSI_ESCAPE)) {
    return fail('ansi-under-no-color', [
      context.assert.diagnostic('stdout contained an ANSI escape while NO_COLOR was set'),
    ]);
  }
  return assertCommand(context, result, { exitCode: 1 }, 'no-color-failed');
};

const jsonExecutor = async (context) => {
  const result = await runCli(context, {
    args: ['fit', '--json', '--check', 'no-console-log'],
  });
  if (result.timedOut) return fail('timed-out', [context.assert.diagnostic(result.stderrTail)]);
  if ((result.status ?? 1) !== 1) {
    return fail('unexpected-exit', [
      context.assert.diagnostic(`expected exit 1 (seeded finding), got ${result.status}`),
    ]);
  }
  const parsed = readJson(result);
  if (!parsed.ok) return fail('stdout-not-pure-json', [context.assert.diagnostic(parsed.message)]);
  const failures = expectEnvelope({ tool: 'fit' })(parsed.value);
  return failures.length === 0
    ? pass()
    : fail(
        'json-envelope-invalid',
        failures.map((f) => context.assert.diagnostic(f)),
      );
};

const filtersRawExecutor = async (context) => {
  const filtered = await runCli(context, {
    args: ['fit', '--json', '--check', 'no-console-log', '--filter', 'errors-only', '--top', '5'],
  });
  if (filtered.timedOut) return fail('timed-out', [context.assert.diagnostic(filtered.stderrTail)]);
  const filteredParsed = readJson(filtered);
  if (!filteredParsed.ok)
    return fail('filtered-not-json', [context.assert.diagnostic(filteredParsed.message)]);
  if ((filtered.status ?? 1) !== 1) {
    return fail('filtered-unexpected-exit', [
      context.assert.diagnostic(`expected filtered fit exit 1, got ${filtered.status}`),
    ]);
  }
  // Filtered output is a non-run CommandOutcome whose `.data` is the
  // AgentFilteredResult; that result carries the envelope one level below.
  const filteredData = cmdData(filteredParsed.value);
  const filteredFailures = [
    ...expectEnvelope({ tool: 'fit' })(filteredData),
    ...agentFilteredFailures(filteredData, ['errors-only', 'top:5']),
  ];
  if (filteredFailures.length > 0) {
    return fail(
      'filtered-envelope-invalid',
      filteredFailures.map((failure) => context.assert.diagnostic(failure)),
    );
  }

  const raw = await runCli(context, {
    args: ['fit', '--json', '--check', 'no-console-log', '--raw'],
  });
  if (raw.timedOut) return fail('timed-out', [context.assert.diagnostic(raw.stderrTail)]);
  const rawParsed = readJson(raw);
  if (!rawParsed.ok) return fail('raw-not-json', [context.assert.diagnostic(rawParsed.message)]);
  if ((raw.status ?? 1) !== 1) {
    return fail('raw-unexpected-exit', [
      context.assert.diagnostic(`expected raw fit exit 1, got ${raw.status}`),
    ]);
  }
  // `--raw` unwraps the CommandOutcome: AgentFilteredResult is the top-level
  // object and retains its nested envelope plus filter/count metadata.
  const rawFailures = [
    ...expectEnvelope({ tool: 'fit' })(rawParsed.value),
    ...agentFilteredFailures(rawParsed.value, []),
  ];
  if (rawFailures.length > 0) {
    return fail('raw-not-unwrapped', [
      ...rawFailures.map((failure) => context.assert.diagnostic(failure)),
    ]);
  }
  return pass();
};

const sarifExecutor = async (context) => {
  const sarifPath = join(context.paths.workRoot, 'acceptance-graph.sarif');
  const result = await runCli(context, {
    args: ['graph', '--json', '--sarif', sarifPath],
  });
  if (result.timedOut) return fail('timed-out', [context.assert.diagnostic(result.stderrTail)]);
  if ((result.status ?? 1) !== 0 || result.signal !== null || result.cancelled === true) {
    return fail('sarif-command-failed', [
      context.assert.diagnostic(
        `graph --json --sarif exited ${result.status} (${result.signal ?? 'none'})`,
      ),
    ]);
  }
  const stdout = readJson(result);
  if (!stdout.ok) {
    return fail('sarif-stdout-not-json', [context.assert.diagnostic(stdout.message)]);
  }
  const envelopeFailures = expectEnvelope({ tool: 'graph' })(stdout.value);
  if (envelopeFailures.length > 0) {
    return fail(
      'sarif-envelope-invalid',
      envelopeFailures.map((failure) => context.assert.diagnostic(failure)),
    );
  }
  if (!existsSync(sarifPath)) {
    return fail('sarif-not-written', [
      context.assert.diagnostic('graph --json --sarif did not write the SARIF side file'),
    ]);
  }
  const sarifFile = readBoundedOwnedText(sarifPath, context.paths.workRoot);
  if (!sarifFile.ok) {
    return fail(sarifFile.reasonCode, [
      context.assert.diagnostic('SARIF side file was not a bounded, run-owned regular file'),
    ]);
  }
  let sarif;
  try {
    sarif = JSON.parse(sarifFile.text);
  } catch {
    return fail('sarif-not-json', [context.assert.diagnostic('SARIF file is not valid JSON')]);
  }
  const failures = [];
  if (sarif?.version !== '2.1.0')
    failures.push(`SARIF version: expected "2.1.0", got ${JSON.stringify(sarif?.version)}`);
  if (!Array.isArray(sarif?.runs)) failures.push('SARIF runs is not an array');
  return failures.length === 0
    ? pass()
    : fail(
        'sarif-malformed',
        failures.map((f) => context.assert.diagnostic(f)),
      );
};

const reportHtmlExecutor = async (context) => {
  const result = await runCli(context, {
    args: ['report', '--no-open', '--json'],
  });
  if (result.timedOut) return fail('timed-out', [context.assert.diagnostic(result.stderrTail)]);
  if ((result.status ?? 1) !== 0 || result.signal !== null || result.cancelled === true) {
    return fail('report-command-failed', [
      context.assert.diagnostic(
        `report --no-open exited ${result.status} (${result.signal ?? 'none'})`,
      ),
    ]);
  }
  const parsed = readJson(result);
  if (!parsed.ok) return fail('report-not-json', [context.assert.diagnostic(parsed.message)]);
  const data = cmdData(parsed.value);
  if (data?.type !== 'report' || typeof data?.path !== 'string') {
    return fail('report-shape-invalid', [
      context.assert.diagnostic(
        `report result: type=${JSON.stringify(data?.type)}, path=${JSON.stringify(data?.path)}`,
      ),
    ]);
  }
  const reportFile = readBoundedOwnedText(data.path, context.paths.workRoot);
  if (!reportFile.ok) {
    return fail(reportFile.reasonCode, [
      context.assert.diagnostic('report path was not a bounded, run-owned regular file'),
    ]);
  }
  const html = reportFile.text;
  if (!/<!doctype html|<html/i.test(html)) {
    return fail('report-not-html', [
      context.assert.diagnostic('report file is not recognizable HTML'),
    ]);
  }
  return pass();
};

export const outputJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'output.human-non-tty',
    category: 'output',
    value: {
      human: 'Readable output when piped',
      agent: 'human mode never leaks the machine envelope to stdout',
    },
    steps: [{ label: 'run fit (no --json) piped' }, { label: 'assert human, non-JSON, exit 1' }],
    executor: humanNonTtyExecutor,
  }),
  defineJourney({
    id: 'output.no-color',
    category: 'output',
    value: {
      human: 'Respect NO_COLOR',
      agent: 'NO_COLOR yields zero ANSI escapes on stdout',
    },
    steps: [{ label: 'run fit with NO_COLOR=1' }, { label: 'assert no ANSI escape bytes' }],
    executor: noColorExecutor,
  }),
  defineJourney({
    id: 'output.json',
    category: 'output',
    value: {
      human: 'Clean machine JSON',
      agent: 'fit --json stdout is pure, parseable, schemaVersion 2',
    },
    steps: [{ label: 'run fit --json' }, { label: 'assert whole stdout parses to a fit envelope' }],
    executor: jsonExecutor,
  }),
  defineJourney({
    id: 'output.filters-raw',
    category: 'output',
    value: {
      human: 'Agent filters + raw payload',
      agent: '--filter/--top parse; --raw unwraps the CommandOutcome',
    },
    steps: [
      { label: 'run fit --json --filter errors-only --top 5' },
      { label: 'run fit --json --raw' },
      { label: 'assert raw is an unwrapped AgentFilteredResult containing the envelope' },
    ],
    executor: filtersRawExecutor,
  }),
  defineJourney({
    id: 'output.sarif',
    category: 'output',
    value: {
      human: 'SARIF side output',
      agent: 'graph --json --sarif emits a graph envelope and writes SARIF 2.1.0',
    },
    steps: [
      { label: 'run graph --json --sarif <path>' },
      { label: 'assert stdout parses to a graph envelope' },
      { label: 'parse the SARIF file, assert version 2.1.0' },
    ],
    executor: sarifExecutor,
  }),
  defineJourney({
    id: 'output.report-html',
    category: 'output',
    value: {
      human: 'HTML report on disk',
      agent: 'report --no-open writes a real HTML file at data.path',
    },
    steps: [
      { label: 'run report --no-open --json' },
      { label: 'read the file, assert it is HTML' },
    ],
    executor: reportHtmlExecutor,
  }),
  defineJourney({
    id: 'output.pty',
    category: 'output',
    value: {
      human: 'Live view under a real TTY',
      agent: 'fit renders under a PTY without crashing (exit 1)',
    },
    capabilities: ['pty'],
    steps: [{ label: 'run fit under a PTY' }, { label: 'assert exit 1 and non-empty output' }],
    executor: ptyExecutor,
  }),
]);
