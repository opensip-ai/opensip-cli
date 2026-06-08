/**
 * Tests for `mountCommandSpec` — the host-owned declarative command mounting
 * layer (release 2.11.0, Phase 1).
 *
 * Two surfaces are covered:
 *
 *   1. WIRING — a fixture `CommandSpec` mounts onto a throwaway `Command`;
 *      common flags, tool options (value / boolean / negatable / default /
 *      choices / required), positional args (variadic / optional), and aliases
 *      all land, and the action runs the handler with the parsed opts.
 *
 *   2. DISPATCH — one test per `output` mode through the single `dispatchOutput`
 *      seam: `command-result` (json short-circuit + render), `signal-envelope`
 *      (emitEnvelope under --json, render otherwise), `raw-stream` (host renders
 *      nothing), and `live-view` (renderLive(name, args)). Plus the typed-error
 *      → exit-code mapping the mounter owns.
 */

import { ConfigurationError, defineCommand } from '@opensip-tools/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { mountCommandSpec } from '../commands/mount-command-spec.js';

import type { CommandMountContext, HostCommandSpec } from '../commands/mount-command-spec.js';
import type { CommandResult } from '@opensip-tools/contracts';
import type { CommandSpec, ToolCliContext } from '@opensip-tools/core';

/** A Commander argParser reducer that accumulates repeated flag values into an array. */
function accumulateReducer(raw: string, previous: unknown): string[] {
  return [...((previous as string[] | undefined) ?? []), raw];
}

interface CapturedCtx {
  ctx: ToolCliContext;
  rendered: unknown[];
  envelopes: unknown[];
  liveViews: { key: string; args: unknown }[];
  exitCodes: number[];
}

/** Build a fake `ToolCliContext` recording every emitter the dispatch seam may hit. */
function makeCtx(): CapturedCtx {
  const rendered: unknown[] = [];
  const envelopes: unknown[] = [];
  const liveViews: { key: string; args: unknown }[] = [];
  const exitCodes: number[] = [];
  const ctx: ToolCliContext = {
    program: new Command(),
    scope: {} as ToolCliContext['scope'],
    render: vi.fn((result: unknown) => {
      rendered.push(result);
      return Promise.resolve();
    }),
    registerLiveView: vi.fn(),
    renderLive: vi.fn((key: string, args: unknown) => {
      liveViews.push({ key, args });
      return Promise.resolve();
    }),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn((code: number) => {
      exitCodes.push(code);
    }),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn((envelope: unknown) => {
      envelopes.push(envelope);
    }),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
  };
  return { ctx, rendered, envelopes, liveViews, exitCodes };
}

describe('mountCommandSpec — wiring', () => {
  it('wires the name, description, aliases, options, args, and runs the handler', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const handler = vi.fn(() => ({ type: 'help' }) as const);

    const spec: HostCommandSpec = defineCommand({
      name: 'demo',
      description: 'A demo command',
      aliases: ['d'],
      commonFlags: ['cwd', 'json'],
      options: [
        { flag: '--recipe', value: '<name>', description: 'recipe name' },
        { flag: '--gate-save', description: 'save gate', default: false },
        { flag: '--no-cache', negatable: true, description: 'skip cache' },
        {
          flag: '--resolution',
          value: '<mode>',
          description: 'resolution mode',
          default: 'exact',
          choices: ['exact', 'fast'],
        },
      ],
      args: [{ name: 'paths', variadic: true, optional: true, description: 'subtrees' }],
      scope: 'project',
      output: 'command-result',
      handler,
    });

    mountCommandSpec(program, spec, ctx);

    const cmd = program.commands.find((c) => c.name() === 'demo');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toBe('A demo command');
    expect(cmd?.aliases()).toContain('d');

    const optionFlags = cmd?.options.map((o) => o.flags) ?? [];
    expect(optionFlags).toContain('--cwd <path>');
    expect(optionFlags).toContain('--json');
    expect(optionFlags).toContain('--recipe <name>');
    expect(optionFlags).toContain('--gate-save');
    expect(optionFlags).toContain('--no-cache');
    expect(optionFlags).toContain('--resolution <mode>');

    await program.parseAsync(['demo', '--recipe', 'r1', 'src', 'lib'], { from: 'user' });

    expect(handler).toHaveBeenCalledOnce();
    const opts = handler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.recipe).toBe('r1');
    expect(opts.gateSave).toBe(false);
    // negatable default → cache true; resolution default → 'exact'
    expect(opts.cache).toBe(true);
    expect(opts.resolution).toBe('exact');
    expect(typeof opts.cwd).toBe('string');
    // Positionals ride on the parsed-opts object under `_args` for EVERY output
    // mode (not just live-view), so a raw-stream/command-result handler that
    // declares `args` can read them. `demo`'s sole positional is the variadic
    // `[paths...]`, which Commander hands over as one array argument: `_args`
    // therefore carries `[['src', 'lib']]` (one variadic slot).
    expect(opts._args).toEqual([['src', 'lib']]);
  });

  it('applies a value default and enforces choices', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    // Commander writes choice-validation failures to stderr and throws; suppress
    // the process.exit override so the parse rejects in-band.
    program.exitOverride();
    const handler = vi.fn(() => ({ type: 'help' }) as const);

    const spec: HostCommandSpec = defineCommand({
      name: 'pick',
      description: 'pick a mode',
      commonFlags: [],
      options: [
        { flag: '--mode', value: '<m>', description: 'mode', default: 'a', choices: ['a', 'b'] },
      ],
      scope: 'none',
      output: 'command-result',
      handler,
    });
    mountCommandSpec(program, spec, ctx);

    // Default applied when flag omitted.
    await program.parseAsync(['pick'], { from: 'user' });
    expect((handler.mock.calls[0]?.[0] as Record<string, unknown>).mode).toBe('a');

    // Out-of-choice value rejected.
    await expect(
      program.parseAsync(['pick', '--mode', 'zzz'], { from: 'user' }),
    ).rejects.toThrow();
  });

  it('seeds a fresh array for an arrayDefault repeatable option via its parse reducer', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const handler = vi.fn(() => ({ type: 'help' }) as const);

    const spec: HostCommandSpec = defineCommand({
      name: 'acc',
      description: 'accumulate',
      commonFlags: [],
      options: [
        {
          flag: '--exclude',
          value: '<slug>',
          description: 'repeatable exclude',
          arrayDefault: [],
          parse: accumulateReducer,
        },
      ],
      scope: 'none',
      output: 'command-result',
      handler,
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['acc', '--exclude', 'x', '--exclude', 'y'], { from: 'user' });
    expect((handler.mock.calls[0]?.[0] as Record<string, unknown>).exclude).toEqual(['x', 'y']);
  });

  it('makes a required value option mandatory', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    program.exitOverride();
    const spec: HostCommandSpec = defineCommand({
      name: 'needs',
      description: 'needs out',
      commonFlags: [],
      options: [{ flag: '--out', value: '<path>', description: 'output path', required: true }],
      scope: 'none',
      output: 'raw-stream',
      handler: () => undefined,
    });
    mountCommandSpec(program, spec, ctx);

    await expect(program.parseAsync(['needs'], { from: 'user' })).rejects.toThrow();
  });
});

describe('mountCommandSpec — dispatchOutput modes', () => {
  it('command-result: renders by default, short-circuits to JSON under --json', async () => {
    const { ctx, rendered } = makeCtx();
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    });

    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'res',
      description: 'result command',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: () => ({ type: 'help' }) as const,
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['res'], { from: 'user' });
    expect(rendered).toEqual([{ type: 'help' }]);

    await program.parseAsync(['res', '--json'], { from: 'user' });
    expect(rendered).toHaveLength(1); // not rendered again
    expect(writes.join('')).toContain('"type": "help"');
    stdoutSpy.mockRestore();
  });

  it('signal-envelope: renders by default, emits the envelope under --json', async () => {
    const { ctx, rendered, envelopes } = makeCtx();
    const envelope = { verdict: { passed: true }, signals: [] };
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'run',
      description: 'run command',
      commonFlags: ['json'],
      scope: 'project',
      output: 'signal-envelope',
      handler: () => envelope,
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['run'], { from: 'user' });
    expect(rendered).toEqual([envelope]);
    expect(envelopes).toEqual([]);

    await program.parseAsync(['run', '--json'], { from: 'user' });
    expect(envelopes).toEqual([envelope]);
    expect(rendered).toHaveLength(1); // not rendered under --json
  });

  it('raw-stream: the host renders nothing (handler owns its own IO)', async () => {
    const { ctx, rendered, envelopes } = makeCtx();
    const sideEffect = vi.fn();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'export',
      description: 'export command',
      commonFlags: [],
      scope: 'none',
      output: 'raw-stream',
      handler: () => {
        sideEffect();
        return undefined;
      },
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['export'], { from: 'user' });
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(rendered).toEqual([]);
    expect(envelopes).toEqual([]);
    expect(ctx.render).not.toHaveBeenCalled();
  });

  it('live-view: dispatches renderLive(name, {…opts, _args}) and ignores the return value', async () => {
    const { ctx, liveViews } = makeCtx();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'view',
      description: 'live command',
      commonFlags: ['json'],
      args: [{ name: 'paths', variadic: true, optional: true, description: 'paths' }],
      scope: 'project',
      output: 'live-view',
      handler: () => undefined,
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['view', 'a', 'b'], { from: 'user' });
    expect(liveViews).toHaveLength(1);
    expect(liveViews[0]?.key).toBe('view');
    // Commander passes a variadic positional as ONE array argument, so `_args`
    // carries the faithful positional list: `[['a', 'b']]` (one variadic slot).
    expect((liveViews[0]?.args as Record<string, unknown>)._args).toEqual([['a', 'b']]);
  });

  it('maps a thrown typed ToolError to the canonical exit code', async () => {
    const { ctx, exitCodes } = makeCtx();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'boom',
      description: 'throws',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler: () => {
        throw new ConfigurationError('bad flag combo');
      },
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['boom'], { from: 'user' });
    // ConfigurationError → CONFIGURATION_ERROR (exit 2)
    expect(exitCodes).toEqual([2]);
  });

  it('re-throws a non-ToolError so the top-level boundary handles it', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'bug',
      description: 'plain throw',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler: () => {
        throw new Error('unexpected');
      },
    });
    mountCommandSpec(program, spec, ctx);

    await expect(program.parseAsync(['bug'], { from: 'user' })).rejects.toThrow('unexpected');
  });
});

// ---------------------------------------------------------------------------
// Leaner CommandMountContext — the HOST-command path (release 2.11.0 Phase 6).
// Host commands mount with a context that provides only `render` + `setExitCode`
// (no `emitEnvelope` / `renderLive`); the generic mounter accepts it, the
// command-result + raw-stream arms work, and the signal-envelope / live-view
// arms throw loudly rather than silently no-op'ing.
// ---------------------------------------------------------------------------

interface LeanCtx {
  ctx: CommandMountContext;
  rendered: CommandResult[];
  exitCodes: number[];
}

/** A context with ONLY the always-used mount members — the host-command shape. */
function makeLeanCtx(): LeanCtx {
  const rendered: CommandResult[] = [];
  const exitCodes: number[] = [];
  const ctx: CommandMountContext = {
    render: (result: CommandResult) => {
      rendered.push(result);
      return Promise.resolve();
    },
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
  };
  return { ctx, rendered, exitCodes };
}

describe('mountCommandSpec — leaner host CommandMountContext', () => {
  it('command-result: renders through a context with no emitEnvelope/renderLive', async () => {
    const { ctx, rendered } = makeLeanCtx();
    const program = new Command();
    const spec: CommandSpec<unknown, CommandMountContext> = defineCommand({
      name: 'hostlike',
      description: 'host-style command',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: () => ({ type: 'help' }),
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['hostlike'], { from: 'user' });
    expect(rendered).toEqual([{ type: 'help' }]);
  });

  it('raw-stream: the host renders nothing (handler owns IO), lean context fine', async () => {
    const { ctx, rendered } = makeLeanCtx();
    const program = new Command();
    let ran = false;
    const spec: CommandSpec<unknown, CommandMountContext> = defineCommand({
      name: 'rawhost',
      description: 'raw host command',
      commonFlags: [],
      scope: 'none',
      output: 'raw-stream',
      handler: () => {
        ran = true;
      },
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['rawhost'], { from: 'user' });
    expect(ran).toBe(true);
    expect(rendered).toHaveLength(0);
  });

  it('signal-envelope under --json throws when the lean context lacks emitEnvelope', async () => {
    const { ctx } = makeLeanCtx();
    const program = new Command();
    const spec: CommandSpec<unknown, CommandMountContext> = defineCommand({
      name: 'envhost',
      description: 'envelope host command',
      commonFlags: ['json'],
      scope: 'none',
      output: 'signal-envelope',
      handler: () => ({ ok: true }),
    });
    mountCommandSpec(program, spec, ctx);

    await expect(
      program.parseAsync(['envhost', '--json'], { from: 'user' }),
    ).rejects.toThrow(/no emitEnvelope/);
  });

  it('live-view throws when the lean context lacks renderLive', async () => {
    const { ctx } = makeLeanCtx();
    const program = new Command();
    const spec: CommandSpec<unknown, CommandMountContext> = defineCommand({
      name: 'livehost',
      description: 'live host command',
      commonFlags: [],
      scope: 'none',
      output: 'live-view',
      handler: () => undefined,
    });
    mountCommandSpec(program, spec, ctx);

    await expect(
      program.parseAsync(['livehost'], { from: 'user' }),
    ).rejects.toThrow(/no renderLive/);
  });
});
