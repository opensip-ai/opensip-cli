/**
 * Integration tests for graph's command surface against the real TypeScript
 * adapter.
 *
 * Since release 2.11.0 Phase 5 graph mounts via declarative `commandSpecs`, not
 * the deprecated `register()` hook. The Commander parsing layer (flag wiring,
 * `_args` positionals, choices/required enforcement) is unit-covered in
 * `cli/src/__tests__/mount-command-spec.test.ts`; here we drive the primary
 * `graph` spec's handler directly (exactly what the host invokes post-parse)
 * with the real typescript adapter registered, so the executeGraph / renderLive
 * pipeline runs end-to-end. Positionals ride on the parsed-opts object under the
 * `_args` key (the host convention); graph's sole variadic `[paths...]` is
 * `_args[0]`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, RunScope } from '@opensip-cli/core';
import { currentAdapterRegistry, graphTool } from '@opensip-cli/graph';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import type { CommandHandler, CommandSpec, ToolCliContext } from '@opensip-cli/core';

/** Resolve a graph command-spec by name (the host mounts these). */
function graphSpec(name: string): CommandSpec<unknown, ToolCliContext> {
  const spec = (graphTool.commandSpecs ?? []).find((s) => s.name === name);
  if (spec === undefined) throw new Error(`graphTool exposes no command spec '${name}'`);
  return spec;
}

/** The primary `graph` command handler (host invokes `handler(opts, ctx)`). */
function graphHandler(): CommandHandler<unknown, ToolCliContext> {
  return graphSpec('graph').handler;
}

beforeEach(() => {
  // Item 1: graph registries are per-RunScope. Construct a scope with the graph
  // subscope and register the typescript adapter into it so the handler reaches
  // pickAdapter() through a live scope.
  const scope = new RunScope();
  Object.assign(scope, graphTool.contributeScope?.() ?? {});
  enterScope(scope);
  currentAdapterRegistry().register(typescriptGraphAdapter);
});

function makeCli(overrides: Partial<ToolCliContext> = {}): ToolCliContext {
  const project = {
    cwd: '/test',
    cwdExplicit: false,
    projectRoot: '/test',
    configPath: undefined,
    walkedUp: 0,
    scope: 'none' as const,
  };
  return {
    scope: new RunScope({ projectContext: project }),
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve({ cloudAccepted: 0 })),
    writeSarif: vi.fn(() => Promise.resolve()),
    saveBaseline: vi.fn(() => Promise.resolve()),
    compareBaseline: vi.fn(() =>
      Promise.resolve({ added: [], resolved: [], unchanged: [], degraded: false }),
    ),
    exportBaselineSarif: vi.fn(() => Promise.resolve()),
    exportBaselineFingerprints: vi.fn(() => Promise.resolve()),
    toolState: {
      get: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    },
    runSession: {
      timing: {
        startedAt: new Date().toISOString(),
        startedAtEpochMs: Date.now(),
        elapsedMs: () => 0,
        snapshot: () => ({ startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0 }),
      },
      record: () => undefined,
    },
    ...overrides,
  };
}

describe('graph command spec', () => {
  it('declares a `graph` command described as static call-graph analysis', () => {
    const spec = graphSpec('graph');
    expect(spec.name).toBe('graph');
    expect(spec.description).toContain('static call-graph');
    // The handler owns its full output surface (TTY-vs-static + egress).
    expect(spec.output).toBe('raw-stream');
  });

  it('declares the documented option set on the graph command', () => {
    const spec = graphSpec('graph');
    // Common flags from the ADR-0021 registry (the CommonFlagKey form).
    expect([...spec.commonFlags]).toEqual(
      expect.arrayContaining(['cwd', 'json', 'reportTo', 'debug']),
    );
    // Tool-specific options.
    const optionFlags = (spec.options ?? []).map((o) => o.flag);
    expect(optionFlags).toContain('--no-cache');
    expect(optionFlags).toContain('--gate-save');
    expect(optionFlags).toContain('--gate-compare');
    // --baseline was removed (audit P1.2): it was mounted + documented but had
    // zero readers. Guard against re-adding a vestigial no-op flag.
    expect(optionFlags).not.toContain('--baseline');
  });

  it('--concurrency parses as a number via the declared parse reducer', () => {
    const spec = graphSpec('graph');
    const concurrency = (spec.options ?? []).find((o) => o.flag === '--concurrency');
    expect(concurrency?.parse).toBeTypeOf('function');
    expect(concurrency?.parse?.('4', undefined)).toBe(4);
  });
});

describe('graph handler — end-to-end via the real typescript adapter', () => {
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
      const setExitCode = vi.fn();
      const cli = makeCli({
        setExitCode,
        // Mirror the composition root's `emitEnvelope` seam (JSON to stdout).
        emitError: vi.fn(),
        emitEnvelope: vi.fn((envelope: unknown) => {
          process.stdout.write(`${JSON.stringify(envelope)}\n`);
        }),
      });
      try {
        // With a positional path, the heap preflight is skipped — important
        // because preflight could re-exec the test process. The variadic
        // positional rides on `_args[0]`.
        await graphHandler()({ cwd: dir, json: true, _args: [[dir]] }, cli);
      } finally {
        stdoutSpy.mockRestore();
      }
      const parsed = JSON.parse(stdout) as { tool: string; schemaVersion: number };
      expect(parsed.tool).toBe('graph');
      expect(parsed.schemaVersion).toBe(2);
      expect(setExitCode).toHaveBeenCalledWith(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('interactive --exact path delegates to cli.renderLive', async () => {
    // The Ink live view drives the EXACT engine, so it is eligible only under
    // `--exact` on a TTY (ADR-0032: sharded is the default and routes to the
    // static path). The fixture is tiny so heap preflight no-ops (file count
    // < 1000).
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

      const renderLive = vi.fn(() => Promise.resolve());
      const cli = makeCli({ renderLive });
      // --exact (the live view drives the exact engine), no
      // --json/--gate-*/--report-to/positional: this is the interactive live
      // path, which delegates to renderLive — but only on a TTY (a non-TTY run
      // falls back to the static render seam). vitest's stdout is not a TTY, so
      // force it for this assertion.
      const prevTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      try {
        await graphHandler()({ cwd: dir, exact: true, _args: [[]] }, cli);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
      }
      expect(renderLive).toHaveBeenCalledOnce();
      expect(renderLive).toHaveBeenCalledWith('graph', expect.objectContaining({ cwd: dir }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
