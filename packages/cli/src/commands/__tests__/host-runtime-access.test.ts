import {
  ToolRegistry,
  type CommandSpec,
  type RuntimeAccessLease,
  type RuntimeLease,
  type RuntimeReadLease,
  type UserStateReadLease,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildPreBootstrapInspectionHostSpecs,
  buildTopLevelHostSpecs,
} from '../host-command-specs.js';
import {
  DEFAULT_HOST_RUNTIME_POLICY,
  acquireHostRuntimeLease,
  createRuntimeLeaseLifecycle,
  createSafeRuntimeLeaseEventBuffer,
  defineHostCommand,
  isInspectionOnlyHostRequest,
  resolveHostRuntimePolicy,
} from '../host-runtime-access.js';

import type { CliCommandsContext } from '../shared.js';

function commandSpec(
  overrides: Partial<CommandSpec<unknown, unknown>> = {},
): CommandSpec<unknown, unknown> {
  return {
    name: 'status',
    description: 'fixture',
    commonFlags: [],
    scope: 'none',
    output: 'command-result',
    handler: () => undefined,
    ...overrides,
  };
}

function lease(): RuntimeLease {
  return {
    ownerToken: 'owner-token-1234567890',
    acquiredAt: 1,
    release: vi.fn(),
  };
}

describe('host command runtime policy', () => {
  it('decorates a new frozen copy only after core validation', () => {
    const handler = (): undefined => undefined;
    const source = {
      ...commandSpec({ handler }),
      ignoredHostInput: 'must-not-survive-core-copy',
    };
    const policy = {
      runtimeAccess: 'default',
      bootstrapMode: 'inspection-only',
    } as const;

    const decorated = defineHostCommand(source, policy);

    expect(decorated).not.toBe(source);
    expect(decorated.handler).toBe(handler);
    expect(Object.isFrozen(decorated)).toBe(true);
    expect(Object.isFrozen(decorated.hostRuntimePolicy)).toBe(true);
    expect(decorated.hostRuntimePolicy).toEqual(policy);
    expect('ignoredHostInput' in decorated).toBe(false);
  });

  it('rejects invalid policy fields and inspection privileges on project commands', () => {
    expect(() =>
      defineHostCommand(commandSpec(), {
        bootstrapMode: 'inspection-only',
        extra: true,
      } as never),
    ).toThrow(/Unsupported host runtime policy field/);
    expect(() =>
      defineHostCommand(commandSpec({ scope: 'project' }), {
        bootstrapMode: 'inspection-only',
      }),
    ).toThrow(/scope-none host commands/);
    expect(() =>
      defineHostCommand(commandSpec(), {
        bootstrapMode: 'inspection-only',
        runtimeAccess: 'user-state',
      }),
    ).toThrow(/default runtime access/);
  });

  it('derives the early inspection route from decorated specs and exact root argv', () => {
    const status = defineHostCommand(commandSpec(), {
      bootstrapMode: 'inspection-only',
    });
    expect(isInspectionOnlyHostRequest(['status'], [status])).toBe(true);
    expect(isInspectionOnlyHostRequest(['--no-cloud', '--no-plugins', 'status'], [status])).toBe(
      true,
    );
    expect(isInspectionOnlyHostRequest(['completion', 'status'], [status])).toBe(false);
    expect(isInspectionOnlyHostRequest(['status'], [defineHostCommand(commandSpec())])).toBe(false);
  });

  it('keeps the pre-bootstrap inspection projection identical to the live host inventory', () => {
    const ctx = {
      setExitCode: vi.fn(),
      render: vi.fn(() => Promise.resolve()),
      emitJson: vi.fn(),
      emitRaw: vi.fn(),
      emitError: vi.fn(),
      pluginLayouts: [],
      toolScaffolds: [],
      datastore: () => undefined,
      tools: new ToolRegistry(),
    } satisfies CliCommandsContext;
    const liveInspectionSpecs = buildTopLevelHostSpecs(ctx).filter(
      (spec) =>
        resolveHostRuntimePolicy(spec.hostRuntimePolicy).bootstrapMode === 'inspection-only',
    );
    const earlyInspectionSpecs = buildPreBootstrapInspectionHostSpecs();
    const namesAndAliases = (
      specs: readonly {
        readonly name: string;
        readonly aliases?: readonly string[];
      }[],
    ) =>
      specs.map((spec) => ({
        name: spec.name,
        aliases: [...(spec.aliases ?? [])],
      }));

    expect(namesAndAliases(earlyInspectionSpecs)).toEqual(namesAndAliases(liveInspectionSpecs));
    expect(liveInspectionSpecs).toHaveLength(1);
    for (const spec of liveInspectionSpecs) {
      expect(spec.scope).toBe('none');
      expect(spec.hostRuntimePolicy).toEqual({
        runtimeAccess: 'default',
        bootstrapMode: 'inspection-only',
      });
    }
  });
});

describe('runtime lease acquisition', () => {
  it('maps declared project/default access to a project reader', async () => {
    const acquired = {
      ...lease(),
      kind: 'runtime-read',
      coordinationKey: 'a'.repeat(24),
    } satisfies RuntimeReadLease;
    const read = vi.fn(() => Promise.resolve(acquired));
    const result = await acquireHostRuntimeLease(
      {
        command: 'fit',
        cwd: '/project',
        projectDir: '/project',
        scope: 'project',
        policy: DEFAULT_HOST_RUNTIME_POLICY,
      },
      { acquireRuntimeReadLease: read },
    );
    expect(result).toBe(acquired);
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'fit',
        projectDir: '/project',
        cwdBasename: 'project',
      }),
    );
  });

  it('uses one atomic composite for project plus user state', async () => {
    const acquired = {
      ...lease(),
      kind: 'runtime-access-composite',
      coordinationKey: 'b'.repeat(24),
      projectRead: true,
      userStateRead: true,
    } satisfies RuntimeAccessLease;
    const composite = vi.fn(() => Promise.resolve(acquired));
    await acquireHostRuntimeLease(
      {
        command: 'fixture',
        cwd: '/project',
        projectDir: '/project',
        scope: 'project',
        policy: { runtimeAccess: 'user-state', bootstrapMode: 'standard' },
      },
      { acquireRuntimeAccessLease: composite },
    );
    expect(composite).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRead: { projectDir: '/project' },
        userStateRead: true,
      }),
    );
  });

  it('adds no command-phase lease for scope-none/default or inspection-only commands', async () => {
    const read = vi.fn();
    const user = vi.fn();
    const composite = vi.fn();
    const deps = {
      acquireRuntimeReadLease: read,
      acquireUserStateReadLease: user,
      acquireRuntimeAccessLease: composite,
    };
    await expect(
      acquireHostRuntimeLease(
        {
          command: 'completion',
          cwd: '/project',
          projectDir: '/project',
          scope: 'none',
          policy: DEFAULT_HOST_RUNTIME_POLICY,
        },
        deps,
      ),
    ).resolves.toBeUndefined();
    await expect(
      acquireHostRuntimeLease(
        {
          command: 'status',
          cwd: '/project',
          projectDir: '/project',
          scope: 'none',
          policy: {
            runtimeAccess: 'default',
            bootstrapMode: 'inspection-only',
          },
        },
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(user).not.toHaveBeenCalled();
    expect(composite).not.toHaveBeenCalled();
  });

  it('uses the user reader for a scope-none user-state command', async () => {
    const acquired = {
      ...lease(),
      kind: 'user-state-read',
    } satisfies UserStateReadLease;
    const user = vi.fn(() => Promise.resolve(acquired));
    await expect(
      acquireHostRuntimeLease(
        {
          command: 'configure',
          cwd: '/project',
          projectDir: '/project',
          scope: 'none',
          policy: { runtimeAccess: 'user-state', bootstrapMode: 'standard' },
        },
        { acquireUserStateReadLease: user },
      ),
    ).resolves.toBe(acquired);
  });
});

describe('lease lifecycle and event safety', () => {
  it('releases only after native close is proven', () => {
    const release = vi.fn();
    const lifecycle = createRuntimeLeaseLifecycle({
      ownerToken: 'owner-token-1234567890',
      acquiredAt: 1,
      release,
    });
    lifecycle.transferToScope();
    lifecycle.finishAfterDatastoreClose({
      checkpointed: true,
      closed: false,
      reason: 'native-close-failed',
    });
    lifecycle.releaseBootstrapOwned();
    expect(lifecycle.state()).toBe('retained');
    expect(release).not.toHaveBeenCalled();

    const releasable = createRuntimeLeaseLifecycle({
      ownerToken: 'owner-token-abcdefghij',
      acquiredAt: 1,
      release,
    });
    releasable.transferToScope();
    releasable.finishAfterDatastoreClose({ checkpointed: true, closed: true });
    releasable.releaseBootstrapOwned();
    expect(releasable.state()).toBe('released');
    expect(release).toHaveBeenCalledOnce();

    const checkpointFailedRelease = vi.fn();
    const checkpointFailed = createRuntimeLeaseLifecycle({
      ownerToken: 'owner-token-checkpoint-failed',
      acquiredAt: 1,
      release: checkpointFailedRelease,
    });
    checkpointFailed.transferToScope();
    checkpointFailed.finishAfterDatastoreClose({
      checkpointed: false,
      closed: true,
      reason: 'checkpoint-failed',
    });
    checkpointFailed.releaseBootstrapOwned();
    checkpointFailed.finishAfterDatastoreClose({
      checkpointed: false,
      closed: true,
      reason: 'checkpoint-failed',
    });
    expect(checkpointFailed.state()).toBe('released');
    expect(checkpointFailedRelease).toHaveBeenCalledOnce();
  });

  it('releases the command reference before its retained startup reference', () => {
    const order: string[] = [];
    const lifecycle = createRuntimeLeaseLifecycle(
      {
        ownerToken: 'owner-token-command-1234',
        acquiredAt: 2,
        release: () => order.push('command'),
      },
      [
        {
          ownerToken: 'owner-token-startup-1234',
          acquiredAt: 1,
          release: () => order.push('startup'),
        },
      ],
    );
    lifecycle.transferToScope();

    lifecycle.finishAfterDatastoreClose({ checkpointed: true, closed: true });
    lifecycle.finishAfterDatastoreClose({ checkpointed: true, closed: true });

    expect(order).toEqual(['command', 'startup']);
    expect(lifecycle.state()).toBe('released');
  });

  it('drops raw paths and owner identity synchronously and caps the buffer', () => {
    const buffer = createSafeRuntimeLeaseEventBuffer(1);
    buffer.onEvent({
      kind: 'acquire.wait',
      lockPath: '/isolated/home/.opensip-cli-coordination/coordination.lock',
      resource: 'runtime',
      operation: '/isolated/home/owner-token/coordination.lock',
      waitMs: 12,
      ownerPid: 987,
      ownerHostname: 'private-host',
    });
    buffer.onEvent({
      kind: 'acquire.complete',
      lockPath: '/another/private/path',
      resource: 'runtime',
    });
    const projection = buffer.drain();
    const serialized = JSON.stringify(projection);
    expect(projection.dropped).toBe(1);
    expect(serialized).not.toContain('isolated');
    expect(serialized).not.toContain('owner-token');
    expect(serialized).not.toContain('coordination.lock');
    expect(serialized).not.toContain('private-host');
    expect(serialized).not.toContain('987');
    expect(buffer.drain()).toEqual({ events: [], dropped: 0 });
  });

  it('preserves only the closed cache-metadata operation vocabulary', () => {
    const buffer = createSafeRuntimeLeaseEventBuffer();
    buffer.onEvent({
      kind: 'acquire.complete',
      lockPath: '/private/cache/.project-marker.lock',
      resource: 'runtime',
      operation: 'ephemeral-marker',
    });
    buffer.onEvent({
      kind: 'acquire.complete',
      lockPath: '/private/cache/.last-prune.lock',
      resource: 'runtime',
      operation: 'ephemeral-prune-stamp',
    });

    expect(buffer.drain().events).toEqual([
      {
        kind: 'acquire.complete',
        resource: 'runtime',
        operation: 'ephemeral-marker',
      },
      {
        kind: 'acquire.complete',
        resource: 'runtime',
        operation: 'ephemeral-prune-stamp',
      },
    ]);
  });

  it('forwards safe release events after the run logger attaches', () => {
    const buffer = createSafeRuntimeLeaseEventBuffer();
    const events: unknown[] = [];
    const dropped: number[] = [];
    buffer.onEvent({
      kind: 'lease.acquire.complete',
      resource: 'runtime',
      operation: 'runtime-read',
      ownerPid: 987,
      ownerHostname: 'private-host',
    });

    buffer.attach({
      onEvent: (event) => events.push(event),
      onDropped: (count) => dropped.push(count),
    });
    buffer.onEvent({
      kind: 'lease.release',
      resource: 'runtime',
      operation: 'runtime-read',
      ownerPid: 987,
      ownerHostname: 'private-host',
    });

    expect(events).toEqual([
      {
        kind: 'lease.acquire.complete',
        resource: 'runtime',
        operation: 'runtime-read',
      },
      {
        kind: 'lease.release',
        resource: 'runtime',
        operation: 'runtime-read',
      },
    ]);
    expect(dropped).toEqual([]);
    expect(JSON.stringify(events)).not.toMatch(/private|coordination|987/u);
    expect(buffer.drain()).toEqual({ events: [], dropped: 0 });
  });

  it('firewalls attached diagnostic sink failures from lease callbacks', () => {
    const buffer = createSafeRuntimeLeaseEventBuffer();
    buffer.onEvent({
      kind: 'lease.acquire.complete',
      resource: 'runtime',
      operation: 'runtime-read',
    });

    expect(() =>
      buffer.attach({
        onEvent: () => {
          throw new Error('logger failed');
        },
        onDropped: () => {
          throw new Error('drop logger failed');
        },
      }),
    ).not.toThrow();
    expect(() =>
      buffer.onEvent({
        kind: 'lease.release',
        resource: 'runtime',
        operation: 'runtime-read',
      }),
    ).not.toThrow();
  });
});
