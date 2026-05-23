/**
 * Drift test for the static `SUBCOMMANDS` list in
 * `commands/completion.ts`. The audit dismissed the static completion
 * list as a non-finding but flagged drift as the failure mode — this
 * test closes that loop.
 *
 * The shell-completion script can't introspect the live registry at
 * sourcing time (the user's shell sources it once), so we keep a
 * static list and assert at test time that it matches the live
 * Commander program built from `defaultToolRegistry.list()` plus the
 * CLI-owned commands.
 */

import { defaultToolRegistry, type ToolCliContext, type LiveViewRenderer } from '@opensip-tools/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  registerFirstPartyTools,
  mountAllToolCommands,
} from '../bootstrap/register-tools.js';
import { SUBCOMMANDS } from '../commands/completion.js';
import { registerCliCommands } from '../commands/index.js';

function makeStubContext(program: Command): ToolCliContext {
  // Stub renderers for tools that hard-fail when their built-in
  // renderer is missing (e.g. graph — Audit 2026-05-23 N-1). Keyed
  // by tool id; production wiring lives in
  // bootstrap/render-helpers.ts.
  const stubRenderer: LiveViewRenderer = vi.fn(() => Promise.resolve());
  const builtinLiveViews = new Map<string, LiveViewRenderer>();
  for (const tool of defaultToolRegistry.list()) {
    builtinLiveViews.set(tool.metadata.id, stubRenderer);
  }
  return {
    program,
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    builtinLiveViews,
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    setExitCode: vi.fn(),
  };
}

describe('SUBCOMMANDS drift test', () => {
  it('matches the live Commander program (tool subcommands plus CLI-owned)', () => {
    const program = new Command('opensip-tools');
    // Reset / re-populate the registry to mirror what bootstrapCli does.
    // Tool register() implementations are idempotent so re-mounting on a
    // fresh program is safe.
    registerFirstPartyTools(defaultToolRegistry);
    const ctx = makeStubContext(program);
    mountAllToolCommands(defaultToolRegistry, ctx);
    registerCliCommands(program, {
      setExitCode: ctx.setExitCode,
      render: (result) => ctx.render(result),
    });

    const live = program.commands.map((c) => c.name()).sort();
    // `dashboard` is mounted as a tool subcommand by fitness's
    // register(); `help` is a Commander built-in that the completion
    // script also surfaces. Filter out the `help` synthetic since
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
    // script to surface it.
    for (const sub of live) {
      if (sub === 'help') continue; // optional Commander built-in
      expect(completionList, `expected SUBCOMMANDS to include '${sub}'`).toContain(sub);
    }
  });
});
