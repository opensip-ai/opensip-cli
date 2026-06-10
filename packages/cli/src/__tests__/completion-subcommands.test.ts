/**
 * Parity test for shell completion.
 *
 * Completion is no longer a hand-maintained flag list: the `completion`
 * command derives its subcommands + per-command flags from the live
 * `CommandSpec`s (the same specs the runtime mounts) via
 * `assembleCompletionInventory`. These tests assert that derivation against the
 * live Commander program so completion can never drift from the real command
 * surface — neither a missing subcommand (a new `audit` tool) nor a missing
 * flag (the historical gap: `fit --gate-save` / `--gate-compare` / `--show`,
 * `sim --show`, and `graph`'s flags entirely).
 */

import { ToolRegistry, type ToolCliContext } from '@opensip-tools/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { registerFirstPartyTools, mountAllToolCommands } from '../bootstrap/register-tools.js';
import {
  assembleCompletionInventory,
  buildCompletionScript,
  specLongFlags,
  INTERNAL_COMMANDS,
  type CompletionInventory,
} from '../commands/completion.js';
import { buildTopLevelHostSpecs } from '../commands/host-command-specs.js';
import { buildHostSubcommandGroups } from '../commands/host-subcommand-groups.js';
import { registerCliCommands } from '../commands/index.js';

import type { CliCommandsContext } from '../commands/shared.js';

function makeStubToolContext(): ToolCliContext {
  // Layer 5 Phase 3 (audit 2026-05-23 F3): tools own their renderers
  // and register them directly via `cli.registerLiveView`.
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
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  };
}

/** A minimal host context for building the host specs we introspect (handlers
 *  are never invoked here — only the static declarations are read). */
function makeStubHostContext(): CliCommandsContext {
  return {
    setExitCode: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitError: vi.fn(),
    pluginLayouts: [],
    datastore: () => undefined,
  };
}

/** Build the completion inventory exactly as the `completion` command handler
 *  does, from the live first-party tool specs + host specs + groups. */
async function buildLiveInventory(): Promise<{
  inventory: CompletionInventory;
  program: Command;
  registry: ToolRegistry;
}> {
  const program = new Command('opensip-tools');
  const registry = new ToolRegistry();
  await registerFirstPartyTools(registry);
  const toolCtx = makeStubToolContext();
  mountAllToolCommands(registry, program, toolCtx);
  const hostCtx = makeStubHostContext();
  registerCliCommands(program, hostCtx);

  const inventory = assembleCompletionInventory({
    toolSpecs: registry.list().flatMap((t) => t.commandSpecs ?? []),
    hostSpecs: buildTopLevelHostSpecs(hostCtx),
    groups: buildHostSubcommandGroups(hostCtx),
  });
  return { inventory, program, registry };
}

describe('completion subcommand parity', () => {
  it('every live user-facing subcommand is completable', async () => {
    const { inventory, program } = await buildLiveInventory();
    const live = program.commands.map((c) => c.name());
    for (const sub of live) {
      if (INTERNAL_COMMANDS.has(sub)) continue;
      if (sub === 'help') continue; // Commander built-in
      expect(
        inventory.subcommands,
        `expected completion to surface live subcommand '${sub}'`,
      ).toContain(sub);
    }
  });
});

describe('completion flag parity', () => {
  it('every declared flag of every tool command is completable', async () => {
    const { inventory, registry } = await buildLiveInventory();
    const toolSpecs = registry.list().flatMap((t) => t.commandSpecs ?? []);
    for (const spec of toolSpecs) {
      if (INTERNAL_COMMANDS.has(spec.name)) continue;
      const declared = specLongFlags(spec);
      for (const flag of declared) {
        expect(
          inventory.commandFlags[spec.name],
          `expected completion for '${spec.name}' to include '${flag}'`,
        ).toContain(flag);
      }
    }
  });

  it('closes the historical gaps (fit gate/show, sim show, graph present)', async () => {
    const { inventory } = await buildLiveInventory();
    // graph was entirely absent from completion before (fell to the generic
    // `*)` arm). It must now have its own derived flag set.
    expect(inventory.commandFlags.graph, 'graph must be completable').toBeDefined();
    // The audit named these specific fit/sim flags as missing. They are now
    // derived from the live specs — assert they survive into completion.
    expect(inventory.commandFlags.fit).toEqual(
      expect.arrayContaining(['--gate-save', '--gate-compare', '--show']),
    );
    expect(inventory.commandFlags.sim).toContain('--show');
  });

  it('emitted bash/zsh scripts carry the derived flags', async () => {
    const { inventory } = await buildLiveInventory();
    const bash = buildCompletionScript('bash', inventory);
    const zsh = buildCompletionScript('zsh', inventory);
    for (const flag of ['--gate-save', '--gate-compare', '--show']) {
      expect(bash, `bash completion should carry '${flag}'`).toContain(flag);
      expect(zsh, `zsh completion should carry '${flag}'`).toContain(flag);
    }
  });
});

describe('completion plugin sub-subcommand parity', () => {
  it('emitted bash/zsh scripts list the live plugin subcommands (no install/add drift)', async () => {
    const { inventory, program } = await buildLiveInventory();
    const pluginCmd = program.commands.find((c) => c.name() === 'plugin');
    expect(pluginCmd, 'plugin command should be registered').toBeDefined();
    const liveSubs = (pluginCmd?.commands ?? []).map((c) => c.name()).sort();

    const bash = buildCompletionScript('bash', inventory);
    const zsh = buildCompletionScript('zsh', inventory);
    for (const sub of liveSubs) {
      expect(bash, `bash completion should list plugin '${sub}'`).toContain(sub);
      expect(zsh, `zsh completion should list plugin '${sub}'`).toContain(sub);
    }
    // The historical drift was `install` (canonical action is `add` post-F7).
    expect(inventory.groupSubcommands.plugin).not.toContain('install');
  });
});
