/**
 * Tests for the composition-root bootstrap modules.
 *
 * Covers:
 *  - registerLanguageAdapters wires every bundled adapter into a fresh
 *    LanguageRegistry.
 *  - registerFirstPartyTools registers fitness, simulation, graph in
 *    the documented order with no surprises.
 *  - mountAllToolCommands isolates failing tools (one bad register()
 *    call doesn't take the whole registry down).
 */

import {
  LanguageRegistry,
  ToolRegistry,
  type Tool,
  type ToolCliContext,
} from '@opensip-tools/core';
import { describe, expect, it, vi } from 'vitest';

import { registerLanguageAdapters } from '../bootstrap/register-language-adapters.js';
import {
  mountAllToolCommands,
  registerFirstPartyTools,
} from '../bootstrap/register-tools.js';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

function makeStubContext(): ToolCliContext {
  return {
    // Minimal Commander-like program: mountAllToolCommands applies the shared
    // help configuration (ADR-0021) by walking commands after registration.
    program: { configureHelp: vi.fn(), addHelpText: vi.fn(), commands: [] },
    project: {
      cwd: '/test',
      cwdExplicit: false,
      projectRoot: '/test',
      configPath: undefined,
      walkedUp: 0,
      scope: 'none',
    },
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
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  };
}

describe('registerLanguageAdapters', () => {
  it('registers every bundled adapter into the supplied registry', () => {
    const registry = new LanguageRegistry();
    registerLanguageAdapters(registry);

    // The registry should now resolve every supported language id.
    const ids = ['typescript', 'rust', 'python', 'java', 'go', 'cpp'];
    for (const id of ids) {
      const adapter = registry.get(id);
      expect(adapter, `expected ${id} to be registered`).toBeDefined();
      expect(adapter?.id).toBe(id);
    }
  });
});

describe('registerFirstPartyTools', () => {
  it('registers fitness, simulation, and graph in the documented order', async () => {
    const registry = new ToolRegistry();
    await registerFirstPartyTools(registry);
    const ids = registry.list().map((t) => t.metadata.id);
    expect(ids).toEqual(BUNDLED_TOOLS.map((t) => t.metadata.id));
  });

  it('produces a deterministic ordering matching BUNDLED_TOOLS', () => {
    expect(BUNDLED_TOOLS.map((t) => t.metadata.id)).toEqual(['fitness', 'simulation', 'graph']);
  });
});

describe('mountAllToolCommands', () => {
  it('calls register(ctx) on every tool in the registry', () => {
    const registry = new ToolRegistry();
    const reg1 = vi.fn();
    const reg2 = vi.fn();
    const tool1: Tool = {
      metadata: { id: 'fake-1', name: 'Fake 1', version: '0.0.0', description: '' },
      commands: [],
      register: reg1,
    };
    const tool2: Tool = {
      metadata: { id: 'fake-2', name: 'Fake 2', version: '0.0.0', description: '' },
      commands: [],
      register: reg2,
    };
    registry.register(tool1);
    registry.register(tool2);

    const ctx = makeStubContext();
    mountAllToolCommands(registry, ctx);

    expect(reg1).toHaveBeenCalledOnce();
    expect(reg2).toHaveBeenCalledOnce();
    expect(reg1).toHaveBeenCalledWith(ctx);
    expect(reg2).toHaveBeenCalledWith(ctx);
  });

  it('isolates failing tools — one throw does not stop subsequent registrations', () => {
    const registry = new ToolRegistry();
    const reg2 = vi.fn();
    const tool1: Tool = {
      metadata: { id: 'broken', name: 'Broken', version: '0.0.0', description: '' },
      commands: [],
      register: () => {
        throw new Error('boom');
      },
    };
    const tool2: Tool = {
      metadata: { id: 'works', name: 'Works', version: '0.0.0', description: '' },
      commands: [],
      register: reg2,
    };
    registry.register(tool1);
    registry.register(tool2);

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const ctx = makeStubContext();
    mountAllToolCommands(registry, ctx);

    expect(reg2).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});
