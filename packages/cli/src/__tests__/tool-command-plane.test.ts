/**
 * The command plane (north-star §5.4) + the named 10-step tool lifecycle.
 *
 * 3.0.0 GA: there is ONE command surface — a tool's declared `commandSpecs`,
 * mounted by the host. `register()` and the raw-Commander `program` handle were
 * removed. Asserts:
 *   1. a tool with `commandSpecs` mounts via the declarative spec path (the
 *      command lands on the host-owned program);
 *   2. a tool with no `commandSpecs` is a mis-declaration → a structured
 *      `cli.tool.no_command_surface` event (no fallback);
 *   3. the lifecycle step ordinals are the documented canonical sequence and
 *      `mountToolCommands` drives step 8 over every registered tool;
 *   4. a mount failure is isolated per tool — the rest still mount;
 *   5. `isValidTool` requires a non-empty `commandSpecs` (no register surface).
 */

import {
  ToolRegistry as ToolRegistryClass,
  logger,
  type CommandSpec,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';
import { Command } from 'commander';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { mountAllToolCommands } from '../bootstrap/register-tools.js';
import { TOOL_LIFECYCLE_STEPS, mountToolCommands } from '../bootstrap/tool-lifecycle.js';
import { isValidTool } from '../bootstrap/validate-tool.js';

/** A throwaway handler-facing `ToolCliContext` (no Commander program — 3.0.0). */
function makeStubContext(): ToolCliContext {
  return {
    scope: {},
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    runSession: {
      timing: {
        startedAt: new Date().toISOString(),
        startedAtEpochMs: Date.now(),
        elapsedMs: () => 0,
        snapshot: () => ({ startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0 }),
      },
      record: () => undefined,
    },
  } as never;
}

/** Silence the per-tool stderr warning the failure-isolation path writes. */
function silenceStderr(): () => void {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  return () => {
    process.stderr.write = orig;
  };
}

/** A minimal declarative spec the mounter can wire onto a Commander program. */
function makeSpec(name: string): CommandSpec<unknown, ToolCliContext> {
  return {
    name,
    description: `the ${name} command`,
    commonFlags: ['json'],
    scope: 'project',
    output: 'command-result',
    handler: vi.fn(() => ({ type: 'ok' })),
  };
}

/** A tool that mounts one command via the declarative commandSpecs path. */
function specTool(id: string, commandName: string): Tool {
  return {
    metadata: { id, version: '0.0.0', description: id },
    commands: [{ name: commandName, description: `${commandName} cmd` }],
    commandSpecs: [makeSpec(commandName)],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mountAllToolCommands — declarative commandSpecs path (the one surface)', () => {
  it('mounts a tool via its commandSpecs onto the host-owned program', () => {
    const registry = new ToolRegistryClass();
    registry.register(specTool('spec-tool', 'speccmd'));

    const program = new Command('opensip');
    mountAllToolCommands(registry, program, makeStubContext());

    expect(program.commands.map((c) => c.name())).toContain('speccmd');
  });

  it('warns cli.tool.no_command_surface for a tool with no commandSpecs (no fallback)', () => {
    const registry = new ToolRegistryClass();
    const tool = {
      metadata: { id: 'empty-tool', version: '0.0.0', description: 'empty' },
      commands: [],
    } as unknown as Tool;
    registry.register(tool);

    const program = new Command('opensip');
    const warnSpy = vi.spyOn(logger, 'warn');
    mountAllToolCommands(registry, program, makeStubContext());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.tool.no_command_surface', toolId: 'empty-tool' }),
    );
    expect(program.commands.map((c) => c.name())).not.toContain('empty-tool');
  });
});

describe('mountAllToolCommands — per-tool failure isolation', () => {
  it('a failing mount does not stop the other tools from mounting', () => {
    const registry = new ToolRegistryClass();
    // A malformed spec (a boolean flag marked required) throws inside mountCommandSpec.
    const bad: Tool = {
      metadata: { id: 'bad-tool', version: '0.0.0', description: 'bad' },
      commands: [{ name: 'badcmd', description: 'bad' }],
      commandSpecs: [
        {
          ...makeSpec('badcmd'),
          options: [{ flag: '--flag', description: 'boolean but required', required: true }],
        },
      ],
    };
    registry.register(bad);
    registry.register(specTool('ok-tool', 'okcmd'));

    const program = new Command('opensip');
    const warnSpy = vi.spyOn(logger, 'warn');
    const restore = silenceStderr();
    try {
      expect(() => mountAllToolCommands(registry, program, makeStubContext())).not.toThrow();
    } finally {
      restore();
    }

    // The good tool mounted despite the bad tool throwing; the failure was logged.
    expect(program.commands.map((c) => c.name())).toContain('okcmd');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.tool.register_failed', toolId: 'bad-tool' }),
    );
  });
});

describe('tool lifecycle — canonical 10-step ordering', () => {
  it('enumerates the documented step ordinals 1..10 with mount = step 8', () => {
    expect(TOOL_LIFECYCLE_STEPS.mount).toBe(8);
    const ordered = Object.entries(TOOL_LIFECYCLE_STEPS)
      .sort((a, b) => a[1] - b[1])
      .map(([k]) => k);
    expect(ordered).toEqual([
      'discover',
      'compat',
      'trust',
      'import',
      'config',
      'scope',
      'capabilities',
      'mount',
      'initialize',
      'dispatch',
    ]);
    expect(Object.values(TOOL_LIFECYCLE_STEPS)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('mountToolCommands (step 8) mounts every registered tool in registration order', () => {
    const registry = new ToolRegistryClass();
    registry.register(specTool('first', 'firstcmd'));
    registry.register(specTool('second', 'secondcmd'));

    const program = new Command('opensip');
    mountToolCommands(registry, program, makeStubContext());

    // Step 8 mounts every registered tool's command, in registration (== help/
    // listing) order — provenance no longer matters at this step.
    expect(program.commands.map((c) => c.name())).toEqual(['firstcmd', 'secondcmd']);
  });
});

describe('isValidTool — command-surface requirement', () => {
  const base = { metadata: { id: 'x' }, commands: [] };

  it('accepts a tool with a non-empty commandSpecs', () => {
    expect(isValidTool({ ...base, commandSpecs: [makeSpec('c')] })).toBe(true);
  });

  it('rejects a tool with no command surface', () => {
    expect(isValidTool({ ...base })).toBe(false);
  });

  it('rejects an empty commandSpecs array', () => {
    expect(isValidTool({ ...base, commandSpecs: [] })).toBe(false);
  });
});
