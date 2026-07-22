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

import { bashScript, fishScript, zshScript } from './completion-scripts.js';

import type { CompletionInventory } from './completion-scripts.js';

export type { CompletionInventory } from './completion-scripts.js';

export type Shell = 'bash' | 'zsh' | 'fish';

/** Internal/machine-facing commands excluded from shell completion (host-spawned workers). */
export const INTERNAL_COMMANDS: ReadonlySet<string> = new Set([
  'graph-shard-worker',
  'graph-equivalence-check',
  'fit-run-worker',
  'sim-run-worker',
  'graph-run-worker',
  '__capability-pack-worker',
  '__tool-command-worker',
]);

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

/** A grouped command leaf whose completion surface is derived like any other spec. */
export interface GroupLeafLike {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly commonFlags?: readonly CommonFlagKey[];
  readonly options?: readonly { readonly flag: string }[];
}

/** One action-less group (`runs` / `sessions` / `tools`) and its leaf commands. */
export interface GroupLike {
  readonly name: string;
  readonly leaves: readonly GroupLeafLike[];
}

/**
 * One pack-supporting tool's `plugin` group, keyed by the primary verb it mounts
 * under (`fit`/`sim`). The `plugin` parent is offered as a leaf under that verb
 * (`opensip fit <TAB>` ⇒ `… plugin`), and the `add|list|remove|sync` leaves are
 * registered under the `${parentVerb} plugin` path for deeper completion.
 */
export interface ToolPluginGroupLike {
  readonly parentVerb: string;
  readonly parentAliases?: readonly string[];
  readonly leaves: readonly GroupLeafLike[];
}

/** Long `--flag` form of each registry spec (short alias + arg placeholder
 *  stripped). Precomputed by mapping the registry entries, so completion's
 *  common-flag list derives from the one ADR-0021 registry rather than
 *  re-listing flag names that can drift. Dot-access stays null-safe. */
const LONG_FLAGS = Object.fromEntries(
  Object.entries(commonFlags).map(([key, spec]) => {
    const match = /--[a-z][a-z0-9-]*/.exec(spec.flags);
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
  const match = /--[a-z][a-z0-9-]*/.exec(flags);
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

interface InventoryAccumulator {
  readonly commandFlags: Record<string, readonly string[]>;
  readonly subcommands: string[];
  readonly toolGroupLeaves: Record<string, string[]>;
  readonly parentAliases: Record<string, readonly string[]>;
}

function addFlatSpec(spec: SpecLike, flags: readonly string[], acc: InventoryAccumulator): void {
  const primaryAliases = spec.aliases ?? [];
  if (primaryAliases.length > 0) {
    acc.parentAliases[spec.name] = primaryAliases;
  }
  for (const name of [spec.name, ...primaryAliases]) {
    acc.subcommands.push(name);
    acc.commandFlags[name] = flags;
  }
}

function addNestedSpec(spec: SpecLike, flags: readonly string[], acc: InventoryAccumulator): void {
  if (spec.parent === undefined) return;
  const leaves = (acc.toolGroupLeaves[spec.parent] ??= []);
  for (const name of [spec.name, ...(spec.aliases ?? [])]) {
    leaves.push(name);
    acc.commandFlags[`${spec.parent} ${name}`] = flags;
  }
}

function addSpecToInventory(
  spec: SpecLike,
  internalCommands: ReadonlySet<string>,
  acc: InventoryAccumulator,
): void {
  if (internalCommands.has(spec.name)) return;
  const flags = specLongFlags(spec);
  if (spec.parent !== undefined) {
    addNestedSpec(spec, flags, acc);
    return;
  }
  addFlatSpec(spec, flags, acc);
}

function addGroupedCommands(
  groups: readonly GroupLike[],
  subcommands: string[],
  commandFlags: Record<string, readonly string[]>,
  groupSubcommands: Record<string, readonly string[]>,
): void {
  for (const group of groups) {
    subcommands.push(group.name);
    const leaves: string[] = [];
    for (const leaf of group.leaves) {
      const flags = specLongFlags({
        ...leaf,
        commonFlags: leaf.commonFlags ?? [],
      });
      for (const name of [leaf.name, ...(leaf.aliases ?? [])]) {
        leaves.push(name);
        commandFlags[`${group.name} ${name}`] = flags;
      }
    }
    groupSubcommands[group.name] = leaves;
  }
}

function foldToolLeaves(
  toolGroupLeaves: Record<string, string[]>,
  parentAliases: Record<string, readonly string[]>,
  commandFlags: Record<string, readonly string[]>,
  groupSubcommands: Record<string, readonly string[]>,
): void {
  for (const [parent, leaves] of Object.entries(toolGroupLeaves)) {
    groupSubcommands[parent] = [...(groupSubcommands[parent] ?? []), ...leaves];
    for (const alias of parentAliases[parent] ?? []) {
      groupSubcommands[alias] = [...(groupSubcommands[alias] ?? []), ...leaves];
      for (const leaf of leaves) {
        const parentFlags = commandFlags[`${parent} ${leaf}`];
        if (parentFlags !== undefined) {
          commandFlags[`${alias} ${leaf}`] = parentFlags;
        }
      }
    }
  }
}

function foldToolPluginGroups(
  toolPluginGroups: readonly ToolPluginGroupLike[] | undefined,
  commandFlags: Record<string, readonly string[]>,
  groupSubcommands: Record<string, readonly string[]>,
): void {
  for (const group of toolPluginGroups ?? []) {
    const pluginParents = [group.parentVerb, ...(group.parentAliases ?? [])];
    for (const parent of pluginParents) {
      groupSubcommands[parent] = [...(groupSubcommands[parent] ?? []), 'plugin'];
      const leaves: string[] = [];
      for (const leaf of group.leaves) {
        const flags = specLongFlags({
          ...leaf,
          commonFlags: leaf.commonFlags ?? [],
        });
        for (const name of [leaf.name, ...(leaf.aliases ?? [])]) {
          leaves.push(name);
          commandFlags[`${parent} plugin ${name}`] = flags;
        }
      }
      groupSubcommands[`${parent} plugin`] = leaves;
    }
  }
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
   * the tool verb and `add|list|remove|sync` under `${parentVerb} plugin`. Optional
   * so callers without tools omit it.
   */
  readonly toolPluginGroups?: readonly ToolPluginGroupLike[];
  readonly internalCommands?: ReadonlySet<string>;
}): CompletionInventory {
  const internalCommands = input.internalCommands ?? INTERNAL_COMMANDS;
  const acc: InventoryAccumulator = {
    commandFlags: {},
    subcommands: [],
    // `parent` → leaf names, accumulated from `parent`-nested tool specs (the
    // `<tool> <verb>` grammar). Merged into `groupSubcommands` below so the
    // emitted script offers `<parent> <leaf>` exactly like a host group.
    toolGroupLeaves: {},
    parentAliases: {},
  };

  for (const spec of [...input.toolSpecs, ...input.hostSpecs]) {
    addSpecToInventory(spec, internalCommands, acc);
  }

  const groupSubcommands: Record<string, readonly string[]> = {};
  addGroupedCommands(input.groups, acc.subcommands, acc.commandFlags, groupSubcommands);
  // Fold tool-command sub-subcommands into the group map. A primary verb
  // (e.g. `graph`) is already a top-level subcommand with its own flags; adding
  // its nested leaves here lets the script also complete `graph export` etc.
  foldToolLeaves(acc.toolGroupLeaves, acc.parentAliases, acc.commandFlags, groupSubcommands);
  // Fold the per-tool `plugin` groups in: `plugin` becomes a completable leaf
  // under the tool verb (`opensip fit <TAB>` ⇒ `… plugin`), and the bound
  // leaf names register under the doubly-nested `${parentVerb} plugin` key for
  // deeper completion. There is NO top-level `plugin` group anymore.
  foldToolPluginGroups(input.toolPluginGroups, acc.commandFlags, groupSubcommands);

  // `help` is a Commander built-in the script also surfaces.
  acc.subcommands.push('help');

  return {
    subcommands: [...new Set(acc.subcommands)].sort(),
    commandFlags: acc.commandFlags,
    groupSubcommands,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the requested shell's completion script from an already-assembled
 * inventory. The per-shell renderers live in `completion-scripts.ts`; this
 * function's only job is dispatch plus supplying the ADR-0021 common-flag
 * fallback list (`COMMON_FLAGS`, owned by this module) to the shells that
 * use it.
 */
export function buildCompletionScript(shell: Shell, inventory: CompletionInventory): string {
  switch (shell) {
    case 'bash': {
      return bashScript(inventory, COMMON_FLAGS.join(' '));
    }
    case 'zsh': {
      return zshScript(inventory, COMMON_FLAGS.join(' '));
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
