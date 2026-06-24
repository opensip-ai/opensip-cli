/**
 * Draft command-spec helpers for defineTool identity normalization.
 *
 * Primary and nested drafts omit identity-derived fields; defineTool fills
 * name/aliases/parent before running assertCommandSpec.
 */

import type { CommandContext, CommandSpec } from './command-spec.js';

/** Marker: primary command draft — name/aliases supplied by defineTool. */
export const PRIMARY_COMMAND_DRAFT = Symbol.for('opensip-cli.primary-command-draft');

/** Marker: nested command draft — parent supplied by defineTool. */
export const NESTED_COMMAND_DRAFT = Symbol.for('opensip-cli.nested-command-draft');

export type PrimaryCommandSpecDraft<TOpts = unknown, TCtx = CommandContext> = Omit<
  CommandSpec<TOpts, TCtx>,
  'name' | 'aliases' | 'parent'
> & {
  readonly [PRIMARY_COMMAND_DRAFT]: true;
};

export type NestedCommandSpecDraft<TOpts = unknown, TCtx = CommandContext> = Omit<
  CommandSpec<TOpts, TCtx>,
  'parent'
> & {
  readonly [NESTED_COMMAND_DRAFT]: true;
};

export type ToolCommandSpecInput<TOpts = unknown, TCtx = CommandContext> =
  | CommandSpec<TOpts, TCtx>
  | PrimaryCommandSpecDraft<TOpts, TCtx>
  | NestedCommandSpecDraft<TOpts, TCtx>;

/** Type guard for a primary command draft (name/aliases filled by defineTool). */
export function isPrimaryCommandDraft<TOpts, TCtx>(
  spec: ToolCommandSpecInput<TOpts, TCtx>,
): spec is PrimaryCommandSpecDraft<TOpts, TCtx> {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    (spec as PrimaryCommandSpecDraft<TOpts, TCtx>)[PRIMARY_COMMAND_DRAFT] === true
  );
}

/** Type guard for a nested command draft (parent filled by defineTool). */
export function isNestedCommandDraft<TOpts, TCtx>(
  spec: ToolCommandSpecInput<TOpts, TCtx>,
): spec is NestedCommandSpecDraft<TOpts, TCtx> {
  return (
    typeof spec === 'object' &&
    spec !== null &&
    (spec as NestedCommandSpecDraft<TOpts, TCtx>)[NESTED_COMMAND_DRAFT] === true
  );
}

/** Primary run command draft — name/aliases supplied by defineTool from identity. */
export function definePrimaryCommand<TOpts, TCtx>(
  spec: Omit<CommandSpec<TOpts, TCtx>, 'name' | 'aliases' | 'parent'>,
): PrimaryCommandSpecDraft<TOpts, TCtx> {
  return { ...spec, [PRIMARY_COMMAND_DRAFT]: true };
}

/** Nested <tool> <verb> child draft — parent supplied by defineTool from identity. */
export function defineNestedCommand<TOpts, TCtx>(
  spec: Omit<CommandSpec<TOpts, TCtx>, 'parent'> & { readonly name: string },
): NestedCommandSpecDraft<TOpts, TCtx> {
  return { ...spec, [NESTED_COMMAND_DRAFT]: true };
}
