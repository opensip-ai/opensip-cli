/**
 * host-subcommand-groups — the action-less Commander subcommand GROUPS
 * (`sessions`, `tools`) and their leaf {@link CommandSpec}s, PLUS the
 * DOMAIN-BOUND per-tool `plugin` group leaves (launch Phase 6 + the
 * command-surface-taxonomy "packs under the tool" refinement).
 *
 * Split out of `host-command-specs.ts` for ONE reason: to break a module cycle.
 * The completion-script generator (`completion.ts`) sources its `sessions` /
 * `tools` sub-subcommand NAME lists from the live leaf specs (single source —
 * Phase 6 Task 6.2), so it must import the group inventory. The
 * `host-command-specs.ts` module, in turn, imports `printCompletionScript` from
 * `completion.ts` for the `completion` command's handler. Housing the GROUP
 * leaves + inventory here (a module that imports NEITHER `completion.ts` nor
 * `host-command-specs.ts`) lets both depend on this leaf module without a cycle.
 *
 * Leaf specs are split across `host-subcommand-sessions.ts` and
 * `host-subcommand-plugins.ts` to stay under the file-length-limit; this module
 * remains the cycle-free assembly + inventory surface.
 */

import { buildSessionsGroupLeaves } from './host-subcommand-sessions.js';
import { type HostSpec } from './host-subcommand-shared.js';
import { buildToolsGroupLeaves } from './tools/index.js';

import type { CliCommandsContext } from './shared.js';

export type { HostSpec } from './host-subcommand-shared.js';
export { effectiveCwd } from './host-subcommand-shared.js';
export {
  buildToolPluginLeaves,
  buildToolPluginGroups,
  mountToolPluginGroups,
  type ToolPluginGroup,
} from './host-subcommand-plugins.js';

/** One subcommand-group parent: a raw action-less `program.command(name)`
 *  shell + the leaf specs that mount onto it. */
export interface HostSubcommandGroup {
  readonly name: string;
  readonly description: string;
  readonly leaves: readonly HostSpec[];
}

/**
 * The action-less Commander subcommand GROUPS that legitimately cannot be a
 * single {@link CommandSpec} — they have no action body, only sub-subcommands.
 * This is the FINITE, NAMED set the Phase 7 `command-surface-parity` guardrail
 * allow-lists as documented host exceptions. Every other host command IS a spec.
 */
export const HOST_SUBCOMMAND_GROUPS: readonly string[] = ['sessions', 'tools'] as const;

/** Build the subcommand-group parents with their leaf specs. */
export function buildHostSubcommandGroups(ctx: CliCommandsContext): readonly HostSubcommandGroup[] {
  return [
    {
      name: 'sessions',
      description: 'Manage session data',
      leaves: buildSessionsGroupLeaves(ctx),
    },
    {
      name: 'tools',
      description: 'Manage whole Tool plugins (list, validate, install, uninstall)',
      leaves: buildToolsGroupLeaves(ctx),
    },
  ];
}

const INVENTORY_CTX: CliCommandsContext = {
  setExitCode: () => {
    /* inert — inventory builds never dispatch a handler */
  },
  render: () => Promise.resolve(),
  emitJson: () => {
    /* inert — inventory builds never dispatch a handler */
  },
  emitRaw: () => {
    /* inert — inventory builds never dispatch a handler */
  },
  emitError: () => {
    /* inert — inventory builds never dispatch a handler */
  },
  pluginLayouts: [],
  toolScaffolds: [],
  // eslint-disable-next-line unicorn/no-useless-undefined -- explicit no-store sentinel matching the `datastore` thunk contract
  datastore: () => undefined,
};

export interface HostCommandInventory {
  readonly groupSubcommands: Readonly<Record<string, readonly string[]>>;
}

/** Build the host subcommand-group name inventory (single source for completion). */
export function buildHostCommandInventory(): HostCommandInventory {
  const groupSubcommands: Record<string, readonly string[]> = {};
  for (const group of buildHostSubcommandGroups(INVENTORY_CTX)) {
    groupSubcommands[group.name] = group.leaves.map((l) => l.name);
  }
  return { groupSubcommands };
}
