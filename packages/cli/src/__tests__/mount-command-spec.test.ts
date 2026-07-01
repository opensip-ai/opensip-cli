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

import { mapToolErrorToExitCode } from '@opensip-cli/contracts';
import { ConfigurationError, defineCommand } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRunActionHooks,
  createRunPlaneFactory,
  createRunSessionSeam,
} from '../bootstrap/run-plane.js';
import { mountCommandSpec } from '../commands/mount-command-spec.js';

import type { CommandMountContext, HostCommandSpec } from '../commands/mount-command-spec.js';
import type { CommandResult } from '@opensip-cli/contracts';
import type { CommandSpec, Logger, ToolCliContext } from '@opensip-cli/core';

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
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn((code: number) => {
      exitCodes.push(code);
    }),
    emitJson: vi.fn(),
    emitError: vi.fn(),
    reportFailure: vi.fn((detail) => {
      if (detail.error !== undefined) {
        exitCodes.push(mapToolErrorToExitCode(detail.error));
      } else if (detail.exitCode !== undefined) {
        exitCodes.push(detail.exitCode);
      }
      return Promise.resolve();
    }),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn((envelope: unknown) => {
      envelopes.push(envelope);
    }),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    runSession: {
      timing: {
        startedAt: new Date().toISOString(),
        startedAtEpochMs: Date.now(),
        elapsedMs: () => 0,
        snapshot: () => ({
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        }),
        complete: () => ({
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        }),
      },
    },
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
      args: [
        {
          name: 'paths',
          variadic: true,
          optional: true,
          description: 'subtrees',
        },
      ],
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

    await program.parseAsync(['demo', '--recipe', 'r1', 'src', 'lib'], {
      from: 'user',
    });

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
        {
          flag: '--mode',
          value: '<m>',
          description: 'mode',
          default: 'a',
          choices: ['a', 'b'],
        },
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
    await expect(program.parseAsync(['pick', '--mode', 'zzz'], { from: 'user' })).rejects.toThrow();
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

    await program.parseAsync(['acc', '--exclude', 'x', '--exclude', 'y'], {
      from: 'user',
    });
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
      options: [
        {
          flag: '--out',
          value: '<path>',
          description: 'output path',
          required: true,
        },
      ],
      scope: 'none',
      output: 'raw-stream',
      rawStreamReason: 'file-export',
      handler: () => undefined,
    });
    mountCommandSpec(program, spec, ctx);

    await expect(program.parseAsync(['needs'], { from: 'user' })).rejects.toThrow();
  });

  it('injects the variadic ellipsis into a value placeholder (<slug> → <slug...>)', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const handler = vi.fn(() => ({ type: 'help' }) as const);
    const spec: HostCommandSpec = defineCommand({
      name: 'many',
      description: 'variadic option',
      commonFlags: [],
      // A variadic VALUE option (not a positional arg) — exercises
      // `resolveValuePlaceholder`'s `<slug>` → `<slug...>` rewrite.
      options: [{ flag: '--tag', value: '<slug>', description: 'tags', variadic: true }],
      scope: 'none',
      output: 'command-result',
      handler,
    });
    mountCommandSpec(program, spec, ctx);

    const cmd = program.commands.find((c) => c.name() === 'many');
    // The mounted option renders the variadic ellipsis inside the bracket pair.
    expect(cmd?.options.map((o) => o.flags)).toContain('--tag <slug...>');

    await program.parseAsync(['many', '--tag', 'a', 'b'], { from: 'user' });
    // Commander collects a variadic option's values into an array.
    expect((handler.mock.calls[0]?.[0] as Record<string, unknown>).tag).toEqual(['a', 'b']);
  });

  it('throws at mount when a valueless (boolean) option is marked required', () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'badreq',
      description: 'boolean cannot be required',
      commonFlags: [],
      // A boolean option (no `value`) marked `required` is an authoring error:
      // only value options can be made mandatory. The mounter throws.
      options: [{ flag: '--force', description: 'force it', required: true }],
      scope: 'none',
      output: 'raw-stream',
      rawStreamReason: 'diagnostic-gate',
      handler: () => undefined,
    });

    expect(() => mountCommandSpec(program, spec, ctx)).toThrow(
      /only value options can be required/,
    );
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

  // Task 2: the dispatchOutput seam (used by mount for command-result / signal-envelope)
  // plus the ctx emits, all funnel through the same assemble/render for uniform CommandOutcome.
  it('command-result dispatch (used by emitCommandResult) participates in the one-outcome contract', async () => {
    const { ctx, rendered } = makeCtx();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'res',
      description: 'result cmd',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: () => ({ type: 'list' }),
    });
    mountCommandSpec(program, spec, ctx);
    // For the fake lean ctx here, command-result under --json still goes through
    // emitCommandResult which (in real) assembles via renderOutcome; we just
    // assert the dispatch arm and non-crash (the full uniform-shape contract is
    // pinned in assemble-outcome + render-outcome tests + e2e json-contract).
    await program.parseAsync(['res', '--json'], { from: 'user' });
    expect(rendered).toHaveLength(0); // json short-circuits render in the emit path
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
      rawStreamReason: 'file-export',
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

  it('routes a thrown typed ToolError through reportFailure', async () => {
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
    expect(ctx.reportFailure).toHaveBeenCalledWith({
      error: expect.any(ConfigurationError),
      jsonRequested: false,
    });
    expect(exitCodes).toEqual([2]);
  });

  it('passes jsonRequested when --json is set on a thrown ToolError', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'boom-json',
      description: 'throws json',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: () => {
        throw new ConfigurationError('bad json');
      },
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['boom-json', '--json'], { from: 'user' });
    expect(ctx.reportFailure).toHaveBeenCalledWith({
      error: expect.any(ConfigurationError),
      jsonRequested: true,
    });
  });

  it('treats reportFailure plus an undefined return as terminal output', async () => {
    const { ctx, rendered, exitCodes } = makeCtx();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'handled-failure',
      description: 'reports and returns',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: async (_opts, cli) => {
        await cli.reportFailure({
          message: 'handled failure',
          exitCode: 3,
          jsonRequested: false,
        });
      },
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['handled-failure'], { from: 'user' });
    expect(ctx.reportFailure).toHaveBeenCalledTimes(1);
    expect(exitCodes).toEqual([3]);
    expect(rendered).toEqual([]);
  });

  it('reports command-result handlers that return undefined without an explicit failure', async () => {
    const { ctx, rendered, exitCodes } = makeCtx();
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'undefined-result',
      description: 'returns undefined',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler: () => undefined as never,
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['undefined-result'], { from: 'user' });
    expect(ctx.reportFailure).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: 'SYSTEM.COMMAND_RESULT.UNDEFINED',
      }),
      jsonRequested: false,
    });
    expect(exitCodes).toEqual([1]);
    expect(rendered).toEqual([]);
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
      rawStreamReason: 'file-export',
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

    await expect(program.parseAsync(['envhost', '--json'], { from: 'user' })).rejects.toThrow(
      /no emitEnvelope/,
    );
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

    await expect(program.parseAsync(['livehost'], { from: 'user' })).rejects.toThrow(
      /no renderLive/,
    );
  });
});

// ---------------------------------------------------------------------------
// splitActionArgs fidelity (regression for defensive arg walking eating positionals)
// The splitter is internal, but its contract is observable through any spec that
// declares `args`. These tests exercise 0, 1, and N positionals (including variadic)
// mixed with common flags, ensuring _args is exactly the declared positionals and
// not corrupted by the opts/Command trailing pair.
// ---------------------------------------------------------------------------

describe('mountCommandSpec — positional args (_args) fidelity through splitActionArgs', () => {
  it('preserves zero positionals when none are supplied', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const received: { opts: Record<string, unknown>; positionals: unknown }[] = [];
    const spec: HostCommandSpec = defineCommand({
      name: 'nopos',
      description: 'no positionals',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: (opts) => {
        received.push({ opts, positionals: opts._args });
        return { type: 'help' } as const;
      },
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['nopos'], { from: 'user' });
    expect(received[0].positionals).toEqual([]);

    await program.parseAsync(['nopos', '--json'], { from: 'user' });
    expect(received[1].positionals).toEqual([]);
    expect(received[1].opts.json).toBe(true);
  });

  it('preserves a single positional and trailing common flags', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const received: { opts: Record<string, unknown>; positionals: unknown }[] = [];
    const spec: HostCommandSpec = defineCommand({
      name: 'onepos',
      description: 'one positional',
      commonFlags: ['cwd'],
      args: [{ name: 'target', optional: false, description: 'single target' }],
      scope: 'none',
      output: 'command-result',
      handler: (opts) => {
        received.push({ opts, positionals: opts._args });
        return { type: 'help' } as const;
      },
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['onepos', 'src/foo'], { from: 'user' });
    expect(received[0].positionals).toEqual(['src/foo']);
    // cwd is seeded by applyCommonFlags when the flag is declared
    expect(received[0].opts.cwd).toBeTruthy();

    await program.parseAsync(['onepos', 'src/bar', '--cwd', 'some/tmp/x'], {
      from: 'user',
    });
    expect(received[1].positionals).toEqual(['src/bar']);
    expect(received[1].opts.cwd).toBe('some/tmp/x');
  });

  it('preserves multiple (variadic) positionals without eating them into opts', async () => {
    const { ctx } = makeCtx();
    const program = new Command();
    const received: { opts: Record<string, unknown>; positionals: unknown }[] = [];
    const spec: HostCommandSpec = defineCommand({
      name: 'multipos',
      description: 'variadic positionals',
      commonFlags: ['json'],
      args: [
        {
          name: 'paths',
          variadic: true,
          optional: true,
          description: 'paths...',
        },
      ],
      scope: 'none',
      output: 'command-result',
      handler: (opts) => {
        received.push({ opts, positionals: opts._args });
        return { type: 'help' } as const;
      },
    });
    mountCommandSpec(program, spec, ctx);

    await program.parseAsync(['multipos', 'a', 'b', 'c'], { from: 'user' });
    // Variadic positionals surface via _args as an array containing the variadic list
    expect(received[0].positionals).toEqual([['a', 'b', 'c']]);

    await program.parseAsync(['multipos', 'x', '--json', 'y'], {
      from: 'user',
    });
    // --json is a flag, not a positional; the two real positionals (for the variadic) survive.
    // Current _args delivery for the variadic collects them as a nested array in this handler context.
    expect(received[1].positionals).toEqual([['x', 'y']]);
    expect(received[1].opts.json).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Host run-lifecycle hooks (host-owned-run-timing Phase 8). The mount dispatch
// reads beginRun/completeRun from the host hooks parameter (RunActionHooks). These prove
// the wiring the run-plane unit tests exercise in isolation actually fires
// through the real command action, in the right order, exactly once.
// ---------------------------------------------------------------------------

/** Silent logger for the integration run plane (no warn/info spam). */
const SILENT_LOG: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('mountCommandSpec — host run-lifecycle hooks', () => {
  it('calls beginRun before the handler and completeRun(result) after — exactly once each, in order', async () => {
    const { ctx } = makeCtx();
    const order: string[] = [];
    const beginRun = vi.fn(() => order.push('beginRun'));
    const completeRun = vi.fn(() => order.push('completeRun'));
    const result = { type: 'help' as const };
    const handler = vi.fn(() => {
      order.push('handler');
      return result;
    });
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'lc',
      description: 'lifecycle',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler,
    });
    mountCommandSpec(program, spec, ctx, { beginRun, completeRun });

    await program.parseAsync(['lc'], { from: 'user' });

    expect(beginRun).toHaveBeenCalledOnce();
    expect(completeRun).toHaveBeenCalledOnce();
    expect(order).toEqual(['beginRun', 'handler', 'completeRun']);
    // completeRun receives the handler's return value (so it can read .session).
    expect(completeRun).toHaveBeenCalledWith(result);
  });

  it('calls beginRun once but NOT completeRun when the handler throws a ToolError', async () => {
    const { ctx, exitCodes } = makeCtx();
    const beginRun = vi.fn();
    const completeRun = vi.fn();
    const handler = vi.fn(() => {
      throw new ConfigurationError('bad', { code: 'CONFIGURATION_ERROR' });
    });
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'boom',
      description: 'boom',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler,
    });
    mountCommandSpec(program, spec, ctx, { beginRun, completeRun });

    await program.parseAsync(['boom'], { from: 'user' });

    expect(beginRun).toHaveBeenCalledOnce();
    expect(completeRun).not.toHaveBeenCalled(); // handler threw before the completeRun line
    expect(exitCodes.length).toBeGreaterThan(0); // ToolError → mapped non-zero exit
  });
});

describe('mountCommandSpec — dispatch persists a returned contribution through the host run plane', () => {
  let datastore: DataStore;
  afterEach(() => {
    datastore?.close();
  });

  /** Build a ctx + hooks whose run seam is backed by a REAL run plane. */
  function ctxWithRealRunPlane(ds: DataStore): {
    ctx: ToolCliContext;
    hooks: ReturnType<typeof createRunActionHooks>;
  } {
    const factory = createRunPlaneFactory({
      getDatastore: () => ds,
      logger: SILENT_LOG,
    });
    return {
      ctx: Object.assign({}, makeCtx().ctx, {
        runSession: createRunSessionSeam(factory),
      }),
      hooks: createRunActionHooks(factory),
    };
  }

  it('writes exactly one host-stamped StoredSession (+ persistMs) for a returned ToolRunCompletion', async () => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    const { ctx, hooks } = ctxWithRealRunPlane(datastore);
    const handler = vi.fn(() => ({
      session: {
        tool: 'fit',
        cwd: '/proj',
        recipe: 'example',
        score: 88,
        passed: true,
        payload: { x: 1 },
      },
    }));
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'persisted',
      description: 'persists a session',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler,
    });
    mountCommandSpec(program, spec, ctx, hooks);

    await program.parseAsync(['persisted'], { from: 'user' });

    const rows = new SessionRepo(datastore).list();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.tool).toBe('fit');
    expect(row?.recipe).toBe('example');
    expect(row?.score).toBe(88);
    expect(row?.passed).toBe(true);
    // Timing is HOST-stamped (the tool supplied none).
    expect(typeof row?.startedAt).toBe('string');
    expect(typeof row?.completedAt).toBe('string');
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    // Sibling host-metrics row hydrated onto the session.
    expect(row?.hostMetrics?.persistMs).toBeGreaterThanOrEqual(0);
    // Tool payload round-trips opaquely.
    expect(row?.payload).toEqual({ x: 1 });
  });

  it('persists no row when the handler returns a plain CommandResult (no session)', async () => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    const { ctx, hooks } = ctxWithRealRunPlane(datastore);
    const handler = vi.fn(() => ({ type: 'help' as const }));
    const program = new Command();
    const spec: HostCommandSpec = defineCommand({
      name: 'nopersist',
      description: 'no session',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler,
    });
    mountCommandSpec(program, spec, ctx, hooks);

    await program.parseAsync(['nopersist'], { from: 'user' });

    expect(new SessionRepo(datastore).list()).toHaveLength(0);
  });
});
