/**
 * raw-stream inventory + behavioral contract parity (architecture review).
 *
 * Primary tools and workers declare raw-stream by design; this test keeps the
 * inventory authoritative and pins host behavior per reason category.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineCommand, RAW_STREAM_REASONS } from '@opensip-cli/core';
import { fitnessTool } from '@opensip-cli/fitness';
import { graphTool } from '@opensip-cli/graph';
import { mcpTool } from '@opensip-cli/mcp';
import { simulationTool } from '@opensip-cli/simulation';
import { yagniTool } from '@opensip-cli/yagni';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { mountCommandSpec } from '../commands/mount-command-spec.js';

import type {
  CommandSpec,
  RawStreamReason,
  ToolCliContext,
  ToolCommandManifest,
} from '@opensip-cli/core';

interface RawStreamEntry {
  readonly tool: string;
  readonly packageName?: string;
  readonly command: string;
  readonly path: string;
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
      path: spec.parent === undefined ? spec.name : `${spec.parent} ${spec.name}`,
      reason: spec.rawStreamReason,
    });
  }
  return entries;
}

interface ToolPackageJson {
  readonly name: string;
  readonly opensipTools?: {
    readonly kind?: string;
    readonly id?: string;
    readonly identity?: { readonly name?: string };
    readonly commands?: readonly ToolCommandManifest[];
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const RAW_STREAM_MANIFEST_BUDGET = 24;

function workspacePackageDirs(): readonly string[] {
  const packagesDir = join(REPO_ROOT, 'packages');
  const dirs: string[] = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const topLevel = join(packagesDir, entry.name);
    if (existsSync(join(topLevel, 'package.json'))) dirs.push(topLevel);
    for (const child of readdirSync(topLevel, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const nested = join(topLevel, child.name);
      if (existsSync(join(nested, 'package.json'))) dirs.push(nested);
    }
  }
  return dirs;
}

function readToolPackage(dir: string): ToolPackageJson | undefined {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ToolPackageJson;
  return pkg.opensipTools?.kind === 'tool' ? pkg : undefined;
}

function collectManifestRawStreamEntries(): readonly RawStreamEntry[] {
  const entries: RawStreamEntry[] = [];
  for (const dir of workspacePackageDirs()) {
    const pkg = readToolPackage(dir);
    if (pkg === undefined) continue;
    const toolName = pkg.opensipTools?.identity?.name ?? pkg.opensipTools?.id ?? pkg.name;
    for (const command of pkg.opensipTools?.commands ?? []) {
      if (command.output !== 'raw-stream') continue;
      if (command.rawStreamReason === undefined) {
        throw new Error(`${pkg.name}:${command.name} missing rawStreamReason`);
      }
      entries.push({
        tool: toolName,
        packageName: pkg.name,
        command: command.name,
        path: command.parent === undefined ? command.name : `${command.parent} ${command.name}`,
        reason: command.rawStreamReason,
      });
    }
  }
  return entries.sort((a, b) =>
    `${a.packageName ?? a.tool}:${a.path}`.localeCompare(`${b.packageName ?? b.tool}:${b.path}`),
  );
}

function reasonKeys(
  inventory: readonly RawStreamEntry[],
  reason: RawStreamReason,
): readonly string[] {
  return inventory
    .filter((entry) => entry.reason === reason)
    .map((entry) => `${entry.tool}:${entry.path}`)
    .sort();
}

const RUNTIME_RENDER_DISPATCH = new Set([
  'fitness:fitness',
  'graph:graph',
  'graph:graph impact',
  'simulation:simulation',
  'yagni:yagni',
  'gitleaks:gitleaks',
  'osv-scanner:osv-scanner',
  'trivy:trivy',
]);

describe('raw-stream inventory (packaged tools)', () => {
  const runtimeInventory = [
    ...collectRawStreamSpecs('fitness', fitnessTool.commandSpecs ?? []),
    ...collectRawStreamSpecs('graph', graphTool.commandSpecs ?? []),
    ...collectRawStreamSpecs('mcp', mcpTool.commandSpecs ?? []),
    ...collectRawStreamSpecs('simulation', simulationTool.commandSpecs ?? []),
    ...collectRawStreamSpecs('yagni', yagniTool.commandSpecs ?? []),
  ];
  const manifestInventory = collectManifestRawStreamEntries();

  it('lists every packaged raw-stream command with a valid reason', () => {
    expect(manifestInventory).toHaveLength(RAW_STREAM_MANIFEST_BUDGET);
    for (const entry of manifestInventory) {
      expect(RAW_STREAM_REASONS).toContain(entry.reason);
    }
  });

  it('runtime command specs also declare valid raw-stream reasons', () => {
    expect(runtimeInventory.length).toBeGreaterThan(0);
    for (const entry of runtimeInventory) {
      expect(RAW_STREAM_REASONS).toContain(entry.reason);
    }
  });

  it('runtime-render dispatch commands stay explicitly classified', () => {
    for (const key of RUNTIME_RENDER_DISPATCH) {
      const entry = manifestInventory.find((e) => `${e.tool}:${e.path}` === key);
      expect(entry, `expected raw-stream command ${key}`).toBeDefined();
      expect(entry?.reason).toBe('runtime-render-dispatch');
    }
  });

  it('worker-ipc commands exist for all forked run workers', () => {
    expect(reasonKeys(manifestInventory, 'worker-ipc')).toEqual([
      'fitness:fit-run-worker',
      'graph:graph-run-worker',
      'graph:graph-shard-worker',
      'simulation:sim-run-worker',
      'yagni:yagni-run-worker',
    ]);
  });

  it('includes the mcp command with the mcp-stdio reason (long-lived stdio transport)', () => {
    const entry = manifestInventory.find((e) => e.tool === 'mcp' && e.command === 'mcp');
    expect(entry, 'expected the mcp command in the raw-stream inventory').toBeDefined();
    expect(entry?.reason).toBe('mcp-stdio');
  });

  it('has no lookup raw-stream entries', () => {
    expect(manifestInventory.some((e) => e.reason === 'lookup')).toBe(false);
    expect(manifestInventory.some((e) => e.command === 'lookup' && e.tool === 'graph')).toBe(false);
  });

  it('groups bundled raw-stream commands by reason category', () => {
    expect(reasonKeys(manifestInventory, 'runtime-render-dispatch')).toEqual([
      'fitness:fitness',
      'gitleaks:gitleaks',
      'graph:graph',
      'graph:graph impact',
      'osv-scanner:osv-scanner',
      'simulation:simulation',
      'trivy:trivy',
      'yagni:yagni',
    ]);
    expect(reasonKeys(manifestInventory, 'file-export')).toEqual([
      'fitness:fitness export',
      'graph:graph export',
      'graph:graph index',
    ]);
    expect(reasonKeys(manifestInventory, 'diagnostic-gate')).toEqual([
      'gitleaks:gitleaks doctor',
      'gitleaks:gitleaks version',
      'graph:graph-equivalence-check',
      'osv-scanner:osv-scanner doctor',
      'osv-scanner:osv-scanner version',
      'trivy:trivy doctor',
      'trivy:trivy version',
    ]);
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
