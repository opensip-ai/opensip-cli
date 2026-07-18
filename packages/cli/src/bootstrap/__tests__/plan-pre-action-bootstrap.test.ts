/**
 * Table-driven bootstrap planner + post-bailout phase-order tests (ADR-0052).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILTIN_TRUST_POLICY } from '@opensip-cli/config';
import {
  defineCommand,
  LanguageRegistry,
  projectCoordinationKey,
  resolveEphemeralProjectPaths,
  resolveUserPaths,
  touchEphemeralRuntime,
  ToolRegistry,
  type CommandScopeRequirement,
  type CommandSpec,
  type RuntimeReadLease,
  type ScopeContribution,
  type Tool,
  type ToolCliContext,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { buildCommandScopeIndex } from '../../commands/command-scope-index.js';
import { type RuntimeLeaseLifecycle } from '../../commands/host-runtime-access.js';
import { type HostSpec } from '../../commands/host-subcommand-shared.js';
import { type CliCommandsContext } from '../../commands/shared.js';
import { BootstrapError } from '../bootstrap-error.js';
import { executePostBailoutBootstrap } from '../execute-post-bailout-bootstrap.js';
import { planPreActionBootstrap } from '../plan-pre-action-bootstrap.js';
import { PolicyAuditCollector } from '../policy-audit.js';
import { POST_BAILOUT_PHASE_ORDER, PRE_ACTION_PHASES } from '../pre-action-bootstrap-phases.js';

import type { PreActionRuntime } from '../pre-action-runtime.js';

function scopeSpec(name: string, scope: CommandScopeRequirement, noInit = false): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name,
    description: `${name} command`,
    commonFlags: [],
    scope,
    ...(noInit ? { noInit: true } : {}),
    output: 'command-result',
    handler: () => undefined,
  });
}

function toolCommandSpec(
  name: string,
  scope: CommandScopeRequirement,
  parent?: string,
): CommandSpec<unknown, ToolCliContext> {
  return defineCommand<unknown, ToolCliContext>({
    name,
    description: `${name} command`,
    commonFlags: [],
    scope,
    ...(parent === undefined ? {} : { parent }),
    output: 'command-result',
    handler: () => undefined,
  });
}

const COMMAND_SCOPES = buildCommandScopeIndex({
  hostSpecs: [
    scopeSpec('init', 'none'),
    scopeSpec('configure', 'none'),
    scopeSpec('completion', 'none'),
    scopeSpec('agent-catalog', 'none'),
    scopeSpec('status', 'none', true),
    // `fit` is first-run capable (declares noInit); `fit-list` is not.
    scopeSpec('fit', 'project', true),
    scopeSpec('fit-list', 'project'),
  ],
  hostGroups: [
    {
      name: 'tools',
      description: 'Tools group',
      leaves: [scopeSpec('list', 'none'), scopeSpec('data-purge', 'project')],
    },
  ],
  toolSpecs: [],
});

const noopTool = (name: string): Tool => ({
  identity: { name },
  metadata: { id: name, name, version: '0', description: name },
  commands: [{ name, description: name }],
  commandSpecs: [],
});

const nestedTool = (id: string, primary: string): Tool => {
  const primarySpec = toolCommandSpec(primary, 'project');
  const listSpec = toolCommandSpec('list', 'project', primary);
  return {
    identity: { name: primary },
    metadata: { id, name: primary, version: '0', description: primary },
    commands: [
      { name: primary, description: primary, scope: 'project' },
      { name: 'list', description: 'list', parent: primary, scope: 'project' },
    ],
    commandSpecs: [primarySpec, listSpec],
  };
};

function runtimeWith(tools: Tool[]): PreActionRuntime {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  return {
    languages: new LanguageRegistry(),
    tools: registry,
    manifests: [] as ToolPluginManifest[],
    provenance: [] as ToolProvenance[],
    bootstrapDiagnostics: [],
    trustPolicy: BUILTIN_TRUST_POLICY,
    policyAudit: new PolicyAuditCollector(),
  };
}

describe('planPreActionBootstrap', () => {
  it('schema-version bailout completes through bailout-window only', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 99\ntargets: {}\n', 'utf8');
    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_test',
        commandName: 'fit-list',
        commandPath: 'fit-list',
        commandScopes: COMMAND_SCOPES,
      }),
    ).toThrow(BootstrapError);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('no-project bailout for project-scoped command', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_test',
        commandName: 'fit',
        commandPath: 'fit',
        commandScopes: COMMAND_SCOPES,
      }),
    ).toThrow(BootstrapError);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('synthesizes an ephemeral project for eligible no-init commands with markers', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}\n', 'utf8');
    writeFileSync(join(tmp, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_test',
      commandName: 'fit',
      commandPath: 'fit',
      commandScopes: COMMAND_SCOPES,
    });
    expect(plan.project.scope).toBe('ephemeral');
    expect(plan.project.configPath).toBeUndefined();
    expect(plan.project.ephemeralConfigDocument).toMatchObject({
      schemaVersion: expect.any(Number),
      targets: expect.objectContaining({ 'typescript-source': expect.any(Object) }),
    });
    expect(plan.runLoggerOptions.logDir).toContain('.opensip-cli');
    expect((plan.opts.projectContext as { scope: string }).scope).toBe('ephemeral');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('agnostic command pass-through when no project', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_test',
      commandName: 'init',
      commandPath: 'init',
      commandScopes: COMMAND_SCOPES,
    });
    expect(plan.completedThrough).toBe(PRE_ACTION_PHASES.bailoutWindow);
    expect(plan.project.scope).toBe('none');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('scope:none command paths are agnostic', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_test',
      commandName: 'list',
      commandPath: 'tools list',
      commandScopes: COMMAND_SCOPES,
    });
    expect(plan.project.scope).toBe('none');
    expect(plan.completedThrough).toBe(PRE_ACTION_PHASES.bailoutWindow);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('does not synthesize or select cache storage for an inspection-only scope:none command', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}\n', 'utf8');
    writeFileSync(join(tmp, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: true,
      runId: 'RUN_test',
      commandName: 'status',
      commandPath: 'status',
      commandScopes: COMMAND_SCOPES,
    });
    expect(plan.project.scope).toBe('none');
    expect(plan.project.ephemeralConfigDocument).toBeUndefined();
    expect(plan.runLoggerOptions.logDir).toBeUndefined();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('scope:project grouped command paths still require a project', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_test',
        commandName: 'data-purge',
        commandPath: 'tools data-purge',
        commandScopes: COMMAND_SCOPES,
      }),
    ).toThrow(BootstrapError);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('normal project run produces runLoggerOptions with logDir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_test',
      commandName: 'fit-list',
      commandPath: 'fit-list',
      commandScopes: COMMAND_SCOPES,
    });
    expect(plan.project.scope).toBe('project');
    expect(plan.runLoggerOptions.runId).toBe('RUN_test');
    expect(plan.runLoggerOptions.logDir).toContain('opensip-cli/.runtime/logs');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('strict --config miss throws BootstrapError', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_test',
        commandName: 'fit',
        commandPath: 'fit',
        commandScopes: COMMAND_SCOPES,
        explicitConfigPath: join(tmp, 'missing.yml'),
      }),
    ).toThrow(BootstrapError);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('executePostBailoutBootstrap phase ordering', () => {
  it('records post-bailout phases in ADR-0052 order', async () => {
    const phases: string[] = [];

    const plan = planPreActionBootstrap({
      opts: {},
      cwd: process.cwd(),
      cwdExplicit: false,
      runId: 'RUN_order',
      commandName: 'init',
      commandPath: 'init',
      commandScopes: COMMAND_SCOPES,
    });

    await executePostBailoutBootstrap(
      {
        plan,
        runtime: runtimeWith([]),
        version: '0.0.0-test',
        noCloud: true,
      },
      {
        recordPhase: (p) => phases.push(p),
        enterScope: () => undefined,
        isScopeEntered: () => true,
        checkForUpdate: () => undefined,
        startProfiling: () => Promise.resolve(undefined),
        maybeInitializeOwningTool: () => Promise.resolve(),
        loadOwningToolCapabilities: () => Promise.resolve(0),
      },
    );

    expect(phases).toEqual([...POST_BAILOUT_PHASE_ORDER]);
  });

  it('runs ephemeral cache maintenance under the current project lease before scope build', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-maintenance-order-'));
    writeFileSync(join(tmp, 'package.json'), '{"type":"module"}\n', 'utf8');
    writeFileSync(join(tmp, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: true,
      runId: 'RUN_cache_lease',
      commandName: 'fit',
      commandPath: 'fit',
      commandScopes: COMMAND_SCOPES,
    });
    const order: string[] = [];
    let leaseLive = true;
    const lease = {
      kind: 'runtime-read' as const,
      ownerToken: 'a'.repeat(32),
      acquiredAt: Date.now(),
      coordinationKey: projectCoordinationKey(tmp),
      release: () => {
        leaseLive = false;
      },
    };
    const lifecycle: RuntimeLeaseLifecycle = {
      lease,
      state: () => (leaseLive ? 'bootstrap' : 'released'),
      transferToScope: vi.fn(),
      releaseBootstrapOwned: vi.fn(),
      finishAfterDatastoreClose: vi.fn(),
    };
    const maintainEphemeralCache = vi.fn(
      (
        _project: typeof plan.project,
        _logger: unknown,
        observedLifecycle: RuntimeLeaseLifecycle | undefined,
      ) => {
        expect(leaseLive).toBe(true);
        expect(observedLifecycle).toBe(lifecycle);
        order.push('cache-maintenance');
        return Promise.resolve();
      },
    );

    const result = await executePostBailoutBootstrap(
      {
        plan,
        runtime: runtimeWith([]),
        version: '0.0.0-test',
        noCloud: true,
        runtimeLeaseLifecycle: lifecycle,
      },
      {
        recordPhase: (phase) => order.push(phase),
        createRunLogger: () => ({
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        }),
        enterScope: () => undefined,
        isScopeEntered: () => true,
        checkForUpdate: () => undefined,
        startProfiling: () => Promise.resolve(undefined),
        maybeInitializeOwningTool: () => Promise.resolve(),
        loadOwningToolCapabilities: () => Promise.resolve(0),
        maintainEphemeralCache,
      },
    );

    expect(maintainEphemeralCache).toHaveBeenCalledOnce();
    expect(order.indexOf(PRE_ACTION_PHASES.runtimeLease)).toBeLessThan(
      order.indexOf('cache-maintenance'),
    );
    expect(order.indexOf('cache-maintenance')).toBeLessThan(
      order.indexOf(PRE_ACTION_PHASES.buildScope),
    );
    result.scope.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('protects the current cache while actual lease-authorized maintenance prunes an orphan', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'opensip-maintenance-real-'));
    const home = join(sandbox, 'home');
    const project = join(sandbox, 'project');
    const previousHome = process.env.HOME;
    mkdirSync(home);
    mkdirSync(project);
    process.env.HOME = home;
    try {
      writeFileSync(join(project, 'package.json'), '{"type":"module"}\n', 'utf8');
      writeFileSync(join(project, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
      const plan = planPreActionBootstrap({
        opts: {},
        cwd: project,
        cwdExplicit: true,
        runId: 'RUN_cache_real_lease',
        commandName: 'fit',
        commandPath: 'fit',
        commandScopes: COMMAND_SCOPES,
      });
      const current = resolveEphemeralProjectPaths(project);
      const orphan = resolveEphemeralProjectPaths(join(sandbox, 'deleted-project'));
      const now = Date.now();
      touchEphemeralRuntime(current, now - 60 * 24 * 60 * 60 * 1000);
      touchEphemeralRuntime(orphan, now - 60 * 24 * 60 * 60 * 1000);
      const lease: RuntimeReadLease = {
        kind: 'runtime-read',
        ownerToken: 'b'.repeat(32),
        acquiredAt: now,
        coordinationKey: current.coordinationKey,
        release: vi.fn(),
      };
      const lifecycle: RuntimeLeaseLifecycle = {
        lease,
        state: () => 'bootstrap',
        transferToScope: vi.fn(),
        releaseBootstrapOwned: vi.fn(),
        finishAfterDatastoreClose: vi.fn(),
      };

      const result = await executePostBailoutBootstrap(
        {
          plan,
          runtime: runtimeWith([]),
          version: '0.0.0-test',
          noCloud: true,
          runtimeLeaseLifecycle: lifecycle,
        },
        {
          createRunLogger: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          }),
          enterScope: () => undefined,
          isScopeEntered: () => true,
          checkForUpdate: () => undefined,
          startProfiling: () => Promise.resolve(undefined),
          maybeInitializeOwningTool: () => Promise.resolve(),
          loadOwningToolCapabilities: () => Promise.resolve(0),
        },
      );

      expect(existsSync(current.runtimeDir)).toBe(true);
      expect(existsSync(orphan.runtimeDir)).toBe(false);
      result.scope.dispose();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'mismatched'] as const)(
    'skips actual cache maintenance when the project lease is %s',
    async (leaseState) => {
      const sandbox = mkdtempSync(join(tmpdir(), `opensip-maintenance-${leaseState}-`));
      const home = join(sandbox, 'home');
      const project = join(sandbox, 'project');
      const previousHome = process.env.HOME;
      mkdirSync(home);
      mkdirSync(project);
      process.env.HOME = home;
      try {
        writeFileSync(join(project, 'package.json'), '{"type":"module"}\n', 'utf8');
        writeFileSync(join(project, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
        const plan = planPreActionBootstrap({
          opts: {},
          cwd: project,
          cwdExplicit: true,
          runId: `RUN_cache_${leaseState}`,
          commandName: 'fit',
          commandPath: 'fit',
          commandScopes: COMMAND_SCOPES,
        });
        const current = resolveEphemeralProjectPaths(project);
        const orphan = resolveEphemeralProjectPaths(join(sandbox, 'deleted-project'));
        touchEphemeralRuntime(orphan, Date.now() - 60 * 24 * 60 * 60 * 1000);
        const mismatchedLease: RuntimeReadLease = {
          kind: 'runtime-read',
          ownerToken: 'c'.repeat(32),
          acquiredAt: Date.now(),
          coordinationKey: '0'.repeat(24),
          release: vi.fn(),
        };
        const lifecycle: RuntimeLeaseLifecycle | undefined =
          leaseState === 'missing'
            ? undefined
            : {
                lease: mismatchedLease,
                state: () => 'bootstrap',
                transferToScope: vi.fn(),
                releaseBootstrapOwned: vi.fn(),
                finishAfterDatastoreClose: vi.fn(),
              };

        const result = await executePostBailoutBootstrap(
          {
            plan,
            runtime: runtimeWith([]),
            version: '0.0.0-test',
            noCloud: true,
            runtimeLeaseLifecycle: lifecycle,
          },
          {
            createRunLogger: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
            enterScope: () => undefined,
            isScopeEntered: () => true,
            checkForUpdate: () => undefined,
            startProfiling: () => Promise.resolve(undefined),
            maybeInitializeOwningTool: () => Promise.resolve(),
            loadOwningToolCapabilities: () => Promise.resolve(0),
          },
        );

        expect(existsSync(current.runtimeDir)).toBe(false);
        expect(existsSync(orphan.runtimeDir)).toBe(true);
        expect(existsSync(join(resolveUserPaths().ephemeralProjectsDir, '.last-prune'))).toBe(
          false,
        );
        result.scope.dispose();
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );

  it('awaits profiler startup before running tool preflight', async () => {
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: process.cwd(),
      cwdExplicit: false,
      runId: 'RUN_profile_order',
      commandName: 'init',
      commandPath: 'init',
      commandScopes: COMMAND_SCOPES,
    });
    let releaseProfile: (() => void) | undefined;
    const startProfiling = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          releaseProfile = () => resolve(undefined);
        }),
    );
    const maybeInitializeOwningTool = vi.fn(() => Promise.resolve());

    const execution = executePostBailoutBootstrap(
      {
        plan,
        runtime: runtimeWith([]),
        version: '0.0.0-test',
        noCloud: true,
      },
      {
        enterScope: () => undefined,
        isScopeEntered: () => true,
        checkForUpdate: () => undefined,
        startProfiling,
        maybeInitializeOwningTool,
        loadOwningToolCapabilities: () => Promise.resolve(0),
      },
    );

    expect(startProfiling).toHaveBeenCalledOnce();
    expect(maybeInitializeOwningTool).not.toHaveBeenCalled();
    releaseProfile?.();
    await execution;
    expect(maybeInitializeOwningTool).toHaveBeenCalledOnce();
  });

  it('builds a real project RunScope before tool preflight', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-post-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const tool = {
      ...noopTool('scoped-tool'),
      extensionPoints: {
        // `scopedTool` is a tool-contributed subscope slot (module-augmented in
        // real tools); cast to the augmentable contribution bag the host installs.
        contributeScope: () => ({ scopedTool: { ready: true } }) as ScopeContribution,
      },
    } satisfies Tool;
    const runtime = {
      ...runtimeWith([tool]),
      startupTimings: [
        {
          name: 'installed-tool-discovery',
          durationMs: 4.2,
          sinceStartMs: 5.1,
        },
      ],
    };
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_scope',
      commandName: 'fit-list',
      commandPath: 'fit-list',
      commandScopes: COMMAND_SCOPES,
    });

    const result = await executePostBailoutBootstrap(
      {
        plan,
        runtime,
        version: '0.0.0-test',
        noCloud: true,
      },
      {
        enterScope: () => undefined,
        isScopeEntered: () => true,
        checkForUpdate: () => undefined,
        startProfiling: () => Promise.resolve(undefined),
        maybeInitializeOwningTool: () => Promise.resolve(),
        loadOwningToolCapabilities: () => Promise.resolve(0),
      },
    );

    expect(result.scope.runId).toBe('RUN_scope');
    expect(result.scope.projectContext?.scope).toBe('project');
    expect(result.scope.configDocument).toBeDefined();
    expect((result.scope as unknown as { scopedTool?: { ready: boolean } }).scopedTool?.ready).toBe(
      true,
    );
    const events = result.scope.diagnostics.snapshot().events;
    expect(events).toContainEqual(
      expect.objectContaining({
        message: "startup phase 'installed-tool-discovery' completed",
        data: expect.objectContaining({
          source: 'startup',
          phase: 'installed-tool-discovery',
          durationMs: 4.2,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        message: "pre-action phase 'build-scope' completed",
        data: expect.objectContaining({
          source: 'pre-action',
          phase: PRE_ACTION_PHASES.buildScope,
          durationMs: expect.any(Number),
        }),
      }),
    );
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drives capabilities for the owner named by commandPath, not a shared leaf', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-post-owner-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const fitTool = nestedTool('fit-tool-id', 'fit');
    const graphTool = nestedTool('graph-tool-id', 'graph');
    const commandScopes = buildCommandScopeIndex({
      hostSpecs: [],
      hostGroups: [
        {
          name: 'tools',
          description: 'Tools group',
          leaves: [scopeSpec('list', 'none')],
        },
      ],
      toolSpecs: [...(fitTool.commandSpecs ?? []), ...(graphTool.commandSpecs ?? [])],
    });
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_owner',
      commandName: 'list',
      commandPath: 'graph list',
      commandScopes,
    });
    const maybeInitializeOwningTool = vi.fn(() => Promise.resolve());
    const loadOwningToolCapabilities = vi.fn(() => Promise.resolve(0));

    await executePostBailoutBootstrap(
      {
        plan,
        runtime: runtimeWith([fitTool, graphTool]),
        version: '0.0.0-test',
        noCloud: true,
      },
      {
        enterScope: () => undefined,
        isScopeEntered: () => true,
        checkForUpdate: () => undefined,
        startProfiling: () => Promise.resolve(undefined),
        maybeInitializeOwningTool,
        loadOwningToolCapabilities,
      },
    );

    expect(maybeInitializeOwningTool).toHaveBeenCalledWith(
      expect.any(ToolRegistry),
      'graph list',
      'RUN_owner',
      [],
    );
    expect(loadOwningToolCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({
        owningTool: expect.objectContaining({
          metadata: expect.objectContaining({ id: 'graph-tool-id' }),
        }),
      }),
    );
    expect(loadOwningToolCapabilities).not.toHaveBeenCalledWith(
      expect.objectContaining({
        owningTool: expect.objectContaining({
          metadata: expect.objectContaining({ id: 'fit-tool-id' }),
        }),
      }),
    );

    rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'schema-version',
      writeConfig: (dir: string) =>
        writeFileSync(join(dir, 'opensip-cli.config.yml'), 'schemaVersion: 99\ntargets: {}\n'),
      commandName: 'fit-list',
    },
    {
      label: 'no-project',
      writeConfig: () => undefined,
      commandName: 'fit',
    },
  ])('planner bailout stops before post-bailout phase: $label', ({ writeConfig, commandName }) => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-bail-'));
    writeConfig(tmp);

    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_bail',
        commandName,
        commandPath: commandName,
        commandScopes: COMMAND_SCOPES,
      }),
    ).toThrow(BootstrapError);

    rmSync(tmp, { recursive: true, force: true });
  });
});
