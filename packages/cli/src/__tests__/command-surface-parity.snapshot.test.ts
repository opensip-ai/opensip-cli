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
 * ── BASELINE = 2.10.0, WITH SANCTIONED DELTAS ────────────────────────────────
 * The captured surface equals the 2.10.0 surface EXCEPT for these intentional,
 * reviewer-approved changes:
 *
 * 1. The three graph commands that bear `--resolution` (`graph`,
 *    `catalog-export`, `sarif-export`) now render
 *
 *        (choices: "exact", "fast", default: "exact")
 *
 *    in their `--resolution` help, because the command plane moved
 *    `--resolution` validation OUT of the handler (which used to throw on a bad
 *    string) and INTO the host-owned declared `choices: ['exact','fast']` on the
 *    OptionSpec. That is the migration making validation declarative — NOT
 *    surface drift.
 *
 * 2. `fit --tags` and `init --language` now declare an array accumulator
 *    (`arrayDefault: []` + a `parse` reducer), so their snapshot shows
 *    `defaultValue: []` and a "repeatable or comma-separated" description.
 *    This fixes the `repeatable-option-needs-accumulator` dogfood finding:
 *    Commander keeps only the LAST value of a value option without a reducer, so
 *    `--tags a --tags b` silently dropped `a`. Both forms (`--tags a,b` and
 *    `--tags a --tags b`) now accumulate.
 *
 * 3. tool-command-surface-taxonomy Tasks 2.1/2.2: a NESTED canonical `export`
 *    subcommand appears under BOTH `fit` (`fit export --format baseline`)
 *    and `graph` (`graph export --format sarif|catalog|baseline`). These are the
 *    canonical export-under-tool forms (mounted via the `parent`-nested mount).
 *
 * 4. tool-command-surface-taxonomy Task 3.1/3.2/3.3/3.4: NESTED grouped
 *    `<tool> <verb>` children — `fit list` / `fit recipes`, `graph recipes` /
 *    `graph lookup` / `graph index` / `graph list`, and `sim recipes` — appear
 *    under their tool primaries (mounted via the same `parent`-nested mount).
 *
 * 5. The nine legacy flat-root aliases — `fit-list` / `fit-recipes` /
 *    `fit-baseline-export` / `graph-recipes` / `graph-lookup` /
 *    `graph-symbol-index` / `graph-baseline-export` / `sarif-export` /
 *    `catalog-export` — were REMOVED once their deprecation window closed. The
 *    canonical nested `<tool> <verb>` forms (deltas 3 + 4) are the only command
 *    surface; the flat verbs no longer appear at the top level.
 *
 * 6. Uniform tool-primary surface (tool-command-surface version phase): the host
 *    mount layer (`decorateToolPrimary`) GUARANTEES the same baseline on EVERY
 *    tool PRIMARY (`fit` / `graph` / `sim`), so the snapshot now shows:
 *      - a per-tool `--version` option on each primary (prints the TOOL's
 *        version, e.g. `fit 0.1.6`; distinct from the CLI `opensip --version`);
 *      - `--config <path>` on the `graph` and `sim` primaries (it was already on
 *        `fit`), now guaranteed by the host rather than declared per tool.
 *    These appear ONLY on the three primaries — never on the nested
 *    `<tool> <verb>` children or the Tier-3 workers — and the `--cwd`/`--json`/
 *    `--quiet`/`--verbose` baseline was already present (the host decoration is
 *    idempotent and adds only what a tool did not declare).
 *
 * 7. Packs-under-the-tool (command-surface-taxonomy "retire top-level plugin"):
 *    the top-level `opensip plugin` group was RETIRED. The pack ops
 *    (`add`/`list`/`remove`/`sync`) now mount as a `plugin` GROUP under each
 *    PACK-SUPPORTING tool primary — `fit plugin …` and `sim plugin …` (graph has
 *    no `pluginLayout`, so it gets no `plugin` group). The domain is PRE-BOUND
 *    from the tool, so the leaves no longer carry `--domain`/`--project`; their
 *    descriptions are now domain-specific (`… fit pack …`). Whole Tool plugins
 *    remain `opensip tools …` (unchanged). So `plugin` is absent from the root
 *    surface and present under `fit`/`sim`.
 *
 * 8. ADR-0054 M4-E (config two-pass + worker-by-default): a NEW host-mounted
 *    internal command `__tool-command-worker` appears in the full tree. The
 *    dispatch supervisor forks it (`opensip __tool-command-worker <spec>`) to run
 *    one external tool command out-of-process. It declares `visibility:'internal'`,
 *    so it is mounted-but-hidden (ABSENT from `--help`/completion, PRESENT and
 *    invocable in the tree) exactly like the five Tier-3 workers — asserted below.
 *
 * Every other command is byte-identical to 2.10.0. Any change OTHER than the
 * deltas above is a regression to investigate.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { LanguageRegistry, RunScope, ToolRegistry, runWithScopeSync } from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { mountAllToolCommands } from '../bootstrap/register-tools.js';
import { registerCliCommands } from '../commands/index.js';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

import type { ToolCliContext } from '@opensip-cli/core';

/**
 * A throwaway tool context whose `program` is a real Commander root. Mounting
 * only READS each spec's static declarations (name/aliases/options/args) — no
 * handler runs — so the render/datastore members are inert stubs.
 */
function makeStubToolContext(): ToolCliContext {
  return {
    project: { scope: 'project', projectRoot: '/x', walkedUp: 0 },
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  } as never;
}

/** Build the fully-mounted program: bundled tools + CLI-owned host commands. */
function buildFullProgram(): Command {
  const scope = new RunScope({
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
  });
  return runWithScopeSync(scope, () => {
    const program = new Command('opensip').description(
      'Codebase intelligence from your terminal — pluggable tools for fitness, simulation, and more',
    );
    program.option('--no-cloud', 'Disable OpenSIP Cloud signal sync for this run');
    program.option(
      '--no-plugins',
      'Skip loading installed npm tool packages (incident response; does not affect bundled or authored tools)',
    );

    // Register the bundled tools into a fresh registry and mount their command
    // specs (the same path index.ts drives at step 8 of the tool lifecycle).
    const registry = new ToolRegistry();
    for (const tool of BUNDLED_TOOLS) registry.register(tool);
    mountAllToolCommands(registry, program, makeStubToolContext(), []);

    // Host-owned commands (init/report/sessions/configure/completion/uninstall/
    // tools), mounted via the same command plane — PLUS the domain-bound
    // per-tool `plugin` groups, which mount UNDER each pack-supporting tool
    // primary (`opensip fit plugin …`). Those primaries were just mounted above,
    // so pass the bundled tools' real `pluginLayout`s (fit + sim; graph has
    // none) for `mountToolPluginGroups` to hang the groups off of.
    const pluginLayouts = BUNDLED_TOOLS.flatMap((t) => (t.pluginLayout ? [t.pluginLayout] : []));
    registerCliCommands(program, {
      setExitCode: vi.fn(),
      render: vi.fn(() => Promise.resolve()),
      datastore: () => undefined,
      pluginLayouts,
      tools: registry,
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

/**
 * The PUBLIC top-level command names — the ones `--help` actually lists. A
 * command is public iff Commander's `_hidden` flag (the property the help
 * renderer filters on, set by the Phase 1 host hide pass) is not `true`. This is
 * the same flag the hide pass writes; reading it here is the inverse of that
 * filter, so the assertion tracks exactly what a user would see.
 */
function publicTopLevelCommandNames(program: Command): readonly string[] {
  return program.commands
    .filter((c) => (c as unknown as { _hidden?: boolean })._hidden !== true)
    .map((c) => c.name());
}

/** Resolve a nested `<parent> <verb>` command (e.g. `graph export`) to its leaf. */
function nestedChild(program: Command, parent: string, verb: string): Command | undefined {
  const parentCmd = program.commands.find((c) => c.name() === parent);
  return parentCmd?.commands.find((c) => c.name() === verb);
}

/** The set of `--long` flag strings a Commander command declares. */
function longFlagsOf(cmd: Command): ReadonlySet<string> {
  return new Set(cmd.options.map((o) => o.long).filter((l): l is string => typeof l === 'string'));
}

/** Assert a command declares `--resolution` with the `exact|fast` choices delta. */
function assertResolutionChoices(cmd: Command | undefined, name: string): void {
  expect(cmd, `expected a mounted '${name}' command`).toBeDefined();
  const resolution = cmd!.options.find((o) => o.long === '--resolution');
  expect(resolution, `${name} must declare --resolution`).toBeDefined();
  expect((resolution as { argChoices?: readonly string[] }).argChoices).toEqual(['exact', 'fast']);
  expect(resolution!.defaultValue).toBe('exact');
}

describe('behaviour-parity snapshot (command surface = 2.10.0 + the --resolution delta)', () => {
  it('pins the full mounted command surface', () => {
    const program = buildFullProgram();
    const surface = describeCommand(program);
    expect(surface).toMatchSnapshot();
  });

  it('the public command surface excludes Tier-3 internal commands (present-but-hidden)', () => {
    const program = buildFullProgram();
    const topLevel = program.commands.map((c) => c.name());

    // The known Tier-3 internal/worker commands (tool-command-surface-taxonomy
    // T-1, + ADR-0054 M4-E). They are IPC/CI bootstrap entry points — still
    // directly invocable, so they MUST remain mounted in the full tree (PRESENT
    // below)...
    //
    // `__tool-command-worker` is the M4-E addition: a HOST-mounted internal
    // command (the dispatch supervisor forks it). It is the case that proved the
    // old hide mechanism was order-dependent — the former post-mount registry walk
    // ran inside `mountAllToolCommands`, BEFORE `registerCliCommands` mounted this
    // host command, so it leaked into `--help`. Hiding is now self-enforced AT
    // MOUNT by `mountCommandSpec` (visibility:'internal' → `_hidden`), which is
    // order-independent and covers tool workers AND host internal commands alike.
    const TIER_3_INTERNAL = [
      'fit-run-worker',
      'graph-run-worker',
      'graph-shard-worker',
      'graph-equivalence-check',
      'sim-run-worker',
      '__tool-command-worker',
    ];
    for (const name of TIER_3_INTERNAL) {
      expect(topLevel, `internal command '${name}' must stay mounted (invocable)`).toContain(name);
    }

    // ...but `mountCommandSpec` set Commander's `_hidden` on each at mount, so they
    // are ABSENT from `--help`. This is the no-internal-worker-leakage assertion
    // for the public surface: every Tier-3 command is mounted yet hidden (absent
    // from the PUBLIC surface), and NO non-internal command is hidden.
    const publicNames = publicTopLevelCommandNames(program);
    for (const name of TIER_3_INTERNAL) {
      expect(
        publicNames,
        `internal command '${name}' must be ABSENT from the public surface`,
      ).not.toContain(name);
    }
    // Exactly the Tier-3 internals are hidden — nothing more, nothing less.
    const hiddenNames = program.commands
      .filter((c) => (c as unknown as { _hidden?: boolean })._hidden === true)
      .map((c) => c.name())
      .sort();
    expect(hiddenNames, 'exactly the Tier-3 internal commands are hidden from --help').toEqual(
      [...TIER_3_INTERNAL].sort(),
    );
  });

  it('the canonical public verbs are PRESENT in the public surface (no over-hiding)', () => {
    const program = buildFullProgram();
    const publicNames = publicTopLevelCommandNames(program);

    // Tier-2 tool primaries + Tier-1 host commands are all on the public surface.
    // NOTE: `plugin` is NO LONGER a top-level verb — the pack ops mount under
    // each pack-supporting tool primary (`opensip fit plugin …`), asserted below.
    for (const verb of [
      'fitness',
      'graph',
      'simulation',
      'init',
      'report',
      'configure',
      'agent-catalog',
      'completion',
      'uninstall',
      'sessions',
      'tools',
    ]) {
      expect(publicNames, `public verb '${verb}' must be listed in --help`).toContain(verb);
    }

    // The retired top-level `plugin` group is GONE from the root surface.
    expect(publicNames, '`plugin` must NOT be a top-level command').not.toContain('plugin');

    // The canonical nested export forms (Phase 2) are mounted children under
    // their tool primary — `graph export` and `fit export`.
    expect(nestedChild(program, 'graph', 'export'), '`graph export` must be mounted').toBeDefined();
    expect(
      nestedChild(program, 'fitness', 'export'),
      '`fitness export` must be mounted',
    ).toBeDefined();

    // The new discoverability commands (Phase 3) — `simulation recipes` and `graph list`.
    expect(
      nestedChild(program, 'simulation', 'recipes'),
      '`simulation recipes` must be mounted',
    ).toBeDefined();
    expect(nestedChild(program, 'graph', 'list'), '`graph list` must be mounted').toBeDefined();

    // The per-tool `plugin` groups mount UNDER the pack-supporting tool primaries
    // (fit + sim; graph has no pluginLayout, so no `plugin` group).
    expect(
      nestedChild(program, 'fitness', 'plugin'),
      '`fitness plugin` must be mounted',
    ).toBeDefined();
    expect(
      nestedChild(program, 'simulation', 'plugin'),
      '`simulation plugin` must be mounted',
    ).toBeDefined();
    expect(
      nestedChild(program, 'graph', 'plugin'),
      '`graph plugin` must NOT exist (graph supports no packs)',
    ).toBeUndefined();
  });

  it('the --resolution-bearing graph commands declare choices exact|fast (the sanctioned delta)', () => {
    const program = buildFullProgram();
    // The legacy flat-root catalog-export/sarif-export were removed; the
    // --resolution flag now lives on the `graph` primary and the canonical
    // nested `graph export` command.
    assertResolutionChoices(
      program.commands.find((c) => c.name() === 'graph'),
      'graph',
    );
    assertResolutionChoices(nestedChild(program, 'graph', 'export'), 'graph export');
  });

  // Uniform tool-primary surface (decorateToolPrimary): the host guarantees the
  // same baseline on EVERY tool primary — a per-tool `--version` plus
  // `--cwd`/`--json`/`--config`/`--quiet`/`--verbose` — and ONLY on the primary.
  describe('host-guaranteed uniform tool-primary surface', () => {
    it.each(['fitness', 'graph', 'simulation'])(
      '%s primary carries --version + the guaranteed baseline flags',
      (toolVerb) => {
        const program = buildFullProgram();
        const primary = program.commands.find((c) => c.name() === toolVerb);
        expect(primary, `expected a mounted '${toolVerb}' primary`).toBeDefined();
        const flags = longFlagsOf(primary!);
        for (const guaranteed of [
          '--version',
          '--cwd',
          '--json',
          '--config',
          '--quiet',
          '--verbose',
        ]) {
          expect(flags, `${toolVerb} primary must carry ${guaranteed}`).toContain(guaranteed);
        }
        // The version option help text is the host-owned per-tool string.
        const version = primary!.options.find((o) => o.long === '--version');
        expect(version?.description).toBe("Print this tool's version");
      },
    );

    it('the guaranteed flags are NOT injected onto nested <tool> <verb> children', () => {
      const program = buildFullProgram();
      // `fit list` is a Tier-2 nested child — it must NOT pick up the primary-only
      // `--version` decoration (only the host adds it, and only to the primary).
      const fitList = nestedChild(program, 'fitness', 'list');
      expect(fitList, '`fitness list` must be mounted').toBeDefined();
      expect(
        longFlagsOf(fitList!),
        '`fitness list` must not carry the primary --version',
      ).not.toContain('--version');
    });
  });
});
