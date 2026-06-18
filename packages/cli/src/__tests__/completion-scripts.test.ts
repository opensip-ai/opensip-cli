import { type CommonFlagKey } from '@opensip-cli/contracts';
import { describe, it, expect, vi } from 'vitest';

import {
  assembleCompletionInventory,
  buildCompletionScript,
  printCompletionScript,
  type CompletionInventory,
  type SpecLike,
} from '../commands/completion.js';

/** Build a structural spec the inventory assembler can read. */
function spec(name: string, common: CommonFlagKey[], optionFlags: string[]): SpecLike {
  return { name, commonFlags: common, options: optionFlags.map((flag) => ({ flag })) };
}

/** A representative inventory exercising tool + host commands. The egress
 *  (`reportTo`/`apiKey`) + `verbose` common flags come from the ADR-0021
 *  registry via `specLongFlags`, so completion can't disagree with the real
 *  flag names. */
function fixtureInventory(): CompletionInventory {
  return assembleCompletionInventory({
    toolSpecs: [
      spec('fit', ['cwd', 'json', 'verbose', 'reportTo', 'apiKey'], ['--recipe', '--gate-save']),
      spec('sim', ['cwd', 'json', 'verbose', 'reportTo', 'apiKey'], ['--show']),
    ],
    hostSpecs: [
      spec('init', [], ['--language']),
      spec('uninstall', [], ['-y, --yes', '--dry-run', '--user']),
    ],
    groups: [],
  });
}

describe('buildCompletionScript', () => {
  it('emits a bash completion script with the expected scaffolding', () => {
    const s = buildCompletionScript('bash', fixtureInventory());
    expect(s).toContain('_opensip()');
    expect(s).toContain('compgen -W');
    expect(s).toContain('complete -F _opensip opensip');
    // Subcommand `fit` should be present.
    expect(s).toContain('fit');
  });

  it('derives common flags from the registry — sim advertises --verbose (ADR-0021)', () => {
    // Regression: before ADR-0021 completion's COMMON_FLAGS listed --verbose but
    // sim did not implement it. Now sim implements it AND completion derives the
    // list from the registry, so the two cannot disagree.
    const s = buildCompletionScript('bash', fixtureInventory());
    expect(s).toContain('--verbose');
    expect(s).toContain('--report-to');
    // The fish per-subcommand lines should attach a verbose completion to sim
    // (fish renders long flags without the leading `--`).
    const fish = buildCompletionScript('fish', fixtureInventory());
    expect(fish).toContain('__fish_seen_subcommand_from sim" -l "verbose"');
  });

  it('emits a zsh completion script with #compdef and _values', () => {
    const s = buildCompletionScript('zsh', fixtureInventory());
    expect(s).toContain('#compdef opensip');
    expect(s).toContain('_values');
    expect(s).toContain('compdef _opensip opensip');
  });

  it('emits a fish completion script with one complete line per flag', () => {
    const s = buildCompletionScript('fish', fixtureInventory());
    expect(s).toContain('complete -c opensip');
    expect(s).toContain('__fish_use_subcommand');
    expect(s).toContain('__fish_seen_subcommand_from fit');
    expect(s).toContain('__fish_seen_subcommand_from sim');
    expect(s).toContain('__fish_seen_subcommand_from uninstall');
    // Subcommand list should appear in the first complete line.
    expect(s).toContain('init');
  });
});

// The base fixture has no groups, so the per-shell group-arm loops never run.
// This inventory carries two groups with leaves so each script renders the
// group completion arms.
function groupedInventory(): CompletionInventory {
  return assembleCompletionInventory({
    toolSpecs: [spec('fit', ['cwd', 'json'], ['--recipe'])],
    hostSpecs: [],
    groups: [
      { name: 'plugin', leaves: [{ name: 'list' }, { name: 'add' }, { name: 'remove' }] },
      { name: 'sessions', leaves: [{ name: 'list' }, { name: 'purge' }] },
    ],
  });
}

/** Count lines that (after leading whitespace) begin a `<name>)` case arm. */
function countArmsFor(script: string, name: string): number {
  return script.split('\n').filter((l) => l.trimStart().startsWith(`${name})`)).length;
}

describe('buildCompletionScript — action-less groups (plugin / sessions)', () => {
  it('bash renders a compgen arm per group with its leaves', () => {
    const s = buildCompletionScript('bash', groupedInventory());
    expect(s).toContain('plugin) COMPREPLY=($(compgen -W "list add remove"');
    expect(s).toContain('sessions) COMPREPLY=($(compgen -W "list purge"');
  });

  it('zsh renders a _values arm per group', () => {
    const s = buildCompletionScript('zsh', groupedInventory());
    expect(s).toContain("plugin) _values 'plugin subcommand' list add remove");
    expect(s).toContain("sessions) _values 'sessions subcommand' list purge");
  });

  it('fish surfaces the groups in the subcommand list', () => {
    const s = buildCompletionScript('fish', groupedInventory());
    expect(s).toContain('plugin');
    expect(s).toContain('sessions');
  });

  it('merges a command name that is BOTH a flag-bearing verb and a group (one union arm)', () => {
    // tool-command-surface-taxonomy Task 2.1/2.2 + Task 0.4: a primary tool verb
    // (e.g. `graph`/`fit`) is BOTH a flag-bearing command AND a group with nested
    // `<tool> <verb>` children. The group arm now UNIONs the parent verb's own
    // flags with its nested-subcommand leaves (so at the second word the user can
    // type a nested subcommand OR a parent flag). Still exactly ONE arm per name
    // (no duplicate flag arm). An action-less host group has no own flags, so its
    // union is just the leaves (unchanged behaviour).
    const inv: CompletionInventory = {
      subcommands: ['fit', 'plugin', 'help'],
      commandFlags: { fit: ['--json'], plugin: ['--json'] },
      groupSubcommands: { plugin: ['list', 'add'] },
    };
    const bash = buildCompletionScript('bash', inv);
    // Exactly one `plugin)` arm — the merged group arm (leaves + own flags).
    expect(countArmsFor(bash, 'plugin')).toBe(1);
    expect(bash).toContain('plugin) COMPREPLY=($(compgen -W "list add --json"');

    const zsh = buildCompletionScript('zsh', inv);
    expect(countArmsFor(zsh, 'plugin')).toBe(1);

    // fish: a colliding verb's own flags are still emitted (only the qualified
    // `${parent} ${name}` nested keys are skipped — they contain a space).
    const fish = buildCompletionScript('fish', inv);
    expect(fish).toContain('__fish_seen_subcommand_from plugin');
    expect(fish).toContain('__fish_seen_subcommand_from fit');
  });
});

describe('printCompletionScript', () => {
  it('writes the script through the supplied callback', () => {
    const out: string[] = [];
    printCompletionScript('bash', fixtureInventory(), (s) => out.push(s));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('opensip');
  });

  it('defaults to process.stdout.write', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      printCompletionScript('zsh', fixtureInventory());
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0] ?? '')).toContain('#compdef');
    } finally {
      spy.mockRestore();
    }
  });
});
