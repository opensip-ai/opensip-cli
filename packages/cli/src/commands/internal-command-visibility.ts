/**
 * internal-command-visibility — the single host source of truth for the
 * tool-command-surface-taxonomy Tier-3 hide policy.
 *
 * Two host-owned primitives, used in lockstep so `--help` and shell completion
 * agree on exactly which commands are internal and when they are revealed:
 *
 *   - {@link internalCommandNames} walks the populated per-invocation
 *     `ToolRegistry` and collects every command whose `ToolCommandDescriptor`
 *     declares `visibility: 'internal'`. This is the descriptor-driven set the
 *     help hide pass (`register-tools-mount.ts`) and the completion inventory
 *     (`host-command-specs.ts` → `assembleCompletionInventory`) both consume —
 *     so adding a new internal worker is a one-line descriptor change, not a
 *     hand-maintained list edit in two places.
 *
 *   - {@link showInternalCommands} is the single env predicate
 *     (`OPENSIP_CLI_SHOW_INTERNAL=1`) that un-hides internal commands across
 *     help + completion. Routed through the host {@link hostEnv} registry (the
 *     `env-via-registry` guardrail), so the value is documented in the env
 *     surface and read in exactly one place.
 *
 * Asymmetry (deliberate): the agent-catalog is a CURATED machine surface, not a
 * debug dump, so it NEVER surfaces internal commands and the env reveal does NOT
 * apply to it. Only `--help` and shell completion honour the override.
 */

import { resolveToolCommands, type ToolRegistry } from '@opensip-cli/core';

import { hostEnv } from '../env/host-env-specs.js';

/**
 * Host-owned internal command names — `visibility: 'internal'` commands the HOST
 * mounts (not from a tool registry). Today just the ADR-0054 M4-E dispatch worker
 * subcommand `__tool-command-worker` (forked by the supervisor; never a public
 * surface). Unioned into {@link internalCommandNames} so the help hide pass +
 * completion treat it as internal exactly like the tool workers.
 */
export const HOST_INTERNAL_COMMANDS: ReadonlySet<string> = new Set(['__tool-command-worker']);

/**
 * Collect the names of every command declared `visibility: 'internal'` (Tier-3):
 * each tool's internal commands (from `registry`) PLUS the host-owned internal
 * commands ({@link HOST_INTERNAL_COMMANDS}). The single host source for "which
 * mounted commands are internal", read by the help hide pass and the completion
 * inventory so the two never drift.
 */
export function internalCommandNames(registry: ToolRegistry): ReadonlySet<string> {
  const names = new Set<string>(HOST_INTERNAL_COMMANDS);
  for (const tool of registry.list()) {
    for (const descriptor of resolveToolCommands(tool)) {
      if (descriptor.visibility === 'internal') names.add(descriptor.name);
    }
  }
  return names;
}

/**
 * Whether internal (Tier-3) commands should be REVEALED on the public surfaces
 * that honour the override (`--help`, shell completion). True iff
 * `OPENSIP_CLI_SHOW_INTERNAL` is exactly `'1'` (the env spec's strict coerce).
 *
 * The agent-catalog deliberately does NOT consult this — see the module JSDoc.
 */
export function showInternalCommands(): boolean {
  return hostEnv.get<boolean>('OPENSIP_CLI_SHOW_INTERNAL') === true;
}
