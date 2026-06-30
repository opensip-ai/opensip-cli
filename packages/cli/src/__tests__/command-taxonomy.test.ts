/**
 * Command-taxonomy resolution test.
 *
 * The CANONICAL `<tool> <verb>` subcommands are the only command surface — the
 * legacy flat hyphenated/bare aliases were removed once their deprecation window
 * closed. This test mounts the full bundled program (the same `BUNDLED_TOOLS` +
 * `mountAllToolCommands` path the parity snapshot uses) and asserts the canonical
 * nested children resolve to a mounted Commander command AND that each removed
 * legacy flat name no longer resolves — so neither the canonical surface can be
 * dropped nor a legacy alias re-introduced without a loud failure.
 */

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runWithScopeSync,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';
import { fitnessTool } from '@opensip-cli/fitness';
import { graphTool } from '@opensip-cli/graph';
import { simulationTool } from '@opensip-cli/simulation';
import { yagniTool } from '@opensip-cli/yagni';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { mountAllToolCommands } from '../bootstrap/register-tools.js';
import { registerCliCommands } from '../commands/index.js';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

/** A throwaway tool context — mounting only READS each spec's static
 *  declarations (no handler runs), so every member is an inert stub. */
function makeStubToolContext(): ToolCliContext {
  return {
    project: { scope: 'project', projectRoot: '/x', walkedUp: 0 },
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  } as never;
}

/** Build the fully-mounted program: bundled tools + CLI-owned host commands. */
function buildFullProgram(): Command {
  const scope = new RunScope({
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
  });
  return runWithScopeSync(scope, () => {
    const program = new Command('opensip');
    const registry = new ToolRegistry();
    for (const tool of BUNDLED_TOOLS) registry.register(tool);
    mountAllToolCommands(registry, program, makeStubToolContext(), []);
    registerCliCommands(program, {
      setExitCode: vi.fn(),
      render: vi.fn(() => Promise.resolve()),
      datastore: () => undefined,
      pluginLayouts: [],
    });
    return program;
  });
}

/** Resolve a flat top-level command by name OR Commander alias. */
function resolveTopLevel(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/** Resolve a nested `<parent> <verb>` command (e.g. `graph export`) to its leaf. */
function resolveNested(program: Command, parent: string, verb: string): Command | undefined {
  const parentCmd = resolveTopLevel(program, parent);
  return parentCmd?.commands.find((c) => c.name() === verb || c.aliases().includes(verb));
}

describe('command taxonomy — canonical resolves, legacy is gone (Step 2)', () => {
  /**
   * Each row pairs a REMOVED legacy flat command name with its CANONICAL
   * `<tool> <verb>` form. The canonical child must resolve; the legacy flat name
   * must NOT resolve (it was deleted entirely).
   */
  const PAIRS: readonly { legacy: string; parent: string; verb: string }[] = [
    // Export forms. The three legacy graph exports all map to `graph export`.
    { legacy: 'sarif-export', parent: 'graph', verb: 'export' },
    { legacy: 'catalog-export', parent: 'graph', verb: 'export' },
    { legacy: 'graph-baseline-export', parent: 'graph', verb: 'export' },
    { legacy: 'fit-baseline-export', parent: 'fitness', verb: 'export' },
    // Cosmetic grouped forms.
    { legacy: 'fit-list', parent: 'fitness', verb: 'list' },
    { legacy: 'fit-recipes', parent: 'fitness', verb: 'recipes' },
    { legacy: 'graph-recipes', parent: 'graph', verb: 'recipes' },
    { legacy: 'graph-lookup', parent: 'graph', verb: 'lookup' },
    { legacy: 'graph-symbol-index', parent: 'graph', verb: 'index' },
  ];

  it.each(PAIRS)(
    'canonical $parent $verb resolves and legacy %s is removed',
    ({ legacy, parent, verb }) => {
      const program = buildFullProgram();
      expect(
        resolveTopLevel(program, legacy),
        `legacy flat command '${legacy}' must be removed`,
      ).toBeUndefined();
      expect(
        resolveNested(program, parent, verb),
        `canonical '${parent} ${verb}' must be a mounted nested child`,
      ).toBeDefined();
    },
  );
});

describe('command taxonomy — new discoverability commands exist (Step 3)', () => {
  it('mounts `simulation recipes` (new — no legacy predecessor)', () => {
    const program = buildFullProgram();
    expect(resolveNested(program, 'simulation', 'recipes')).toBeDefined();
    expect(resolveNested(program, 'sim', 'recipes')).toBeDefined();
    // No flat `sim-recipes` ever existed.
    expect(resolveTopLevel(program, 'sim-recipes')).toBeUndefined();
  });

  it('mounts `graph list` (new — no legacy predecessor)', () => {
    const program = buildFullProgram();
    expect(resolveNested(program, 'graph', 'list')).toBeDefined();
    expect(resolveTopLevel(program, 'graph-list')).toBeUndefined();
  });
});

describe('command taxonomy — metadata.name parity (Step 4)', () => {
  it('each bundled tool metadata.name equals its canonical primary command verb', () => {
    expect(fitnessTool.metadata.name).toBe('fitness');
    expect(simulationTool.metadata.name).toBe('simulation');
    expect(graphTool.metadata.name).toBe('graph');

    const program = buildFullProgram();
    for (const verb of ['fitness', 'simulation', 'graph']) {
      expect(resolveTopLevel(program, verb), `'${verb}' must be a mounted command`).toBeDefined();
    }
  });

  it('short CLI aliases resolve to the same primary commands', () => {
    const program = buildFullProgram();
    const fitness = resolveTopLevel(program, 'fitness');
    const fit = resolveTopLevel(program, 'fit');
    expect(fit).toBe(fitness);
    const simulation = resolveTopLevel(program, 'simulation');
    const sim = resolveTopLevel(program, 'sim');
    expect(sim).toBe(simulation);
  });
});

describe('command taxonomy — internal descriptors carry visibility:internal (Step 5)', () => {
  /** The five Tier-3 internal command names and the tool that owns each. */
  const INTERNAL: readonly { tool: Tool; name: string }[] = [
    { tool: fitnessTool, name: 'fit-run-worker' },
    { tool: graphTool, name: 'graph-run-worker' },
    { tool: graphTool, name: 'graph-shard-worker' },
    { tool: graphTool, name: 'graph-equivalence-check' },
    { tool: simulationTool, name: 'sim-run-worker' },
    { tool: yagniTool, name: 'yagni-run-worker' },
  ];

  it.each(INTERNAL)('descriptor for $name declares visibility: internal', ({ tool, name }) => {
    const descriptor = tool.commands.find((c) => c.name === name);
    expect(descriptor, `tool must declare a '${name}' command descriptor`).toBeDefined();
    expect(descriptor?.visibility).toBe('internal');
  });

  it('no PUBLIC tool command descriptor is marked visibility: internal', () => {
    const internalNames = new Set(INTERNAL.map((i) => i.name));
    for (const tool of [fitnessTool, simulationTool, graphTool, yagniTool]) {
      for (const descriptor of tool.commands) {
        if (internalNames.has(descriptor.name)) continue;
        expect(
          descriptor.visibility,
          `public command '${descriptor.name}' must NOT be internal`,
        ).not.toBe('internal');
      }
    }
  });
});
