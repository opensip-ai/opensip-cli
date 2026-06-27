/**
 * raw-stream inventory + behavioral contract parity (architecture review).
 *
 * Primary tools and workers declare raw-stream by design; this test keeps the
 * inventory authoritative and pins host behavior per reason category.
 */

import { defineCommand, RAW_STREAM_REASONS } from '@opensip-cli/core';
import { fitnessTool } from '@opensip-cli/fitness';
import { graphTool } from '@opensip-cli/graph';
import { simulationTool } from '@opensip-cli/simulation';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { mountCommandSpec } from '../commands/mount-command-spec.js';

import type { CommandSpec, RawStreamReason, ToolCliContext } from '@opensip-cli/core';

interface RawStreamEntry {
  readonly tool: string;
  readonly command: string;
  readonly reason: RawStreamReason;
}

function collectRawStreamSpecs(toolName: string, specs: readonly CommandSpec[]): RawStreamEntry[] {
  const entries: RawStreamEntry[] = [];
  for (const spec of specs) {
    if (spec.output !== 'raw-stream') continue;
    if (spec.rawStreamReason === undefined) {
      throw new Error(`${toolName}:${spec.name} missing rawStreamReason`);
    }
    entries.push({
      tool: toolName,
      command: spec.name,
      reason: spec.rawStreamReason,
    });
  }
  return entries;
}

const PRIMARY_RUNTIME_DISPATCH = new Set(['fitness', 'graph', 'simulation']);

describe('raw-stream inventory (bundled tools)', () => {
  const inventory = [
    ...collectRawStreamSpecs('fitness', fitnessTool.commandSpecs ?? []),
    ...collectRawStreamSpecs('graph', graphTool.commandSpecs ?? []),
    ...collectRawStreamSpecs('simulation', simulationTool.commandSpecs ?? []),
  ];

  it('lists every bundled raw-stream command with a valid reason', () => {
    expect(inventory.length).toBeGreaterThan(0);
    for (const entry of inventory) {
      expect(RAW_STREAM_REASONS).toContain(entry.reason);
    }
  });

  it('primary entry commands use runtime-render-dispatch', () => {
    for (const name of PRIMARY_RUNTIME_DISPATCH) {
      const entry = inventory.find((e) => e.command === name);
      expect(entry, `expected raw-stream primary command ${name}`).toBeDefined();
      expect(entry?.reason).toBe('runtime-render-dispatch');
    }
  });

  it('worker-ipc commands exist for fit, graph, and sim workers', () => {
    const workerCommands = inventory.filter((e) => e.reason === 'worker-ipc').map((e) => e.command);
    expect(workerCommands).toContain('fit-run-worker');
    expect(workerCommands).toContain('graph-run-worker');
    expect(workerCommands).toContain('sim-run-worker');
  });

  it('has no lookup raw-stream entries', () => {
    expect(inventory.some((e) => e.reason === 'lookup')).toBe(false);
    expect(inventory.some((e) => e.command === 'lookup' && e.tool === 'graph')).toBe(false);
  });

  it('groups bundled raw-stream commands by reason category', () => {
    const byReason = Object.groupBy(inventory, (e) => e.reason);
    expect(byReason['runtime-render-dispatch']?.map((e) => e.command).sort()).toEqual([
      'fitness',
      'graph',
      'impact',
      'simulation',
    ]);
    expect(byReason['worker-ipc']?.length).toBeGreaterThanOrEqual(3);
    expect(byReason['file-export']?.length).toBeGreaterThanOrEqual(1);
  });
});

describe('raw-stream host parity', () => {
  it('host does not render or emit envelopes for raw-stream handlers', async () => {
    const rendered: unknown[] = [];
    const envelopes: unknown[] = [];
    const exitCodes: number[] = [];
    const sideEffect = vi.fn();

    const ctx = {
      render: (r: unknown) => {
        rendered.push(r);
        return Promise.resolve();
      },
      emitEnvelope: (e: unknown) => {
        envelopes.push(e);
      },
      setExitCode: (code: number) => {
        exitCodes.push(code);
      },
      scope: {} as ToolCliContext['scope'],
    } as ToolCliContext;

    const program = new Command();
    mountCommandSpec(
      program,
      defineCommand({
        name: 'probe',
        description: 'raw-stream probe',
        commonFlags: [],
        scope: 'none',
        output: 'raw-stream',
        rawStreamReason: 'runtime-render-dispatch',
        handler: () => {
          sideEffect();
        },
      }),
      ctx,
    );

    await program.parseAsync(['probe'], { from: 'user' });
    expect(sideEffect).toHaveBeenCalledOnce();
    expect(rendered).toEqual([]);
    expect(envelopes).toEqual([]);
    expect(exitCodes).toEqual([]);
  });
});
