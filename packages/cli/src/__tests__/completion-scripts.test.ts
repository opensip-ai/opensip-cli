import { describe, it, expect, vi } from 'vitest';

import { buildCompletionScript, printCompletionScript } from '../commands/completion.js';

describe('buildCompletionScript', () => {
  it('emits a bash completion script with the expected scaffolding', () => {
    const s = buildCompletionScript('bash');
    expect(s).toContain('_opensip_tools()');
    expect(s).toContain('compgen -W');
    expect(s).toContain('complete -F _opensip_tools opensip-tools');
    // Subcommand `fit` should be present.
    expect(s).toContain('fit');
  });

  it('derives common flags from the registry — sim advertises --verbose (ADR-0021)', () => {
    // Regression: before ADR-0021 completion's COMMON_FLAGS listed --verbose but
    // sim did not implement it. Now sim implements it AND completion derives the
    // list from the registry, so the two cannot disagree.
    const s = buildCompletionScript('bash');
    expect(s).toContain('--verbose');
    expect(s).toContain('--report-to');
    // The fish per-subcommand lines should attach a verbose completion to sim
    // (fish renders long flags without the leading `--`).
    const fish = buildCompletionScript('fish');
    expect(fish).toContain('__fish_seen_subcommand_from sim" -l "verbose"');
  });

  it('emits a zsh completion script with #compdef and _values', () => {
    const s = buildCompletionScript('zsh');
    expect(s).toContain('#compdef opensip-tools');
    expect(s).toContain('_values');
    expect(s).toContain('compdef _opensip_tools opensip-tools');
  });

  it('emits a fish completion script with one complete line per flag', () => {
    const s = buildCompletionScript('fish');
    expect(s).toContain('complete -c opensip-tools');
    expect(s).toContain('__fish_use_subcommand');
    expect(s).toContain('__fish_seen_subcommand_from fit');
    expect(s).toContain('__fish_seen_subcommand_from sim');
    expect(s).toContain('__fish_seen_subcommand_from uninstall');
    // Subcommand list should appear in the first complete line.
    expect(s).toContain('init');
  });
});

describe('printCompletionScript', () => {
  it('writes the script through the supplied callback', () => {
    const out: string[] = [];
    printCompletionScript('bash', (s) => out.push(s));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('opensip-tools');
  });

  it('defaults to process.stdout.write', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      printCompletionScript('zsh');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0] ?? '')).toContain('#compdef');
    } finally {
      spy.mockRestore();
    }
  });
});
