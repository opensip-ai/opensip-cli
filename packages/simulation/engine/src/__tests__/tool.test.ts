/**
 * @fileoverview Smoke tests for simulationTool — the Tool plugin
 * descriptor wired into the CLI dispatcher.
 *
 * Since release 2.11.0 Phase 3 (the reference migration) sim mounts via a
 * declarative `CommandSpec` (`simulationTool.commandSpecs`) rather than the
 * deprecated `register()` hook. The host-owned mount path
 * (`mountCommandSpec` → parse → handler → dispatch) is covered in
 * `cli/src/__tests__/mount-command-spec.test.ts`; this file exercises the
 * descriptor metadata, the declared command surface, and the command
 * handler directly with a fake ToolCliContext (the handler is what the host
 * invokes after parsing).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enterScope, RunScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { clearScenarioRegistry, currentScenarioRegistry } from '../framework/registry.js';
import { defineLoadScenario } from '../kinds/load/define.js';
import { simulationTool } from '../tool.js';

import { noopTarget } from './test-utils/targets.js';

import type { CommandSpec, ToolCliContext } from '@opensip-cli/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(resolve(HERE, '../../package.json'), 'utf8')) as {
  version: string;
};

beforeEach(() => {
  // Item 1: scenarioRegistry and recipe registry are per-RunScope.
  // Construct a fresh scope (with simulation extended) and enter it via
  // AsyncLocalStorage so the handler resolves them through currentScope()
  // while it runs.
  const scope = new RunScope();
  Object.assign(scope, simulationTool.contributeScope?.() ?? {});
  enterScope(scope);
});

afterEach(() => {
  clearScenarioRegistry();
});

/** The single declarative `sim` command sim now exports. */
function simSpec(): CommandSpec<unknown, ToolCliContext> {
  const spec = simulationTool.commandSpecs?.[0];
  if (spec === undefined) throw new Error('simulationTool exposes no commandSpecs');
  return spec;
}

function makeFakeContext(): {
  ctx: ToolCliContext;
  rendered: unknown[];
  exitCodes: number[];
  emitted: unknown[];
} {
  const rendered: unknown[] = [];
  const exitCodes: number[] = [];
  const emitted: unknown[] = [];
  const project = {
    cwd: '/test',
    cwdExplicit: false,
    projectRoot: '/test',
    configPath: undefined,
    walkedUp: 0,
    scope: 'none' as const,
  };
  // The handler uses currentScope() (set by enterScope in beforeEach), not
  // cli.scope, but ToolCliContext requires a scope value; mirror project
  // into a throwaway scope here.
  const ctxScope = new RunScope({ projectContext: project });
  Object.assign(ctxScope, simulationTool.contributeScope?.() ?? {});
  const ctx: ToolCliContext = {
    scope: ctxScope,
    render: vi.fn((result: unknown) => {
      rendered.push(result);
      return Promise.resolve();
    }),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    setExitCode: (code: number) => {
      exitCodes.push(code);
    },
    emitJson: (value: unknown) => {
      emitted.push(value);
    },
    emitRaw: (value: unknown) => {
      emitted.push(value);
    },
    emitEnvelope: (value: unknown) => {
      emitted.push(value);
    },
    emitError: (detail: { message: string; exitCode: number; suggestion?: string }) => {
      exitCodes.push(detail.exitCode);
      emitted.push(detail);
    },
    deliverSignals: () => Promise.resolve({ cloudAccepted: 0 }),
    writeSarif: () => Promise.resolve(),
    saveBaseline: () => Promise.resolve(),
    compareBaseline: () =>
      Promise.resolve({ added: [], resolved: [], unchanged: [], degraded: false }),
    exportBaselineSarif: () => Promise.resolve(),
    exportBaselineFingerprints: () => Promise.resolve(),
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
        snapshot: () => ({
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        }),
      },
      record: () => undefined,
    },
  };
  return { ctx, rendered, exitCodes, emitted };
}

/**
 * Register one trivial load scenario into the current scope's registry so a
 * `sim` run has work to do. Since the zero-scenario fail-closed guard (audit
 * P1c), a run with an empty registry returns an ErrorResult (exit 2) rather
 * than a sim-done pass — happy-path tests must supply at least one scenario.
 */
function registerProbeScenario(): void {
  currentScenarioRegistry().register(
    defineLoadScenario({
      id: 'probe',
      name: 'probe',
      description: 'probe',
      tags: [],
      target: noopTarget,
      workload: { rps: 1 },
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }),
  );
}

describe('simulationTool metadata', () => {
  it('exposes name (human), id (stable UUID), version, description', () => {
    expect(simulationTool.metadata.name).toBe('simulation');
    expect(simulationTool.metadata.id).toBe('715d32c2-692c-4ed4-985b-a35deaf186aa');
    expect(simulationTool.metadata.version).toBe(PKG.version);
    expect(simulationTool.metadata.description).toContain('simulation');
  });

  it('declares the user-facing sim subcommand (+ the internal worker)', () => {
    const names = simulationTool.commands.map((c) => c.name);
    expect(names).toContain('sim');
    // The internal off-main-process worker (ADR-0028), forked by the live view.
    expect(names).toContain('sim-run-worker');
    expect(simulationTool.commands).toHaveLength(2);
  });
});

describe('simulationTool command surface (Phase 3 — CommandSpec migration)', () => {
  it('mounts via commandSpecs — the one command surface (register() removed in 3.0.0)', () => {
    // `sim` + the internal `sim-run-worker` (ADR-0028).
    expect(simulationTool.commandSpecs).toHaveLength(2);
    // `register` is no longer a Tool member (3.0.0) — its absence is structural,
    // enforced by the type system, not asserted at runtime.
  });

  it('declares the sim command name/description/output/scope', () => {
    const spec = simSpec();
    expect(spec.name).toBe('sim');
    expect(spec.description).toBe('Run simulation scenarios');
    // The handler owns its full output surface (TTY-vs-static branch + egress).
    expect(spec.output).toBe('raw-stream');
    expect(spec.scope).toBe('project');
    expect(typeof spec.handler).toBe('function');
  });

  it('declares the ADR-0021 common flags and the --recipe option', () => {
    const spec = simSpec();
    // Cross-tool flags from the single registry (ADR-0021).
    expect([...spec.commonFlags]).toEqual(
      expect.arrayContaining([
        'cwd',
        'json',
        'quiet',
        'verbose',
        'debug',
        'reportTo',
        'apiKey',
        'open',
      ]),
    );
    const optionFlags = (spec.options ?? []).map((o) => o.flag);
    expect(optionFlags).toContain('--recipe');
    const recipe = (spec.options ?? []).find((o) => o.flag === '--recipe');
    expect(recipe?.value).toBe('<name>');
  });
});

describe('sim command handler', () => {
  it('runs against the default recipe and renders the result', async () => {
    const { ctx, rendered } = makeFakeContext();
    registerProbeScenario();

    // Non-TTY/non-json path: the handler runs the engine and renders statically.
    await simSpec().handler({ cwd: process.cwd() }, ctx);

    expect(rendered).toHaveLength(1);
    const result = rendered[0] as { type: string; recipeName?: string };
    expect(result.type).toBe('sim-done');
    expect(result.recipeName).toBe('default');
  });

  it('emits the signal envelope through cli.emitEnvelope when --json is passed', async () => {
    const { ctx, emitted } = makeFakeContext();
    registerProbeScenario();

    await simSpec().handler({ cwd: process.cwd(), json: true }, ctx);

    // ADR-0011 (Phase 4): --json routes the SignalEnvelope (not the bespoke
    // SimDoneResult) through the root's emitEnvelope → formatSignalJson.
    expect(emitted).toHaveLength(1);
    const payload = emitted[0] as { schemaVersion?: number; tool?: string };
    expect(payload.schemaVersion).toBe(2);
    expect(payload.tool).toBe('sim');
  });

  it('returns exit code 2 in JSON mode when the recipe is unknown', async () => {
    const { ctx, exitCodes, emitted } = makeFakeContext();

    await simSpec().handler({ cwd: process.cwd(), json: true, recipe: 'nope' }, ctx);

    expect(exitCodes).toContain(2);
    expect(emitted).toHaveLength(1);
    // 2.12.0: a failed --json run emits a structured error detail (`message`),
    // not a bare `{ error }` (the host wraps it in a status:'error' outcome).
    const payload = emitted[0] as { message?: string };
    expect(payload.message).toContain('Unknown sim recipe');
  });

  it('returns exit code 2 in non-JSON mode for unknown recipe', async () => {
    const { ctx, exitCodes, rendered } = makeFakeContext();

    await simSpec().handler({ cwd: process.cwd(), recipe: 'still-nope' }, ctx);

    expect(exitCodes).toContain(2);
    const errResult = rendered[0] as { type: string; message?: string };
    expect(errResult.type).toBe('error');
    expect(errResult.message).toContain('still-nope');
  });
});
