/**
 * Built-CLI acceptance matrix for the trusted agent-context evidence suite.
 *
 * This intentionally crosses package boundaries through dist/index.js. It
 * proves the shipped command, migrations, bundled graph adapters, host suite
 * ledger, and public JSON outcome agree for the same three customer fixtures
 * used by the agent-eval harness.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { distRunner, type SpawnResult } from './harness/cli-acceptance.js';

import type { CommandOutcome, SuiteRunResult, TaskContextManifest } from '@opensip-cli/contracts';

const REPOSITORY_ROOT = realpathSync(fileURLToPath(new URL('../../../..', import.meta.url)));
const FIXTURES_ROOT = join(REPOSITORY_ROOT, 'packages/agent-eval/__fixtures__');
const CPP_FIXTURE = join(REPOSITORY_ROOT, 'packages/cli/src/__tests__/fixtures/languages/cpp');
const DIST_CLI = join(REPOSITORY_ROOT, 'packages/cli/dist/index.js');
const CONTEXT_MIGRATION = join(REPOSITORY_ROOT, 'packages/datastore/migrations/0010_big_leo.sql');
const cli = distRunner();

const PRODUCER_COMMANDS = [
  'graph-context-inventory',
  'graph-context-ensure',
  'graph-context-select-tests',
] as const;

interface FixtureCase {
  readonly fixture: 'customer-ts' | 'customer-workspace' | 'customer-py';
  readonly language: 'typescript' | 'python';
  readonly file: string;
}

const FIXTURE_CASES: readonly FixtureCase[] = [
  {
    fixture: 'customer-ts',
    language: 'typescript',
    file: 'src/services/billing/calculate-invoice.ts',
  },
  {
    fixture: 'customer-workspace',
    language: 'typescript',
    file: 'packages/ws-core/src/normalize-account.ts',
  },
  {
    fixture: 'customer-py',
    language: 'python',
    file: 'ledger/core.py',
  },
];

const temporaryRoots: string[] = [];

function prepareFixture(
  source: string,
  label: string,
): {
  readonly home: string;
  readonly project: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `opensip-agent-context-${label}-`)));
  temporaryRoots.push(root);
  const project = join(root, 'workspace');
  const home = join(root, 'home');
  cpSync(source, project, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { home, project };
}

function isolatedEnv(home: string): Readonly<Record<string, string>> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENSIP_NO_UPDATE: '1',
    NO_UPDATE_NOTIFIER: '1',
    OPENSIP_PROFILING: '0',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
  };
}

function parseOutcome<T>(result: SpawnResult, label: string): CommandOutcome<T> {
  try {
    return JSON.parse(result.stdout) as CommandOutcome<T>;
  } catch (error) {
    throw new Error(
      `${label} did not emit one JSON outcome: ${error instanceof Error ? error.message : String(error)}\n` +
        `exit=${String(result.exitCode)} stderr=${result.stderr.slice(-2000)}`,
      { cause: error },
    );
  }
}

function runSetup(project: string, home: string, language: FixtureCase['language'] | 'cpp'): void {
  const options = {
    cwd: project,
    env: isolatedEnv(home),
    timeout: 120_000,
  } as const;
  const init = cli.run(['init', '--cwd', project, '--language', language, '--json'], options);
  const initOutcome = parseOutcome(init, `${language} init`);
  expect(init.exitCode, init.stderr).toBe(0);
  expect(initOutcome.exitCode).toBe(0);
  expect(initOutcome.status).not.toBe('error');

  if (language === 'cpp') return;
  const graph = cli.run(
    ['--no-cloud', 'graph', '--json', '--cwd', project, '--language', language],
    options,
  );
  const graphOutcome = parseOutcome(graph, `${language} graph`);
  expect([0, 1], graph.stderr).toContain(graph.exitCode);
  expect(graphOutcome.exitCode).toBe(graph.exitCode);
  expect(graphOutcome.status).not.toBe('error');
}

function runContext(input: {
  readonly project: string;
  readonly home: string;
  readonly files?: readonly string[];
}): { readonly outcome: CommandOutcome<SuiteRunResult>; readonly result: SpawnResult } {
  const fileArgs = (input.files ?? []).flatMap((file) => ['--files', file]);
  const result = cli.run(
    ['--no-cloud', 'suite', 'run', 'agent-context', ...fileArgs, '--cwd', input.project, '--json'],
    {
      cwd: input.project,
      env: isolatedEnv(input.home),
      timeout: 120_000,
    },
  );
  return { outcome: parseOutcome(result, 'agent-context'), result };
}

function assertEvidenceOnlyOutcome(
  outcome: CommandOutcome<SuiteRunResult>,
  expectedMode: TaskContextManifest['fileScope']['mode'],
  expectedFileCount: number,
): TaskContextManifest {
  expect(outcome.kind).toBe('suite-run');
  expect(outcome.envelope).toBeUndefined();
  expect(outcome.data).toMatchObject({ type: 'suite-run', suite: 'agent-context' });
  const data = outcome.data;
  expect(data).toBeDefined();
  if (data === undefined) throw new Error('agent-context outcome omitted suite data');

  expect(data.runId).toMatch(/^RUN_[0-9A-HJKMNP-TV-Z]{26}$/u);
  expect(data.steps.map((step) => step.command)).toEqual(PRODUCER_COMMANDS);
  expect(data.steps.every((step) => step.kind === 'evidence')).toBe(true);
  expect(data.steps.every((step) => step.verdict === undefined)).toBe(true);
  expect(data.reviewBrief).toBeUndefined();
  expect(JSON.stringify(data)).not.toContain('"findings"');

  const manifest = data.contextManifest;
  expect(manifest).toBeDefined();
  if (manifest === undefined) throw new Error('agent-context outcome omitted its context manifest');
  expect(manifest.runId).toBe(data.runId);
  expect(manifest.fileScope).toMatchObject({
    mode: expectedMode,
    fileCount: expectedFileCount,
  });
  expect(manifest.fileScope.filesIdentity).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(manifest.planes.map((plane) => plane.kind)).toEqual([
    'inventory',
    'graph',
    'test-selection',
  ]);
  return manifest;
}

beforeAll(() => {
  const prerequisites = [
    DIST_CLI,
    CONTEXT_MIGRATION,
    CPP_FIXTURE,
    ...FIXTURE_CASES.map(({ fixture }) => join(FIXTURES_ROOT, fixture)),
  ];
  const missing = prerequisites.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `agent-context acceptance prerequisites are missing:\n${missing.join('\n')}\nRun pnpm build first.`,
    );
  }
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agent-context acceptance through built CLI', () => {
  it.each(FIXTURE_CASES)(
    'emits evidence-only project and explicit-file outcomes for $fixture',
    ({ fixture, language, file }) => {
      const { home, project } = prepareFixture(join(FIXTURES_ROOT, fixture), fixture);
      runSetup(project, home, language);

      const projectRun = runContext({ project, home });
      expect(projectRun.result.exitCode, projectRun.result.stderr).toBe(0);
      expect(projectRun.outcome.exitCode).toBe(0);
      const projectManifest = assertEvidenceOnlyOutcome(projectRun.outcome, 'project', 0);
      expect(projectManifest.readiness).not.toBe('unavailable');
      expect(projectRun.outcome.data?.aggregate).toMatchObject({
        steps: 3,
        passed: 3,
        failed: 0,
        faulted: 0,
        errors: 0,
        warnings: 0,
      });
      expect(projectManifest.planes[2]).toMatchObject({
        kind: 'test-selection',
        required: false,
        status: 'unsupported',
        coverage: { status: 'unavailable' },
      });

      const explicitRun = runContext({ project, home, files: [file] });
      expect(explicitRun.result.exitCode, explicitRun.result.stderr).toBe(0);
      expect(explicitRun.outcome.exitCode).toBe(0);
      const explicitManifest = assertEvidenceOnlyOutcome(explicitRun.outcome, 'explicit', 1);
      expect(explicitManifest.readiness).not.toBe('unavailable');
      expect(explicitManifest.fileScope.filesIdentity).not.toBe(
        projectManifest.fileScope.filesIdentity,
      );
      expect(explicitManifest.planes[2]?.required).toBe(true);
      expect(explicitManifest.planes[2]?.pointer?.kind).toBe('test-selection');
      expect(JSON.stringify(explicitManifest)).not.toContain(file);
    },
    240_000,
  );

  it('fails closed when a required graph capability is unavailable', () => {
    const { home, project } = prepareFixture(CPP_FIXTURE, 'unsupported-cpp');
    runSetup(project, home, 'cpp');

    const context = runContext({ project, home, files: ['src/clean.cpp'] });
    expect(context.result.exitCode).toBe(1);
    expect(context.outcome.exitCode).toBe(1);
    const manifest = assertEvidenceOnlyOutcome(context.outcome, 'explicit', 1);
    expect(manifest.readiness).toBe('unavailable');
    expect(
      manifest.planes.some(
        (plane) =>
          plane.required && plane.status === 'failed' && plane.coverage.status === 'unavailable',
      ),
    ).toBe(true);
    expect(context.outcome.data?.aggregate?.faulted).toBeGreaterThan(0);
  }, 120_000);
});
