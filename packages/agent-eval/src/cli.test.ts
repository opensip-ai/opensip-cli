import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CLI_DEPENDENCIES,
  InvocationError,
  USAGE,
  defaultJsonPath,
  main,
  markdownPathFor,
  parseGitProvenance,
  parseArgs,
  resolveGitProvenance,
  type ArtifactFileSystem,
  type CliDependencies,
} from './cli.js';
import { HarnessPrerequisiteError } from './runner/spawn.js';

import type { Arm, GoldTask } from './model/task.js';
import type { EvalReport } from './report/model.js';
import type { EvaluatedArmRun } from './runner/run-task.js';

const FIXED_DATE = new Date('2026-07-12T20:01:02.345Z');
const CLI_VERSION = '0.6.0';
const GIT_SHA = 'abcdef123456';
const TASK_ONE = makeTask('entrypoint-trace.customer-ts');
const TASK_TWO = makeTask('orient.customer-ts');

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix = 'agent-eval-cli-test-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function installedCliEntrypoint(root: string, bytes = 'export default 1;\n'): string {
  const packageRoot = join(root, 'node_modules', 'opensip-cli');
  const entrypoint = join(packageRoot, 'dist', 'cli.js');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ bin: { opensip: './dist/cli.js' }, name: 'opensip-cli' })}\n`,
  );
  writeFileSync(entrypoint, bytes, 'utf8');
  return entrypoint;
}

function makeTask(id: string): GoldTask {
  return {
    assertions: {},
    fixture: 'customer-ts',
    id,
    question: `Question for ${id}`,
    strategies: {
      control: { arm: 'control', steps: [], version: 'native-v1' },
      opensip: { arm: 'opensip', steps: [], version: 'mcp-epoch-4-v1' },
    },
  };
}

function armResult(task: GoldTask, arm: Arm, passed = true): EvaluatedArmRun {
  return {
    assertions: { incorrectNone: passed ? 0 : 1, passed, scopes: [] },
    metrics: {
      callCount: 1,
      incorrectNone: passed ? 0 : 1,
      responseBytes: 42,
      timeToFirstUsefulContextMs: 3,
      totalWallMs: 3,
    },
    record: {
      arm,
      legs: [],
      setup: { mode: 'fixture', stages: [] },
      strategyVersion: task.strategies[arm].version,
      taskId: task.id,
    },
    recoveryMetrics: { callCount: 0, responseBytes: 0, totalWallMs: 0 },
  };
}

interface DependencyHarness {
  readonly calls: string[];
  readonly dependencies: CliDependencies;
  readonly stderr: () => string;
  readonly stdout: () => string;
}

function dependencyHarness(
  root: string,
  overrides: Partial<CliDependencies> = {},
): DependencyHarness {
  const calls: string[] = [];
  let stdout = '';
  let stderr = '';
  const registry = { [TASK_ONE.id]: TASK_ONE, [TASK_TWO.id]: TASK_TWO };
  const dependencies: CliDependencies = {
    ...DEFAULT_CLI_DEPENDENCIES,
    cwd: () => root,
    harnessVersion: '0.6.0',
    nodeVersion: 'v24.0.0',
    now: () => new Date(FIXED_DATE),
    platform: 'test-platform',
    registry,
    resolveContractFingerprint: () => Promise.resolve(`sha256:${'a'.repeat(64)}`),
    resolveCliVersion: () => Promise.resolve(CLI_VERSION),
    resolveGitProvenance: () => Promise.resolve({ gitSha: GIT_SHA, worktreeDirty: false }),
    resultsRoot: join(root, 'results'),
    runArm: (task, arm) => {
      calls.push(`${task.id}:${arm}`);
      return Promise.resolve(armResult(task, arm));
    },
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
    ...overrides,
  };
  return {
    calls,
    dependencies,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

describe('parseArgs', () => {
  it('applies evaluation defaults', () => {
    expect(parseArgs([])).toEqual({
      arm: 'both',
      help: false,
      list: false,
      smoke: false,
      taskIds: [],
    });
  });

  it('accepts repeatable tasks and one explicit arm and output path', () => {
    expect(
      parseArgs([
        '--task',
        TASK_TWO.id,
        '--task',
        TASK_ONE.id,
        '--arm',
        'opensip',
        '--json',
        'out/report.json',
      ]),
    ).toEqual({
      arm: 'opensip',
      help: false,
      jsonPath: 'out/report.json',
      list: false,
      smoke: false,
      taskIds: [TASK_TWO.id, TASK_ONE.id],
    });
  });

  it('accepts an installed entrypoint in smoke and evaluation modes', () => {
    expect(parseArgs(['--smoke', '--opensip-entrypoint', '/abs/cli/index.js'])).toEqual({
      arm: 'both',
      help: false,
      list: false,
      opensipEntrypoint: '/abs/cli/index.js',
      smoke: true,
      taskIds: [],
    });
    expect(
      parseArgs(['--task', TASK_ONE.id, '--opensip-entrypoint', '/abs/cli/index.js']),
    ).toMatchObject({ opensipEntrypoint: '/abs/cli/index.js' });
  });

  it.each([
    { argv: ['--wat'], label: 'unknown options' },
    { argv: ['positional'], label: 'positional input' },
    { argv: ['--arm', 'bogus'], label: 'invalid arms' },
    { argv: ['--arm'], label: 'missing arm values' },
    { argv: ['--task'], label: 'missing task values' },
    { argv: ['--json', '--smoke'], label: 'missing output values' },
    {
      argv: ['--json', 'unsafe\npath.json'],
      label: 'control characters in values',
    },
    { argv: ['--arm', 'both', '--arm', 'control'], label: 'duplicate arms' },
    {
      argv: ['--json', 'a.json', '--json', 'b.json'],
      label: 'duplicate output paths',
    },
    { argv: ['--smoke', '--task', TASK_ONE.id], label: 'smoke task overrides' },
    { argv: ['--smoke', '--arm', 'control'], label: 'smoke arm overrides' },
    { argv: ['--smoke', '--list'], label: 'smoke list mode' },
    { argv: ['--smoke', '--help'], label: 'smoke help mode' },
    { argv: ['--list', '--json', 'a.json'], label: 'list evaluation options' },
    {
      argv: ['--help', '--task', TASK_ONE.id],
      label: 'help evaluation options',
    },
    {
      argv: ['--list', '--opensip-entrypoint', '/abs/index.js'],
      label: 'installed entrypoint in list mode',
    },
    {
      argv: ['--help', '--opensip-entrypoint', '/abs/index.js'],
      label: 'installed entrypoint in help mode',
    },
    {
      argv: ['--opensip-entrypoint', '/a.js', '--opensip-entrypoint', '/b.js'],
      label: 'duplicate installed entrypoints',
    },
    {
      argv: ['--opensip-entrypoint'],
      label: 'missing installed entrypoint value',
    },
    {
      argv: Array.from({ length: 513 }, () => '--list'),
      label: 'an argv count over the bound',
    },
    {
      argv: ['--json', 'x'.repeat(8193)],
      label: 'a single argument over the byte bound',
    },
  ])('rejects $label', ({ argv }) => {
    expect(() => parseArgs(argv)).toThrow(InvocationError);
  });

  it('accepts an argv exactly at the count and per-argument byte bounds', () => {
    // 512 tokens total (256 --task/value pairs), each value at the 8 KiB ceiling.
    const value = 'v'.repeat(8 * 1024);
    const argv = Array.from({ length: 256 }, () => ['--task', value]).flat();
    expect(argv).toHaveLength(512);
    const parsed = parseArgs(argv);
    expect(parsed.taskIds).toHaveLength(256);
    expect(parsed.taskIds.every((id) => id === value)).toBe(true);
  });
});

describe('report paths', () => {
  it('builds a colon-free UTC identity and a sibling markdown path', () => {
    const path = defaultJsonPath('/results', FIXED_DATE, CLI_VERSION, GIT_SHA, 'clean');
    expect(basename(path)).toBe('20260712T200102Z-v0.6.0-abcdef123456.json');
    expect(path).not.toContain(':');
    expect(markdownPathFor(path)).toBe('/results/20260712T200102Z-v0.6.0-abcdef123456.md');
    expect(markdownPathFor('/results/custom.output')).toBe('/results/custom.output.md');
  });

  it('marks non-clean default artifacts as dirty', () => {
    expect(basename(defaultJsonPath('/results', FIXED_DATE, CLI_VERSION, GIT_SHA, 'dirty'))).toBe(
      '20260712T200102Z-v0.6.0-abcdef123456-dirty.json',
    );
    expect(
      basename(defaultJsonPath('/results', FIXED_DATE, CLI_VERSION, GIT_SHA, 'changed-during-run')),
    ).toBe('20260712T200102Z-v0.6.0-abcdef123456-dirty.json');
  });
});

describe('parseGitProvenance', () => {
  it('binds one porcelain snapshot to its revision and dirty state', () => {
    expect(
      parseGitProvenance(
        '# branch.oid abcdef1234567890abcdef1234567890abcdef12\n# branch.head main\n',
      ),
    ).toEqual({ gitSha: GIT_SHA, worktreeDirty: false });
    expect(
      parseGitProvenance(
        '# branch.oid abcdef1234567890abcdef1234567890abcdef12\n? packages/agent-eval/\n',
      ),
    ).toEqual({ gitSha: GIT_SHA, worktreeDirty: true });
  });

  it('rejects promotion when the bounded ignored-source inventory is non-empty', () => {
    const revision = '# branch.oid abcdef1234567890abcdef1234567890abcdef12\n';
    expect(parseGitProvenance(revision, '')).toEqual({
      gitSha: GIT_SHA,
      worktreeDirty: false,
    });
    expect(parseGitProvenance(revision, 'packages/core/src/ignored.ts\0')).toEqual({
      gitSha: GIT_SHA,
      worktreeDirty: true,
    });
  });

  it('keeps an ignored environment file clean but rejects ignored graph source', async () => {
    const root = temporaryDirectory('agent-eval-git-provenance-');
    writeFileSync(join(root, '.gitignore'), '.env\n*.ts\ngo.sum\n', 'utf8');
    writeFileSync(join(root, 'README.md'), 'tracked\n', 'utf8');
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Agent Eval',
        '-c',
        'user.email=eval@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'initial',
      ],
      { cwd: root },
    );
    writeFileSync(join(root, '.env'), 'IGNORED_SECRET=needle\n', 'utf8');

    await expect(resolveGitProvenance(root)).resolves.toMatchObject({
      worktreeDirty: false,
    });
    writeFileSync(join(root, 'go.sum'), 'example.invalid/module v1.0.0 hash\n', 'utf8');
    await expect(resolveGitProvenance(root)).resolves.toMatchObject({
      worktreeDirty: true,
    });
    rmSync(join(root, 'go.sum'));
    writeFileSync(join(root, 'ignored.ts'), 'export const ignored = true;\n', 'utf8');
    await expect(resolveGitProvenance(root)).resolves.toMatchObject({
      worktreeDirty: true,
    });
  });

  it('fails closed when the snapshot has no commit identity', () => {
    expect(() => parseGitProvenance('# branch.oid (initial)\n# branch.head main\n')).toThrow(
      HarnessPrerequisiteError,
    );
  });
});

describe('main', () => {
  it('prints help and task ids without resolving run prerequisites', async () => {
    const root = temporaryDirectory();
    let prerequisiteCalls = 0;
    const harness = dependencyHarness(root, {
      resolveCliVersion: () => {
        prerequisiteCalls += 1;
        return Promise.resolve(CLI_VERSION);
      },
    });

    await expect(main(['--help'], harness.dependencies)).resolves.toBe(0);
    expect(harness.stdout()).toBe(USAGE);
    expect(harness.stderr()).toBe('');

    const listHarness = dependencyHarness(root, {
      resolveCliVersion: harness.dependencies.resolveCliVersion,
    });
    await expect(main(['--list'], listHarness.dependencies)).resolves.toBe(0);
    expect(listHarness.stdout()).toBe(`${TASK_ONE.id}\n${TASK_TWO.id}\n`);
    expect(listHarness.stderr()).toBe('');
    expect(prerequisiteCalls).toBe(0);
  });

  it('executes selected tasks and arms sequentially and writes both report formats', async () => {
    const root = temporaryDirectory();
    const jsonPath = join(root, 'reports', 'ordered.json');
    const harness = dependencyHarness(root, {
      runArm: (task, arm) => {
        harness.calls.push(`${task.id}:${arm}`);
        const first = task.id === TASK_TWO.id && arm === 'control';
        return Promise.resolve(armResult(task, arm, !first));
      },
    });

    const exitCode = await main(
      ['--task', TASK_TWO.id, '--task', TASK_ONE.id, '--arm', 'both', '--json', jsonPath],
      harness.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(harness.calls).toEqual([
      `${TASK_TWO.id}:control`,
      `${TASK_TWO.id}:opensip`,
      `${TASK_ONE.id}:control`,
      `${TASK_ONE.id}:opensip`,
    ]);
    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as EvalReport;
    expect(report).toMatchObject({
      cliVersion: CLI_VERSION,
      contractFingerprint: `sha256:${'a'.repeat(64)}`,
      gitSha: GIT_SHA,
      harnessVersion: '0.6.0',
      nodeVersion: 'v24.0.0',
      platform: 'test-platform',
      promotionEligible: true,
      schemaVersion: 1,
      selectedArms: ['control', 'opensip'],
      sourceState: 'clean',
    });
    expect(report.tasks.map((task) => task.taskId)).toEqual([TASK_TWO.id, TASK_ONE.id]);
    expect(existsSync(markdownPathFor(jsonPath))).toBe(true);
    expect(harness.stdout()).toBe(
      `Report: ${jsonPath}\nCompleted 2 task(s), 4 arm run(s), 1 assertion failure(s).\n`,
    );
    expect(harness.stderr()).toContain(`${TASK_TWO.id} [control] starting`);
    expect(harness.stderr()).toContain('report artifacts complete');
  });

  it('records the installed CLI target and threads one target to version + arm runs', async () => {
    const root = temporaryDirectory();
    const entrypoint = installedCliEntrypoint(root);
    const realEntrypoint = realpathSync(entrypoint);
    const jsonPath = join(root, 'installed.json');
    const targets: { entrypoint: string; phase: string; source: string }[] = [];
    const harness = dependencyHarness(root, {
      resolveCliVersion: (target) => {
        targets.push({
          entrypoint: target.entrypoint,
          phase: 'version',
          source: target.source,
        });
        return Promise.resolve(CLI_VERSION);
      },
      runArm: (task, arm, target) => {
        targets.push({
          entrypoint: target.entrypoint,
          phase: 'arm',
          source: target.source,
        });
        return Promise.resolve(armResult(task, arm));
      },
    });

    await expect(
      main(
        [
          '--task',
          TASK_ONE.id,
          '--arm',
          'opensip',
          '--opensip-entrypoint',
          entrypoint,
          '--json',
          jsonPath,
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(0);

    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as EvalReport;
    expect(report.cliTarget).toMatchObject({
      entrypointName: 'cli.js',
      source: 'installed',
    });
    expect(report.cliTarget?.source === 'installed' && report.cliTarget.entrypointSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(report.cliTarget?.source === 'installed' && report.cliTarget.packageJsonSha256).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(targets).toEqual([
      { entrypoint: realEntrypoint, phase: 'version', source: 'installed' },
      { entrypoint: realEntrypoint, phase: 'arm', source: 'installed' },
    ]);
  });

  it('rejects an installed entrypoint that is not a usable JS bin with exit two', async () => {
    const root = temporaryDirectory();
    const harness = dependencyHarness(root);
    await expect(
      main(
        ['--task', TASK_ONE.id, '--opensip-entrypoint', join(root, 'missing.js')],
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    expect(harness.calls).toEqual([]);
    expect(harness.stderr()).toContain('prerequisite');
  });

  it('rejects installed entrypoint bytes changed by an arm before writing evidence', async () => {
    const root = temporaryDirectory();
    const entrypoint = installedCliEntrypoint(root);
    const jsonPath = join(root, 'mutated.json');
    const harness = dependencyHarness(root, {
      runArm: (task, arm) => {
        writeFileSync(entrypoint, 'export default 2;\n', 'utf8');
        return Promise.resolve(armResult(task, arm));
      },
    });

    await expect(
      main(
        [
          '--task',
          TASK_ONE.id,
          '--arm',
          'opensip',
          '--opensip-entrypoint',
          entrypoint,
          '--json',
          jsonPath,
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    expect(existsSync(jsonPath)).toBe(false);
    expect(harness.stderr()).toContain('prerequisite');
  });

  it('rejects a private snapshot mutation at the final run boundary before writing evidence', async () => {
    const root = temporaryDirectory();
    const entrypoint = installedCliEntrypoint(root);
    const jsonPath = join(root, 'snapshot-mutated.json');
    const harness = dependencyHarness(root, {
      runArm: (task, arm, target) => {
        if (target.source !== 'installed') throw new TypeError('expected an installed target');
        chmodSync(target.executionEntrypoint, 0o600);
        writeFileSync(target.executionEntrypoint, 'export default 2;\n', 'utf8');
        return Promise.resolve(armResult(task, arm));
      },
    });

    await expect(
      main(
        [
          '--task',
          TASK_ONE.id,
          '--arm',
          'opensip',
          '--opensip-entrypoint',
          entrypoint,
          '--json',
          jsonPath,
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(2);
    expect(existsSync(jsonPath)).toBe(false);
    expect(harness.stderr()).toContain('prerequisite');
  });

  it('records a workspace target source when no installed entrypoint is supplied', async () => {
    const root = temporaryDirectory();
    const jsonPath = join(root, 'workspace.json');
    const harness = dependencyHarness(root);
    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'control', '--json', jsonPath], harness.dependencies),
    ).resolves.toBe(0);
    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as EvalReport;
    expect(report.cliTarget?.source).toBe('workspace');
  });

  it('runs only the requested arm without a hidden peer run', async () => {
    const root = temporaryDirectory();
    const jsonPath = join(root, 'opensip-only.json');
    const harness = dependencyHarness(root);

    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'opensip', '--json', jsonPath], harness.dependencies),
    ).resolves.toBe(0);

    expect(harness.calls).toEqual([`${TASK_ONE.id}:opensip`]);
    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as EvalReport;
    expect(report.selectedArms).toEqual(['opensip']);
    expect(Object.keys(report.tasks[0]?.arms ?? {})).toEqual(['opensip']);
  });

  it('keeps task assertion failures as report data with exit zero', async () => {
    const root = temporaryDirectory();
    const jsonPath = join(root, 'failed-assertion.json');
    const harness = dependencyHarness(root, {
      runArm: (task, arm) => Promise.resolve(armResult(task, arm, false)),
    });

    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'control', '--json', jsonPath], harness.dependencies),
    ).resolves.toBe(0);
    expect(harness.stdout()).toContain('1 assertion failure(s)');
  });

  it('uses collision-safe default names without modifying prior artifacts', async () => {
    const root = temporaryDirectory();
    const firstHarness = dependencyHarness(root);
    const secondHarness = dependencyHarness(root);

    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'control'], firstHarness.dependencies),
    ).resolves.toBe(0);
    const firstPath = defaultJsonPath(
      join(root, 'results'),
      FIXED_DATE,
      CLI_VERSION,
      GIT_SHA,
      'clean',
    );
    const firstJson = readFileSync(firstPath, 'utf8');

    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'control'], secondHarness.dependencies),
    ).resolves.toBe(0);
    const secondPath = firstPath.replace(/\.json$/u, '-2.json');

    expect(readFileSync(firstPath, 'utf8')).toBe(firstJson);
    expect(existsSync(secondPath)).toBe(true);
    expect(existsSync(markdownPathFor(firstPath))).toBe(true);
    expect(existsSync(markdownPathFor(secondPath))).toBe(true);
    expect(secondHarness.stdout()).toContain(secondPath);
  });

  it('marks dirty runs as non-promotable and uses a dirty default filename', async () => {
    const root = temporaryDirectory();
    const harness = dependencyHarness(root, {
      resolveGitProvenance: () => Promise.resolve({ gitSha: GIT_SHA, worktreeDirty: true }),
    });

    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'control'], harness.dependencies),
    ).resolves.toBe(0);

    const path = defaultJsonPath(join(root, 'results'), FIXED_DATE, CLI_VERSION, GIT_SHA, 'dirty');
    const report = JSON.parse(readFileSync(path, 'utf8')) as EvalReport;
    expect(report).toMatchObject({
      gitSha: GIT_SHA,
      promotionEligible: false,
      sourceState: 'dirty',
    });
    expect(harness.stderr()).toContain('dirty; report will be non-promotable');
  });

  it('fails promotion eligibility when the revision changes during a run', async () => {
    const root = temporaryDirectory();
    const snapshots = [
      { gitSha: GIT_SHA, worktreeDirty: false },
      { gitSha: '123456abcdef', worktreeDirty: false },
    ];
    const harness = dependencyHarness(root, {
      resolveGitProvenance: () => {
        const snapshot = snapshots.shift();
        if (snapshot === undefined) throw new Error('unexpected provenance read');
        return Promise.resolve(snapshot);
      },
    });

    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'control'], harness.dependencies),
    ).resolves.toBe(0);

    const path = defaultJsonPath(
      join(root, 'results'),
      FIXED_DATE,
      CLI_VERSION,
      GIT_SHA,
      'changed-during-run',
    );
    const report = JSON.parse(readFileSync(path, 'utf8')) as EvalReport;
    expect(report).toMatchObject({
      gitSha: GIT_SHA,
      promotionEligible: false,
      sourceState: 'changed-during-run',
    });
    expect(harness.stderr()).toContain('revision changed during the run');
  });

  it('rejects an explicit existing pair before running and never overwrites it', async () => {
    const root = temporaryDirectory();
    const jsonPath = join(root, 'immutable.json');
    const markdownPath = markdownPathFor(jsonPath);
    writeFileSync(jsonPath, 'original json', 'utf8');
    writeFileSync(markdownPath, 'original markdown', 'utf8');
    const harness = dependencyHarness(root);

    await expect(
      main(['--task', TASK_ONE.id, '--json', jsonPath], harness.dependencies),
    ).resolves.toBe(1);

    expect(harness.calls).toEqual([]);
    expect(readFileSync(jsonPath, 'utf8')).toBe('original json');
    expect(readFileSync(markdownPath, 'utf8')).toBe('original markdown');
    expect(harness.stdout()).toBe('');
    expect(harness.stderr()).toContain('already exists');
  });

  it('does not create the JSON half when only the explicit markdown sibling exists', async () => {
    const root = temporaryDirectory();
    const jsonPath = join(root, 'half.json');
    writeFileSync(markdownPathFor(jsonPath), 'existing markdown', 'utf8');
    const harness = dependencyHarness(root);

    await expect(main(['--json', jsonPath], harness.dependencies)).resolves.toBe(1);
    expect(existsSync(jsonPath)).toBe(false);
  });

  it('removes a newly written JSON file if the markdown write loses a race', async () => {
    const root = temporaryDirectory();
    const files = new Map<string, string>();
    let writeCount = 0;
    const fileSystem: ArtifactFileSystem = {
      exists: () => Promise.resolve(false),
      mkdir: () => Promise.resolve(),
      remove: (path) => {
        files.delete(path);
        return Promise.resolve();
      },
      writeExclusive: (path, content) => {
        writeCount += 1;
        if (writeCount === 2) {
          return Promise.reject(
            Object.assign(new Error('simulated collision'), { code: 'EEXIST' }),
          );
        }
        files.set(path, content);
        return Promise.resolve();
      },
    };
    const harness = dependencyHarness(root, { artifactFileSystem: fileSystem });

    await expect(
      main(['--task', TASK_ONE.id, '--json', 'race.json'], harness.dependencies),
    ).resolves.toBe(1);

    expect(writeCount).toBe(2);
    expect(files.size).toBe(0);
    expect(harness.stderr()).toContain('already exists');
  });

  it('maps invalid invocation and unknown tasks to exit two with usage and known ids', async () => {
    const root = temporaryDirectory();
    for (const argv of [['--wat'], ['--arm', 'hostile'], ['--task']] as const) {
      const invalid = dependencyHarness(root);
      await expect(main(argv, invalid.dependencies)).resolves.toBe(2);
      expect(invalid.stderr()).toContain(USAGE);
      expect(invalid.stdout()).toBe('');
    }

    const unknown = dependencyHarness(root);
    await expect(main(['--task', 'no-such-task'], unknown.dependencies)).resolves.toBe(2);
    expect(unknown.stderr()).toContain(TASK_ONE.id);
    expect(unknown.stderr()).toContain(TASK_TWO.id);
    expect(unknown.stderr()).not.toContain('no-such-task');
    expect(unknown.stderr()).toContain(USAGE);
  });

  it('maps missing prerequisites to exit two with a bounded one-line remedy', async () => {
    const root = temporaryDirectory();
    const harness = dependencyHarness(root, {
      resolveCliVersion: () =>
        Promise.reject(new HarnessPrerequisiteError('Built CLI missing.\nRun pnpm build.')),
    });

    await expect(main([], harness.dependencies)).resolves.toBe(2);
    expect(harness.stdout()).toBe('');
    expect(harness.stderr().trim().split('\n')).toHaveLength(1);
    expect(harness.stderr()).toContain('prerequisite');
    expect(harness.stderr()).toContain('Run pnpm build');
  });

  it('maps unexpected harness failures to exit one without leaking error or environment secrets', async () => {
    const root = temporaryDirectory();
    const canary = 'canary-not-a-real-secret';
    const previous = process.env.OPENSIP_API_KEY;
    process.env.OPENSIP_API_KEY = canary;
    try {
      const harness = dependencyHarness(root, {
        runArm: () => Promise.reject(new Error(`child capture contained ${canary}`)),
      });

      await expect(
        main(['--task', TASK_ONE.id, '--json', join(root, 'secret.json')], harness.dependencies),
      ).resolves.toBe(1);
      expect(harness.stdout()).not.toContain(canary);
      expect(harness.stderr()).not.toContain(canary);
      expect(harness.stderr()).toContain('harness error');
      expect(existsSync(join(root, 'secret.json'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENSIP_API_KEY;
      else process.env.OPENSIP_API_KEY = previous;
    }
  });

  it('rejects an invalid report through the shared validator before writing either artifact', async () => {
    const root = temporaryDirectory();
    const jsonPath = join(root, 'invalid.json');
    const harness = dependencyHarness(root, {
      runArm: (task, arm) =>
        Promise.resolve({
          ...armResult(task, arm),
          record: { ...armResult(task, arm).record, taskId: 'wrong-task' },
        }),
    });

    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'control', '--json', jsonPath], harness.dependencies),
    ).resolves.toBe(1);
    expect(existsSync(jsonPath)).toBe(false);
    expect(existsSync(markdownPathFor(jsonPath))).toBe(false);
    expect(harness.stderr()).toContain('invalid report');
  });

  it('creates a missing requested directory before writing the complete pair', async () => {
    const root = temporaryDirectory();
    const outputDirectory = join(root, 'nested', 'reports');
    const jsonPath = join(outputDirectory, 'pair.json');
    const harness = dependencyHarness(root);

    await expect(
      main(['--task', TASK_ONE.id, '--arm', 'control', '--json', jsonPath], harness.dependencies),
    ).resolves.toBe(0);
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(markdownPathFor(jsonPath))).toBe(true);
  });
});
