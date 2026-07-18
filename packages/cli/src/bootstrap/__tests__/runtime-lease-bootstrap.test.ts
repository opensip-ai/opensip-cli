import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUILTIN_TRUST_POLICY } from '@opensip-cli/config';
import {
  currentScope,
  LanguageRegistry,
  projectCoordinationKey,
  RunScope,
  ToolRegistry,
  type ProjectContext,
  type RuntimeLease,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { buildCommandScopeIndex } from '../../commands/command-scope-index.js';
import {
  DEFAULT_HOST_RUNTIME_POLICY,
  createRuntimeLeaseLifecycle,
  defineHostCommand,
  type AcquireHostRuntimeLeaseInput,
} from '../../commands/host-runtime-access.js';
import { executePostBailoutBootstrap } from '../execute-post-bailout-bootstrap.js';
import {
  planPreActionBootstrap,
  type PreActionBootstrapPlan,
} from '../plan-pre-action-bootstrap.js';
import { PolicyAuditCollector } from '../policy-audit.js';
import { PRE_ACTION_PHASES } from '../pre-action-bootstrap-phases.js';
import {
  createCommandActionScopeRunner,
  disposeCurrentScope,
  prepareLeasedBootstrapPlan,
} from '../pre-action-hook.js';
import {
  acquireStartupRuntimeLease,
  resolveStartupProjectSelection,
} from '../startup-runtime-lease.js';

import type { BuildPerRunScopeInput } from '../build-per-run-scope.js';
import type { PreActionRuntime } from '../pre-action-runtime.js';

function projectSpec(name = 'fit') {
  return defineHostCommand({
    name,
    description: name,
    commonFlags: [],
    scope: 'project',
    output: 'command-result',
    handler: () => undefined,
  });
}

function runtime(): PreActionRuntime {
  return {
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
    manifests: [],
    provenance: [],
    bootstrapDiagnostics: [],
    startupTimings: [],
    trustPolicy: BUILTIN_TRUST_POLICY,
    policyAudit: new PolicyAuditCollector(),
  };
}

function quietLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('Commander action scope handoff', () => {
  it('binds the staged scope for the action and retains it until host teardown', async () => {
    const runner = createCommandActionScopeRunner();
    const scope = new RunScope();
    const disposedWithScopeCurrent = vi.fn();
    scope.onDispose(() => disposedWithScopeCurrent(currentScope() === scope));
    runner.stage(scope);

    await expect(
      runner.run(async () => {
        expect(currentScope()).toBe(scope);
        await Promise.resolve();
        expect(currentScope()).toBe(scope);
        return 'done';
      }),
    ).resolves.toBe('done');

    expect(disposedWithScopeCurrent).not.toHaveBeenCalled();
    expect(currentScope()).toBeUndefined();
    expect(() => runner.run(() => Promise.resolve())).toThrow(
      expect.objectContaining({ code: 'SYSTEM.SCOPE.NOT_ENTERED' }),
    );
    runner.disposeStaged();
    expect(disposedWithScopeCurrent).toHaveBeenCalledWith(true);
  });

  it('disposes a staged action that Commander never starts', () => {
    const runner = createCommandActionScopeRunner();
    const scope = new RunScope();
    const disposedWithScopeCurrent = vi.fn();
    scope.onDispose(() => disposedWithScopeCurrent(currentScope() === scope));
    runner.stage(scope);
    expect(() => runner.stage(scope)).toThrow(
      expect.objectContaining({ code: 'SYSTEM.SCOPE.REENTRANT' }),
    );

    runner.disposeStaged();

    expect(disposedWithScopeCurrent).toHaveBeenCalledWith(true);
    expect(currentScope()).toBeUndefined();
  });

  it('disposes exactly once when the mounted action rejects', async () => {
    const runner = createCommandActionScopeRunner();
    const scope = new RunScope();
    const dispose = vi.fn();
    scope.onDispose(dispose);
    runner.stage(scope);

    await expect(
      runner.run(async () => {
        await Promise.resolve();
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');

    await runner.runWithOwnedScope(async () => {
      expect(currentScope()).toBe(scope);
      await Promise.resolve();
      expect(currentScope()).toBe(scope);
    });
    expect(dispose).not.toHaveBeenCalled();
    runner.disposeStaged();
    expect(dispose).toHaveBeenCalledOnce();
    expect(currentScope()).toBeUndefined();
  });
});

describe('startup discovery lease', () => {
  it('resolves explicit cwd/config before discovery and acquires both shared dimensions', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-startup-selection-'));
    const nested = join(tmp, 'nested');
    const config = join(nested, 'custom.yml');
    const release = vi.fn();
    const acquire = vi.fn(() =>
      Promise.resolve({
        kind: 'runtime-access-composite' as const,
        ownerToken: 'owner-token-startup-1234',
        acquiredAt: 1,
        coordinationKey: 'p1-' + 'a'.repeat(64),
        projectRead: true,
        userStateRead: true,
        release,
      }),
    );
    try {
      mkdirSync(nested, { recursive: true });
      writeFileSync(config, 'schemaVersion: 1\ntargets: {}\n', 'utf8');
      const selection = resolveStartupProjectSelection(
        ['fit', `--cwd=${nested}`, '--config', 'custom.yml'],
        tmp,
      );
      expect(selection.cwd).toBe(nested);
      expect(selection.cwdExplicit).toBe(true);
      expect(selection.explicitConfigPath).toBe('custom.yml');
      expect(selection.project.projectRoot).toBe(realpathSync(nested));

      // Use the real key in the fake handle so the handoff can prove identity.
      acquire.mockResolvedValueOnce({
        kind: 'runtime-access-composite',
        ownerToken: 'owner-token-startup-1234',
        acquiredAt: 1,
        coordinationKey: projectCoordinationKey(selection.project.projectRoot),
        projectRead: true,
        userStateRead: true,
        release,
      });
      const handoff = await acquireStartupRuntimeLease(
        {
          argv: ['fit', `--cwd=${nested}`, '--config', 'custom.yml'],
          defaultCwd: tmp,
        },
        { acquire },
      );
      expect(acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          projectRead: { projectDir: selection.project.projectRoot },
          userStateRead: true,
          inheritFromParent: true,
        }),
      );
      expect(() => handoff.assertDiscoveryProtected(selection.project.projectRoot)).not.toThrow();
      const commandLease = handoff.claimForCommand(selection.project.projectRoot);
      expect(handoff.state()).toBe('command');
      handoff.releaseStartupOwned();
      expect(release).not.toHaveBeenCalled();
      commandLease.release();
      commandLease.release();
      handoff.releaseStartupOwned();
      expect(release).toHaveBeenCalledOnce();
      expect(handoff.state()).toBe('released');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects missing early option values before discovery', () => {
    expect(() => resolveStartupProjectSelection(['fit', '--cwd'], process.cwd())).toThrow(
      expect.objectContaining({ code: 'CONFIGURATION.STARTUP_OPTION_INVALID' }),
    );
    expect(() =>
      resolveStartupProjectSelection(['fit', '--config', '--json'], process.cwd()),
    ).toThrow(expect.objectContaining({ code: 'CONFIGURATION.STARTUP_OPTION_INVALID' }));
  });

  it('releases and reacquires when the canonical root changes during acquisition', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-startup-stabilize-'));
    const nested = join(tmp, 'nested');
    const releases: ReturnType<typeof vi.fn>[] = [];
    let acquisition = 0;
    const acquire = vi.fn(
      (input: { readonly projectRead?: { readonly projectDir: string } | false }) => {
        const projectDir =
          input.projectRead === false || input.projectRead === undefined
            ? nested
            : input.projectRead.projectDir;
        const release = vi.fn();
        releases.push(release);
        acquisition += 1;
        if (acquisition === 1) {
          writeFileSync(
            join(tmp, 'opensip-cli.config.yml'),
            'schemaVersion: 1\ntargets: {}\n',
            'utf8',
          );
        }
        return Promise.resolve({
          kind: 'runtime-access-composite' as const,
          ownerToken: `owner-token-stabilize-${acquisition.toString().padStart(4, '0')}`,
          acquiredAt: acquisition,
          coordinationKey: projectCoordinationKey(projectDir),
          projectRead: true,
          userStateRead: true,
          release,
        });
      },
    );
    try {
      mkdirSync(nested, { recursive: true });
      const handoff = await acquireStartupRuntimeLease(
        {
          argv: ['fit', '--cwd', nested],
          defaultCwd: nested,
        },
        { acquire },
      );

      expect(acquire).toHaveBeenCalledTimes(2);
      expect(releases[0]).toHaveBeenCalledOnce();
      expect(releases[1]).not.toHaveBeenCalled();
      expect(handoff.selection.project.projectRoot).toBe(realpathSync(tmp));
      expect(() =>
        handoff.assertDiscoveryProtected(handoff.selection.project.projectRoot),
      ).not.toThrow();
      handoff.releaseStartupOwned();
      handoff.releaseStartupOwned();
      expect(releases[1]).toHaveBeenCalledOnce();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('releases exactly once when post-acquisition project resolution fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-startup-resolve-failure-'));
    const config = join(tmp, 'custom.yml');
    const release = vi.fn();
    try {
      writeFileSync(config, 'schemaVersion: 1\ntargets: {}\n', 'utf8');
      const acquire = vi.fn(
        (input: { readonly projectRead?: { readonly projectDir: string } | false }) => {
          rmSync(config, { force: true });
          const projectDir =
            input.projectRead === false || input.projectRead === undefined
              ? tmp
              : input.projectRead.projectDir;
          return Promise.resolve({
            kind: 'runtime-access-composite' as const,
            ownerToken: 'owner-token-resolve-failure-0001',
            acquiredAt: 1,
            coordinationKey: projectCoordinationKey(projectDir),
            projectRead: true,
            userStateRead: true,
            release,
          });
        },
      );

      await expect(
        acquireStartupRuntimeLease(
          {
            argv: ['fit', '--cwd', tmp, '--config', 'custom.yml'],
            defaultCwd: tmp,
          },
          { acquire },
        ),
      ).rejects.toMatchObject({
        code: 'CONFIGURATION.STARTUP_PROJECT_UNRESOLVED',
      });

      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('releases every handle once when startup project stabilization never converges', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-startup-churn-'));
    const nested = join(tmp, 'nested');
    const config = join(tmp, 'opensip-cli.config.yml');
    const releases: ReturnType<typeof vi.fn>[] = [];
    let acquisition = 0;
    try {
      mkdirSync(nested, { recursive: true });
      const acquire = vi.fn(
        (input: { readonly projectRead?: { readonly projectDir: string } | false }) => {
          acquisition += 1;
          if (acquisition % 2 === 1) {
            writeFileSync(config, 'schemaVersion: 1\ntargets: {}\n', 'utf8');
          } else {
            rmSync(config, { force: true });
          }
          const release = vi.fn();
          releases.push(release);
          const projectDir =
            input.projectRead === false || input.projectRead === undefined
              ? nested
              : input.projectRead.projectDir;
          return Promise.resolve({
            kind: 'runtime-access-composite' as const,
            ownerToken: `owner-token-startup-churn-${acquisition.toString().padStart(4, '0')}`,
            acquiredAt: acquisition,
            coordinationKey: projectCoordinationKey(projectDir),
            projectRead: true,
            userStateRead: true,
            release,
          });
        },
      );

      await expect(
        acquireStartupRuntimeLease(
          {
            argv: ['fit', '--cwd', nested],
            defaultCwd: nested,
          },
          { acquire },
        ),
      ).rejects.toMatchObject({
        code: 'CONFIGURATION.RUNTIME_CONTEXT_UNSTABLE',
      });

      expect(acquire).toHaveBeenCalledTimes(3);
      expect(releases).toHaveLength(3);
      expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('leased bootstrap planning', () => {
  it.each(['init', 'uninstall'])(
    'releases the discovery composite before the scope-none %s action',
    async (commandName) => {
      const tmp = mkdtempSync(join(tmpdir(), `opensip-${commandName}-discovery-release-`));
      const startupRelease = vi.fn();
      try {
        writeFileSync(
          join(tmp, 'opensip-cli.config.yml'),
          'schemaVersion: 1\ntargets: {}\n',
          'utf8',
        );
        const projectRoot = realpathSync(tmp);
        const startup = await acquireStartupRuntimeLease(
          { argv: [commandName, '--cwd', tmp], defaultCwd: tmp },
          {
            acquire: () =>
              Promise.resolve({
                kind: 'runtime-access-composite',
                ownerToken: `owner-${commandName}-startup-0001`,
                acquiredAt: 1,
                coordinationKey: projectCoordinationKey(projectRoot),
                projectRead: true,
                userStateRead: true,
                release: startupRelease,
              }),
          },
        );
        const spec = defineHostCommand({
          name: commandName,
          description: commandName,
          commonFlags: [],
          scope: 'none',
          output: 'command-result',
          handler: () => undefined,
        });
        const acquire = vi.fn(() => Promise.resolve(undefined));
        const prepared = await prepareLeasedBootstrapPlan(
          {
            opts: {},
            cwd: tmp,
            cwdExplicit: false,
            runId: `run-${commandName}-scope-none`,
            commandName,
            commandPath: commandName,
            commandScopes: buildCommandScopeIndex({
              hostSpecs: [spec],
              hostGroups: [],
              toolSpecs: [],
            }),
            startupRuntimeLease: startup,
          },
          { acquire },
        );

        expect(acquire).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: 'none',
            ownerToken: `owner-${commandName}-startup-0001`,
          }),
        );
        expect(startupRelease).toHaveBeenCalledOnce();
        expect(startup.state()).toBe('released');
        expect(prepared.runtimeLeaseLifecycle.state()).toBe('released');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it('retains only an explicit scope-none resource after protected discovery', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-scope-none-explicit-resource-'));
    const order: string[] = [];
    const startupRelease = vi.fn(() => order.push('startup-release'));
    const commandRelease = vi.fn(() => order.push('command-release'));
    try {
      writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
      const projectRoot = realpathSync(tmp);
      const startup = await acquireStartupRuntimeLease(
        { argv: ['tools-uninstall', '--cwd', tmp], defaultCwd: tmp },
        {
          acquire: () =>
            Promise.resolve({
              kind: 'runtime-access-composite',
              ownerToken: 'owner-explicit-resource-startup-0001',
              acquiredAt: 1,
              coordinationKey: projectCoordinationKey(projectRoot),
              projectRead: true,
              userStateRead: true,
              release: startupRelease,
            }),
        },
      );
      const spec = defineHostCommand(
        {
          name: 'tools-uninstall',
          description: 'fixture',
          commonFlags: [],
          scope: 'none',
          output: 'command-result',
          handler: () => undefined,
        },
        { runtimeAccess: 'project-and-user-state' },
      );
      const acquire = vi.fn((input: AcquireHostRuntimeLeaseInput) => {
        order.push('command-acquire');
        expect(input.ownerToken).toBe('owner-explicit-resource-startup-0001');
        if (input.ownerToken === undefined) {
          throw new Error('expected startup owner token propagation');
        }
        return Promise.resolve({
          ownerToken: input.ownerToken,
          acquiredAt: 2,
          release: commandRelease,
        } satisfies RuntimeLease);
      });
      const prepared = await prepareLeasedBootstrapPlan(
        {
          opts: {},
          cwd: tmp,
          cwdExplicit: false,
          runId: 'run-explicit-resource',
          commandName: 'tools-uninstall',
          commandPath: 'tools-uninstall',
          commandScopes: buildCommandScopeIndex({
            hostSpecs: [spec],
            hostGroups: [],
            toolSpecs: [],
          }),
          startupRuntimeLease: startup,
        },
        { acquire },
      );

      expect(order).toEqual(['command-acquire', 'startup-release']);
      expect(prepared.runtimeLeaseLifecycle.state()).toBe('bootstrap');
      prepared.runtimeLeaseLifecycle.releaseBootstrapOwned();
      expect(order).toEqual(['command-acquire', 'startup-release', 'command-release']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails closed before acquisition when the command scope is undeclared', async () => {
    const acquire = vi.fn();
    await expect(
      prepareLeasedBootstrapPlan(
        {
          opts: {},
          cwd: process.cwd(),
          cwdExplicit: false,
          runId: 'run-missing-scope',
          commandName: 'missing',
          commandPath: 'missing',
          commandScopes: buildCommandScopeIndex({
            hostSpecs: [],
            hostGroups: [],
            toolSpecs: [],
          }),
        },
        { acquire },
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION.COMMAND_SCOPE_UNDECLARED' });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('keeps tentative discovery non-mutating and defers the no-project bailout', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-tentative-'));
    const opts: Record<string, unknown> = { exclude: [] };
    const scopes = buildCommandScopeIndex({
      hostSpecs: [projectSpec()],
      hostGroups: [],
      toolSpecs: [],
    });
    try {
      const tentative = planPreActionBootstrap({
        opts,
        cwd: tmp,
        cwdExplicit: false,
        runId: 'run-tentative',
        commandName: 'fit',
        commandPath: 'fit',
        commandScopes: scopes,
        planningMode: 'tentative',
      });
      expect(tentative.project.scope).toBe('none');
      expect(tentative.completedThrough).toBe(PRE_ACTION_PHASES.resolveProject);
      expect(opts).toEqual({ exclude: [] });
      expect(() =>
        planPreActionBootstrap({
          opts,
          cwd: tmp,
          cwdExplicit: false,
          runId: 'run-authoritative',
          commandName: 'fit',
          commandPath: 'fit',
          commandScopes: scopes,
          planningMode: 'authoritative',
        }),
      ).toThrow(/No opensip-cli\.config\.yml found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not select runtime logs for an ordinary scope-none command inside a project', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-scope-none-'));
    writeFileSync(
      join(tmp, 'opensip-cli.config.yml'),
      'schemaVersion: 1\ncli:\n  verbose: true\ntargets: {}\n',
      'utf8',
    );
    const scopes = buildCommandScopeIndex({
      hostSpecs: [
        defineHostCommand({
          name: 'agent-catalog',
          description: 'catalog',
          commonFlags: [],
          scope: 'none',
          output: 'command-result',
          handler: () => undefined,
        }),
      ],
      hostGroups: [],
      toolSpecs: [],
    });
    try {
      const plan = planPreActionBootstrap({
        opts: { verbose: false },
        cwd: tmp,
        cwdExplicit: false,
        runId: 'run-scope-none',
        commandName: 'agent-catalog',
        commandPath: 'agent-catalog',
        commandScopes: scopes,
      });
      expect(plan.project.scope).toBe('project');
      expect(plan.commandScope).toBe('none');
      expect(plan.runLoggerOptions.logDir).toBeUndefined();
      expect(plan.cliDefaults).toMatchObject({ verbose: true });
      expect(plan.opts.verbose).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('keeps an explicitly composite host datastore lazy and reader-protected', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-composite-host-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const composite = defineHostCommand(
      {
        name: 'tools-uninstall',
        description: 'fixture',
        commonFlags: [],
        scope: 'none',
        output: 'command-result',
        handler: () => undefined,
      },
      { runtimeAccess: 'project-and-user-state' },
    );
    const scopes = buildCommandScopeIndex({
      hostSpecs: [composite],
      hostGroups: [],
      toolSpecs: [],
    });
    const release = vi.fn();
    const acquire = vi.fn((input: AcquireHostRuntimeLeaseInput): Promise<RuntimeLease> => {
      expect(input.policy.runtimeAccess).toBe('project-and-user-state');
      expect(input.scope).toBe('none');
      return Promise.resolve({
        ownerToken: 'owner-token-composite-1234',
        acquiredAt: 1,
        release,
      });
    });
    const datastoreFile = join(tmp, 'opensip-cli', '.runtime', 'datastore.sqlite');
    let entered: RunScope | undefined;
    try {
      const prepared = await prepareLeasedBootstrapPlan(
        {
          opts: {},
          cwd: tmp,
          cwdExplicit: false,
          runId: 'run-composite-host',
          commandName: 'tools-uninstall',
          commandPath: 'tools-uninstall',
          commandScopes: scopes,
        },
        { acquire },
      );
      expect(prepared.plan.commandScope).toBe('none');
      expect(prepared.plan.runLoggerOptions.logDir).toBeUndefined();

      const buildPerRunScope = vi.fn((input: BuildPerRunScopeInput) => {
        const scope = new RunScope({
          projectContext: input.project,
          languages: input.registries.languages,
          tools: input.registries.tools,
          runId: input.runId,
          datastore:
            input.datastoreAccess === 'local-explicit-only'
              ? () => ({ protectedByCompositeLease: true })
              : () => {
                  throw new Error('composite host datastore was denied');
                },
        });
        input.runtimeLeaseLifecycle?.transferToScope();
        scope.onDispose(() =>
          input.runtimeLeaseLifecycle?.finishAfterDatastoreClose({
            checkpointed: true,
            closed: true,
          }),
        );
        return scope;
      });
      const result = await executePostBailoutBootstrap(
        {
          plan: prepared.plan,
          runtime: runtime(),
          version: '0.0.0-test',
          noCloud: true,
          runtimeLeaseLifecycle: prepared.runtimeLeaseLifecycle,
        },
        {
          buildPerRunScope: buildPerRunScope,
          checkForUpdate: () => undefined,
          startProfiling: () => Promise.resolve(undefined),
          maybeInitializeOwningTool: () => Promise.resolve(),
          loadOwningToolCapabilities: () => Promise.resolve(0),
        },
      );
      entered = result.scope;
      expect(buildPerRunScope).toHaveBeenCalledWith(
        expect.objectContaining({ datastoreAccess: 'local-explicit-only' }),
      );
      expect(existsSync(datastoreFile)).toBe(false);
      expect(result.scope.datastore()).toEqual({
        protectedByCompositeLease: true,
      });
    } finally {
      disposeCurrentScope();
      entered?.dispose();
      expect(release).toHaveBeenCalledOnce();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('observes a project created while waiting for the runtime reader', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-replan-'));
    const scopes = buildCommandScopeIndex({
      hostSpecs: [projectSpec()],
      hostGroups: [],
      toolSpecs: [],
    });
    const release = vi.fn();
    const acquire = vi.fn((): Promise<RuntimeLease> => {
      writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
      return Promise.resolve({
        ownerToken: 'owner-token-replan-1234',
        acquiredAt: 1,
        release,
      });
    });
    try {
      const prepared = await prepareLeasedBootstrapPlan(
        {
          opts: {},
          cwd: tmp,
          cwdExplicit: false,
          runId: 'run-replan',
          commandName: 'fit',
          commandPath: 'fit',
          commandScopes: scopes,
        },
        { acquire },
      );
      expect(prepared.plan.project.scope).toBe('project');
      expect(prepared.plan.project.configPath).toBe(
        join(realpathSync(tmp), 'opensip-cli.config.yml'),
      );
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).not.toHaveBeenCalled();
      prepared.runtimeLeaseLifecycle.releaseBootstrapOwned();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('releases exactly once when the authoritative replan fails after acquisition', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-authoritative-failure-'));
    const scopes = buildCommandScopeIndex({
      hostSpecs: [projectSpec()],
      hostGroups: [],
      toolSpecs: [],
    });
    const release = vi.fn();
    const failure = new Error('authoritative planning failed');
    try {
      writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
      const plan = vi.fn((input: Parameters<typeof planPreActionBootstrap>[0]) => {
        if (input.planningMode === 'authoritative') throw failure;
        return planPreActionBootstrap(input);
      });
      const acquire = vi.fn(() =>
        Promise.resolve({
          ownerToken: 'owner-token-authoritative-failure',
          acquiredAt: 1,
          release,
        }),
      );

      await expect(
        prepareLeasedBootstrapPlan(
          {
            opts: {},
            cwd: tmp,
            cwdExplicit: false,
            runId: 'run-authoritative-failure',
            commandName: 'fit',
            commandPath: 'fit',
            commandScopes: scopes,
          },
          { acquire, plan },
        ),
      ).rejects.toBe(failure);

      expect(plan).toHaveBeenCalledTimes(2);
      expect(acquire).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('bounds repeated canonical-root churn and reuses the owner token', async () => {
    const first = mkdtempSync(join(tmpdir(), 'opensip-root-a-'));
    const second = mkdtempSync(join(tmpdir(), 'opensip-root-b-'));
    const scopes = buildCommandScopeIndex({
      hostSpecs: [projectSpec()],
      hostGroups: [],
      toolSpecs: [],
    });
    const releases: ReturnType<typeof vi.fn>[] = [];
    const acquisitions: AcquireHostRuntimeLeaseInput[] = [];
    const acquire = vi.fn((input: AcquireHostRuntimeLeaseInput): Promise<RuntimeLease> => {
      acquisitions.push(input);
      const release = vi.fn();
      releases.push(release);
      return Promise.resolve({
        ownerToken: 'owner-token-stable-1234',
        acquiredAt: 1,
        release,
      });
    });
    const fakePlan = ((input): PreActionBootstrapPlan => {
      const projectRoot = input.planningMode === 'tentative' ? first : second;
      const project: ProjectContext = {
        cwd: projectRoot,
        cwdExplicit: false,
        projectRoot,
        configPath: join(projectRoot, 'opensip-cli.config.yml'),
        walkedUp: 0,
        scope: 'project',
      };
      return {
        runId: input.runId,
        cwd: input.cwd,
        cwdExplicit: input.cwdExplicit,
        opts: {},
        cliDefaults: {},
        project,
        commandName: input.commandName,
        commandPath: input.commandPath,
        commandScope: 'project',
        jsonOutput: false,
        runtimePolicy: DEFAULT_HOST_RUNTIME_POLICY,
        runLoggerOptions: { silent: true, runId: input.runId },
        completedThrough:
          input.planningMode === 'tentative'
            ? PRE_ACTION_PHASES.resolveProject
            : PRE_ACTION_PHASES.bailoutWindow,
      };
    }) satisfies typeof planPreActionBootstrap;
    try {
      await expect(
        prepareLeasedBootstrapPlan(
          {
            opts: {},
            cwd: first,
            cwdExplicit: false,
            runId: 'run-churn',
            commandName: 'fit',
            commandPath: 'fit',
            commandScopes: scopes,
          },
          { acquire, plan: fakePlan },
        ),
      ).rejects.toMatchObject({
        code: 'CONFIGURATION.RUNTIME_CONTEXT_UNSTABLE',
      });
      expect(acquisitions).toHaveLength(3);
      expect(acquisitions[0]?.ownerToken).toBeUndefined();
      expect(acquisitions[1]?.ownerToken).toBe('owner-token-stable-1234');
      expect(acquisitions[2]?.ownerToken).toBe('owner-token-stable-1234');
      expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('acquires and replans before logger, scope, and Tool side effects', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-integrated-lease-order-'));
    const order: string[] = [];
    const release = vi.fn(() => order.push('release'));
    try {
      writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
      const prepared = await prepareLeasedBootstrapPlan(
        {
          opts: {},
          cwd: tmp,
          cwdExplicit: false,
          runId: 'run-integrated-lease-order',
          commandName: 'fit',
          commandPath: 'fit',
          commandScopes: buildCommandScopeIndex({
            hostSpecs: [projectSpec()],
            hostGroups: [],
            toolSpecs: [],
          }),
        },
        {
          plan: (input) => {
            order.push(`plan-${input.planningMode ?? 'authoritative'}`);
            return planPreActionBootstrap(input);
          },
          acquire: () => {
            order.push('acquire');
            return Promise.resolve({
              ownerToken: 'owner-integrated-order-0001',
              acquiredAt: 1,
              release,
            });
          },
        },
      );
      const scope = new RunScope({
        projectContext: prepared.plan.project,
        languages: runtime().languages,
        tools: runtime().tools,
      });
      prepared.runtimeLeaseLifecycle.transferToScope();
      scope.onDispose(() =>
        prepared.runtimeLeaseLifecycle.finishAfterDatastoreClose({
          checkpointed: true,
          closed: true,
        }),
      );

      await executePostBailoutBootstrap(
        {
          plan: prepared.plan,
          runtime: runtime(),
          version: '0.0.0-test',
          noCloud: true,
          runtimeLeaseLifecycle: prepared.runtimeLeaseLifecycle,
        },
        {
          createRunLogger: () => {
            order.push('logger');
            return quietLogger();
          },
          checkForUpdate: () => {
            order.push('update');
            return undefined;
          },
          buildPerRunScope: () => {
            order.push('scope');
            return scope;
          },
          enterScope: () => order.push('enter'),
          isScopeEntered: () => true,
          startProfiling: () => {
            order.push('profiling');
            return Promise.resolve(undefined);
          },
          maybeInitializeOwningTool: () => {
            order.push('tool-initialize');
            return Promise.resolve();
          },
          loadOwningToolCapabilities: () => {
            order.push('capability-load');
            return Promise.resolve(0);
          },
        },
      );

      expect(order).toEqual([
        'plan-tentative',
        'acquire',
        'plan-authoritative',
        'logger',
        'update',
        'scope',
        'enter',
        'profiling',
        'tool-initialize',
        'capability-load',
      ]);
      scope.dispose();
      expect(order.at(-1)).toBe('release');
    } finally {
      disposeCurrentScope();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('post-bailout lease failure paths', () => {
  function createProjectPlan(projectRoot: string): PreActionBootstrapPlan {
    return planPreActionBootstrap({
      opts: { json: true },
      cwd: projectRoot,
      cwdExplicit: false,
      runId: 'run-post-bailout-failure',
      commandName: 'fit',
      commandPath: 'fit',
      commandScopes: buildCommandScopeIndex({
        hostSpecs: [projectSpec()],
        hostGroups: [],
        toolSpecs: [],
      }),
    });
  }

  it.each(['run-logger', 'update-check', 'scope-build'] as const)(
    'releases a bootstrap-owned lease exactly once after a %s failure',
    async (fault) => {
      const tmp = mkdtempSync(join(tmpdir(), `opensip-${fault}-failure-`));
      const release = vi.fn();
      const lifecycle = createRuntimeLeaseLifecycle({
        ownerToken: `owner-token-${fault}-failure`,
        acquiredAt: 1,
        release,
      });
      const failure = new Error(`${fault} failed`);
      try {
        writeFileSync(
          join(tmp, 'opensip-cli.config.yml'),
          'schemaVersion: 1\ntargets: {}\n',
          'utf8',
        );
        const plan = createProjectPlan(tmp);

        await expect(
          executePostBailoutBootstrap(
            {
              plan,
              runtime: runtime(),
              version: '0.0.0-test',
              noCloud: true,
              runtimeLeaseLifecycle: lifecycle,
            },
            {
              createRunLogger:
                fault === 'run-logger'
                  ? () => {
                      throw failure;
                    }
                  : () => quietLogger(),
              ...(fault === 'scope-build'
                ? {
                    buildPerRunScope: () => {
                      throw failure;
                    },
                  }
                : {}),
              checkForUpdate:
                fault === 'update-check'
                  ? () => {
                      throw failure;
                    }
                  : () => undefined,
            },
          ),
        ).rejects.toBe(failure);

        lifecycle.releaseBootstrapOwned();
        disposeCurrentScope();
        expect(lifecycle.state()).toBe('released');
        expect(release).toHaveBeenCalledOnce();
      } finally {
        disposeCurrentScope();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it.each(['scope-enter', 'profiling', 'tool-initialize', 'capability-load'] as const)(
    'releases a scope-owned lease exactly once after a %s failure',
    async (fault) => {
      const tmp = mkdtempSync(join(tmpdir(), `opensip-${fault}-failure-`));
      const release = vi.fn();
      const lifecycle = createRuntimeLeaseLifecycle({
        ownerToken: `owner-token-${fault}-failure`,
        acquiredAt: 1,
        release,
      });
      const failure = new Error(`${fault} failed`);
      try {
        writeFileSync(
          join(tmp, 'opensip-cli.config.yml'),
          'schemaVersion: 1\ntargets: {}\n',
          'utf8',
        );
        const plan = createProjectPlan(tmp);
        const buildPerRunScope = vi.fn((input: BuildPerRunScopeInput) => {
          const scope = new RunScope({
            projectContext: input.project,
            languages: input.registries.languages,
            tools: input.registries.tools,
            runId: input.runId,
          });
          input.runtimeLeaseLifecycle?.transferToScope();
          scope.onDispose(() =>
            input.runtimeLeaseLifecycle?.finishAfterDatastoreClose({
              checkpointed: true,
              closed: true,
            }),
          );
          return scope;
        });

        await expect(
          executePostBailoutBootstrap(
            {
              plan,
              runtime: runtime(),
              version: '0.0.0-test',
              noCloud: true,
              runtimeLeaseLifecycle: lifecycle,
            },
            {
              createRunLogger: () => quietLogger(),
              buildPerRunScope,
              ...(fault === 'scope-enter'
                ? {
                    enterScope: () => {
                      throw failure;
                    },
                  }
                : {}),
              checkForUpdate: () => undefined,
              startProfiling:
                fault === 'profiling'
                  ? () => Promise.reject(failure)
                  : () => Promise.resolve(undefined),
              maybeInitializeOwningTool:
                fault === 'tool-initialize'
                  ? () => Promise.reject(failure)
                  : () => Promise.resolve(),
              loadOwningToolCapabilities:
                fault === 'capability-load'
                  ? () => Promise.reject(failure)
                  : () => Promise.resolve(0),
            },
          ),
        ).rejects.toBe(failure);

        lifecycle.releaseBootstrapOwned();
        disposeCurrentScope();
        expect(buildPerRunScope).toHaveBeenCalledOnce();
        expect(lifecycle.state()).toBe('released');
        expect(release).toHaveBeenCalledOnce();
        expect(currentScope()).toBeUndefined();
      } finally {
        disposeCurrentScope();
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

describe('inspection-only bootstrap', () => {
  it('enters a minimal scope and skips every persistent/Tool bootstrap dependency', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-status-'));
    const status = defineHostCommand(
      {
        name: 'status',
        description: 'status',
        commonFlags: [],
        scope: 'none',
        output: 'command-result',
        handler: () => undefined,
      },
      { bootstrapMode: 'inspection-only' },
    );
    const scopes = buildCommandScopeIndex({
      hostSpecs: [status],
      hostGroups: [],
      toolSpecs: [],
    });
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'run-status',
      commandName: 'status',
      commandPath: 'status',
      commandScopes: scopes,
    });
    const createRunLogger = vi.fn();
    const buildPerRunScope = vi.fn();
    const checkForUpdate = vi.fn();
    const startProfiling = vi.fn();
    const maybeInitializeOwningTool = vi.fn();
    const loadOwningToolCapabilities = vi.fn();
    const phases: string[] = [];
    try {
      const result = await executePostBailoutBootstrap(
        {
          plan,
          runtime: runtime(),
          version: '0.0.0-test',
          noCloud: true,
        },
        {
          createRunLogger,
          buildPerRunScope,
          checkForUpdate,
          startProfiling,
          maybeInitializeOwningTool,
          loadOwningToolCapabilities,
          recordPhase: (phase) => phases.push(phase),
        },
      );
      expect(result.scope.projectContext?.projectRoot).toBe(realpathSync(tmp));
      expect(result.scope.languages.list()).toEqual([]);
      expect(result.scope.tools.list()).toEqual([]);
      expect(result.scope.datastore()).toBeUndefined();
      expect(phases).toEqual([
        PRE_ACTION_PHASES.runtimeLease,
        PRE_ACTION_PHASES.buildScope,
        PRE_ACTION_PHASES.enterScope,
      ]);
      expect(createRunLogger).not.toHaveBeenCalled();
      expect(buildPerRunScope).not.toHaveBeenCalled();
      expect(checkForUpdate).not.toHaveBeenCalled();
      expect(startProfiling).not.toHaveBeenCalled();
      expect(maybeInitializeOwningTool).not.toHaveBeenCalled();
      expect(loadOwningToolCapabilities).not.toHaveBeenCalled();
    } finally {
      disposeCurrentScope();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
