/**
 * Tests for the Commander wiring inside graphTool.register().
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, RunScope } from '@opensip-tools/core';
import { currentAdapterRegistry, graphTool } from '@opensip-tools/graph';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';


import { typescriptGraphAdapter } from '../index.js';

import type { ToolCliContext } from '@opensip-tools/core';

beforeEach(() => {
  // Item 1: graph registries are per-RunScope. Construct a scope with
  // graph subscope and register the typescript adapter into it so the
  // graphTool.register() tests reach pickAdapter() through a live
  // scope.
  const scope = new RunScope();
  Object.assign(scope, graphTool.contributeScope?.() ?? {});
  enterScope(scope);
  currentAdapterRegistry().register(typescriptGraphAdapter);
});

function makeCli(program: Command): ToolCliContext {
  // Layer 5 Phase 3 (audit 2026-05-23 F3): tools own their renderers.
  // The graph tool registers `renderGraphLive` directly via
  // `cli.registerLiveView` — no `builtinLiveViews` map lookup.
  const project = {
    cwd: '/test',
    cwdExplicit: false,
    projectRoot: '/test',
    configPath: undefined,
    walkedUp: 0,
    scope: 'none' as const,
  };
  return {
    program,
    scope: new RunScope({ projectContext: project }),
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
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
    expect(flags).toContain('--report-to');
    expect(flags).toContain('--debug');
    // --baseline was removed (audit P1.2): it was mounted + documented but had
    // zero readers (runGateMode is datastore-backed). Guard against re-adding
    // a vestigial no-op flag.
    expect(flags).not.toContain('--baseline');
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
      // Commander passes (positionalPaths, opts, command) to the
      // action callback now that `.argument('[paths...]')` is declared.
      sub.action((paths: readonly string[], opts: unknown) => {
        spy(paths, opts);
      });
      await sub.parseAsync(['--cwd', '/tmp', '--json'], { from: 'user' });
      expect(spy).toHaveBeenCalledOnce();
      const call = spy.mock.calls[0] as [readonly string[], { cwd: string; json: boolean }];
      expect(call[0]).toEqual([]);
      expect(call[1].cwd).toBe('/tmp');
      expect(call[1].json).toBe(true);
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
      const project = {
        cwd: '/test',
        cwdExplicit: false,
        projectRoot: '/test',
        configPath: undefined,
        walkedUp: 0,
        scope: 'none' as const,
      };
      const cli: ToolCliContext = {
        program,
        scope: new RunScope({ projectContext: project }),
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
        emitEnvelope: vi.fn(),
        deliverSignals: vi.fn(() => Promise.resolve()),
        registerLiveView: vi.fn(),
      };
      graphTool.register(cli);
      try {
        // With a positional path, the heap preflight is skipped —
        // important because preflight could re-exec the test process.
        await program.parseAsync(['graph', '--cwd', dir, '--json', dir], { from: 'user' });
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
      const project2 = {
        cwd: '/test',
        cwdExplicit: false,
        projectRoot: '/test',
        configPath: undefined,
        walkedUp: 0,
        scope: 'none' as const,
      };
      const cli: ToolCliContext = {
        program,
        scope: new RunScope({ projectContext: project2 }),
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
        emitEnvelope: vi.fn(),
        deliverSignals: vi.fn(() => Promise.resolve()),
        registerLiveView: vi.fn(),
      };
      graphTool.register(cli);
      // No --json/--gate-*/--report-to/--package: this is the interactive
      // default path, which delegates to renderLive — but only on a TTY (a
      // non-TTY run falls back to the static render seam). vitest's stdout is
      // not a TTY, so force it for this assertion.
      const prevTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      try {
        await program.parseAsync(['graph', '--cwd', dir], { from: 'user' });
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      }
      expect(renderLive).toHaveBeenCalledOnce();
      expect(renderLive).toHaveBeenCalledWith('graph', expect.objectContaining({ cwd: dir }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--concurrency parses as a number', async () => {
    // Exercise the parse function for --concurrency.
    const program = new Command();
    program.exitOverride();
    graphTool.register(makeCli(program));
    const sub = program.commands.find((c) => c.name() === 'graph');
    expect(sub).toBeDefined();
    const spy = vi.fn();
    if (sub) {
      sub.action((paths: readonly string[], opts: unknown) => {
        spy(paths, opts);
      });
      await sub.parseAsync(['--cwd', '/tmp', '--concurrency', '4'], { from: 'user' });
      const call = spy.mock.calls[0] as [readonly string[], { concurrency: number }];
      expect(call[1].concurrency).toBe(4);
    }
  });
});
