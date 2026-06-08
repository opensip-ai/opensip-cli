/**
 * Drift test for the static `SUBCOMMANDS` list in
 * `commands/completion.ts`. The audit dismissed the static completion
 * list as a non-finding but flagged drift as the failure mode — this
 * test closes that loop.
 *
 * The shell-completion script can't introspect the live registry at
 * sourcing time (the user's shell sources it once), so we keep a
 * static list and assert at test time that it matches the live
 * Commander program built from the registered tools plus the
 * CLI-owned commands.
 */

import { ToolRegistry, type ToolCliContext } from '@opensip-tools/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  registerFirstPartyTools,
  mountAllToolCommands,
} from '../bootstrap/register-tools.js';
import { buildCompletionScript, SUBCOMMANDS } from '../commands/completion.js';
import { registerCliCommands } from '../commands/index.js';

function makeStubContext(program: Command): ToolCliContext {
  // Layer 5 Phase 3 (audit 2026-05-23 F3): tools own their renderers
  // and register them directly via `cli.registerLiveView`. The CLI no
  // longer hands out bundled renderers via a `builtinLiveViews` map.
  return {
    program,
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
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  };
}

describe('SUBCOMMANDS drift test', () => {
  it('matches the live Commander program (tool subcommands plus CLI-owned)', () => {
    const program = new Command('opensip-tools');
    // Fresh per-test ToolRegistry — the previously-exported
    // `defaultToolRegistry` module singleton was removed in T1 cleanup.
    const registry = new ToolRegistry();
    registerFirstPartyTools(registry);
    const ctx = makeStubContext(program);
    mountAllToolCommands(registry, ctx);
    registerCliCommands(program, {
      setExitCode: ctx.setExitCode,
      render: (result) => ctx.render(result),
      datastore: () => undefined,
    });

    const live = program.commands.map((c) => c.name()).sort();
    // `dashboard` is a CLI-owned command (registerCliCommands) since L2 —
    // the cross-tool composition root. `help` is a Commander built-in
    // that the completion script also surfaces. Filter out the `help`
    // synthetic since
    // Commander adds it automatically and SUBCOMMANDS lists it
    // explicitly.
    const completionList = [...SUBCOMMANDS].sort();
    // Commander auto-includes 'help' in commands.map() depending on
    // version; we tolerate either form.
    const liveSet = new Set(live);
    for (const sub of completionList) {
      if (sub === 'help') continue; // synthetic Commander built-in
      expect(liveSet, `expected '${sub}' to be a registered subcommand`).toContain(sub);
    }
    // Conversely — every live tool / CLI subcommand should be in
    // SUBCOMMANDS so a new `audit` tool would force the completion
    // script to surface it. Internal, non-user-facing commands are
    // exempt: they are not offered in shell completion.
    const INTERNAL = new Set([
      'help', // optional Commander built-in
      // Spawned by the sharded build (`graph --json` on a multi-package
      // repo), never typed by a user — intentionally absent from completion.
      'graph-shard-worker',
      // Machine-facing exports spawned by opensip's EngineSubprocessPort
      // (DEC-498), never typed by a user — intentionally absent from completion.
      'catalog-export',
      'sarif-export',
    ]);
    for (const sub of live) {
      if (INTERNAL.has(sub)) continue;
      expect(completionList, `expected SUBCOMMANDS to include '${sub}'`).toContain(sub);
    }
  });

  it('emitted bash/zsh scripts list the live plugin subcommands (no install/add drift)', () => {
    const program = new Command('opensip-tools');
    const registry = new ToolRegistry();
    registerFirstPartyTools(registry);
    const ctx = makeStubContext(program);
    mountAllToolCommands(registry, ctx);
    registerCliCommands(program, {
      setExitCode: ctx.setExitCode,
      render: (result) => ctx.render(result),
      datastore: () => undefined,
    });

    const pluginCmd = program.commands.find((c) => c.name() === 'plugin');
    expect(pluginCmd, 'plugin command should be registered').toBeDefined();
    const liveSubs = (pluginCmd?.commands ?? []).map((c) => c.name()).sort();

    // Bash/zsh completion arms should enumerate every live plugin
    // sub-subcommand. The historical drift was `install` (canonical
    // action is `add` post-F7).
    const bash = buildCompletionScript('bash');
    const zsh = buildCompletionScript('zsh');
    for (const sub of liveSubs) {
      expect(bash, `bash completion should list plugin '${sub}'`).toContain(sub);
      expect(zsh, `zsh completion should list plugin '${sub}'`).toContain(sub);
    }
    expect(bash).not.toMatch(/plugin\)\s+COMPREPLY=\(\$\(compgen[^"]*"[^"]*\binstall\b/);
    expect(zsh).not.toMatch(/plugin\)\s+_values 'plugin subcommand'[^;]*\binstall\b/);
  });
});
