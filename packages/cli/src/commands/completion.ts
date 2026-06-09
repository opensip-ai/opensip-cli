/**
 * @fileoverview Shell-completion script generator.
 *
 * Emits a sourceable completion script for bash, zsh, or fish that the
 * user drops into their shell init (or pipes directly into their
 * current shell to try it out).
 *
 * Usage:
 *   opensip-tools completion bash >> ~/.bashrc
 *   opensip-tools completion zsh  >> ~/.zshrc
 *   opensip-tools completion fish > ~/.config/fish/completions/opensip-tools.fish
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
 * that can query `opensip-tools fit --list` at completion time.
 */

import { commonFlags, type CommonFlagKey } from '@opensip-tools/contracts'

export type Shell = 'bash' | 'zsh' | 'fish'

/**
 * Internal/machine-facing command names never offered in shell completion.
 * These are spawned by the host (sharded build, off-process engine workers,
 * machine exports), never typed by a user. Single source for both the
 * inventory builder and the drift test.
 */
export const INTERNAL_COMMANDS: ReadonlySet<string> = new Set([
  'graph-shard-worker',
  'catalog-export',
  'sarif-export',
  'fit-run-worker',
  'sim-run-worker',
  'graph-run-worker',
])

/**
 * The derived completion surface, assembled from the live `CommandSpec`s by
 * {@link assembleCompletionInventory}. Everything the emitted script needs to
 * know about the command surface lives here — there are no hand-maintained
 * flag lists anymore.
 */
export interface CompletionInventory {
  /** User-facing top-level command names (incl. aliases + `help`). */
  readonly subcommands: readonly string[]
  /** Per-command long-flag list, keyed by command name (and alias). */
  readonly commandFlags: Readonly<Record<string, readonly string[]>>
  /** Sub-subcommand names for the action-less groups (`plugin`, `sessions`). */
  readonly groupSubcommands: Readonly<Record<string, readonly string[]>>
}

/** Minimal structural view of a `CommandSpec` this module needs to read. */
export interface SpecLike {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly commonFlags: readonly CommonFlagKey[]
  readonly options?: readonly { readonly flag: string }[]
}

/** One action-less group (`plugin` / `sessions`) and its leaf command names. */
export interface GroupLike {
  readonly name: string
  readonly leaves: readonly { readonly name: string }[]
}

/** Long `--flag` form of each registry spec (short alias + arg placeholder
 *  stripped). Precomputed by mapping the registry entries, so completion's
 *  common-flag list derives from the one ADR-0021 registry rather than
 *  re-listing flag names that can drift. Dot-access stays null-safe. */
const LONG_FLAGS = Object.fromEntries(
  Object.entries(commonFlags).map(([key, spec]) => {
    const match = /--[a-z][a-z-]*/.exec(spec.flags)
    return [key, match ? match[0] : spec.flags]
  }),
) as Record<CommonFlagKey, string>

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
]

/**
 * Extract the canonical long `--flag` from a Commander flag string —
 * `'-y, --yes'` → `'--yes'`, `'--no-cache'` → `'--no-cache'`,
 * `'--resolution'` → `'--resolution'`. Returns `undefined` for a short-only
 * flag (none exist in the current surface, but the caller filters defensively).
 */
export function extractLongFlag(flags: string): string | undefined {
  const match = /--[a-z][a-z-]*/.exec(flags)
  return match ? match[0] : undefined
}

/**
 * The long flags a single command exposes: its resolved {@link CommonFlagKey}
 * common flags + its option long forms + Commander's built-in `--help`. Pure —
 * the single place a spec's flag surface is turned into completion candidates.
 */
export function specLongFlags(spec: SpecLike): readonly string[] {
  // LONG_FLAGS is a total `Record<CommonFlagKey, string>`, so the common-flag
  // lookup never yields undefined; only the option extraction can.
  const common = spec.commonFlags.map((k) => LONG_FLAGS[k])
  const opts = (spec.options ?? [])
    .map((o) => extractLongFlag(o.flag))
    .filter((f): f is string => f !== undefined)
  return [...new Set([...common, ...opts, '--help'])]
}

/**
 * Assemble the completion inventory from the live specs. Pure: callers pass
 * the tool command specs (from the populated `ToolRegistry`), the top-level
 * host specs, and the action-less groups; this turns them into the flag /
 * subcommand maps the script builders consume. Internal worker commands are
 * filtered out ({@link INTERNAL_COMMANDS}).
 */
export function assembleCompletionInventory(input: {
  readonly toolSpecs: readonly SpecLike[]
  readonly hostSpecs: readonly SpecLike[]
  readonly groups: readonly GroupLike[]
}): CompletionInventory {
  const commandFlags: Record<string, readonly string[]> = {}
  const subcommands: string[] = []

  for (const spec of [...input.toolSpecs, ...input.hostSpecs]) {
    if (INTERNAL_COMMANDS.has(spec.name)) continue
    const flags = specLongFlags(spec)
    for (const name of [spec.name, ...(spec.aliases ?? [])]) {
      subcommands.push(name)
      commandFlags[name] = flags
    }
  }

  const groupSubcommands: Record<string, readonly string[]> = {}
  for (const group of input.groups) {
    subcommands.push(group.name)
    groupSubcommands[group.name] = group.leaves.map((l) => l.name)
  }

  // `help` is a Commander built-in the script also surfaces.
  subcommands.push('help')

  return {
    subcommands: [...new Set(subcommands)].sort(),
    commandFlags,
    groupSubcommands,
  }
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function bashScript(inv: CompletionInventory): string {
  const subs = inv.subcommands.join(' ')
  const commonFlagList = COMMON_FLAGS.join(' ')
  const arms: string[] = []
  for (const [name, subsList] of Object.entries(inv.groupSubcommands)) {
    arms.push(`    ${name}) COMPREPLY=($(compgen -W "${subsList.join(' ')}" -- "\${cur}")) ;;`)
  }
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    if (name in inv.groupSubcommands) continue
    arms.push(`    ${name}) COMPREPLY=($(compgen -W "${flags.join(' ')}" -- "\${cur}")) ;;`)
  }
  arms.push(`    *) COMPREPLY=($(compgen -W "${commonFlagList}" -- "\${cur}")) ;;`)
  return `# bash completion for opensip-tools
# Source this file from ~/.bashrc or /etc/bash_completion.d/

_opensip_tools() {
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

complete -F _opensip_tools opensip-tools
`
}

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

function zshScript(inv: CompletionInventory): string {
  const subs = inv.subcommands.join(' ')
  const commonFlagList = COMMON_FLAGS.join(' ')
  const arms: string[] = []
  for (const [name, subsList] of Object.entries(inv.groupSubcommands)) {
    arms.push(`    ${name}) _values '${name} subcommand' ${subsList.join(' ')} ;;`)
  }
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    if (name in inv.groupSubcommands) continue
    arms.push(`    ${name}) _values 'flag' ${flags.join(' ')} ;;`)
  }
  arms.push(`    *) _values 'flag' ${commonFlagList} ;;`)
  return `#compdef opensip-tools
# zsh completion for opensip-tools
# Source this file from your fpath (e.g. ~/.zsh/completions/_opensip-tools).

_opensip_tools() {
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

compdef _opensip_tools opensip-tools
`
}

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

function fishScript(inv: CompletionInventory): string {
  const subs = inv.subcommands.join(' ')
  const lines: string[] = [
    '# fish completion for opensip-tools',
    '# Drop this at ~/.config/fish/completions/opensip-tools.fish',
    '',
    `complete -c opensip-tools -f -n "__fish_use_subcommand" -a "${subs}" -d "opensip-tools subcommand"`,
  ]
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    if (name in inv.groupSubcommands) continue
    for (const flag of flags) {
      lines.push(
        `complete -c opensip-tools -n "__fish_seen_subcommand_from ${name}" -l "${flag.replace(/^--/, '')}"`,
      )
    }
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildCompletionScript(shell: Shell, inventory: CompletionInventory): string {
  switch (shell) {
    case 'bash': { return bashScript(inventory)
    }
    case 'zsh': {  return zshScript(inventory)
    }
    case 'fish': { return fishScript(inventory)
    }
  }
}

export function printCompletionScript(
  shell: Shell,
  inventory: CompletionInventory,
  write: (s: string) => void = (s) => process.stdout.write(s),
): void {
  write(buildCompletionScript(shell, inventory))
}
