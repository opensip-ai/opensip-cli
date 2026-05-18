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

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearScenarioRegistry } from '../framework/registry.js';
import { defaultSimulationRecipeRegistry } from '../recipes/registry.js';
import { simulationTool } from '../tool.js';

import type { ToolCliContext } from '@opensip-tools/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(
  readFileSync(resolve(HERE, '../../package.json'), 'utf8'),
) as { version: string };

afterEach(() => {
  clearScenarioRegistry();
  defaultSimulationRecipeRegistry.reset();
});

function makeFakeContext(program: Command): {
  ctx: ToolCliContext;
  rendered: unknown[];
  exitCodes: number[];
} {
  const rendered: unknown[] = [];
  const exitCodes: number[] = [];
  const ctx: ToolCliContext = {
    program,
    render: vi.fn((result: unknown) => {
      rendered.push(result);
      return Promise.resolve();
    }),
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
  };
  return { ctx, rendered, exitCodes };
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
      expect.arrayContaining(['--recipe', '--cwd', '--json', '--kind', '--debug', '--open']),
    );
    expect(optionNames).toEqual(expect.arrayContaining(['--quiet']));
  });

  it('runs the action against the default recipe and renders the result', async () => {
    const program = new Command();
    program.exitOverride();
    const { ctx, rendered } = makeFakeContext(program);

    simulationTool.register(ctx);

    await program.parseAsync(['node', 'cli', 'sim'], { from: 'node' });

    expect(rendered).toHaveLength(1);
    const result = rendered[0] as { type: string; recipeName?: string };
    expect(result.type).toBe('sim-done');
    expect(result.recipeName).toBe('default');
  });

  it('writes JSON to stdout when --json is passed', async () => {
    const program = new Command();
    program.exitOverride();
    const { ctx } = makeFakeContext(program);

    simulationTool.register(ctx);

    const writes: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    try {
      await program.parseAsync(['node', 'cli', 'sim', '--json'], { from: 'node' });
    } finally {
      process.stdout.write = realWrite;
    }

    const out = writes.join('');
    expect(out).toContain('"type"');
    expect(out).toContain('"sim-done"');
  });

  it('returns exit code 2 in JSON mode when the recipe is unknown', async () => {
    const program = new Command();
    program.exitOverride();
    const { ctx, exitCodes } = makeFakeContext(program);

    simulationTool.register(ctx);

    const writes: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    };

    try {
      await program.parseAsync(['node', 'cli', 'sim', '--json', '--recipe', 'nope'], { from: 'node' });
    } finally {
      process.stdout.write = realWrite;
    }

    expect(exitCodes).toContain(2);
    expect(writes.join('')).toContain('Unknown sim recipe');
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
