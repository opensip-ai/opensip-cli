import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SETUP_FIXTURE_PROJECT_DEPENDENCIES,
  buildGraphArgv,
  buildInitArgv,
  setupFixtureProject,
  type SetupFixtureProjectDependencies,
} from './opensip-cli.js';

import type { SpawnResult } from '../runner/spawn.js';

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    durationMs: 12,
    exitCode: 0,
    outputLimitExceeded: false,
    signal: null,
    stderr: '',
    stdout: '',
    timedOut: false,
    ...overrides,
  };
}

function dependenciesWith(results: readonly SpawnResult[]): SetupFixtureProjectDependencies & {
  readonly prepareHome: ReturnType<typeof vi.fn<SetupFixtureProjectDependencies['prepareHome']>>;
  readonly spawnCli: ReturnType<typeof vi.fn<SetupFixtureProjectDependencies['spawnCli']>>;
} {
  const spawnStub = vi.fn<SetupFixtureProjectDependencies['spawnCli']>();
  for (const result of results) spawnStub.mockResolvedValueOnce(result);
  return {
    ...DEFAULT_SETUP_FIXTURE_PROJECT_DEPENDENCIES,
    prepareHome: vi.fn<SetupFixtureProjectDependencies['prepareHome']>(),
    spawnCli: spawnStub,
  };
}

describe('OpenSIP setup argv', () => {
  it('keeps a project path containing spaces in one init argument', () => {
    const root = join(process.cwd(), 'customer fixture', 'project');
    expect(buildInitArgv(root, 'typescript')).toEqual([
      'init',
      '--cwd',
      root,
      '--language',
      'typescript',
      '--json',
    ]);
  });

  it('places the root --no-cloud flag before graph and forces language and cwd', () => {
    const root = join(process.cwd(), 'customer fixture', 'project');
    expect(buildGraphArgv(root, 'python')).toEqual([
      '--no-cloud',
      'graph',
      '--json',
      '--cwd',
      root,
      '--language',
      'python',
    ]);
  });
});

describe('setupFixtureProject', () => {
  it('runs init then graph with one isolated deterministic environment', async () => {
    const root = join(process.cwd(), 'customer fixture', 'project');
    const dependencies = dependenciesWith([
      spawnResult({ durationMs: 7 }),
      spawnResult({ durationMs: 19 }),
    ]);

    await expect(setupFixtureProject(root, 'typescript', dependencies)).resolves.toEqual({
      mode: 'fixture',
      stages: [
        { durationMs: 7, exitCode: 0, name: 'init' },
        { durationMs: 19, exitCode: 0, name: 'graph' },
      ],
    });

    expect(dependencies.spawnCli).toHaveBeenCalledTimes(2);
    expect(dependencies.prepareHome).toHaveBeenCalledOnce();
    expect(dependencies.prepareHome).toHaveBeenCalledWith(join(root, '.agent-eval-home'));
    expect(dependencies.spawnCli.mock.calls[0]?.[0]).toEqual(buildInitArgv(root, 'typescript'));
    expect(dependencies.spawnCli.mock.calls[1]?.[0]).toEqual(buildGraphArgv(root, 'typescript'));
    const initOptions = dependencies.spawnCli.mock.calls[0]?.[1];
    const graphOptions = dependencies.spawnCli.mock.calls[1]?.[1];
    expect(initOptions?.cwd).toBe(root);
    expect(initOptions?.env).toMatchObject({
      CI: '1',
      HOME: join(root, '.agent-eval-home'),
      NO_COLOR: '1',
      OPENSIP_CLI_SKIP_INSTALLED: '1',
      OPENSIP_NO_UPDATE: '1',
      XDG_CONFIG_HOME: join(root, '.agent-eval-home', '.config'),
    });
    expect(graphOptions?.env).toBe(initOptions?.env);
  });

  it('accepts graph exit code 1 because a catalog may still have been persisted', async () => {
    const dependencies = dependenciesWith([spawnResult(), spawnResult({ exitCode: 1 })]);
    const root = join(process.cwd(), 'project');

    await expect(setupFixtureProject(root, 'go', dependencies)).resolves.toMatchObject({
      stages: [
        { exitCode: 0, name: 'init' },
        { exitCode: 1, name: 'graph' },
      ],
    });
  });

  it('rejects an init nonzero exit and does not start graph', async () => {
    const dependencies = dependenciesWith([
      spawnResult({ exitCode: 2, stderr: 'invalid configuration' }),
    ]);

    await expect(
      setupFixtureProject(join(process.cwd(), 'project'), 'java', dependencies),
    ).rejects.toThrow(
      /OpenSIP init setup exited with code 2.*Diagnostic tail.*invalid configuration/s,
    );
    expect(dependencies.spawnCli).toHaveBeenCalledTimes(1);
  });

  it('rejects graph exits outside the documented zero-or-one acceptance set', async () => {
    const dependencies = dependenciesWith([spawnResult(), spawnResult({ exitCode: 2 })]);

    await expect(
      setupFixtureProject(join(process.cwd(), 'project'), 'rust', dependencies),
    ).rejects.toThrow('OpenSIP graph setup exited with code 2.');
  });

  it.each([
    ['init', [spawnResult({ exitCode: null, signal: 'SIGTERM', timedOut: true })]],
    ['graph', [spawnResult(), spawnResult({ exitCode: null, signal: 'SIGTERM', timedOut: true })]],
  ] as const)('rejects a %s timeout', async (stage, results) => {
    const dependencies = dependenciesWith(results);
    await expect(
      setupFixtureProject(join(process.cwd(), 'project'), 'typescript', dependencies),
    ).rejects.toThrow(`OpenSIP ${stage} setup timed out.`);
  });

  it.each([
    ['init', [spawnResult({ outputLimitExceeded: true })]],
    ['graph', [spawnResult(), spawnResult({ outputLimitExceeded: true })]],
  ] as const)(
    'rejects truncated %s output even when the process exited zero',
    async (stage, results) => {
      const dependencies = dependenciesWith(results);
      await expect(
        setupFixtureProject(join(process.cwd(), 'project'), 'typescript', dependencies),
      ).rejects.toThrow(`OpenSIP ${stage} setup exceeded the output limit.`);
    },
  );
});
