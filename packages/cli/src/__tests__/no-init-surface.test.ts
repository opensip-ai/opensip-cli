/**
 * The no-init (first-run) command surface, derived from the REAL mounted specs.
 *
 * This is a drift guard, and it exists because the thing it guards already
 * broke once. No-init eligibility used to be a hardcoded `Set` of command paths
 * in `no-init-eligibility.ts`, and its unit test asserted that Set against
 * itself — so it passed while `audit`, the canonical first-run command, was
 * missing from it. `opensip audit` hard-failed with "No OpenSIP CLI project
 * found" on exactly the zero-config first run the installer, the quick start,
 * and ADR-0155 all promise.
 *
 * Eligibility now comes from `CommandSpec.noInit`, indexed by
 * `buildCommandScopeIndex` from the same specs Commander mounts. This test
 * pins the resulting surface against the real host + bundled-tool specs, so a
 * rename, a re-mount, or a new first-run command that forgets to declare
 * itself fails here rather than in a user's terminal.
 */
import { LanguageRegistry, RunScope, runWithScopeSync, ToolRegistry } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { isNoInitEligibleCommand } from '../bootstrap/no-init-eligibility.js';
import { buildCommandScopeIndex } from '../commands/command-scope-index.js';
import { buildTopLevelHostSpecs } from '../commands/host-command-specs.js';
import { buildHostSubcommandGroups } from '../commands/host-subcommand-groups.js';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

import type { CommandScopeIndex } from '../commands/command-scope-index.js';
import type { CliCommandsContext } from '../commands/shared.js';

/**
 * Commands that MUST run on a repo with no `opensip-cli.config.yml`.
 * `audit` is the load-bearing entry: it is the canonical first-run command and
 * the one the marketing surface, installer, and quick start all lead with.
 */
const MUST_RUN_WITHOUT_INIT = [
  'audit',
  'status',
  'suite run',
  'fitness',
  'fit', // the alias must inherit eligibility from the primary spec
  'graph',
  'graph impact',
  // A pre-init run records real evidence in the ephemeral datastore. The
  // commands that READ that evidence back must be first-run capable too —
  // otherwise the user accumulates history they cannot see until they init.
  'runs list',
  'runs show',
  'sessions list',
  'sessions show',
  // Purge targets the active local evidence store (cache or project runtime),
  // same store list/show read — first-run capable so pre-init history can be cleared.
  'sessions purge',
  'report',
] as const;

/**
 * Commands that MUST NOT be promoted into an ephemeral project. `sim` and
 * `yagni` need authored scenarios/config to say anything useful; tool-management
 * commands mutate durable install state that expects an initialized layout.
 */
const MUST_REQUIRE_INIT = ['sim', 'simulation', 'yagni', 'tools list'] as const;

function makeCtx(tools: ToolRegistry): CliCommandsContext {
  return {
    setExitCode: vi.fn(),
    getExitCode: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitError: vi.fn(),
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: vi.fn(),
    tools,
    toolContext: {} as CliCommandsContext['toolContext'],
    toolRunActionHooks: {},
  };
}

/** Build the scope index from the real host specs + the real bundled tool specs. */
function realCommandScopeIndex(): CommandScopeIndex {
  const tools = new ToolRegistry();
  for (const tool of BUNDLED_TOOLS) tools.register(tool);
  const scope = new RunScope({ tools, languages: new LanguageRegistry() });

  return runWithScopeSync(scope, () => {
    const ctx = makeCtx(tools);
    return buildCommandScopeIndex({
      toolSpecs: BUNDLED_TOOLS.flatMap((tool) => [...(tool.commandSpecs ?? [])]),
      hostSpecs: buildTopLevelHostSpecs(ctx),
      hostGroups: buildHostSubcommandGroups(ctx),
    });
  });
}

describe('no-init (first-run) command surface', () => {
  it('lets every documented first-run command run without an initialized project', () => {
    const index = realCommandScopeIndex();
    for (const command of MUST_RUN_WITHOUT_INIT) {
      expect(
        isNoInitEligibleCommand(command, index),
        `'${command}' must run on a repo with no opensip-cli.config.yml`,
      ).toBe(true);
    }
  });

  it('keeps audit and suite run in agreement on the first run (ADR-0159)', () => {
    // The two spellings are equivalent by construction. They must not diverge
    // on the one run that matters most — the first one.
    const index = realCommandScopeIndex();
    expect(isNoInitEligibleCommand('audit', index)).toBe(
      isNoInitEligibleCommand('suite run', index),
    );
  });

  it('does not promote commands that need an initialized project', () => {
    const index = realCommandScopeIndex();
    for (const command of MUST_REQUIRE_INIT) {
      expect(isNoInitEligibleCommand(command, index), `'${command}' must not be no-init`).toBe(
        false,
      );
    }
  });

  it('treats an unknown command path as requiring a project', () => {
    expect(isNoInitEligibleCommand('does-not-exist', realCommandScopeIndex())).toBe(false);
  });
});
