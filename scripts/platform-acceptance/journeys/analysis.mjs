/**
 * @fileoverview Analysis journeys — the stateful human CLI path.
 *
 * These journeys share ONE initialized project + session store (declared
 * `isolated: false`), so Phase 3 runs them serially in profile order: pre-init
 * `audit`, then `init`, `fit`, `graph`, `graph impact`, the deterministic
 * example `sim`, `yagni`, `report`, and session list/show/replay. The command
 * journeys carry a `commandSteps` source shared with the release-smoke
 * projection; the rest own bespoke executors over the same measured-process
 * port. Every assertion targets PUBLIC contract fields (envelope
 * `schemaVersion`/`tool`, `data.type`, exit codes, JSON purity) — never a full
 * output snapshot.
 *
 * All command construction is argv arrays through the injected port; no journey
 * accepts command text or resolves an executable.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expectEnvelope } from '../../cli-acceptance-core.mjs';
import {
  assertCommand,
  assertUniqueJourneyIds,
  defineJourney,
  fail,
  makeCommandExecutor,
  readJson,
  runCli,
} from '../journey-kit.mjs';

/** Unwrap the CommandOutcome `.data` (non-run results) or fall back to a bare shape. */
const cmdData = (parsed) => parsed?.data ?? parsed;
/** Unwrap the CommandOutcome `.envelope` (run-command results) or fall back to a bare shape. */
const cmdEnvelope = (parsed) => parsed?.envelope ?? parsed;

const TYPESCRIPT_TEST_TARGET = `  typescript-tests:
    description: TypeScript tests
    languages: [typescript]
    concerns: [test]
    include:
      - "src/**/*.test.ts"
    exclude:
      - "**/node_modules/**"
      - "**/dist/**"

`;

/**
 * Seed one small source→test relationship for the later agent-context journey.
 * The initialized TypeScript source target intentionally excludes tests, so the
 * fixture contributes a separate test target instead of weakening that default.
 */
function writeAnalysisFixture(cwd) {
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'clean.ts'), 'export const x = 1;\n');
  writeFileSync(
    join(cwd, 'src', 'bad.ts'),
    "export function bad(): void {\n  console.log('debug');\n}\n",
  );
  writeFileSync(join(cwd, 'src', 'bad.test.ts'), "import { bad } from './bad.js';\n\nbad();\n");
  writeFileSync(
    join(cwd, 'package.json'),
    `${JSON.stringify(
      {
        name: 'opensip-platform-acceptance-fixture',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: { test: 'vitest run' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(cwd, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2)}\n`,
  );

  const configPath = join(cwd, 'opensip-cli.config.yml');
  const config = readFileSync(configPath, 'utf8');
  if (!config.includes('  typescript-tests:')) {
    const fitnessMarker = '\nfitness:';
    if (!config.includes(fitnessMarker)) {
      throw new Error('initialized fixture config is missing the fitness block');
    }
    writeFileSync(configPath, config.replace(fitnessMarker, `\n${TYPESCRIPT_TEST_TARGET}fitness:`));
  }
}

// ---------------------------------------------------------------------------
// Command-only journeys — commandSteps feed BOTH the executor and the smoke
// projection. Names are preserved verbatim from the historical packed smoke.
// ---------------------------------------------------------------------------

const initSteps = () => [
  {
    slug: 'init',
    name: 'init --language typescript --json scaffolds a pristine project',
    args: ['init', '--language', 'typescript', '--json'],
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const failures = [];
        const data = cmdData(parsed);
        if (data?.type !== 'init')
          failures.push(`init.type: expected "init", got ${JSON.stringify(data?.type)}`);
        if (data?.created !== true)
          failures.push(`init.created: expected true, got ${JSON.stringify(data?.created)}`);
        if (typeof data?.path !== 'string' || !data.path.endsWith('opensip-cli.config.yml')) {
          failures.push(
            `init.path: expected a path ending in opensip-cli.config.yml, got ${JSON.stringify(data?.path)}`,
          );
        }
        return failures;
      },
    },
  },
];

const fitSteps = () => [
  {
    slug: 'fit-check',
    name: 'fit --json --check no-console-log flags exactly one finding',
    args: ['fit', '--json', '--check', 'no-console-log'],
    setup: ({ cwd }) => writeAnalysisFixture(cwd),
    expect: {
      exitCode: 1,
      json: (parsed) => {
        const failures = expectEnvelope({ tool: 'fit' })(parsed);
        const env = cmdEnvelope(parsed);
        const total = env?.verdict?.summary?.total;
        if (total !== 1)
          failures.push(`fit verdict.summary.total: expected 1, got ${JSON.stringify(total)}`);
        const signals = Array.isArray(env?.signals) ? env.signals : [];
        if (!signals.some((s) => s?.source === 'no-console-log')) {
          failures.push('fit signals: expected a no-console-log signal');
        }
        return failures;
      },
    },
  },
  {
    slug: 'fit-list',
    name: 'fit --list --json enumerates the bundled checks',
    args: ['fit', '--list', '--json'],
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const failures = [];
        const data = cmdData(parsed);
        if (data?.type !== 'list-checks') {
          failures.push(
            `list-checks.type: expected "list-checks", got ${JSON.stringify(data?.type)}`,
          );
        }
        if (typeof data?.totalCount !== 'number' || data.totalCount <= 0) {
          failures.push(
            `list-checks.totalCount: expected > 0, got ${JSON.stringify(data?.totalCount)}`,
          );
        }
        const slugs = new Set(Array.isArray(data?.checks) ? data.checks.map((c) => c?.slug) : []);
        const requiredByPack = {
          'checks-python': 'python-no-bare-except',
          'checks-go': 'go-no-fmt-print',
          'checks-java': 'java-no-print-stack-trace',
          'checks-cpp': 'cpp-clang-tidy',
          'checks-rust': 'rust-no-dbg-macro',
        };
        for (const [pack, slug] of Object.entries(requiredByPack)) {
          if (!slugs.has(slug)) {
            failures.push(
              `list-checks: expected a "${slug}" check from ${pack} — the packed CLI does not bundle that language pack`,
            );
          }
        }
        return failures;
      },
    },
  },
];

const graphSteps = () => [
  {
    slug: 'graph',
    name: 'graph --json emits a well-formed graph envelope',
    args: ['graph', '--json'],
    expect: { exitCode: 0, json: expectEnvelope({ tool: 'graph' }) },
  },
];

const reportSteps = () => [
  {
    slug: 'report',
    name: 'report --no-open --json writes the report without launching a browser',
    args: ['report', '--no-open', '--json'],
    expect: {
      exitCode: 0,
      json: (parsed) => {
        const failures = [];
        const data = cmdData(parsed);
        if (data?.type !== 'report')
          failures.push(`report.type: expected "report", got ${JSON.stringify(data?.type)}`);
        if (data?.opened !== false)
          failures.push(`report.opened: expected false, got ${JSON.stringify(data?.opened)}`);
        return failures;
      },
    },
  },
];

const sessionsListSteps = () => [
  {
    slug: 'sessions-list',
    name: 'sessions list reads the run history',
    args: ['sessions', 'list'],
    expect: { exitCode: 0 },
  },
];

// ---------------------------------------------------------------------------
// Bespoke executors
// ---------------------------------------------------------------------------

/** Fetch the first stored session id via `sessions list --json`. */
async function firstSessionId(context) {
  const listed = await runCli(context, { args: ['sessions', 'list', '--json'] });
  if (listed.timedOut || (listed.status ?? 1) !== 0) return { ok: false, result: listed };
  const parsed = readJson(listed);
  if (!parsed.ok) return { ok: false, result: listed, message: parsed.message };
  const data = cmdData(parsed.value);
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const id = sessions.find((s) => typeof s?.id === 'string')?.id;
  return id === undefined
    ? { ok: false, result: listed, message: 'no stored session id' }
    : { ok: true, id };
}

function sessionReplayFailures(data, expectedId) {
  const failures = [];
  if (data?.session?.id !== expectedId) {
    failures.push(
      `session.id: expected ${JSON.stringify(expectedId)}, got ${JSON.stringify(data?.session?.id)}`,
    );
  }
  if (typeof data?.session?.tool !== 'string' || data.session.tool.length === 0) {
    failures.push('session.tool: expected a non-empty tool id');
  }
  if (data?.fidelity !== 'projection') {
    failures.push(`fidelity: expected "projection", got ${JSON.stringify(data?.fidelity)}`);
  }
  if (
    data?.envelope?.schemaVersion !== 2 ||
    data?.envelope?.tool !== data?.session?.tool ||
    !Array.isArray(data?.envelope?.signals)
  ) {
    failures.push('envelope: expected a schemaVersion 2 envelope matching the session tool');
  }
  return failures;
}

const auditPreinitExecutor = async (context) => {
  // Zero-init means OpenSIP can operate before `opensip init`; it does not mean
  // an entirely empty directory is a recognizable source project. Seed the
  // smallest TypeScript project so this journey exercises cache-backed audit
  // persistence without accidentally testing project-language discovery.
  mkdirSync(join(context.paths.workRoot, 'src'), { recursive: true });
  writeFileSync(join(context.paths.workRoot, 'src', 'index.ts'), 'export const ready = true;\n');
  writeFileSync(
    join(context.paths.workRoot, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2)}\n`,
  );
  const result = await runCli(context, { args: ['audit', '--json'] });
  return assertCommand(
    context,
    result,
    {
      exitCodeOneOf: [0, 1],
      json: (parsed) => {
        const data = cmdData(parsed);
        const failures = [];
        if (data?.type !== 'suite-run')
          failures.push(`audit.type: expected "suite-run", got ${JSON.stringify(data?.type)}`);
        if (data?.suite !== 'audit')
          failures.push(`audit.suite: expected "audit", got ${JSON.stringify(data?.suite)}`);
        return failures;
      },
    },
    'audit-preinit-failed',
  );
};

const graphImpactExecutor = async (context) => {
  const result = await runCli(context, {
    args: ['graph', 'impact', '--files', 'src/bad.ts', '--json'],
  });
  return assertCommand(
    context,
    result,
    {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        return data?.type === 'graph-impact'
          ? []
          : [`graph-impact.type: expected "graph-impact", got ${JSON.stringify(data?.type)}`];
      },
    },
    'graph-impact-failed',
  );
};

const simExecutor = async (context) => {
  const result = await runCli(context, { args: ['sim', '--recipe', 'example', '--json'] });
  return assertCommand(
    context,
    result,
    { exitCode: 0, json: expectEnvelope({ tool: 'sim' }) },
    'sim-failed',
  );
};

const yagniExecutor = async (context) => {
  const result = await runCli(context, { args: ['yagni', '--json'] });
  return assertCommand(
    context,
    result,
    { exitCodeOneOf: [0, 1], json: expectEnvelope({ tool: 'yagni' }) },
    'yagni-failed',
  );
};

const sessionsShowExecutor = async (context) => {
  const found = await firstSessionId(context);
  if (!found.ok) {
    return fail('no-stored-session', [
      context.assert.diagnostic(found.message ?? 'sessions list did not yield a session id'),
    ]);
  }
  const result = await runCli(context, { args: ['sessions', 'show', found.id, '--json'] });
  return assertCommand(
    context,
    result,
    {
      exitCode: 0,
      json: (parsed) => {
        const data = cmdData(parsed);
        return sessionReplayFailures(data, found.id);
      },
    },
    'sessions-show-failed',
  );
};

const replayExecutor = async (context) => {
  const found = await firstSessionId(context);
  if (!found.ok) {
    return fail('no-stored-session', [
      context.assert.diagnostic(found.message ?? 'sessions list did not yield a session id'),
    ]);
  }
  // Deterministic replay: two reads of the same stored session must render the
  // same tool + verdict envelope (persisted replay is byte-stable).
  const first = await runCli(context, { args: ['sessions', 'show', found.id, '--json'] });
  const second = await runCli(context, { args: ['sessions', 'show', found.id, '--json'] });
  if (first.timedOut || second.timedOut)
    return fail('timed-out', [context.assert.diagnostic('replay read timed out')]);
  if ((first.status ?? 1) !== 0 || (second.status ?? 1) !== 0) {
    return fail('replay-failed', [
      context.assert.diagnostic('one of the public replay reads exited non-zero'),
    ]);
  }
  const a = readJson(first);
  const b = readJson(second);
  if (!a.ok || !b.ok)
    return fail('replay-not-json', [context.assert.diagnostic((a.ok ? b : a).message)]);
  const da = cmdData(a.value);
  const db = cmdData(b.value);
  const failures = [...sessionReplayFailures(da, found.id), ...sessionReplayFailures(db, found.id)];
  if (da?.envelope?.tool !== db?.envelope?.tool)
    failures.push('replay: tool differs between two reads (non-deterministic replay)');
  if (JSON.stringify(da?.envelope?.verdict) !== JSON.stringify(db?.envelope?.verdict)) {
    failures.push('replay: verdict differs between two reads (non-deterministic replay)');
  }
  return failures.length === 0
    ? assertCommand(context, second, { exitCode: 0 }, 'replay-failed')
    : fail(
        'replay-nondeterministic',
        failures.map((f) => context.assert.diagnostic(f)),
      );
};

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

export const analysisJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'analysis.audit-preinit',
    category: 'analysis',
    value: {
      human: 'Get a code review before any setup',
      agent: 'audit --json works pre-init and returns a suite-run',
    },
    steps: [
      { label: 'run audit --json before init' },
      { label: 'assert data.type=suite-run, suite=audit' },
    ],
    executor: auditPreinitExecutor,
  }),
  defineJourney({
    id: 'analysis.init',
    category: 'analysis',
    value: {
      human: 'Scaffold a project',
      agent: 'init --json reports type=init, created, config path',
    },
    steps: [{ label: 'run init --language typescript --json' }],
    commandSteps: initSteps,
    executor: makeCommandExecutor(initSteps),
  }),
  defineJourney({
    id: 'analysis.fit',
    category: 'analysis',
    value: {
      human: 'Run fitness checks',
      agent: 'fit --json emits a schemaVersion 2 envelope with findings',
    },
    steps: [
      { label: 'seed src + tsconfig' },
      { label: 'run fit --check no-console-log --json' },
      { label: 'run fit --list --json' },
    ],
    commandSteps: fitSteps,
    executor: makeCommandExecutor(fitSteps),
  }),
  defineJourney({
    id: 'analysis.graph',
    category: 'analysis',
    value: {
      human: 'Build the call graph',
      agent: 'graph --json emits a schemaVersion 2 graph envelope',
    },
    steps: [{ label: 'run graph --json' }],
    commandSteps: graphSteps,
    executor: makeCommandExecutor(graphSteps),
  }),
  defineJourney({
    id: 'analysis.graph-impact',
    category: 'analysis',
    value: {
      human: 'See what a change impacts',
      agent: 'graph impact --files --json returns type=graph-impact',
    },
    steps: [
      { label: 'run graph impact --files src/bad.ts --json' },
      { label: 'assert data.type=graph-impact' },
    ],
    executor: graphImpactExecutor,
  }),
  defineJourney({
    id: 'analysis.sim',
    category: 'analysis',
    value: {
      human: 'Run a simulation scenario',
      agent: 'sim --recipe example --json emits a sim envelope, exit 0',
    },
    steps: [{ label: 'run sim --recipe example --json' }, { label: 'assert sim envelope, exit 0' }],
    executor: simExecutor,
  }),
  defineJourney({
    id: 'analysis.yagni',
    category: 'analysis',
    value: { human: 'Run the reduction audit', agent: 'yagni --json emits a yagni envelope' },
    steps: [{ label: 'run yagni --json' }, { label: 'assert yagni envelope' }],
    executor: yagniExecutor,
  }),
  defineJourney({
    id: 'analysis.report',
    category: 'analysis',
    value: {
      human: 'Generate the HTML report',
      agent: 'report --no-open --json reports type=report, opened=false',
    },
    steps: [{ label: 'run report --no-open --json' }],
    commandSteps: reportSteps,
    executor: makeCommandExecutor(reportSteps),
  }),
  defineJourney({
    id: 'analysis.sessions-list',
    category: 'analysis',
    value: { human: 'List run history', agent: 'sessions list exits 0' },
    steps: [{ label: 'run sessions list' }],
    commandSteps: sessionsListSteps,
    executor: makeCommandExecutor(sessionsListSteps),
  }),
  defineJourney({
    id: 'analysis.sessions-show',
    category: 'analysis',
    value: {
      human: 'Inspect a stored result',
      agent: 'sessions show <id> --json returns type=session-replay',
    },
    steps: [{ label: 'sessions list --json → id' }, { label: 'sessions show <id> --json' }],
    executor: sessionsShowExecutor,
  }),
  defineJourney({
    id: 'analysis.replay',
    category: 'analysis',
    value: {
      human: 'Replay a stored result deterministically',
      agent: 'two sessions show reads render identical tool+verdict',
    },
    steps: [
      { label: 'sessions list --json → id' },
      { label: 'sessions show <id> --json twice' },
      { label: 'assert identical replay' },
    ],
    executor: replayExecutor,
  }),
]);
