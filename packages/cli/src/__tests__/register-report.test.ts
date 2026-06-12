/**
 * Coverage for the `report` host command spec's wiring AND its action body
 * (release 2.11.0 Phase 6 — `host-command-specs.ts`).
 *
 * `register-commands.test.ts` deliberately never runs action bodies; here we
 * drive the `report` action through `parseAsync` so the
 * `composeAndWriteReport({ open })` delegation (and the `--no-open` /
 * `--json` open-suppression logic) is exercised. `composeAndWriteReport`
 * is mocked so the test neither writes files nor launches a browser.
 */

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const composeAndWriteReport = vi.fn();

vi.mock('../report-compose.js', () => ({ composeAndWriteReport }));

beforeEach(() => {
  composeAndWriteReport.mockReset();
  composeAndWriteReport.mockResolvedValue({
    type: 'report',
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
      pluginLayouts: [],
      datastore: () => undefined,
    } as never,
    rendered,
  };
}

async function mount(ctx: never): Promise<Command> {
  const { mountHostCommands } = await import('../commands/host-command-specs.js');
  const program = new Command('opensip');
  mountHostCommands(program, ctx);
  return program;
}

describe('report spec', () => {
  it('mounts `report` with --no-open and --json flags', async () => {
    const { ctx } = makeCtx();
    const program = await mount(ctx);
    const cmd = program.commands.find((c) => c.name() === 'report');
    expect(cmd).toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--no-open', '--json']));
  });

  it('composes with open=true by default and renders the result', async () => {
    const { ctx, rendered } = makeCtx();
    const program = await mount(ctx);

    await program.parseAsync(['node', 'cli', 'report']);

    expect(composeAndWriteReport).toHaveBeenCalledWith({ open: true });
    expect(rendered).toHaveLength(1);
  });

  it('suppresses browser-open when --no-open is passed', async () => {
    const { ctx } = makeCtx();
    const program = await mount(ctx);

    await program.parseAsync(['node', 'cli', 'report', '--no-open']);

    expect(composeAndWriteReport).toHaveBeenCalledWith({ open: false });
  });

  it('never opens a browser in --json mode and writes JSON to stdout instead of rendering', async () => {
    const { ctx, rendered } = makeCtx();
    const program = await mount(ctx);

    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      await program.parseAsync(['node', 'cli', 'report', '--json']);
    } finally {
      spy.mockRestore();
    }

    // open = opts.open(true) && !opts.json(true) ⇒ false.
    expect(composeAndWriteReport).toHaveBeenCalledWith({ open: false });
    expect(out.join('')).toContain('"type": "report"');
    expect(rendered).toHaveLength(0);
  });
});
