import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defaultToolRegistry,
  type Tool,
  type ToolCliContext,
  type ToolRegistry,
} from '@opensip-tools/core';
import { Command } from 'commander';
import { describe, it, expect, vi } from 'vitest';

import {
  FIRST_PARTY_TOOLS,
  discoverAndRegisterToolPackages,
  mountAllToolCommands,
  registerFirstPartyTools,
} from '../bootstrap/register-tools.js';

function makeRegistry(): ToolRegistry {
  const map = new Map<string, Tool>();
  const list = (): Tool[] => [...map.values()];
  return {
    register: (tool: Tool) => {
      if (!map.has(tool.metadata.id)) map.set(tool.metadata.id, tool);
    },
    registerThirdParty: (tool: Tool) => {
      if (!map.has(tool.metadata.id)) map.set(tool.metadata.id, tool);
    },
    get: (id: string) => map.get(id),
    list,
    clear: () => map.clear(),
  } as never;
}

function makeStubContext(): ToolCliContext {
  return {
    program: new Command('opensip-tools'),
    project: { scope: 'project', projectRoot: '/x', walkedUp: 0 } as never,
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    datastore: undefined,
  };
}

describe('FIRST_PARTY_TOOLS', () => {
  it('contains fitness, simulation, and graph', () => {
    const ids = FIRST_PARTY_TOOLS.map((t) => t.metadata.id);
    expect(ids).toEqual(expect.arrayContaining(['fitness', 'simulation', 'graph']));
  });
});

describe('registerFirstPartyTools', () => {
  it('registers every first-party tool into the supplied registry', () => {
    const registry = makeRegistry();
    registerFirstPartyTools(registry);
    expect(registry.list()).toHaveLength(FIRST_PARTY_TOOLS.length);
  });

  it('is idempotent when called twice (first-writer-wins via id check)', () => {
    const registry = makeRegistry();
    registerFirstPartyTools(registry);
    registerFirstPartyTools(registry);
    expect(registry.list()).toHaveLength(FIRST_PARTY_TOOLS.length);
  });
});

describe('mountAllToolCommands', () => {
  it('calls register(ctx) on every tool', () => {
    const registry = makeRegistry();
    const registerA = vi.fn();
    const registerB = vi.fn();
    registry.register({
      metadata: { id: 'tool-a', name: 'A' },
      register: registerA,
    } as never);
    registry.register({
      metadata: { id: 'tool-b', name: 'B' },
      register: registerB,
    } as never);
    const ctx = makeStubContext();

    mountAllToolCommands(registry, ctx);

    expect(registerA).toHaveBeenCalledWith(ctx);
    expect(registerB).toHaveBeenCalledWith(ctx);
  });

  it('isolates a failing register so the rest still mount', () => {
    const registry = makeRegistry();
    const registerOk = vi.fn();
    const registerBad = vi.fn(() => {
      throw new Error('boom');
    });
    registry.register({
      metadata: { id: 'tool-good', name: 'good' },
      register: registerOk,
    } as never);
    registry.register({
      metadata: { id: 'tool-bad', name: 'bad' },
      register: registerBad,
    } as never);
    const ctx = makeStubContext();

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);
    try {
      mountAllToolCommands(registry, ctx);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(registerOk).toHaveBeenCalledOnce();
    expect(registerBad).toHaveBeenCalledOnce();
  });

  it('isolates a non-Error throw too', () => {
    const registry = makeRegistry();
    registry.register({
      metadata: { id: 'tool-throws-string', name: 'x' },
      register: () => {
        const nonError: unknown = 'plain string';
        throw nonError;
      },
    } as never);
    const ctx = makeStubContext();
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);
    try {
      expect(() => mountAllToolCommands(registry, ctx)).not.toThrow();
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe('discoverAndRegisterToolPackages', () => {
  it('does not throw when there are no third-party tool packages on disk', async () => {
    // Reset the registry to a clean state because the test runs in
    // process with other tests that may have populated it.
    defaultToolRegistry.clear();
    const empty = mkdtempSync(join(tmpdir(), 'opensip-discover-test-'));
    try {
      await expect(
        discoverAndRegisterToolPackages(defaultToolRegistry, { projectDir: empty }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
