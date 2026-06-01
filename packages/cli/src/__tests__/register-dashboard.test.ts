/**
 * Coverage for register-dashboard's Commander wiring AND its action body.
 *
 * register-commands.test.ts deliberately never runs action bodies; here we
 * drive the `dashboard` action through `parseAsync` so the
 * `composeAndWriteDashboard({ open })` delegation (and the `--no-open` /
 * `--json` open-suppression logic) is exercised. `composeAndWriteDashboard`
 * is mocked so the test neither writes files nor launches a browser.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const composeAndWriteDashboard = vi.fn();

vi.mock('../dashboard-compose.js', () => ({ composeAndWriteDashboard }));

beforeEach(() => {
  composeAndWriteDashboard.mockReset();
  composeAndWriteDashboard.mockResolvedValue({
    type: 'dashboard',
    path: 'reports/latest.html',
    opened: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCtx() {
  const rendered: unknown[] = [];
  return {
    ctx: {
      setExitCode: () => undefined,
      render: (r: unknown) => {
        rendered.push(r);
        return Promise.resolve();
      },
    } as never,
    rendered,
  };
}

describe('registerDashboard', () => {
  it('mounts `dashboard` with --no-open and --json flags', async () => {
    const { registerDashboard } = await import('../commands/register-dashboard.js');
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerDashboard(program, ctx);
    const cmd = program.commands.find((c) => c.name() === 'dashboard');
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--no-open', '--json']));
  });

  it('composes with open=true by default and renders the result', async () => {
    const { registerDashboard } = await import('../commands/register-dashboard.js');
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerDashboard(program, ctx);

    await program.parseAsync(['node', 'cli', 'dashboard']);

    expect(composeAndWriteDashboard).toHaveBeenCalledWith({ open: true });
    expect(rendered).toHaveLength(1);
  });

  it('suppresses browser-open when --no-open is passed', async () => {
    const { registerDashboard } = await import('../commands/register-dashboard.js');
    const program = new Command('opensip-tools');
    const { ctx } = makeCtx();
    registerDashboard(program, ctx);

    await program.parseAsync(['node', 'cli', 'dashboard', '--no-open']);

    expect(composeAndWriteDashboard).toHaveBeenCalledWith({ open: false });
  });

  it('never opens a browser in --json mode and writes JSON to stdout instead of rendering', async () => {
    const { registerDashboard } = await import('../commands/register-dashboard.js');
    const program = new Command('opensip-tools');
    const { ctx, rendered } = makeCtx();
    registerDashboard(program, ctx);

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await program.parseAsync(['node', 'cli', 'dashboard', '--json']);
    } finally {
      spy.mockRestore();
    }

    // open = opts.open(true) && !opts.json(true) ⇒ false.
    expect(composeAndWriteDashboard).toHaveBeenCalledWith({ open: false });
    expect(out.join('')).toContain('"type": "dashboard"');
    expect(rendered).toHaveLength(0);
  });
});
