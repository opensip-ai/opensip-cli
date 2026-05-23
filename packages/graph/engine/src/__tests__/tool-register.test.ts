/**
 * Tests for the Commander wiring inside graphTool.register().
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { graphTool } from '../tool.js';

import type { ToolCliContext } from '@opensip-tools/core';

function makeCli(program: Command): ToolCliContext {
  // Provide a renderer for `graph` in `builtinLiveViews`. The tool's
  // `register()` hard-fails when no renderer is found for its tool id
  // (Audit 2026-05-23 N-1).
  const stubRenderer = vi.fn(() => Promise.resolve());
  return {
    program,
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    builtinLiveViews: new Map([[graphTool.metadata.id, stubRenderer]]),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    datastore: undefined,
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

describe('graphTool action handler — end-to-end via Commander', () => {
  // The default handler isn't replaced; we hit the actual path that
  // calls executeGraph (or renderLive for the interactive default).
  // Use a tiny TS fixture so the run completes quickly.

  it('runs --json against a real fixture and exits with code 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'graph-tool-action-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'Node16',
            moduleResolution: 'Node16',
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            rootDir: '.',
          },
          include: ['**/*.ts'],
        }),
        'utf8',
      );
      writeFileSync(join(dir, 'index.ts'), `export function x(): number { return 1; }\n`, 'utf8');

      // Capture stdout so we don't pollute test output.
      let stdout = '';
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdout += typeof chunk === 'string' ? chunk : String(chunk);
        return true;
      });

      const program = new Command();
      program.exitOverride();
      const setExitCode = vi.fn();
      const cli: ToolCliContext = {
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
        setExitCode,
        emitJson: vi.fn(),
        registerLiveView: vi.fn(),
        builtinLiveViews: new Map([[graphTool.metadata.id, (() => Promise.resolve()) as never]]),
        datastore: undefined,
      };
      graphTool.register(cli);
      try {
        // With --package set, the heap preflight is skipped — important
        // because preflight could re-exec the test process.
        await program.parseAsync(['graph', '--cwd', dir, '--json', '--package', dir], { from: 'user' });
      } finally {
        stdoutSpy.mockRestore();
      }
      const parsed = JSON.parse(stdout) as { tool: string };
      expect(parsed.tool).toBe('graph');
      expect(setExitCode).toHaveBeenCalledWith(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('interactive default path delegates to cli.renderLive', async () => {
    // Default mode (no other flags) calls cli.renderLive. The fixture
    // is tiny so the heap preflight no-ops (file count < 1000).
    const dir = mkdtempSync(join(tmpdir(), 'graph-tool-action-live-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'Node16' },
          include: ['**/*.ts'],
        }),
        'utf8',
      );
      writeFileSync(join(dir, 'index.ts'), 'export function x(): number { return 1; }\n', 'utf8');

      const program = new Command();
      program.exitOverride();
      const renderLive = vi.fn(() => Promise.resolve());
      const cli: ToolCliContext = {
        program,
        render: vi.fn(() => Promise.resolve()),
        renderLive,
        maybeOpenDashboard: vi.fn(() => Promise.resolve()),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        setExitCode: vi.fn(),
        emitJson: vi.fn(),
        registerLiveView: vi.fn(),
        builtinLiveViews: new Map([[graphTool.metadata.id, (() => Promise.resolve()) as never]]),
        datastore: undefined,
      };
      graphTool.register(cli);
      // No --json/--gate-*/--report-to/--package: this is the
      // interactive default path, which delegates to renderLive.
      await program.parseAsync(['graph', '--cwd', dir], { from: 'user' });
      expect(renderLive).toHaveBeenCalledOnce();
      expect(renderLive).toHaveBeenCalledWith('graph', expect.objectContaining({ cwd: dir }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--packages-concurrency parses as a number', async () => {
    // Exercise the parse function for --packages-concurrency.
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
      await sub.parseAsync(['--cwd', '/tmp', '--packages-concurrency', '4'], { from: 'user' });
      const opts = spy.mock.calls[0]?.[0] as { packagesConcurrency: number };
      expect(opts.packagesConcurrency).toBe(4);
    }
  });
});
