/**
 * build-per-run-scope — focused coverage for the per-run scope contribution
 * contract. The pre-action hook remains the sequencer; this builder owns the
 * central invariant that tool subscopes may be installed but never overwrite
 * host-owned or previously contributed scope slots.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  PluginIncompatibleError,
  runWithScopeSync,
  ToolRegistry,
  type Logger,
  type ProjectContext,
  type Tool,
} from '@opensip-cli/core';
import {
  DataStoreFactory,
  type DataStore,
  type DatastoreCloseResult,
} from '@opensip-cli/datastore';
import { describe, expect, it, vi } from 'vitest';

import { createRuntimeLeaseLifecycle } from '../../commands/host-runtime-access.js';
import { buildPerRunScope } from '../build-per-run-scope.js';
import { isPolicyAuditCollector, PolicyAuditCollector } from '../policy-audit.js';

import type { RuntimeLeaseLifecycle } from '../../commands/host-runtime-access.js';
import type { loadCliDefaults } from '../cli-defaults.js';

const project: ProjectContext = {
  cwd: process.cwd(),
  cwdExplicit: false,
  projectRoot: process.cwd(),
  configPath: undefined,
  walkedUp: 0,
  scope: 'none',
};

const cliDefaults = { cloud: {}, ui: {} } as ReturnType<typeof loadCliDefaults>;

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// The contribution bag is intentionally typed as an arbitrary record: several
// tests pass non-standard / host-owned / dangerous scope keys (`alpha`,
// `logger`, `shared`, `constructor`, `dispose`) that are NOT part of
// `ScopeContribution` precisely to exercise the install guard's rejection paths.
function makeTool(name: string, contribution: Record<string, unknown>): Tool {
  return {
    identity: { name },
    metadata: {
      id: `00000000-0000-4000-8000-${name.padEnd(12, '0').slice(0, 12)}`,
      name,
      version: '0.0.0',
      description: `${name} fixture`,
    },
    commands: [{ name, description: `${name} command` }],
    extensionPoints: { contributeScope: () => contribution },
  };
}

function buildScopeWith(tools: readonly Tool[]) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return buildPerRunScope({
    project,
    runId: 'RUN_test',
    cwd: project.cwd,
    parentCommand: 'fit',
    toolName: 'fitness',
    cliDefaults,
    registries: { languages: new LanguageRegistry(), tools: registry },
    manifests: [],
    provenance: [],
    logger,
    ui: { version: '0.0.0', update: undefined },
    datastoreAccess: 'local',
  });
}

function ephemeralProject(): ProjectContext {
  return {
    ...project,
    scope: 'ephemeral',
    ephemeralConfigDocument: {},
  };
}

function lifecycleStore(
  closeResult: DatastoreCloseResult,
  onClose?: () => void,
): { store: DataStore; closeForLifecycle: ReturnType<typeof vi.fn> } {
  const closeForLifecycle = vi.fn(() => {
    onClose?.();
    return closeResult;
  });
  const store: DataStore = {
    close: vi.fn(),
    closeForLifecycle,
    withWriteLock: (_operation, fn) => fn(),
  };
  return { store, closeForLifecycle };
}

describe('buildPerRunScope scope contributions', () => {
  it('installs disjoint tool subscopes', () => {
    const scope = buildScopeWith([
      makeTool('alpha', { alpha: { value: 1 } }),
      makeTool('beta', { beta: { value: 2 } }),
    ]);

    expect((scope as unknown as { alpha: { value: number } }).alpha.value).toBe(1);
    expect((scope as unknown as { beta: { value: number } }).beta.value).toBe(2);
  });

  it('rejects a contribution that overwrites a host-owned scope slot', () => {
    expect(() => buildScopeWith([makeTool('bad', { logger: {} })])).toThrow(
      PluginIncompatibleError,
    );
  });

  it('rejects duplicate tool contribution keys', () => {
    expect(() =>
      buildScopeWith([
        makeTool('first', { shared: { owner: 'first' } }),
        makeTool('second', { shared: { owner: 'second' } }),
      ]),
    ).toThrow(/overwrite scope key 'shared'/);
  });

  it('rejects dangerous contribution keys', () => {
    expect(() => buildScopeWith([makeTool('bad', { constructor: {} })])).toThrow(
      /forbidden scope key 'constructor'/,
    );
  });

  it('rejects a contribution that shadows a prototype method (dispose)', () => {
    expect(() => buildScopeWith([makeTool('bad', { dispose: { hijacked: true } })])).toThrow(
      /overwrite scope key 'dispose'/,
    );
  });
});

describe('buildPerRunScope datastoreAccess', () => {
  it('installs a denied ambient thunk for host-rpc-only and registers dispose', () => {
    const registry = new ToolRegistry();
    const scope = buildPerRunScope({
      project,
      runId: 'RUN_worker',
      cwd: project.cwd,
      parentCommand: '__tool-command-worker',
      toolName: 'external',
      cliDefaults,
      registries: { languages: new LanguageRegistry(), tools: registry },
      manifests: [],
      provenance: [],
      logger,
      ui: { version: '0.0.0', update: undefined },
      datastoreAccess: 'host-rpc-only',
    });
    expect(() => scope.datastore()).toThrow(PluginIncompatibleError);
    try {
      scope.datastore();
    } catch (error) {
      expect((error as PluginIncompatibleError).code).toBe('PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS');
    }
    // Dispose must be safe (no open connection).
    expect(() => scope.dispose()).not.toThrow();
  });

  it('uses explicit local datastore access for ordinary host scopes', () => {
    const scope = buildScopeWith([]);
    // Local mode returns a thunk that may open SQLite; we only assert the
    // callable is present and is not the denied code path without invoking open
    // against a real project when possible. Calling dispose is always safe.
    expect(typeof scope.datastore).toBe('function');
    expect(() => scope.dispose()).not.toThrow();
  });

  it('denies runtime persistence to a scope-none command without a project lease', () => {
    const scope = buildPerRunScope({
      project: {
        ...project,
        scope: 'project',
        configPath: `${project.projectRoot}/opensip-cli.config.yml`,
      },
      runId: 'RUN_scope_none',
      cwd: project.cwd,
      parentCommand: 'agent-catalog',
      toolName: 'agent-catalog',
      cliDefaults,
      registries: { languages: new LanguageRegistry(), tools: new ToolRegistry() },
      manifests: [],
      provenance: [],
      logger,
      ui: { version: '0.0.0', update: undefined },
      datastoreAccess: 'none',
    });
    expect(() => scope.datastore()).toThrow(/non-project context/);
    expect(() => scope.dispose()).not.toThrow();
  });

  it('does not open SQLite during teardown for an unopened composite host capability', () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-composite-datastore-'));
    const datastoreFile = join(root, 'opensip-cli', '.runtime', 'datastore.sqlite');
    const audit = new PolicyAuditCollector('RUN_composite');
    audit.record({
      occurredAt: '2026-07-17T00:00:00.000Z',
      action: 'install',
      subject: 'installed-tool:fixture',
      outcome: 'allow',
      sourceTier: 'user',
      reasons: ['fixture'],
      exceptionIds: [],
      metadata: {},
    });
    const compositeProject: ProjectContext = {
      cwd: root,
      cwdExplicit: false,
      projectRoot: root,
      configPath: join(root, 'opensip-cli.config.yml'),
      walkedUp: 0,
      scope: 'project',
    };
    try {
      const scope = buildPerRunScope({
        project: compositeProject,
        runId: 'RUN_composite',
        cwd: root,
        parentCommand: 'tools',
        toolName: 'tools',
        cliDefaults,
        registries: { languages: new LanguageRegistry(), tools: new ToolRegistry() },
        manifests: [],
        provenance: [],
        bootstrapPolicyAudit: audit,
        noCloud: true,
        logger,
        ui: { version: '0.0.0', update: undefined },
        datastoreAccess: 'local-explicit-only',
      });
      const scopePolicyAudit = scope.policyAudit;
      expect(isPolicyAuditCollector(scopePolicyAudit)).toBe(true);
      if (!isPolicyAuditCollector(scopePolicyAudit)) {
        throw new TypeError('Expected the run scope to expose a policy audit collector');
      }
      expect(scopePolicyAudit.list()).not.toHaveLength(0);
      expect(existsSync(datastoreFile)).toBe(false);

      runWithScopeSync(scope, () => scope.dispose());

      expect(existsSync(datastoreFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs Tool disposers before close proof and lease release', () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      ...makeTool('ordered', {}),
      extensionPoints: {
        contributeScope: () => ({
          contribution: {},
          onDispose: () => order.push('tool'),
        }),
      },
    });
    const lifecycle: RuntimeLeaseLifecycle = {
      lease: undefined,
      state: () => 'bootstrap',
      transferToScope: vi.fn(() => order.push('transfer')),
      releaseBootstrapOwned: vi.fn(),
      finishAfterDatastoreClose: vi.fn((result) => {
        expect(result.closed).toBe(true);
        order.push('lease');
      }),
    };
    const scope = buildPerRunScope({
      project,
      runId: 'RUN_ordered',
      cwd: project.cwd,
      parentCommand: 'fit',
      toolName: 'fitness',
      cliDefaults,
      registries: { languages: new LanguageRegistry(), tools: registry },
      manifests: [],
      provenance: [],
      logger,
      ui: { version: '0.0.0', update: undefined },
      datastoreAccess: 'local',
      runtimeLeaseLifecycle: lifecycle,
    });

    expect(order).toEqual(['transfer']);
    scope.dispose();
    expect(order).toEqual(['transfer', 'tool', 'lease']);
  });

  it('retains a transferred runtime lease when datastore close is not proven', () => {
    const { store, closeForLifecycle } = lifecycleStore({
      checkpointed: false,
      closed: false,
      reason: 'checkpoint-and-close-failed',
    });
    const open = vi.spyOn(DataStoreFactory, 'open').mockReturnValue(store);
    const release = vi.fn();
    const lifecycle = createRuntimeLeaseLifecycle({
      ownerToken: 'owner-unproven-close',
      acquiredAt: 1,
      release,
    });
    try {
      const scope = buildPerRunScope({
        project: ephemeralProject(),
        runId: 'RUN_unproven_close',
        cwd: project.cwd,
        parentCommand: 'fit',
        toolName: 'fitness',
        cliDefaults,
        registries: { languages: new LanguageRegistry(), tools: new ToolRegistry() },
        manifests: [],
        provenance: [],
        noCloud: true,
        logger,
        ui: { version: '0.0.0', update: undefined },
        datastoreAccess: 'local',
        runtimeLeaseLifecycle: lifecycle,
      });
      expect(lifecycle.state()).toBe('scope');
      expect(scope.datastore()).toBe(store);

      runWithScopeSync(scope, () => scope.dispose());
      scope.dispose();

      expect(closeForLifecycle).toHaveBeenCalledOnce();
      expect(lifecycle.state()).toBe('retained');
      expect(release).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('continues persistence close and lease release after an earlier Tool disposer throws', () => {
    const order: string[] = [];
    const { store, closeForLifecycle } = lifecycleStore({ checkpointed: true, closed: true }, () =>
      order.push('persistence'),
    );
    const open = vi.spyOn(DataStoreFactory, 'open').mockReturnValue(store);
    const registry = new ToolRegistry();
    registry.register({
      ...makeTool('throwing-disposer', {}),
      extensionPoints: {
        contributeScope: () => ({
          contribution: {},
          onDispose: () => {
            order.push('tool');
            throw new Error('Tool disposer failed');
          },
        }),
      },
    });
    const release = vi.fn(() => order.push('lease'));
    const lifecycle = createRuntimeLeaseLifecycle({
      ownerToken: 'owner-throwing-tool-disposer',
      acquiredAt: 1,
      release,
    });
    try {
      const scope = buildPerRunScope({
        project: ephemeralProject(),
        runId: 'RUN_throwing_tool_disposer',
        cwd: project.cwd,
        parentCommand: 'fit',
        toolName: 'fitness',
        cliDefaults,
        registries: { languages: new LanguageRegistry(), tools: registry },
        manifests: [],
        provenance: [],
        noCloud: true,
        logger,
        ui: { version: '0.0.0', update: undefined },
        datastoreAccess: 'local',
        runtimeLeaseLifecycle: lifecycle,
      });
      expect(scope.datastore()).toBe(store);

      expect(() => runWithScopeSync(scope, () => scope.dispose())).not.toThrow();

      expect(order).toEqual(['tool', 'persistence', 'lease']);
      expect(closeForLifecycle).toHaveBeenCalledOnce();
      expect(lifecycle.state()).toBe('released');
      expect(release).toHaveBeenCalledOnce();
    } finally {
      open.mockRestore();
    }
  });
});
