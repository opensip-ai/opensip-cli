import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeStepRecord } from '../model/record.js';

import {
  DOGFOOD_FIXTURE_REFERENCE,
  buildMcpSessionOptions,
  resolveFixtureReference,
  runTask,
  runTaskArm,
  type RunTaskDependencies,
} from './run-task.js';
import { HarnessPrerequisiteError, buildCliTarget, cleanupCliTarget } from './spawn.js';

import type { FixtureCopySource } from './fixture-workspace.js';
import type { McpSetupProvenance, SetupRecord, StepRecord, ToolInvoker } from '../model/record.js';
import type { AnswerFact, GoldTask, ResolvedStrategyStep, StrategyStep } from '../model/task.js';

const temporaryRoots: string[] = [];
const temporaryTargets: ReturnType<typeof buildCliTarget>[] = [];

function installedTarget(entrypoint: string): ReturnType<typeof buildCliTarget> {
  const target = buildCliTarget(entrypoint);
  temporaryTargets.push(target);
  return target;
}

function temporaryDirectory(prefix = 'agent-eval-run-task-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function installedCliEntrypoint(root: string): string {
  const packageRoot = join(root, 'node_modules', 'opensip-cli');
  const entrypoint = join(packageRoot, 'dist', 'cli.js');
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ bin: { opensip: './dist/cli.js' }, name: 'opensip-cli' })}\n`,
  );
  writeFileSync(entrypoint, 'export default 1;\n');
  return entrypoint;
}

function step(id: string, tool = 'readFile'): StrategyStep {
  return {
    arguments: { path: 'src/index.ts' },
    extract: () => [],
    id,
    rationale: `Execute ${id}.`,
    tool,
  };
}

function textFact(value: string): AnswerFact {
  return { kind: 'text', label: 'answer', value };
}

function recordFor(
  resolved: ResolvedStrategyStep,
  facts: readonly AnswerFact[],
  options: {
    readonly catalogIdentity?: string;
    readonly coverage?: StepRecord['coverage'];
    readonly failure?: StepRecord['failure'];
    readonly freshness?: StepRecord['freshness'];
  } = {},
): StepRecord {
  return makeStepRecord({
    catalogIdentity: options.catalogIdentity,
    completeness: 'complete',
    facts,
    failure: options.failure,
    freshness: options.freshness,
    coverage: options.coverage,
    leg: resolved.leg ?? 'main',
    renderedResponse: resolved.id,
    step: resolved,
    wallMs: 1,
  });
}

function ordinaryTask(fixture = 'customer-ts'): GoldTask {
  return {
    assertions: { mustInclude: [textFact('found')] },
    fixture,
    id: `ordinary-${fixture}`,
    question: 'Find the answer.',
    strategies: {
      control: {
        arm: 'control',
        steps: [step('control-main')],
        version: 'control-v1',
      },
      opensip: {
        arm: 'opensip',
        steps: [step('opensip-main', 'search_symbols')],
        version: 'opensip-v1',
      },
    },
  };
}

function setupRecord(root: string): SetupRecord {
  return {
    mode: 'fixture',
    stages: [
      { durationMs: 2, exitCode: 0, name: `init:${root}` },
      { durationMs: 3, exitCode: 0, name: `graph:${root}` },
    ],
  };
}

function provenance(): McpSetupProvenance {
  return {
    handshakeDurationMs: 4,
    mutationPosture: 'read-only',
    projectRootVerified: true,
    projectScope: 'project',
    stderr: { bytes: 0, truncated: false },
    surfaceEpoch: 4,
    surfaceVerified: true,
    toolCount: 21,
    toolNames: ['get_architecture'],
    version: '0.6.0',
  };
}

interface FakeSessionOptions {
  readonly catalogAvailable?: boolean;
  readonly catalogFreshness?: StepRecord['freshness'];
  readonly closeError?: Error;
  readonly facts?: Readonly<Record<string, readonly AnswerFact[]>>;
  readonly throwOnStep?: string;
}

function fakeSession(root: string, events: string[], options: FakeSessionOptions = {}) {
  let closed = false;
  const invoker: ToolInvoker = (resolved) => {
    events.push(`mcp:${resolved.id}`);
    if (resolved.id === options.throwOnStep) {
      return Promise.reject(new Error('tool transport failed'));
    }
    if (resolved.id === 'catalog-prerequisite') {
      return Promise.resolve(
        recordFor(resolved, [], {
          ...(options.catalogAvailable === false ? {} : { catalogIdentity: 'g1:dogfood' }),
          coverage: { complete: true, truncated: false },
          freshness: options.catalogFreshness ?? {
            fresh: true,
            verification: 'complete',
          },
        }),
      );
    }
    return Promise.resolve(
      recordFor(resolved, options.facts?.[resolved.id] ?? [textFact('found')]),
    );
  };
  return {
    close: () => {
      events.push('mcp:close');
      closed = true;
      return options.closeError === undefined
        ? Promise.resolve()
        : Promise.reject(options.closeError);
    },
    invoker: () => invoker,
    provenance: () => {
      if (!closed) throw new Error('provenance requested before close');
      events.push('mcp:provenance');
      return provenance();
    },
  };
}

function fakeFixtureCopies(events: string[], roots: readonly string[]) {
  let index = 0;
  return async <T>(
    _source: FixtureCopySource,
    run: (workspaceRoot: string) => Promise<T>,
  ): Promise<T> => {
    const root = roots[index];
    index += 1;
    if (root === undefined) throw new Error('unexpected fixture copy');
    events.push(`copy:start:${root}`);
    try {
      return await run(root);
    } finally {
      events.push(`copy:cleanup:${root}`);
    }
  };
}

function invokerWithEvents(
  prefix: string,
  events: string[],
  facts: Readonly<Record<string, readonly AnswerFact[]>> = {},
): ToolInvoker {
  return (resolved) => {
    events.push(`${prefix}:${resolved.id}`);
    return Promise.resolve(recordFor(resolved, facts[resolved.id] ?? [textFact('found')]));
  };
}

function visibleDogfoodFiles(root: string) {
  return Promise.resolve([
    { absolutePath: join(root, 'package.json'), relativePath: 'package.json' },
  ]);
}

afterEach(() => {
  for (const target of temporaryTargets.splice(0)) cleanupCliTarget(target);
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('fixture reference resolution', () => {
  it('resolves the closed customer fixture vocabulary and language centrally', () => {
    const fixturesRoot = temporaryDirectory();
    mkdirSync(join(fixturesRoot, 'customer-py'));

    expect(resolveFixtureReference('customer-py', { fixturesRoot })).toEqual({
      language: 'python',
      mode: 'fixture',
      repositoryRoot: realpathSync(fixturesRoot),
      sourceRoot: realpathSync(join(fixturesRoot, 'customer-py')),
    });
    expect(() => resolveFixtureReference('../customer-py', { fixturesRoot })).toThrow(
      'Unknown agent-eval fixture reference',
    );
  });

  it('rejects a known fixture name whose symlink escapes the fixture root', () => {
    const fixturesRoot = temporaryDirectory();
    const outside = temporaryDirectory();
    symlinkSync(outside, join(fixturesRoot, 'customer-ts'), 'dir');

    expect(() => resolveFixtureReference('customer-ts', { fixturesRoot })).toThrow(
      /escapes.*symlink/u,
    );
  });

  it('recognizes dogfood as the canonical existing repository root', () => {
    const repositoryRoot = temporaryDirectory();
    expect(resolveFixtureReference(DOGFOOD_FIXTURE_REFERENCE, { repositoryRoot })).toEqual({
      mode: 'reuse-existing',
      workspaceRoot: realpathSync(repositoryRoot),
    });
  });
});

describe('ordinary task orchestration', () => {
  it('shares fixture setup HOME with MCP while dogfood leaves the repository untouched', () => {
    const root = temporaryDirectory();

    expect(buildMcpSessionOptions(root, 'fixture')).toEqual({
      env: { HOME: join(root, '.agent-eval-home') },
      workspaceRoot: root,
    });
    expect(buildMcpSessionOptions(root, 'reuse-existing')).toEqual({
      workspaceRoot: root,
    });
  });

  it('threads a CLI target into MCP command and entrypoint resolution', () => {
    const root = temporaryDirectory();
    const entrypoint = installedCliEntrypoint(root);
    const target = installedTarget(entrypoint);
    const options = buildMcpSessionOptions(root, 'fixture', target);
    expect(options.workspaceRoot).toBe(root);
    expect(options.env).toEqual({ HOME: join(root, '.agent-eval-home') });
    expect(options.cliCommand).toBe(process.execPath);
    expect(options.cliPreludeArgs).toEqual(target.executionPrelude);
    expect(options.cliDistResolver?.()).toBe(
      target.source === 'installed' ? target.executionEntrypoint : '',
    );
  });

  it('keeps MCP entrypoint resolution pure and verifies once at the process boundary', () => {
    const root = temporaryDirectory();
    const entrypoint = installedCliEntrypoint(root);
    const target = installedTarget(entrypoint);
    const options = buildMcpSessionOptions(root, 'fixture', target);
    writeFileSync(entrypoint, 'export default 2;\n');

    expect(options.cliDistResolver?.()).toBe(
      target.source === 'installed' ? target.executionEntrypoint : '',
    );
    expect(() => options.targetStabilityCheck?.()).toThrow(/changed/u);
  });

  it('threads the run CLI target into fixture setup and the MCP session', async () => {
    const events: string[] = [];
    const root = temporaryDirectory('target-threading-');
    const entrypoint = installedCliEntrypoint(root);
    const target = installedTarget(entrypoint);
    let setupTarget: unknown;
    let connectTarget: unknown;
    let maxToolCalls: number | undefined;
    await runTaskArm(ordinaryTask(), 'opensip', {
      cliTarget: target,
      dependencies: {
        connectMcp: (workspaceRoot, _mode, injected, requestedToolCalls) => {
          connectTarget = injected;
          maxToolCalls = requestedToolCalls;
          return Promise.resolve(fakeSession(workspaceRoot, events));
        },
        setupFixture: (workspaceRoot, _language, injected) => {
          setupTarget = injected;
          return Promise.resolve(setupRecord(workspaceRoot));
        },
        withFixture: fakeFixtureCopies(events, [root]),
      },
    });
    expect(setupTarget).toBe(target);
    expect(connectTarget).toBe(target);
    expect(maxToolCalls).toBe(2);
  });

  it.each(['control', 'opensip'] as const)(
    'executes only the selected %s arm without fabricating its peer',
    async (arm) => {
      const events: string[] = [];
      const root = temporaryDirectory(`selected-${arm}-`);
      const result = await runTaskArm(ordinaryTask(), arm, {
        dependencies: {
          connectMcp: (workspaceRoot, mode) => {
            events.push(`connect:${workspaceRoot}:${mode}`);
            return Promise.resolve(fakeSession(workspaceRoot, events));
          },
          createControlInvoker: (workspaceRoot) => {
            events.push(`native:bind:${workspaceRoot}`);
            return invokerWithEvents('native', events);
          },
          setupFixture: (workspaceRoot) => {
            events.push(`setup:${workspaceRoot}`);
            return Promise.resolve(setupRecord(workspaceRoot));
          },
          withFixture: fakeFixtureCopies(events, [root]),
        },
      });

      expect(result.record.arm).toBe(arm);
      if (arm === 'control') {
        expect(events).toEqual([
          `copy:start:${root}`,
          `native:bind:${root}`,
          'native:control-main',
          `copy:cleanup:${root}`,
        ]);
      } else {
        expect(events).toEqual([
          `copy:start:${root}`,
          `setup:${root}`,
          `connect:${root}:fixture`,
          'mcp:catalog-prerequisite',
          'mcp:opensip-main',
          'mcp:close',
          'mcp:provenance',
          `copy:cleanup:${root}`,
        ]);
      }
    },
  );

  it('runs control first in a fresh copy, then setup and one closed MCP session in another', async () => {
    const events: string[] = [];
    const controlRoot = temporaryDirectory('agent-eval-control-copy-');
    const opensipRoot = temporaryDirectory('agent-eval-opensip-copy-');
    let sessionOpen = false;
    const setupFixture = vi.fn((root: string) => {
      if (sessionOpen) return Promise.reject(new Error('CLI setup ran while MCP was open'));
      events.push(`setup:${root}`);
      return Promise.resolve(setupRecord(root));
    });
    const connectMcp: RunTaskDependencies['connectMcp'] = (root, mode) => {
      events.push(`connect:${root}:${mode}`);
      sessionOpen = true;
      const session = fakeSession(root, events);
      return Promise.resolve({
        ...session,
        close: () => {
          sessionOpen = false;
          return session.close();
        },
      });
    };

    const result = await runTask(ordinaryTask(), {
      dependencies: {
        connectMcp,
        createControlInvoker: (root) => {
          events.push(`native:bind:${root}`);
          return invokerWithEvents('native', events);
        },
        now: () => new Date('2026-07-12T12:00:00.000Z'),
        setupFixture,
        withFixture: fakeFixtureCopies(events, [controlRoot, opensipRoot]),
      },
    });

    expect(events).toEqual([
      `copy:start:${controlRoot}`,
      `native:bind:${controlRoot}`,
      'native:control-main',
      `copy:cleanup:${controlRoot}`,
      `copy:start:${opensipRoot}`,
      `setup:${opensipRoot}`,
      `connect:${opensipRoot}:fixture`,
      'mcp:catalog-prerequisite',
      'mcp:opensip-main',
      'mcp:close',
      'mcp:provenance',
      `copy:cleanup:${opensipRoot}`,
    ]);
    expect(controlRoot).not.toBe(opensipRoot);
    expect(setupFixture).toHaveBeenCalledOnce();
    expect(result.record.completedAt).toBe('2026-07-12T12:00:00.000Z');
    expect(result.record.arms.control.setup).toEqual({
      mode: 'fixture',
      stages: [],
    });
    expect(result.record.arms.opensip.setup).toMatchObject({
      catalogProbe: { catalogIdentity: 'g1:dogfood', durationMs: 1 },
      mcp: { projectRootVerified: true, surfaceVerified: true },
      mode: 'fixture',
    });
    expect(result.assertions.control.passed).toBe(true);
    expect(result.assertions.opensip.passed).toBe(true);
    expect(result.metrics.control.callCount).toBe(1);
    expect(result.metrics.opensip.callCount).toBe(1);
  });

  it('closes the MCP session and cleans both copies when OpenSIP execution fails', async () => {
    const events: string[] = [];
    const roots = [
      temporaryDirectory('control-failure-test-'),
      temporaryDirectory('opensip-failure-test-'),
    ] as const;

    await expect(
      runTask(ordinaryTask(), {
        dependencies: {
          connectMcp: (root) =>
            Promise.resolve(fakeSession(root, events, { throwOnStep: 'opensip-main' })),
          createControlInvoker: () => invokerWithEvents('native', events),
          setupFixture: (root) => Promise.resolve(setupRecord(root)),
          withFixture: fakeFixtureCopies(events, roots),
        },
      }),
    ).rejects.toThrow('tool transport failed');

    expect(events).toContain('mcp:close');
    expect(events).not.toContain('mcp:provenance');
    expect(events.at(-1)).toBe(`copy:cleanup:${roots[1]}`);
    expect(events.filter((event) => event.startsWith('copy:cleanup:'))).toHaveLength(2);
  });

  it('preserves execution failure when MCP session close also fails', async () => {
    const events: string[] = [];
    const root = temporaryDirectory('execution-close-failure-');

    await expect(
      runTaskArm(ordinaryTask(), 'opensip', {
        dependencies: {
          connectMcp: (workspaceRoot) =>
            Promise.resolve(
              fakeSession(workspaceRoot, events, {
                closeError: new Error('stdio containment failed'),
                throwOnStep: 'opensip-main',
              }),
            ),
          setupFixture: (workspaceRoot) => Promise.resolve(setupRecord(workspaceRoot)),
          withFixture: fakeFixtureCopies(events, [root]),
        },
      }),
    ).rejects.toThrow(
      /tool transport failed.*Related MCP session-close failure: stdio containment failed/u,
    );

    expect(events).toContain('mcp:close');
    expect(events).not.toContain('mcp:provenance');
  });

  it('keeps prerequisite classification when catalog failure and close failure coincide', async () => {
    const events: string[] = [];
    const root = temporaryDirectory('catalog-close-failure-');
    let observed: unknown;

    try {
      await runTaskArm(ordinaryTask(), 'opensip', {
        dependencies: {
          connectMcp: (workspaceRoot) =>
            Promise.resolve(
              fakeSession(workspaceRoot, events, {
                catalogAvailable: false,
                closeError: new Error('stdio containment failed'),
              }),
            ),
          setupFixture: (workspaceRoot) => Promise.resolve(setupRecord(workspaceRoot)),
          withFixture: fakeFixtureCopies(events, [root]),
        },
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(HarnessPrerequisiteError);
    expect((observed as Error).message).toMatch(
      /did not produce a queryable graph catalog.*session-close failure: stdio containment failed/u,
    );
  });

  it('rejects a stale fixture catalog before measured task steps begin', async () => {
    const events: string[] = [];
    const root = temporaryDirectory('stale-catalog-prerequisite-');

    await expect(
      runTaskArm(ordinaryTask(), 'opensip', {
        dependencies: {
          connectMcp: (workspaceRoot) =>
            Promise.resolve(
              fakeSession(workspaceRoot, events, {
                catalogFreshness: {
                  fresh: false,
                  reasonCode: 'source-changed',
                  verification: 'partial',
                },
              }),
            ),
          setupFixture: (workspaceRoot) => Promise.resolve(setupRecord(workspaceRoot)),
          withFixture: fakeFixtureCopies(events, [root]),
        },
      }),
    ).rejects.toThrow(/did not produce a queryable graph catalog/u);

    expect(events).toContain('mcp:catalog-prerequisite');
    expect(events).not.toContain('mcp:opensip-main');
    expect(events).toContain('mcp:close');
  });
});

function stalenessTask(): GoldTask {
  return {
    assertions: {
      scoped: [
        { leg: 'post-edit', mustInclude: [textFact('post')] },
        { leg: 'recovery', mustInclude: [textFact('recovered')] },
      ],
      staleness: { postEditLeg: 'post-edit', recoveryLeg: 'recovery' },
    },
    fixture: 'customer-ts',
    id: 'staleness-order',
    question: 'Does the answer change after the edit?',
    staleness: {
      edit: {
        operations: [{ content: 'changed', kind: 'write', path: 'src/index.ts' }],
      },
      postEditSteps: {
        control: [step('control-post')],
        opensip: [step('opensip-post', 'who_calls')],
      },
      recoverySteps: {
        control: [step('control-recovery')],
        opensip: [step('opensip-refresh', 'refresh_graph'), step('opensip-recovery', 'who_calls')],
      },
    },
    strategies: {
      control: {
        arm: 'control',
        steps: [step('control-pre')],
        version: 'control-v1',
      },
      opensip: {
        arm: 'opensip',
        steps: [step('opensip-pre', 'who_calls')],
        version: 'opensip-v1',
      },
    },
  };
}

describe('staleness orchestration', () => {
  it('uses independent pre/post/recovery legs, applies each copy edit in order, and separates cost', async () => {
    const events: string[] = [];
    const controlRoot = temporaryDirectory('stale-control-');
    const opensipRoot = temporaryDirectory('stale-opensip-');
    const facts = {
      'control-post': [textFact('post')],
      'control-recovery': [textFact('recovered')],
      'opensip-post': [textFact('post')],
      'opensip-recovery': [textFact('recovered')],
      'opensip-refresh': [],
    };

    const result = await runTask(stalenessTask(), {
      dependencies: {
        applyEdit: (root) => {
          events.push(`edit:${root}`);
          return [{ kind: 'write', path: 'src/index.ts' }];
        },
        connectMcp: (root) => Promise.resolve(fakeSession(root, events, { facts })),
        createControlInvoker: () => invokerWithEvents('native', events, facts),
        setupFixture: (root) => {
          events.push(`setup:${root}`);
          return Promise.resolve(setupRecord(root));
        },
        withFixture: fakeFixtureCopies(events, [controlRoot, opensipRoot]),
      },
    });

    expect(events).toEqual([
      `copy:start:${controlRoot}`,
      'native:control-pre',
      `edit:${controlRoot}`,
      'native:control-post',
      'native:control-recovery',
      `copy:cleanup:${controlRoot}`,
      `copy:start:${opensipRoot}`,
      `setup:${opensipRoot}`,
      'mcp:catalog-prerequisite',
      'mcp:opensip-pre',
      `edit:${opensipRoot}`,
      'mcp:opensip-post',
      'mcp:opensip-refresh',
      'mcp:opensip-recovery',
      'mcp:close',
      'mcp:provenance',
      `copy:cleanup:${opensipRoot}`,
    ]);
    expect(result.record.arms.control.legs.map(({ leg }) => leg)).toEqual([
      'pre-edit',
      'post-edit',
      'recovery',
    ]);
    expect(result.record.arms.opensip.legs.map(({ leg }) => leg)).toEqual([
      'pre-edit',
      'post-edit',
      'recovery',
    ]);
    for (const arm of ['control', 'opensip'] as const) {
      expect(result.record.arms[arm].legs.find(({ leg }) => leg === 'post-edit')).toMatchObject({
        appliedEdits: [{ kind: 'write', path: 'src/index.ts' }],
      });
    }
    expect(result.metrics.control.callCount).toBe(2);
    expect(result.metrics.opensip.callCount).toBe(2);
    expect(result.recoveryMetrics.control.callCount).toBe(1);
    expect(result.recoveryMetrics.opensip.callCount).toBe(2);
  });

  it('does not allow a post-edit binding to observe pre-edit answer state', async () => {
    const bindingStep: StrategyStep = {
      ...step('post-with-pre-binding'),
      arguments: {
        path: {
          $fact: {
            field: 'filePath',
            leg: 'pre-edit',
            match: { kind: 'symbol-handle', name: 'entry' },
          },
        },
      },
    };
    const task: GoldTask = {
      ...stalenessTask(),
      assertions: {
        scoped: [{ leg: 'post-edit', mustInclude: [textFact('unreachable')] }],
        staleness: { postEditLeg: 'post-edit' },
      },
      id: 'isolated-leg-state',
      staleness: {
        edit: { operations: [] },
        postEditSteps: { control: [bindingStep], opensip: [bindingStep] },
      },
    };
    const preFact: AnswerFact = {
      filePath: 'src/index.ts',
      kind: 'symbol-handle',
      name: 'entry',
      symbolId: 'symbol:entry',
    };
    const events: string[] = [];
    const roots = [temporaryDirectory('isolated-a-'), temporaryDirectory('isolated-b-')] as const;

    const result = await runTask(task, {
      dependencies: {
        applyEdit: () => [],
        connectMcp: (root) =>
          Promise.resolve(
            fakeSession(root, events, {
              facts: { 'opensip-pre': [preFact] },
            }),
          ),
        createControlInvoker: () =>
          invokerWithEvents('native', events, { 'control-pre': [preFact] }),
        setupFixture: (root) => Promise.resolve(setupRecord(root)),
        withFixture: fakeFixtureCopies(events, roots),
      },
    });

    for (const arm of ['control', 'opensip'] as const) {
      const post = result.record.arms[arm].legs.find(({ leg }) => leg === 'post-edit');
      expect(post?.steps[0]?.failure).toMatchObject({
        code: 'missing-binding',
        kind: 'binding',
      });
    }
    expect(events).not.toContain('native:post-with-pre-binding');
    expect(events).not.toContain('mcp:post-with-pre-binding');
  });
});

describe('dogfood reuse-existing guard', () => {
  it('reuses one read-only root, probes the existing catalog outside metrics, and skips copy/setup/edit', async () => {
    const repositoryRoot = temporaryDirectory();
    const canonicalRoot = realpathSync(repositoryRoot);
    const events: string[] = [];
    let admittedPaths: readonly string[] | undefined;
    const forbidden = vi.fn(() => {
      throw new Error('forbidden dogfood effect');
    });
    const result = await runTask(ordinaryTask(DOGFOOD_FIXTURE_REFERENCE), {
      dependencies: {
        applyEdit: forbidden,
        connectMcp: (root, mode) => {
          events.push(`connect:${root}:${mode}`);
          return Promise.resolve(fakeSession(root, events));
        },
        createControlInvoker: (root, options) => {
          events.push(`native:bind:${root}`);
          admittedPaths = options?.allowedPaths;
          return invokerWithEvents('native', events);
        },
        listFixtureFiles: (root) => visibleDogfoodFiles(root),
        setupFixture: forbidden,
        withFixture: forbidden,
      },
      repositoryRoot,
    });

    expect(events).toEqual([
      `native:bind:${canonicalRoot}`,
      'native:control-main',
      `connect:${canonicalRoot}:reuse-existing`,
      'mcp:catalog-prerequisite',
      'mcp:opensip-main',
      'mcp:close',
      'mcp:provenance',
    ]);
    expect(forbidden).not.toHaveBeenCalled();
    expect(admittedPaths).toEqual(['package.json']);
    expect(result.record.arms.control.setup.mode).toBe('reuse-existing');
    expect(result.record.arms.opensip.setup.mode).toBe('reuse-existing');
    expect(result.record.arms.opensip.legs[0]?.steps).toHaveLength(1);
    expect(result.metrics.opensip.callCount).toBe(1);
  });

  it('fails loudly and closes when the existing repository has no g1 catalog', async () => {
    const repositoryRoot = temporaryDirectory();
    const events: string[] = [];

    await expect(
      runTask(ordinaryTask(DOGFOOD_FIXTURE_REFERENCE), {
        dependencies: {
          connectMcp: (root) =>
            Promise.resolve(fakeSession(root, events, { catalogAvailable: false })),
          createControlInvoker: () => invokerWithEvents('native', events),
          listFixtureFiles: (root) => visibleDogfoodFiles(root),
        },
        repositoryRoot,
      }),
    ).rejects.toThrow(/pre-existing graph catalog.*pnpm graph/u);
    expect(events).toContain('mcp:catalog-prerequisite');
    expect(events).toContain('mcp:close');
    expect(events).not.toContain('mcp:opensip-main');
  });

  it.each(['refresh_graph', 'repair_apply_verify'])(
    'rejects dogfood mutation tool %s before any effect runs',
    async (mutationTool) => {
      const repositoryRoot = temporaryDirectory();
      const task: GoldTask = {
        ...ordinaryTask(DOGFOOD_FIXTURE_REFERENCE),
        strategies: {
          ...ordinaryTask(DOGFOOD_FIXTURE_REFERENCE).strategies,
          opensip: {
            arm: 'opensip',
            steps: [step('forbidden-mutation', mutationTool)],
            version: 'opensip-v1',
          },
        },
      };
      const effect = vi.fn();

      await expect(
        runTask(task, {
          dependencies: {
            connectMcp: () => {
              effect();
              return Promise.resolve(fakeSession(repositoryRoot, []));
            },
            createControlInvoker: () => {
              effect();
              return invokerWithEvents('native', []);
            },
          },
          repositoryRoot,
        }),
      ).rejects.toThrow('must not invoke a mutating MCP tool');
      expect(effect).not.toHaveBeenCalled();
    },
  );
});
