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
 * The emitted scripts are static — they complete the canonical
 * subcommand / flag names rather than dynamic values. Static scripts
 * are fast (no subprocess per keystroke), portable (no version
 * mismatch between shell + CLI), and cover the ~95% case. If dynamic
 * completion (e.g. matching existing check slugs) is ever needed,
 * that's an additive change that can query `opensip-tools fit --list`
 * at completion time.
 */

export type Shell = 'bash' | 'zsh' | 'fish'

/**
 * Subcommands surfaced by completion. Kept in sync with the live
 * Commander program at test time — see
 * `__tests__/completion-subcommands.test.ts` (drift catch).
 */
export const SUBCOMMANDS: readonly string[] = [
  'fit',
  'fit-list',
  'fit-recipes',
  'fit-baseline-export',
  'sim',
  'graph',
  'graph-lookup',
  'graph-symbol-index',
  'graph-baseline-export',
  'graph-recipes',
  'init',
  'dashboard',
  'plugin',
  'sessions',
  'configure',
  'uninstall',
  'completion',
  'help',
]

/** Flags common to most commands — completed when the user types a dash. */
const COMMON_FLAGS: readonly string[] = [
  '--cwd',
  '--json',
  '--verbose',
  '--quiet',
  '--debug',
  '--help',
  '--version',
]

/** Flags specific to `fit`. */
const FIT_FLAGS: readonly string[] = [
  ...COMMON_FLAGS,
  '--recipe',
  '--check',
  '--tags',
  '--list',
  '--recipes',
  '--findings',
  '--report-to',
  '--api-key',
  '--exclude',
  '--open',
]

const SIM_FLAGS: readonly string[] = [
  ...COMMON_FLAGS,
  '--open',
]

const UNINSTALL_FLAGS: readonly string[] = [
  '--yes',
  '--dry-run',
  '--help',
]

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function bashScript(): string {
  const subs = SUBCOMMANDS.join(' ')
  const fitFlags = FIT_FLAGS.join(' ')
  const simFlags = SIM_FLAGS.join(' ')
  const uninstFlags = UNINSTALL_FLAGS.join(' ')
  const commonFlags = COMMON_FLAGS.join(' ')
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

  # Subcommand-specific flags
  case "\${COMP_WORDS[1]}" in
    fit)       COMPREPLY=($(compgen -W "${fitFlags}" -- "\${cur}")) ;;
    sim)       COMPREPLY=($(compgen -W "${simFlags}" -- "\${cur}")) ;;
    uninstall) COMPREPLY=($(compgen -W "${uninstFlags}" -- "\${cur}")) ;;
    plugin)    COMPREPLY=($(compgen -W "list add remove sync" -- "\${cur}")) ;;
    sessions)  COMPREPLY=($(compgen -W "list purge" -- "\${cur}")) ;;
    *)         COMPREPLY=($(compgen -W "${commonFlags}" -- "\${cur}")) ;;
  esac
  return 0
}

complete -F _opensip_tools opensip-tools
`
}

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

function zshScript(): string {
  const subs = SUBCOMMANDS.join(' ')
  const fitFlags = FIT_FLAGS.join(' ')
  const simFlags = SIM_FLAGS.join(' ')
  const uninstFlags = UNINSTALL_FLAGS.join(' ')
  const commonFlags = COMMON_FLAGS.join(' ')
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
    fit)       _values 'flag' ${fitFlags} ;;
    sim)       _values 'flag' ${simFlags} ;;
    uninstall) _values 'flag' ${uninstFlags} ;;
    plugin)    _values 'plugin subcommand' list add remove sync ;;
    sessions)  _values 'sessions subcommand' list purge ;;
    *)         _values 'flag' ${commonFlags} ;;
  esac
}

compdef _opensip_tools opensip-tools
`
}

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

function fishScript(): string {
  const subs = SUBCOMMANDS.join(' ')
  const lines: string[] = [
    '# fish completion for opensip-tools',
    '# Drop this at ~/.config/fish/completions/opensip-tools.fish',
    '',
    `complete -c opensip-tools -f -n "__fish_use_subcommand" -a "${subs}" -d "opensip-tools subcommand"`,
  ]
  for (const flag of FIT_FLAGS) {
    lines.push(`complete -c opensip-tools -n "__fish_seen_subcommand_from fit" -l "${flag.replace(/^--/, '')}"`)
  }
  for (const flag of SIM_FLAGS) {
    lines.push(`complete -c opensip-tools -n "__fish_seen_subcommand_from sim" -l "${flag.replace(/^--/, '')}"`)
  }
  for (const flag of UNINSTALL_FLAGS) {
    lines.push(`complete -c opensip-tools -n "__fish_seen_subcommand_from uninstall" -l "${flag.replace(/^--/, '')}"`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildCompletionScript(shell: Shell): string {
  switch (shell) {
    case 'bash': { return bashScript()
    }
    case 'zsh': {  return zshScript()
    }
    case 'fish': { return fishScript()
    }
  }
}

export function printCompletionScript(
  shell: Shell,
  write: (s: string) => void = (s) => process.stdout.write(s),
): void {
  write(buildCompletionScript(shell))
}
