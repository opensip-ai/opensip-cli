/**
 * Behaviour-parity snapshot — the command surface contract for release 2.11.0
 * (the command-plane migration's "zero observable behaviour change" invariant).
 *
 * Phases 0-6 moved every tool (fit/graph/sim) AND every host command off raw
 * Commander `register()` bodies onto declarative `CommandSpec`s mounted by the
 * host's `mountCommandSpec`. "Zero observable behaviour change" is load-bearing
 * and easy to regress silently — a renamed flag, a dropped default, a lost
 * alias would slip through unit tests. This snapshot walks the fully-mounted
 * Commander program and pins EVERY command's externally-observable surface:
 * name, aliases, options (flag, value placeholder, default, choices, negatable),
 * positional args (name, variadic/optional), and the one-line synopsis. Any
 * future drift from this surface fails CI loudly.
 *
 * ── BASELINE = 2.10.0, WITH ONE SANCTIONED DELTA ─────────────────────────────
 * The captured surface equals the 2.10.0 surface EXCEPT for one intentional,
 * reviewer-approved change: the three graph commands that bear `--resolution`
 * (`graph`, `catalog-export`, `sarif-export`) now render
 *
 *     (choices: "exact", "fast", default: "exact")
 *
 * in their `--resolution` help, because the command plane moved `--resolution`
 * validation OUT of the handler (which used to throw on a bad string) and INTO
 * the host-owned declared `choices: ['exact','fast']` on the OptionSpec. That is
 * the migration making validation declarative — NOT surface drift. It is the
 * ONLY difference from 2.10.0; every other command is byte-identical. If a
 * reviewer sees a `--resolution` choices/default line in the snapshot, that is
 * expected. Any OTHER change is a regression to investigate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  runWithScopeSync,
} from '@opensip-tools/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { FIRST_PARTY_TOOLS, mountAllToolCommands } from '../bootstrap/register-tools.js';
import { registerCliCommands } from '../commands/index.js';

import type { ToolCliContext } from '@opensip-tools/core';

/**
 * A throwaway tool context whose `program` is a real Commander root. Mounting
 * only READS each spec's static declarations (name/aliases/options/args) — no
 * handler runs — so the render/datastore members are inert stubs.
 */
function makeStubToolContext(program: Command): ToolCliContext {
  return {
    program,
    project: { scope: 'project', projectRoot: '/x', walkedUp: 0 },
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  } as never;
}

/** Build the fully-mounted program: bundled tools + CLI-owned host commands. */
function buildFullProgram(): Command {
  const scope = new RunScope({ languages: new LanguageRegistry(), tools: new ToolRegistry() });
  return runWithScopeSync(scope, () => {
    const program = new Command('opensip-tools').description(
      'Codebase analysis toolkit — pluggable tools for fitness, simulation, and more',
    );
    program.option('--no-cloud', 'Disable OpenSIP Cloud signal sync for this run');

    // Register the bundled tools into a fresh registry and mount their command
    // specs (the same path index.ts drives at step 8 of the tool lifecycle).
    const registry = new ToolRegistry();
    for (const tool of FIRST_PARTY_TOOLS) registry.register(tool);
    mountAllToolCommands(registry, makeStubToolContext(program));

    // Host-owned commands (init/dashboard/sessions/configure/plugin/completion/
    // uninstall), mounted via the same command plane.
    registerCliCommands(program, {
      setExitCode: vi.fn(),
      render: vi.fn(() => Promise.resolve()),
      datastore: () => undefined,
      pluginLayouts: [],
    });

    return program;
  });
}

/** The externally-observable shape of one Commander option. */
interface OptionSurface {
  flags: string;
  description: string;
  defaultValue: unknown;
  choices: readonly string[] | undefined;
  negate: boolean;
  required: boolean;
  optional: boolean;
  variadic: boolean;
}

/** The externally-observable shape of one positional argument. */
interface ArgSurface {
  name: string;
  required: boolean;
  variadic: boolean;
}

/** The externally-observable shape of one command (recursive over subcommands). */
interface CommandSurface {
  name: string;
  aliases: readonly string[];
  synopsis: string;
  usage: string;
  options: readonly OptionSurface[];
  args: readonly ArgSurface[];
  subcommands: readonly CommandSurface[];
}

/**
 * Redact the absolute working directory from a captured default so the
 * snapshot is path-independent. The `--cwd` option defaults to
 * `process.cwd()`, which embeds the checkout's absolute path — that would
 * make the snapshot fail on CI and in every clone/worktree at a different
 * path. Replacing the cwd prefix with `<cwd>` keeps the surface assertion
 * (a default exists, and its tail) while dropping the machine-specific root.
 */
function normalizeDefault(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const cwd = process.cwd();
  return value.startsWith(cwd) ? value.replace(cwd, '<cwd>') : value;
}

function describeOption(o: Command['options'][number]): OptionSurface {
  return {
    flags: o.flags,
    description: o.description,
    // `defaultValue` is `undefined` when no default was declared — capture it
    // (cwd-normalized) so a dropped/added default is caught without baking in
    // the machine-specific checkout path.
    defaultValue: normalizeDefault(o.defaultValue),
    // Commander stores declared choices under `argChoices`.
    choices: (o as { argChoices?: readonly string[] }).argChoices,
    negate: o.negate,
    required: o.required,
    optional: o.optional,
    variadic: o.variadic,
  };
}

function describeArg(a: Command['registeredArguments'][number]): ArgSurface {
  return {
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
  };
}

function describeCommand(cmd: Command): CommandSurface {
  return {
    name: cmd.name(),
    aliases: [...cmd.aliases()].sort(),
    synopsis: cmd.description(),
    usage: cmd.usage(),
    options: [...cmd.options].map(describeOption).sort((a, b) => a.flags.localeCompare(b.flags)),
    args: cmd.registeredArguments.map(describeArg),
    subcommands: [...cmd.commands]
      .map(describeCommand)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe('behaviour-parity snapshot (command surface = 2.10.0 + the --resolution delta)', () => {
  it('pins the full mounted command surface', () => {
    const program = buildFullProgram();
    const surface = describeCommand(program);
    expect(surface).toMatchSnapshot();
  });

  it('the three --resolution-bearing graph commands declare choices exact|fast (the sanctioned delta)', () => {
    const program = buildFullProgram();
    const RESOLUTION_COMMANDS = ['graph', 'catalog-export', 'sarif-export'];
    for (const name of RESOLUTION_COMMANDS) {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd, `expected a mounted '${name}' command`).toBeDefined();
      const resolution = cmd!.options.find((o) => o.long === '--resolution');
      expect(resolution, `${name} must declare --resolution`).toBeDefined();
      expect((resolution as { argChoices?: readonly string[] }).argChoices).toEqual(['exact', 'fast']);
      expect(resolution!.defaultValue).toBe('exact');
    }
  });
});
