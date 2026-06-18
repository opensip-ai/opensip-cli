/**
 * command-scope-index — the runtime lookup used by pre-action bootstrap to
 * decide whether a command may run without an opensip-cli project.
 *
 * The index is built from the same declarative CommandSpecs that are mounted
 * into Commander: top-level host specs, grouped host leaves, and tool
 * commandSpecs. This keeps `CommandSpec.scope` as the source of truth instead
 * of a parallel allowlist.
 */

import type { HostSubcommandGroup, ToolPluginGroup } from './host-subcommand-groups.js';
import type { CommandScopeRequirement } from '@opensip-cli/core';
import type { Command } from 'commander';

export type CommandScopeIndex = ReadonlyMap<string, CommandScopeRequirement>;

export interface CommandScopeSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly scope: CommandScopeRequirement;
  /**
   * When set, this tool command is nested under the named primary verb (the
   * `<tool> <verb>` grammar — see `CommandSpec.parent`). The index then keys it
   * under `${parent} ${name}` so `commandPath` resolves `graph export` /
   * `fit list` rather than a bare `export` / `list`. Omitted ⇒ flat root key.
   */
  readonly parent?: string;
}

export interface CommandScopeIndexInput {
  readonly hostSpecs: readonly CommandScopeSpec[];
  readonly hostGroups: readonly HostSubcommandGroup[];
  readonly toolSpecs: readonly CommandScopeSpec[];
  /**
   * The DOMAIN-BOUND per-tool `plugin` groups (mounted under each pack-supporting
   * tool primary, e.g. `opensip fit plugin list`). Each leaf keys under
   * `${toolVerb} plugin ${leaf}` so `commandPath` resolves the doubly-nested path.
   * Optional so callers without tools (isolated tests) can omit it.
   */
  readonly toolPluginGroups?: readonly ToolPluginGroup[];
}

function addSpec(
  index: Map<string, CommandScopeRequirement>,
  pathPrefix: string | undefined,
  spec: CommandScopeSpec,
): void {
  const names = [spec.name, ...(spec.aliases ?? [])];
  names.forEach((name) => {
    index.set(pathPrefix === undefined ? name : `${pathPrefix} ${name}`, spec.scope);
  });
}

export function buildCommandScopeIndex(input: CommandScopeIndexInput): CommandScopeIndex {
  const index = new Map<string, CommandScopeRequirement>();

  // Tool specs key flat by `name`, EXCEPT `parent`-nested specs (the
  // `<tool> <verb>` grammar, taxonomy Task 0.4), which key under
  // `${parent} ${name}` so `commandPath` resolves `graph export` / `fit list`.
  input.toolSpecs.forEach((spec) => addSpec(index, spec.parent, spec));
  input.hostSpecs.forEach((spec) => addSpec(index, undefined, spec));
  input.hostGroups.forEach((group) => {
    group.leaves.forEach((leaf) => addSpec(index, group.name, leaf));
  });
  // Per-tool `plugin` group leaves key under the doubly-nested
  // `${toolVerb} plugin ${leaf}` path (e.g. `fit plugin list`), matching what
  // `commandPath` resolves for the mounted `opensip fit plugin list`.
  (input.toolPluginGroups ?? []).forEach((group) => {
    group.leaves.forEach((leaf) => addSpec(index, `${group.toolVerb} plugin`, leaf));
  });

  return index;
}

/**
 * Commander exposes the invoked leaf as `actionCommand`; walk its parents back
 * to the root program and keep only real subcommands. For `opensip tools list`,
 * this returns `tools list`, not just `list`.
 */
export function commandPath(actionCommand: Command): string {
  const parts: string[] = [];
  let cursor: Command | null = actionCommand;
  while (cursor !== null) {
    if (cursor.parent !== null) parts.push(cursor.name());
    cursor = cursor.parent;
  }
  const ordered = [...parts];
  ordered.reverse();
  return ordered.join(' ');
}
