/**
 * @fileoverview Shell-completion script generator.
 *
 * Emits a sourceable completion script for bash, zsh, or fish that the
 * user drops into their shell init (or pipes directly into their
 * current shell to try it out).
 *
 * Usage:
 *   opensip completion bash >> ~/.bashrc
 *   opensip completion zsh  >> ~/.zshrc
 *   opensip completion fish > ~/.config/fish/completions/opensip.fish
 *
 * The emitted scripts are static — the user's shell sources them once, so
 * they complete fixed subcommand / flag names rather than querying the CLI
 * per keystroke (fast, portable, no version skew). What is NOT static is
 * how those names are produced: the subcommand list and each command's
 * flags are DERIVED from the live `CommandSpec`s at generation time (see
 * {@link CompletionInventory} / the `completion` command handler), so the
 * script can never drift from the real command surface the way a
 * hand-maintained flag list does. If dynamic value completion (e.g.
 * matching existing check slugs) is ever needed, that's an additive change
 * that can query `opensip fit --list` at completion time.
 */

import { commonFlags, type CommonFlagKey } from '@opensip-cli/contracts';

export type Shell = 'bash' | 'zsh' | 'fish';

/**
 * Internal/machine-facing command names never offered in shell completion.
 * These are spawned by the host (sharded build, off-process engine workers,
 * machine exports), never typed by a user.
 *
 * This is the STATIC FALLBACK / default for {@link assembleCompletionInventory}'s
 * `internalCommands` argument. The live path passes a descriptor-driven set
 * (`visibility: 'internal'` + this fallback), keeping the runtime filter in
 * lockstep with the `--help` hide pass. The set still backs the completion-drift
 * test, and matters whenever a caller does not supply the descriptor-derived set.
 *
 * Note: the four `*-run-worker` / `*-shard-worker` names AND
 * `graph-equivalence-check` are the Tier-3 `visibility: 'internal'` commands —
 * they also flow through the descriptor-driven set. They are listed here so the
 * static fallback is correct on its own (the historical gap was the missing
 * `graph-equivalence-check`).
 */
/**
 * Internal/machine-facing command names never offered in shell completion — the
 * `visibility: 'internal'` Tier-3 commands: `*-run-worker` / `*-shard-worker` and
 * `graph-equivalence-check` are machine-only IPC/CI bootstrap entry points
 * (ADR-0028), revealed by `OPENSIP_CLI_SHOW_INTERNAL=1`.
 *
 * The legacy flat-root export aliases (`catalog-export` / `sarif-export` /
 * `graph-baseline-export` / `fit-baseline-export`) were removed entirely, so they
 * no longer appear in the tool registry and need no completion suppression — the
 * canonical nested `<tool> export` forms are the only export surface.
 */
export const INTERNAL_COMMANDS: ReadonlySet<string> = new Set([
  'graph-shard-worker',
  'graph-equivalence-check',
  'fit-run-worker',
  'sim-run-worker',
  'graph-run-worker',
]);

/**
 * The derived completion surface, assembled from the live `CommandSpec`s by
 * {@link assembleCompletionInventory}. Everything the emitted script needs to
 * know about the command surface lives here — there are no hand-maintained
 * flag lists anymore.
 */
export interface CompletionInventory {
  /** User-facing top-level command names (incl. aliases + `help`). */
  readonly subcommands: readonly string[];
  /** Per-command long-flag list, keyed by command name (and alias). */
  readonly commandFlags: Readonly<Record<string, readonly string[]>>;
  /**
   * Sub-subcommand names for the action-less groups (`sessions`, `tools`), the
   * `<tool> <verb>` grammar (`fit export`…), and the per-tool `plugin` groups
   * (`fit plugin`, keyed under `${toolVerb} plugin`).
   */
  readonly groupSubcommands: Readonly<Record<string, readonly string[]>>;
}

/** Minimal structural view of a `CommandSpec` this module needs to read. */
export interface SpecLike {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly commonFlags: readonly CommonFlagKey[];
  readonly options?: readonly { readonly flag: string }[];
  /**
   * When set, this tool command is a `<parent> <name>` sub-subcommand (the
   * `<tool> <verb>` grammar — see `CommandSpec.parent`, taxonomy Task 0.4). The
   * inventory then offers it as a leaf under `parent` (like a `plugin`/`sessions`
   * group leaf) and keys its flags under `${parent} ${name}`. Omitted ⇒ a flat
   * top-level command.
   */
  readonly parent?: string;
}

/** One action-less group (`sessions` / `tools`) and its leaf command names. */
export interface GroupLike {
  readonly name: string;
  readonly leaves: readonly { readonly name: string }[];
}

/**
 * One pack-supporting tool's `plugin` group, keyed by the tool verb it mounts
 * under (`fit`/`sim`). The `plugin` parent is offered as a leaf under that verb
 * (`opensip fit <TAB>` ⇒ `… plugin`), and the `add|list|remove|sync` leaves are
 * registered under the `${toolVerb} plugin` path for deeper completion.
 */
export interface ToolPluginGroupLike {
  readonly toolVerb: string;
  readonly leaves: readonly { readonly name: string }[];
}

/** Long `--flag` form of each registry spec (short alias + arg placeholder
 *  stripped). Precomputed by mapping the registry entries, so completion's
 *  common-flag list derives from the one ADR-0021 registry rather than
 *  re-listing flag names that can drift. Dot-access stays null-safe. */
const LONG_FLAGS = Object.fromEntries(
  Object.entries(commonFlags).map(([key, spec]) => {
    const match = /--[a-z][a-z-]*/.exec(spec.flags);
    return [key, match ? match[0] : spec.flags];
  }),
) as Record<CommonFlagKey, string>;

/** Flags every command implicitly carries — the `*)` fallback when a typed
 *  subcommand has no derived entry. Derived from the ADR-0021 registry (plus
 *  Commander's built-in `--help`/`--version`) so it can't drift. */
const COMMON_FLAGS: readonly string[] = [
  LONG_FLAGS.cwd,
  LONG_FLAGS.json,
  LONG_FLAGS.verbose,
  LONG_FLAGS.quiet,
  LONG_FLAGS.debug,
  '--help',
  '--version',
];

/**
 * Extract the canonical long `--flag` from a Commander flag string —
 * `'-y, --yes'` → `'--yes'`, `'--no-cache'` → `'--no-cache'`,
 * `'--resolution'` → `'--resolution'`. Returns `undefined` for a short-only
 * flag (none exist in the current surface, but the caller filters defensively).
 */
export function extractLongFlag(flags: string): string | undefined {
  const match = /--[a-z][a-z-]*/.exec(flags);
  return match ? match[0] : undefined;
}

/**
 * The long flags a single command exposes: its resolved {@link CommonFlagKey}
 * common flags + its option long forms + Commander's built-in `--help`. Pure —
 * the single place a spec's flag surface is turned into completion candidates.
 */
export function specLongFlags(spec: SpecLike): readonly string[] {
  // LONG_FLAGS is a total `Record<CommonFlagKey, string>`, so the common-flag
  // lookup never yields undefined; only the option extraction can.
  const common = spec.commonFlags.map((k) => LONG_FLAGS[k]);
  const opts = (spec.options ?? [])
    .map((o) => extractLongFlag(o.flag))
    .filter((f): f is string => f !== undefined);
  return [...new Set([...common, ...opts, '--help'])];
}

/**
 * Assemble the completion inventory from the live specs. Pure: callers pass
 * the tool command specs (from the populated `ToolRegistry`), the top-level
 * host specs, and the action-less groups; this turns them into the flag /
 * subcommand maps the script builders consume.
 *
 * Internal commands are filtered out by `input.internalCommands` — the
 * descriptor-driven `visibility: 'internal'` set the host computes from the live
 * tool registry (`internalCommandNames`), so completion and the `--help` hide
 * pass key on the SAME source. Defaults to the static {@link INTERNAL_COMMANDS}
 * fallback when omitted (tests / callers without a registry). The
 * `OPENSIP_CLI_SHOW_INTERNAL=1` reveal is applied at the call site: the host
 * passes an EMPTY set to skip filtering when the override is on.
 */
export function assembleCompletionInventory(input: {
  readonly toolSpecs: readonly SpecLike[];
  readonly hostSpecs: readonly SpecLike[];
  readonly groups: readonly GroupLike[];
  /**
   * The DOMAIN-BOUND per-tool `plugin` groups (mounted under each pack-supporting
   * tool primary). Folded into the group map so completion offers `plugin` under
   * the tool verb and `add|list|remove|sync` under `${toolVerb} plugin`. Optional
   * so callers without tools omit it.
   */
  readonly toolPluginGroups?: readonly ToolPluginGroupLike[];
  readonly internalCommands?: ReadonlySet<string>;
}): CompletionInventory {
  const internalCommands = input.internalCommands ?? INTERNAL_COMMANDS;
  const commandFlags: Record<string, readonly string[]> = {};
  const subcommands: string[] = [];
  // `parent` → leaf names, accumulated from `parent`-nested tool specs (the
  // `<tool> <verb>` grammar). Merged into `groupSubcommands` below so the
  // emitted script offers `<parent> <leaf>` exactly like a host group.
  const toolGroupLeaves: Record<string, string[]> = {};

  for (const spec of [...input.toolSpecs, ...input.hostSpecs]) {
    if (internalCommands.has(spec.name)) continue;
    const flags = specLongFlags(spec);
    // A `parent`-nested tool spec is a sub-subcommand, NOT a top-level command:
    // offer it as a leaf under its parent and key its flags under the qualified
    // `${parent} ${name}` path (mirroring the host group leaves).
    if (spec.parent !== undefined) {
      const leaves = (toolGroupLeaves[spec.parent] ??= []);
      for (const name of [spec.name, ...(spec.aliases ?? [])]) {
        leaves.push(name);
        commandFlags[`${spec.parent} ${name}`] = flags;
      }
      continue;
    }
    for (const name of [spec.name, ...(spec.aliases ?? [])]) {
      subcommands.push(name);
      commandFlags[name] = flags;
    }
  }

  const groupSubcommands: Record<string, readonly string[]> = {};
  for (const group of input.groups) {
    subcommands.push(group.name);
    groupSubcommands[group.name] = group.leaves.map((l) => l.name);
  }
  // Fold tool-command sub-subcommands into the group map. A primary verb
  // (e.g. `graph`) is already a top-level subcommand with its own flags; adding
  // its nested leaves here lets the script also complete `graph export` etc.
  for (const [parent, leaves] of Object.entries(toolGroupLeaves)) {
    groupSubcommands[parent] = [...(groupSubcommands[parent] ?? []), ...leaves];
  }
  // Fold the per-tool `plugin` groups in: `plugin` becomes a completable leaf
  // under the tool verb (`opensip fit <TAB>` ⇒ `… plugin`), and the bound
  // leaf names register under the doubly-nested `${toolVerb} plugin` key for
  // deeper completion. There is NO top-level `plugin` group anymore.
  for (const group of input.toolPluginGroups ?? []) {
    groupSubcommands[group.toolVerb] = [...(groupSubcommands[group.toolVerb] ?? []), 'plugin'];
    groupSubcommands[`${group.toolVerb} plugin`] = group.leaves.map((l) => l.name);
  }

  // `help` is a Commander built-in the script also surfaces.
  subcommands.push('help');

  return {
    subcommands: [...new Set(subcommands)].sort(),
    commandFlags,
    groupSubcommands,
  };
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function bashScript(inv: CompletionInventory): string {
  const subs = inv.subcommands.join(' ');
  const commonFlagList = COMMON_FLAGS.join(' ');
  const arms: string[] = [];
  for (const [name, subsList] of Object.entries(inv.groupSubcommands)) {
    // A primary tool verb (e.g. `fit`/`graph`) is BOTH a flag-bearing command
    // AND a group with nested `<tool> <verb>` children (taxonomy Task 0.4): at
    // the second-word position the user can type either a nested subcommand or
    // one of the parent's own flags, so offer the union. An action-less host
    // group (`plugin`/`sessions`) has no own flags, so its union is just leaves.
    const ownFlags = inv.commandFlags[name] ?? [];
    const offered = [...new Set([...subsList, ...ownFlags])];
    arms.push(`    ${name}) COMPREPLY=($(compgen -W "${offered.join(' ')}" -- "\${cur}")) ;;`);
  }
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    if (name in inv.groupSubcommands) continue;
    arms.push(`    ${name}) COMPREPLY=($(compgen -W "${flags.join(' ')}" -- "\${cur}")) ;;`);
  }
  arms.push(`    *) COMPREPLY=($(compgen -W "${commonFlagList}" -- "\${cur}")) ;;`);
  return `# bash completion for opensip
# Source this file from ~/.bashrc or /etc/bash_completion.d/

_opensip() {
  local cur prev words cword
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # First word: subcommand
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${subs}" -- "\${cur}"))
    return 0
  fi

  # Subcommand-specific flags (derived from the live command specs)
  case "\${COMP_WORDS[1]}" in
${arms.join('\n')}
  esac
  return 0
}

complete -F _opensip opensip
`;
}

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

function zshScript(inv: CompletionInventory): string {
  const subs = inv.subcommands.join(' ');
  const commonFlagList = COMMON_FLAGS.join(' ');
  const arms: string[] = [];
  for (const [name, subsList] of Object.entries(inv.groupSubcommands)) {
    // Union of nested subcommands + the parent verb's own flags (see bashScript).
    const ownFlags = inv.commandFlags[name] ?? [];
    const offered = [...new Set([...subsList, ...ownFlags])];
    arms.push(`    ${name}) _values '${name} subcommand' ${offered.join(' ')} ;;`);
  }
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    if (name in inv.groupSubcommands) continue;
    arms.push(`    ${name}) _values 'flag' ${flags.join(' ')} ;;`);
  }
  arms.push(`    *) _values 'flag' ${commonFlagList} ;;`);
  return `#compdef opensip
# zsh completion for opensip
# Source this file from your fpath (e.g. ~/.zsh/completions/_opensip).

_opensip() {
  local -a subcommands
  subcommands=(${subs})

  if (( CURRENT == 2 )); then
    _describe 'subcommand' subcommands
    return
  fi

  case "\${words[2]}" in
${arms.join('\n')}
  esac
}

compdef _opensip opensip
`;
}

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

function fishScript(inv: CompletionInventory): string {
  const subs = inv.subcommands.join(' ');
  const lines: string[] = [
    '# fish completion for opensip',
    '# Drop this at ~/.config/fish/completions/opensip.fish',
    '',
    `complete -c opensip -f -n "__fish_use_subcommand" -a "${subs}" -d "opensip subcommand"`,
  ];
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    // A primary tool verb that also hosts nested `<tool> <verb>` children stays
    // in `groupSubcommands`, but it still owns its own flags — emit them so fish
    // completes `fit --<flag>` (the qualified `${parent} ${name}` keys for the
    // nested leaves are skipped here; they are not top-level commands). An
    // action-less host group has no `commandFlags` entry, so it is unaffected.
    if (name.includes(' ')) continue; // a nested `${parent} ${name}` key, not a verb
    for (const flag of flags) {
      lines.push(
        `complete -c opensip -n "__fish_seen_subcommand_from ${name}" -l "${flag.replace(/^--/, '')}"`,
      );
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildCompletionScript(shell: Shell, inventory: CompletionInventory): string {
  switch (shell) {
    case 'bash': {
      return bashScript(inventory);
    }
    case 'zsh': {
      return zshScript(inventory);
    }
    case 'fish': {
      return fishScript(inventory);
    }
  }
}

export function printCompletionScript(
  shell: Shell,
  inventory: CompletionInventory,
  write: (s: string) => void = (s) => process.stdout.write(s),
): void {
  write(buildCompletionScript(shell, inventory));
}
