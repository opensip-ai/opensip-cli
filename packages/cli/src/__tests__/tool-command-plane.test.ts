/**
 * Phase 2 (release 2.11.0, §5.4) — Tool.commandSpecs mounting + the named
 * 10-step tool lifecycle.
 *
 * Asserts:
 *   1. a tool with `commandSpecs` mounts via the declarative spec path (the
 *      command lands on the program) and its `register()` is NOT called;
 *   2. a tool with only `register()` mounts via the deprecated fallback AND
 *      emits a structured `cli.tool.register_deprecated` event;
 *   3. the lifecycle step ordinals are the documented canonical sequence and
 *      `mountToolCommands` drives step 8 over every registered (bundled) tool;
 *   4. a mount failure is isolated per tool — the rest still mount.
 */

import {
  ToolRegistry as ToolRegistryClass,
  logger,
  type CommandSpec,
  type Tool,
  type ToolCliContext,
} from '@opensip-tools/core';
import { Command } from 'commander';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { mountAllToolCommands } from '../bootstrap/register-tools.js';
import { TOOL_LIFECYCLE_STEPS, mountToolCommands } from '../bootstrap/tool-lifecycle.js';
import { isValidTool } from '../bootstrap/validate-tool.js';

/** A throwaway `ToolCliContext` whose `program` is a real Commander root. */
function makeStubContext(program: Command = new Command('opensip-tools')): ToolCliContext {
  return {
    program,
    scope: {},
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
  } as never;
}

/** Silence the per-tool stderr warning the failure-isolation path writes. */
function silenceStderr(): () => void {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true);
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mountAllToolCommands — declarative commandSpecs path', () => {
  it('mounts a tool via its commandSpecs and does NOT call register()', () => {
    const registry = new ToolRegistryClass();
    const register = vi.fn();
    const tool: Tool = {
      metadata: { id: 'spec-tool', version: '0.0.0', description: 'spec tool' },
      commands: [{ name: 'speccmd', description: 'spec cmd' }],
      commandSpecs: [makeSpec('speccmd')],
      // A tool may declare BOTH during migration; the spec path must win and
      // register() must be skipped entirely.
      register,
    };
    registry.register(tool);

    const program = new Command('opensip-tools');
    const ctx = makeStubContext(program);
    const warnSpy = vi.spyOn(logger, 'warn');

    mountAllToolCommands(registry, ctx);

    // The declarative command is wired onto the Commander program.
    expect(program.commands.map((c) => c.name())).toContain('speccmd');
    // The deprecated register() path was NOT taken.
    expect(register).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.tool.register_deprecated' }),
    );
  });
});

describe('mountAllToolCommands — deprecated register() fallback', () => {
  it('falls back to register() and emits cli.tool.register_deprecated', () => {
    const registry = new ToolRegistryClass();
    const register = vi.fn();
    const tool: Tool = {
      metadata: { id: 'legacy-tool', version: '0.0.0', description: 'legacy tool' },
      commands: [{ name: 'legacycmd', description: 'legacy cmd' }],
      register,
    };
    registry.register(tool);

    const ctx = makeStubContext();
    const warnSpy = vi.spyOn(logger, 'warn');

    mountAllToolCommands(registry, ctx);

    expect(register).toHaveBeenCalledWith(ctx);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.tool.register_deprecated',
        toolId: 'legacy-tool',
      }),
    );
  });

  it('warns cli.tool.no_command_surface for a tool with neither path', () => {
    const registry = new ToolRegistryClass();
    const tool = {
      metadata: { id: 'empty-tool', version: '0.0.0', description: 'empty' },
      commands: [],
    } as unknown as Tool;
    registry.register(tool);

    const ctx = makeStubContext();
    const warnSpy = vi.spyOn(logger, 'warn');

    mountAllToolCommands(registry, ctx);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'cli.tool.no_command_surface', toolId: 'empty-tool' }),
    );
  });
});

describe('mountAllToolCommands — per-tool failure isolation', () => {
  it("a failing mount does not stop the other tools from mounting", () => {
    const registry = new ToolRegistryClass();
    const okRegister = vi.fn();
    const badRegister = vi.fn(() => {
      throw new Error('mount boom');
    });
    registry.register({
      metadata: { id: 'bad-tool', version: '0.0.0', description: 'bad' },
      commands: [{ name: 'badcmd', description: 'bad' }],
      register: badRegister,
    });
    registry.register({
      metadata: { id: 'ok-tool', version: '0.0.0', description: 'ok' },
      commands: [{ name: 'okcmd', description: 'ok' }],
      register: okRegister,
    });

    const ctx = makeStubContext();
    const warnSpy = vi.spyOn(logger, 'warn');
    const restore = silenceStderr();
    try {
      expect(() => mountAllToolCommands(registry, ctx)).not.toThrow();
    } finally {
      restore();
    }

    // Both were attempted; the failing one was isolated + logged.
    expect(badRegister).toHaveBeenCalledOnce();
    expect(okRegister).toHaveBeenCalledOnce();
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
    const order: string[] = [];
    registry.register({
      metadata: { id: 'first', version: '0.0.0', description: 'first' },
      commands: [],
      register: () => order.push('first'),
    });
    registry.register({
      metadata: { id: 'second', version: '0.0.0', description: 'second' },
      commands: [],
      register: () => order.push('second'),
    });

    const ctx = makeStubContext();
    vi.spyOn(logger, 'warn');
    mountToolCommands(registry, ctx);

    // Step 8 drives the mount over every registered tool, in registration
    // (== help/listing) order — provenance no longer matters at this step.
    expect(order).toEqual(['first', 'second']);
  });
});

describe('isValidTool — command-surface requirement', () => {
  const base = { metadata: { id: 'x' }, commands: [] };

  it('accepts a tool with only register()', () => {
    expect(isValidTool({ ...base, register: vi.fn() })).toBe(true);
  });

  it('accepts a tool with only commandSpecs', () => {
    expect(isValidTool({ ...base, commandSpecs: [makeSpec('c')] })).toBe(true);
  });

  it('rejects a tool with NEITHER command surface', () => {
    expect(isValidTool({ ...base })).toBe(false);
  });

  it('rejects an empty commandSpecs array with no register()', () => {
    expect(isValidTool({ ...base, commandSpecs: [] })).toBe(false);
  });
});
