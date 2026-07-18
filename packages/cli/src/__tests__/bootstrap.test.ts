/**
 * Tests for the composition-root bootstrap modules.
 *
 * Covers:
 *  - registerLanguageAdapters wires every bundled adapter into a fresh
 *    LanguageRegistry.
 *  - registerFirstPartyTools registers fitness, simulation, graph in
 *    the documented order with no surprises.
 *  - mountAllToolCommands fail-closes bundled mount failures (exit 5 path).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  PluginIncompatibleError,
  ToolRegistry,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { resetBootstrapDiagnosticsBuffer } from '../bootstrap/bootstrap-diagnostics-buffer.js';
import { bootstrapCli } from '../bootstrap/index.js';
import { registerLanguageAdapters } from '../bootstrap/register-language-adapters.js';
import { mountAllToolCommands, registerFirstPartyTools } from '../bootstrap/register-tools.js';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

function makeStubContext(): ToolCliContext {
  return {
    project: {
      cwd: '/test',
      cwdExplicit: false,
      projectRoot: '/test',
      configPath: undefined,
      walkedUp: 0,
      scope: 'none',
    },
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve({ cloudAccepted: 0 })),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
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
        complete: () => ({
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 0,
        }),
      },
    },
    // Mount-only stub: command handlers are never invoked in these tests, so
    // the remaining ToolCliContext seams (scope, baseline/artifact/toolState)
    // are intentionally omitted. Cast is compile-time only — no runtime change.
  } as unknown as ToolCliContext;
}

describe('registerLanguageAdapters', () => {
  it('registers every bundled adapter into the supplied registry', () => {
    const registry = new LanguageRegistry();
    registerLanguageAdapters(registry);

    // The registry should now resolve every supported language id.
    const ids = ['typescript', 'rust', 'python', 'java', 'go', 'cpp'];
    for (const id of ids) {
      const adapter = registry.get(id);
      expect(adapter, `expected ${id} to be registered`).toBeDefined();
      expect(adapter?.id).toBe(id);
    }
  });
});

describe('bootstrap discovery protection', () => {
  it('checks the stabilized project reader before either external discovery leg', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-bootstrap-protection-')));
    const project = join(root, 'project');
    const home = join(root, 'home');
    const trapDir = join(home, '.opensip-cli', 'tools', 'discovery-trap');
    mkdirSync(project, { recursive: true });
    mkdirSync(trapDir, { recursive: true });
    writeFileSync(
      join(project, 'opensip-cli.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
    writeFileSync(
      join(trapDir, 'opensip-tool.manifest.json'),
      JSON.stringify({
        kind: 'tool',
        id: 'discovery-protection-trap',
        identity: { name: 'discovery-protection-trap' },
        name: 'Discovery protection trap',
        version: '1.0.0',
        apiVersion: 999,
        main: './index.js',
        commands: [{ name: 'discovery-protection-trap', description: 'trap' }],
      }),
      'utf8',
    );
    const failure = new Error('startup reader missing');
    const assertExternalDiscoveryProtected = vi.fn(() => {
      throw failure;
    });
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(
        bootstrapCli({
          langRegistry: new LanguageRegistry(),
          toolRegistry: new ToolRegistry(),
          projectDir: root,
          cwd: project,
          cwdExplicit: true,
          cliEntryUrl: import.meta.url,
          argv: ['agent-catalog'],
          runtimeMode: 'host',
          assertExternalDiscoveryProtected,
        }),
      ).rejects.toBe(failure);
      expect(assertExternalDiscoveryProtected).toHaveBeenCalledWith(realpathSync(project));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('registerFirstPartyTools', () => {
  it('registers fitness, simulation, and graph in the documented order', async () => {
    const registry = new ToolRegistry();
    await registerFirstPartyTools(registry);
    const names = registry.list().map((t) => t.metadata.name ?? t.metadata.id);
    expect(names).toEqual(BUNDLED_TOOLS.map((t) => t.metadata.name ?? t.metadata.id));
  });

  it('produces a deterministic ordering matching BUNDLED_TOOLS (canonical names)', () => {
    expect(BUNDLED_TOOLS.map((t) => t.metadata.name ?? t.metadata.id)).toEqual([
      'fitness',
      'simulation',
      'graph',
      'yagni',
      'mcp',
    ]);
  });
});

/** A tool that mounts one command via the declarative commandSpecs path. */
function specTool(id: string, commandName: string): Tool {
  return {
    identity: { name: id },
    metadata: { id, name: id, version: '0.0.0', description: id },
    commands: [{ name: commandName, description: `${commandName} cmd` }],
    commandSpecs: [
      {
        name: commandName,
        description: `${commandName} cmd`,
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler: () => Promise.resolve({ type: 'noop' }),
      },
    ] as never,
  };
}

describe('mountAllToolCommands', () => {
  it('mounts every tool via its commandSpecs onto the program (3.0.0 — one command surface)', () => {
    const registry = new ToolRegistry();
    registry.register(specTool('fake-1', 'fake1'));
    registry.register(specTool('fake-2', 'fake2'));
    const program = new Command('opensip');

    mountAllToolCommands(registry, program, makeStubContext(), [], {});

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('fake1');
    expect(names).toContain('fake2');
  });

  it('fail-closes bundled tools — one spec that throws aborts mount (exit 5 path)', () => {
    const registry = new ToolRegistry();
    // A malformed spec (a boolean flag marked required) throws inside mountCommandSpec.
    const broken: Tool = {
      identity: { name: 'broken' },
      metadata: {
        id: 'broken',
        name: 'Broken',
        version: '0.0.0',
        description: '',
      },
      commands: [{ name: 'broken', description: 'broken' }],
      commandSpecs: [
        {
          name: 'broken',
          description: 'broken',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          options: [
            {
              flag: '--flag',
              description: 'boolean but required',
              required: true,
            },
          ],
          handler: () => Promise.resolve({ type: 'noop' }),
        },
      ] as never,
    };
    registry.register(broken);
    registry.register(specTool('works', 'works'));
    const program = new Command('opensip');

    const diagnostics = resetBootstrapDiagnosticsBuffer();
    expect(() => mountAllToolCommands(registry, program, makeStubContext(), [], {})).toThrow(
      PluginIncompatibleError,
    );
    expect(program.commands.map((c) => c.name())).not.toContain('works');
    expect(diagnostics.list().some((d) => d.message.includes('failed to mount'))).toBe(true);
  });
});
