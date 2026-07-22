/**
 * @fileoverview Shell-specific completion-script renderers (bash/zsh/fish).
 *
 * Split out of `completion.ts` (file-length limit) to separate that module's
 * inventory-assembly concern — deriving a {@link CompletionInventory} from
 * the live `CommandSpec`s — from this one: turning an already-assembled
 * inventory into each shell's sourceable script text. `completion.ts`
 * re-exports {@link CompletionInventory} from here and calls
 * {@link bashScript} / {@link zshScript} / {@link fishScript} from its
 * `buildCompletionScript`. This module intentionally has no dependency on
 * `completion.ts` (one-directional import, no cycle).
 */

/**
 * The derived completion surface, assembled from the live `CommandSpec`s by
 * `assembleCompletionInventory` (`completion.ts`). Everything the emitted
 * script needs to know about the command surface lives here — there are no
 * hand-maintained flag lists anymore.
 */
export interface CompletionInventory {
  /** User-facing top-level command names (incl. aliases + `help`). */
  readonly subcommands: readonly string[];
  /** Per-command long-flag list, keyed by command name (and alias). */
  readonly commandFlags: Readonly<Record<string, readonly string[]>>;
  /**
   * Sub-subcommand names for the action-less groups (`sessions`, `tools`), the
   * `<tool> <verb>` grammar (`fit export`…), and the per-tool `plugin` groups
   * (`fit plugin`, keyed under `${parentVerb} plugin`).
   */
  readonly groupSubcommands: Readonly<Record<string, readonly string[]>>;
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function shellCasePattern(path: string): string {
  return path.replaceAll(' ', '\\ ');
}

function completionPaths(inv: CompletionInventory): readonly string[] {
  return [...new Set([...Object.keys(inv.groupSubcommands), ...Object.keys(inv.commandFlags)])];
}

function nestedPathPatterns(inv: CompletionInventory): string {
  return completionPaths(inv)
    .filter((path) => path.includes(' '))
    .map(shellCasePattern)
    .join('|');
}

function bashPathResolver(inv: CompletionInventory): string {
  const patterns = nestedPathPatterns(inv);
  if (patterns.length === 0) return '';
  return `
  # Resolve the longest selected nested command path.
  command_path="\${COMP_WORDS[1]}"
  for ((i = 2; i < COMP_CWORD; i++)); do
    candidate_path="\${command_path} \${COMP_WORDS[i]}"
    case "\${candidate_path}" in
      ${patterns}) command_path="\${candidate_path}" ;;
    esac
  done
`;
}

/**
 * Render the bash completion script. `commonFlagList` is the pre-joined
 * ADR-0021 common-flag fallback (owned by `completion.ts`, which is the
 * single place `@opensip-cli/contracts`'s flag registry is read) — this
 * module stays a pure renderer over an already-assembled inventory.
 */
// @graph-ignore-next-line graph:near-duplicate-function-body -- bash and zsh renderers intentionally mirror the same inventory while emitting different shell syntaxes.
export function bashScript(inv: CompletionInventory, commonFlagList: string): string {
  const subs = inv.subcommands.join(' ');
  const arms: string[] = [];
  for (const [name, subsList] of Object.entries(inv.groupSubcommands)) {
    // A primary tool verb (e.g. `fit`/`graph`) is BOTH a flag-bearing command
    // AND a group with nested `<tool> <verb>` children (taxonomy Task 0.4): at
    // the second-word position the user can type either a nested subcommand or
    // one of the parent's own flags, so offer the union. An action-less host
    // group (`plugin`/`sessions`) has no own flags, so its union is just leaves.
    const ownFlags = inv.commandFlags[name] ?? [];
    const offered = [...new Set([...subsList, ...ownFlags])];
    arms.push(
      `    ${shellCasePattern(name)}) COMPREPLY=($(compgen -W "${offered.join(' ')}" -- "\${cur}")) ;;`,
    );
  }
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    if (name in inv.groupSubcommands) continue;
    arms.push(
      `    ${shellCasePattern(name)}) COMPREPLY=($(compgen -W "${flags.join(' ')}" -- "\${cur}")) ;;`,
    );
  }
  arms.push(`    *) COMPREPLY=($(compgen -W "${commonFlagList}" -- "\${cur}")) ;;`);
  return `# bash completion for opensip
# Source this file from ~/.bashrc or /etc/bash_completion.d/

_opensip() {
  local cur prev words cword command_path candidate_path i
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # First word: subcommand
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${subs}" -- "\${cur}"))
    return 0
  fi
${bashPathResolver(inv)}

  # Subcommand-specific flags (derived from the live command specs)
  case "\${command_path:-\${COMP_WORDS[1]}}" in
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

function zshPathResolver(inv: CompletionInventory): string {
  const patterns = nestedPathPatterns(inv);
  if (patterns.length === 0) return '';
  return `
  # Resolve the longest selected nested command path.
  command_path="\${words[2]}"
  for (( i = 3; i < CURRENT; i++ )); do
    candidate_path="\${command_path} \${words[i]}"
    case "\${candidate_path}" in
      ${patterns}) command_path="\${candidate_path}" ;;
    esac
  done
`;
}

/** Render the zsh completion script. See {@link bashScript} for `commonFlagList`. */
export function zshScript(inv: CompletionInventory, commonFlagList: string): string {
  const subs = inv.subcommands.join(' ');
  const arms: string[] = [];
  for (const [name, subsList] of Object.entries(inv.groupSubcommands)) {
    // Union of nested subcommands + the parent verb's own flags (see bashScript).
    const ownFlags = inv.commandFlags[name] ?? [];
    const offered = [...new Set([...subsList, ...ownFlags])];
    arms.push(
      `    ${shellCasePattern(name)}) _values '${name} subcommand' ${offered.join(' ')} ;;`,
    );
  }
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    if (name in inv.groupSubcommands) continue;
    arms.push(`    ${shellCasePattern(name)}) _values 'flag' ${flags.join(' ')} ;;`);
  }
  arms.push(`    *) _values 'flag' ${commonFlagList} ;;`);
  return `#compdef opensip
# zsh completion for opensip
# Source this file from your fpath (e.g. ~/.zsh/completions/_opensip).

_opensip() {
  local -a subcommands
  local command_path candidate_path i
  subcommands=(${subs})

  if (( CURRENT == 2 )); then
    _describe 'subcommand' subcommands
    return
  fi
${zshPathResolver(inv)}

  case "\${command_path:-\${words[2]}}" in
${arms.join('\n')}
  esac
}

compdef _opensip opensip
`;
}

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

function fishPathCondition(path: string, childNames: readonly string[] = []): string {
  const seen = path
    .split(' ')
    .map((part) => `__fish_seen_subcommand_from ${part}`)
    .join('; and ');
  if (childNames.length === 0) return seen;
  return `${seen}; and not __fish_seen_subcommand_from ${childNames.join(' ')}`;
}

/** Render the fish completion script. Fish has no common-flag fallback line. */
export function fishScript(inv: CompletionInventory): string {
  const subs = inv.subcommands.join(' ');
  const lines: string[] = [
    '# fish completion for opensip',
    '# Drop this at ~/.config/fish/completions/opensip.fish',
    '',
    `complete -c opensip -f -n "__fish_use_subcommand" -a "${subs}" -d "opensip subcommand"`,
  ];
  for (const [path, childNames] of Object.entries(inv.groupSubcommands)) {
    lines.push(
      `complete -c opensip -f -n "${fishPathCondition(path, childNames)}" -a "${childNames.join(' ')}" -d "${path} subcommand"`,
    );
  }
  for (const [name, flags] of Object.entries(inv.commandFlags)) {
    const condition = fishPathCondition(name, inv.groupSubcommands[name]);
    for (const flag of flags) {
      lines.push(`complete -c opensip -n "${condition}" -l "${flag.replace(/^--/, '')}"`);
    }
  }
  return lines.join('\n') + '\n';
}
