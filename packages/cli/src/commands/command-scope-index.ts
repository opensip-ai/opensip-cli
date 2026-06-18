/**
 * command-scope-index — the runtime lookup used by pre-action bootstrap to
 * decide whether a command may run without an opensip-cli project.
 *
 * The index is built from the same declarative CommandSpecs that are mounted
 * into Commander: top-level host specs, grouped host leaves, and tool
 * commandSpecs. This keeps `CommandSpec.scope` as the source of truth instead
 * of a parallel allowlist.
 */

import type { HostSubcommandGroup } from './host-subcommand-groups.js';
import type { CommandScopeRequirement } from '@opensip-cli/core';
import type { Command } from 'commander';

export type CommandScopeIndex = ReadonlyMap<string, CommandScopeRequirement>;

export interface CommandScopeSpec {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly scope: CommandScopeRequirement;
}

export interface CommandScopeIndexInput {
  readonly hostSpecs: readonly CommandScopeSpec[];
  readonly hostGroups: readonly HostSubcommandGroup[];
  readonly toolSpecs: readonly CommandScopeSpec[];
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

  input.toolSpecs.forEach((spec) => addSpec(index, undefined, spec));
  input.hostSpecs.forEach((spec) => addSpec(index, undefined, spec));
  input.hostGroups.forEach((group) => {
    group.leaves.forEach((leaf) => addSpec(index, group.name, leaf));
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
