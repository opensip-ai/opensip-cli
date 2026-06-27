/**
 * Tests for the `mountResultCommand` helper. Confirms:
 *
 *   - the handler runs and the result is rendered via the supplied
 *     context's `render` callback
 *   - `--json` short-circuits Ink and emits structured JSON to stdout
 *   - `mountResultCommandWithArg` plumbs the positional argument through
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { mountResultCommand, mountResultCommandWithArg } from '../commands/mount-result-command.js';

import type { CliCommandsContext } from '../commands/index.js';
import type { CommandResult } from '@opensip-cli/contracts';

function makeCtx(): {
  ctx: CliCommandsContext;
  rendered: CommandResult[];
} {
  const rendered: CommandResult[] = [];
  const ctx: CliCommandsContext = {
    setExitCode: vi.fn(),
    render: vi.fn((result: CommandResult) => {
      rendered.push(result);
      return Promise.resolve();
    }),
  };
  return { ctx, rendered };
}

describe('mountResultCommand', () => {
  it('runs the handler and renders the result via ctx.render', async () => {
    const { ctx, rendered } = makeCtx();
    const cmd = new Command('demo').option('--json', 'json', false);
    mountResultCommand<{ json: boolean }>(cmd, () => ({ type: 'help' }), {
      ctx,
      jsonFlag: (opts) => opts.json,
    });

    await cmd.parseAsync([], { from: 'user' });
    expect(rendered).toEqual([{ type: 'help' }]);
  });

  it('bypasses ctx.render and emits JSON when --json is set', async () => {
    const { ctx, rendered } = makeCtx();
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    });

    const cmd = new Command('demo').option('--json', 'json', false);
    mountResultCommand<{ json: boolean }>(cmd, () => ({ type: 'help' }), {
      ctx,
      jsonFlag: (opts) => opts.json,
    });

    await cmd.parseAsync(['--json'], { from: 'user' });

    expect(rendered).toEqual([]);
    expect(ctx.render).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('"type": "help"');
    stdoutSpy.mockRestore();
  });

  it('awaits async handlers before rendering', async () => {
    const { ctx, rendered } = makeCtx();
    const cmd = new Command('demo').option('--json', 'json', false);
    mountResultCommand<{ json: boolean }>(
      cmd,
      () => Promise.resolve<CommandResult>({ type: 'help' }),
      { ctx, jsonFlag: (opts) => opts.json },
    );

    await cmd.parseAsync([], { from: 'user' });
    expect(rendered).toHaveLength(1);
  });
});

describe('mountResultCommandWithArg', () => {
  it('forwards the positional argument and the parsed opts to the handler', async () => {
    const { ctx } = makeCtx();
    const cmd = new Command('demo')
      .argument('<name>')
      .option('--flag <v>')
      .option('--json', 'json', false);

    const handler = vi.fn(
      (_arg: string, _opts: { flag?: string; json: boolean }): CommandResult => ({
        type: 'help',
      }),
    );

    mountResultCommandWithArg<string, { flag?: string; json: boolean }>(cmd, handler, {
      ctx,
      jsonFlag: (opts) => opts.json,
    });

    await cmd.parseAsync(['pkg-a', '--flag', 'v1'], { from: 'user' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toBe('pkg-a');
    expect(handler.mock.calls[0]?.[1]).toMatchObject({
      flag: 'v1',
      json: false,
    });
  });
});
