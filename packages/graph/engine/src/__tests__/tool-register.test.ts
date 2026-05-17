/**
 * Tests for the Commander wiring inside graphTool.register().
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { graphTool } from '../tool.js';

import type { ToolCliContext } from '@opensip-tools/core';

function makeCli(program: Command): ToolCliContext {
  return {
    program,
    render: vi.fn(() => Promise.resolve()),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    setExitCode: vi.fn(),
  };
}

describe('graphTool.register', () => {
  it('mounts a `graph` subcommand on the supplied Commander program', () => {
    const program = new Command();
    program.exitOverride();
    graphTool.register(makeCli(program));
    const sub = program.commands.find((c) => c.name() === 'graph');
    expect(sub).toBeDefined();
    expect(sub?.description()).toContain('static call-graph');
  });

  it('registers the documented option set on the graph subcommand', () => {
    const program = new Command();
    program.exitOverride();
    graphTool.register(makeCli(program));
    const sub = program.commands.find((c) => c.name() === 'graph');
    const flags = sub?.options.map((o) => o.long) ?? [];
    expect(flags).toContain('--cwd');
    expect(flags).toContain('--json');
    expect(flags).toContain('--no-cache');
    expect(flags).toContain('--gate-save');
    expect(flags).toContain('--gate-compare');
    expect(flags).toContain('--baseline');
    expect(flags).toContain('--report-to');
    expect(flags).toContain('--debug');
  });

  it('action calls the registered handler with the parsed options (smoke)', async () => {
    // Wire a fake program; intercept the action so we capture it without
    // actually running the pipeline (which requires a real fixture).
    const program = new Command();
    program.exitOverride();
    graphTool.register(makeCli(program));
    const sub = program.commands.find((c) => c.name() === 'graph');
    expect(sub).toBeDefined();
    const spy = vi.fn();
    if (sub) {
      sub.action((opts: unknown) => {
        spy(opts);
      });
      await sub.parseAsync(['--cwd', '/tmp', '--json'], { from: 'user' });
      expect(spy).toHaveBeenCalledOnce();
      const opts = spy.mock.calls[0]?.[0] as { cwd: string; json: boolean };
      expect(opts.cwd).toBe('/tmp');
      expect(opts.json).toBe(true);
    }
  });
});
