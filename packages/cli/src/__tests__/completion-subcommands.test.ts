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

import { ToolRegistry, type ToolCliContext } from '@opensip-cli/core';
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
import {
  buildHostSubcommandGroups,
  buildToolPluginGroups,
} from '../commands/host-subcommand-groups.js';
import { registerCliCommands } from '../commands/index.js';
import {
  internalCommandNames,
  showInternalCommands,
} from '../commands/internal-command-visibility.js';

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
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
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
      record: () => undefined,
    },
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  };
}

/** A minimal host context for building the host specs we introspect (handlers
 *  are never invoked here — only the static declarations are read). The pack
 *  `plugin` groups are derived from `pluginLayouts`, so supply the real fit/sim
 *  layouts (graph has none) — matching what the composition root threads in. */
function makeStubHostContext(): CliCommandsContext {
  return {
    setExitCode: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitError: vi.fn(),
    pluginLayouts: [
      { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
      { domain: 'sim', userSubdirs: ['scenarios', 'recipes'] },
    ],
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
  const program = new Command('opensip');
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
    toolPluginGroups: buildToolPluginGroups(hostCtx).map((g) => ({
      toolVerb: g.toolVerb,
      leaves: g.leaves.map((l) => ({ name: l.name })),
    })),
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
      // A `parent`-nested spec (taxonomy Task 0.4, e.g. `graph export`) keys its
      // flags under the qualified `${parent} ${name}` path, not the bare name.
      const parent = (spec as { parent?: string }).parent;
      const key = parent === undefined ? spec.name : `${parent} ${spec.name}`;
      for (const flag of declared) {
        expect(
          inventory.commandFlags[key],
          `expected completion for '${key}' to include '${flag}'`,
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

describe('completion plugin sub-subcommand parity (now under each pack-supporting tool)', () => {
  it('there is NO top-level plugin command; the pack ops mount under fit/sim', async () => {
    const { program } = await buildLiveInventory();
    // The retired top-level `plugin` group must not exist; the pack ops live
    // under each pack-supporting tool primary.
    expect(program.commands.find((c) => c.name() === 'plugin')).toBeUndefined();
    for (const toolVerb of ['fit', 'sim']) {
      const primary = program.commands.find((c) => c.name() === toolVerb);
      expect(primary, `${toolVerb} primary should be registered`).toBeDefined();
      const pluginGroup = primary!.commands.find((c) => c.name() === 'plugin');
      expect(pluginGroup, `${toolVerb} should host a plugin group`).toBeDefined();
    }
  });

  it('emitted bash/zsh scripts list the live <tool> plugin subcommands (no install/add drift)', async () => {
    const { inventory, program } = await buildLiveInventory();
    const fitPlugin = program.commands
      .find((c) => c.name() === 'fit')!
      .commands.find((c) => c.name() === 'plugin');
    expect(fitPlugin, 'fit plugin group should be registered').toBeDefined();
    const liveSubs = (fitPlugin?.commands ?? []).map((c) => c.name()).sort();

    const bash = buildCompletionScript('bash', inventory);
    const zsh = buildCompletionScript('zsh', inventory);
    for (const sub of liveSubs) {
      expect(bash, `bash completion should list fit plugin '${sub}'`).toContain(sub);
      expect(zsh, `zsh completion should list fit plugin '${sub}'`).toContain(sub);
    }
    // `plugin` is offered as a leaf under each pack-supporting tool verb, and the
    // bound leaves under `${toolVerb} plugin`.
    expect(inventory.groupSubcommands.fit).toContain('plugin');
    expect(inventory.groupSubcommands.sim).toContain('plugin');
    expect(inventory.groupSubcommands['fit plugin']).toEqual(
      expect.arrayContaining(['list', 'add', 'remove', 'sync']),
    );
    // No top-level `plugin` group in the inventory anymore.
    expect(inventory.groupSubcommands.plugin).toBeUndefined();
    // The historical drift was `install` (canonical action is `add` post-F7).
    expect(inventory.groupSubcommands['fit plugin']).not.toContain('install');
  });
});

/** The legacy flat-root export aliases that were removed entirely — they must
 *  not surface anywhere in completion (no command spec declares them). */
const REMOVED_FLAT_EXPORTS = [
  'catalog-export',
  'sarif-export',
  'graph-baseline-export',
  'fit-baseline-export',
];

describe('completion taxonomy — internal excluded, canonical exports advertised (Task 4.3)', () => {
  /** The five Tier-3 internal command names + the non-`*-worker` equivalence gate. */
  const INTERNAL_NAMES = [
    'fit-run-worker',
    'graph-run-worker',
    'graph-shard-worker',
    'graph-equivalence-check',
    'sim-run-worker',
  ];

  it('no internal command (workers + graph-equivalence-check) appears in completion subcommands', async () => {
    const { inventory } = await buildLiveInventory();
    for (const name of INTERNAL_NAMES) {
      expect(
        inventory.subcommands,
        `internal command '${name}' must not be offered in completion`,
      ).not.toContain(name);
      // It must also not leak as a per-command flag key.
      expect(
        inventory.commandFlags[name],
        `'${name}' must have no completion flag set`,
      ).toBeUndefined();
    }
  });

  it('the descriptor-driven internal set covers all five (incl. the Phase 1 graph-equivalence-check leak fix)', async () => {
    const { registry } = await buildLiveInventory();
    const internal = internalCommandNames(registry);
    for (const name of INTERNAL_NAMES) {
      expect(internal, `descriptor-driven internal set must include '${name}'`).toContain(name);
    }
  });

  it('offers the canonical nested `graph export` / `fit export`; the legacy flat verbs are gone', async () => {
    const { inventory } = await buildLiveInventory();
    // Canonical nested exports flow into the group map under their tool primary.
    expect(inventory.groupSubcommands.graph, 'graph must offer the nested `export` leaf').toContain(
      'export',
    );
    expect(inventory.groupSubcommands.fit, 'fit must offer the nested `export` leaf').toContain(
      'export',
    );
    // The nested forms carry their own flag set keyed under `${parent} export`.
    expect(inventory.commandFlags['graph export']).toBeDefined();
    expect(inventory.commandFlags['fit export']).toBeDefined();
    // The removed flat export verbs are NOT offered as subcommands (no spec
    // declares them anymore).
    for (const removed of REMOVED_FLAT_EXPORTS) {
      expect(
        inventory.subcommands,
        `removed flat export '${removed}' must not be an offered subcommand`,
      ).not.toContain(removed);
    }
  });

  it('OPENSIP_CLI_SHOW_INTERNAL=1 flips internal commands INTO the offered subcommands', async () => {
    const { registry } = await buildLiveInventory();
    const toolSpecs = registry.list().flatMap((t) => t.commandSpecs ?? []);
    const hostCtx = makeStubHostContext();

    const build = (): CompletionInventory => {
      // Mirror the live call-site internal-set computation
      // (host-command-specs.ts): the descriptor-driven internal set is revealed
      // (emptied) when the env override is on.
      const internalCommands = showInternalCommands()
        ? new Set<string>()
        : internalCommandNames(registry);
      return assembleCompletionInventory({
        toolSpecs,
        hostSpecs: buildTopLevelHostSpecs(hostCtx),
        groups: buildHostSubcommandGroups(hostCtx),
        internalCommands,
      });
    };

    // Default (override off): internal workers are filtered out.
    const before = build();
    for (const name of INTERNAL_NAMES) {
      expect(before.subcommands, `'${name}' hidden by default`).not.toContain(name);
    }

    const prev = process.env.OPENSIP_CLI_SHOW_INTERNAL;
    process.env.OPENSIP_CLI_SHOW_INTERNAL = '1';
    try {
      const revealed = build();
      for (const name of INTERNAL_NAMES) {
        expect(revealed.subcommands, `'${name}' revealed by the override`).toContain(name);
      }
      // The removed flat export verbs never appear — they are gone from the
      // command surface entirely (not merely filtered).
      for (const removed of REMOVED_FLAT_EXPORTS) {
        expect(
          revealed.subcommands,
          `removed flat export '${removed}' must never appear`,
        ).not.toContain(removed);
      }
    } finally {
      if (prev === undefined) delete process.env.OPENSIP_CLI_SHOW_INTERNAL;
      else process.env.OPENSIP_CLI_SHOW_INTERNAL = prev;
    }
  });

  it('the grouped `<tool> <verb>` forms appear under fit / graph / sim', async () => {
    const { inventory } = await buildLiveInventory();
    // Task 3.x grouped children, folded into the group map by their parent verb.
    expect(inventory.groupSubcommands.fit).toEqual(
      expect.arrayContaining(['list', 'recipes', 'export']),
    );
    expect(inventory.groupSubcommands.graph).toEqual(
      expect.arrayContaining(['recipes', 'lookup', 'index', 'list', 'export']),
    );
    expect(inventory.groupSubcommands.sim).toEqual(expect.arrayContaining(['recipes']));
  });
});
