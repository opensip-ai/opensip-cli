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

import { LanguageRegistry, ToolRegistry, type Tool, type ToolCliContext } from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerLanguageAdapters } from '../bootstrap/register-language-adapters.js';
import { mountAllToolCommands, registerFirstPartyTools } from '../bootstrap/register-tools.js';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

function makeStubContext(): ToolCliContext {
  return {
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
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
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
    const names = registry.list().map((t) => t.metadata.name ?? t.metadata.id);
    expect(names).toEqual(BUNDLED_TOOLS.map((t) => t.metadata.name ?? t.metadata.id));
  });

  it('produces a deterministic ordering matching BUNDLED_TOOLS (human names)', () => {
    expect(BUNDLED_TOOLS.map((t) => t.metadata.name ?? t.metadata.id)).toEqual([
      'fitness',
      'simulation',
      'graph',
    ]);
  });
});

/** A tool that mounts one command via the declarative commandSpecs path. */
function specTool(id: string, commandName: string): Tool {
  return {
    metadata: { id, name: id, version: '0.0.0', description: id },
    commands: [{ name: commandName, description: `${commandName} cmd` }],
    commandSpecs: [
      {
        name: commandName,
        description: `${commandName} cmd`,
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler: () => Promise.resolve({ type: 'noop' }),
      },
    ] as never,
  };
}

describe('mountAllToolCommands', () => {
  it('mounts every tool via its commandSpecs onto the program (3.0.0 — one command surface)', () => {
    const registry = new ToolRegistry();
    registry.register(specTool('fake-1', 'fake1'));
    registry.register(specTool('fake-2', 'fake2'));
    const program = new Command('opensip');

    mountAllToolCommands(registry, program, makeStubContext());

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('fake1');
    expect(names).toContain('fake2');
  });

  it('isolates failing tools — one spec that throws does not stop subsequent mounts', () => {
    const registry = new ToolRegistry();
    // A malformed spec (a boolean flag marked required) throws inside mountCommandSpec.
    const broken: Tool = {
      metadata: { id: 'broken', name: 'Broken', version: '0.0.0', description: '' },
      commands: [{ name: 'broken', description: 'broken' }],
      commandSpecs: [
        {
          name: 'broken',
          description: 'broken',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          options: [{ flag: '--flag', description: 'boolean but required', required: true }],
          handler: () => Promise.resolve({ type: 'noop' }),
        },
      ] as never,
    };
    registry.register(broken);
    registry.register(specTool('works', 'works'));
    const program = new Command('opensip');

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mountAllToolCommands(registry, program, makeStubContext());

    expect(program.commands.map((c) => c.name())).toContain('works');
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});
