/**
 * @fileoverview Smoke tests for simulationTool — the Tool plugin
 * descriptor wired into the CLI dispatcher.
 *
 * The tool itself is mostly Commander wiring; the executeSim entry
 * point gets dedicated tests in cli/__tests__/sim.test.ts. This file
 * exercises the descriptor metadata and the register() function with
 * a fake ToolCliContext so we can verify the subcommand surface.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enterScope, RunScope } from '@opensip-tools/core';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { noopTarget } from './test-utils/targets.js';
import { clearScenarioRegistry, currentScenarioRegistry } from '../framework/registry.js';
import { defineLoadScenario } from '../kinds/load/define.js';
import { simulationTool } from '../tool.js';

import type { ToolCliContext } from '@opensip-tools/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(
  readFileSync(resolve(HERE, '../../package.json'), 'utf8'),
) as { version: string };

beforeEach(() => {
  // Item 1: scenarioRegistry and recipe registry are per-RunScope.
  // Construct a fresh scope (with simulation extended) and enter it via
  // AsyncLocalStorage so the tool's action body resolves them through
  // currentScope() while the test's program.parseAsync runs.
  const scope = new RunScope();
  Object.assign(scope, simulationTool.contributeScope?.() ?? {});
  enterScope(scope);
});

afterEach(() => {
  clearScenarioRegistry();
});

function makeFakeContext(program: Command): {
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
  // The action body uses currentScope() (set by enterScope in
  // beforeEach), not cli.scope, but ToolCliContext requires a scope
  // value; mirror project into a throwaway scope here.
  const ctxScope = new RunScope({ projectContext: project });
  Object.assign(ctxScope, simulationTool.contributeScope?.() ?? {});
  const ctx: ToolCliContext = {
    program,
    scope: ctxScope,
    render: vi.fn((result: unknown) => {
      rendered.push(result);
      return Promise.resolve();
    }),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
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
    emitEnvelope: (value: unknown) => {
      emitted.push(value);
    },
    deliverSignals: () => Promise.resolve(),
    writeSarif: () => Promise.resolve(),
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
  currentScenarioRegistry().register(defineLoadScenario({
    id: 'probe',
    name: 'probe',
    description: 'probe',
    tags: [],
    target: noopTarget,
    workload: { rps: 1 },
    duration: 1,
    assertions: [ASSERTIONS.lowErrorRate(1)],
  }));
}

describe('simulationTool metadata', () => {
  it('exposes id, version, description', () => {
    expect(simulationTool.metadata.id).toBe('simulation');
    expect(simulationTool.metadata.version).toBe(PKG.version);
    expect(simulationTool.metadata.description).toContain('simulation');
  });

  it('declares a single sim subcommand', () => {
    expect(simulationTool.commands).toHaveLength(1);
    expect(simulationTool.commands[0]?.name).toBe('sim');
  });
});

describe('simulationTool.register', () => {
  it('mounts the sim subcommand on the Commander program', () => {
    const program = new Command();
    program.exitOverride();
    const { ctx } = makeFakeContext(program);

    simulationTool.register(ctx);

    const subcommands = program.commands.map((c) => c.name());
    expect(subcommands).toContain('sim');
  });

  it('declares the documented options on the sim subcommand', () => {
    const program = new Command();
    program.exitOverride();
    const { ctx } = makeFakeContext(program);

    simulationTool.register(ctx);

    const sim = program.commands.find((c) => c.name() === 'sim');
    expect(sim).toBeDefined();
    const optionNames = (sim?.options ?? []).map((o) => o.long ?? o.short);
    expect(optionNames).toEqual(
      expect.arrayContaining(['--recipe', '--cwd', '--json', '--debug', '--open']),
    );
    expect(optionNames).toEqual(expect.arrayContaining(['--quiet']));
    // ADR-0011 (Phase 4): sim gains cloud egress via the root's deliverSignals.
    expect(optionNames).toEqual(expect.arrayContaining(['--report-to', '--api-key']));
  });

  it('runs the action against the default recipe and renders the result', async () => {
    const program = new Command();
    program.exitOverride();
    const { ctx, rendered } = makeFakeContext(program);
    registerProbeScenario();

    simulationTool.register(ctx);

    await program.parseAsync(['node', 'cli', 'sim'], { from: 'node' });

    expect(rendered).toHaveLength(1);
    const result = rendered[0] as { type: string; recipeName?: string };
    expect(result.type).toBe('sim-done');
    expect(result.recipeName).toBe('default');
  });

  it('emits the signal envelope through cli.emitEnvelope when --json is passed', async () => {
    const program = new Command();
    program.exitOverride();
    const { ctx, emitted } = makeFakeContext(program);
    registerProbeScenario();

    simulationTool.register(ctx);

    await program.parseAsync(['node', 'cli', 'sim', '--json'], { from: 'node' });

    // ADR-0011 (Phase 4): --json routes the SignalEnvelope (not the bespoke
    // SimDoneResult) through the root's emitEnvelope → formatSignalJson.
    expect(emitted).toHaveLength(1);
    const payload = emitted[0] as { schemaVersion?: number; tool?: string };
    expect(payload.schemaVersion).toBe(2);
    expect(payload.tool).toBe('sim');
  });

  it('returns exit code 2 in JSON mode when the recipe is unknown', async () => {
    const program = new Command();
    program.exitOverride();
    const { ctx, exitCodes, emitted } = makeFakeContext(program);

    simulationTool.register(ctx);

    await program.parseAsync(['node', 'cli', 'sim', '--json', '--recipe', 'nope'], { from: 'node' });

    expect(exitCodes).toContain(2);
    expect(emitted).toHaveLength(1);
    const payload = emitted[0] as { error?: string };
    expect(payload.error).toContain('Unknown sim recipe');
  });

  it('returns exit code 2 in non-JSON mode for unknown recipe', async () => {
    const program = new Command();
    program.exitOverride();
    const { ctx, exitCodes, rendered } = makeFakeContext(program);

    simulationTool.register(ctx);

    await program.parseAsync(['node', 'cli', 'sim', '--recipe', 'still-nope'], { from: 'node' });

    expect(exitCodes).toContain(2);
    const errResult = rendered[0] as { type: string; message?: string };
    expect(errResult.type).toBe('error');
    expect(errResult.message).toContain('still-nope');
  });
});
