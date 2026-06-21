/**
 * bind-external-dispatch — per-tool wiring of the ADR-0054 out-of-process
 * dispatch hook (`RunActionHooks.maybeDispatchExternal`).
 *
 * `mountOneTool` calls {@link buildMaybeDispatchExternal} to bind a dispatch
 * hook to one tool. At dispatch time the hook resolves the tool's provenance
 * from `currentScope().toolProvenance` (recorded by the bootstrap, paired with
 * the tool registry by stable id):
 *
 *   - BUNDLED provenance (or no provenance recorded) → returns `false`; the
 *     command action runs the handler in-process, byte-identical to before.
 *     Bundled tools are the trusted computing base (ADR-0054 trust tiers).
 *   - EXTERNAL provenance (installed / project-local / user-global) → forks the
 *     worker via {@link dispatchExternalToolCommand}, which imports the untrusted
 *     runtime in the worker, runs the handler, and replays the slim result
 *     through the host seams; returns `true` so the action skips the in-process
 *     path.
 *
 * Resolving provenance from the scope (not threading it through the mount chain)
 * keeps this additive: the mount signature is unchanged and host commands — whose
 * lean context has no run plane — never carry the hook.
 */

import {
  currentScope,
  type Tool,
  type ToolCliContext,
  type ToolProvenance,
} from '@opensip-cli/core';

import { hostEnv } from '../env/host-env-specs.js';

import { dispatchExternalToolCommand } from './dispatch-external-tool-command.js';

/**
 * Find the provenance recorded for `tool` this run. `ToolProvenance.stableId`
 * (optional UUID) maps to `tool.metadata.id`; `ToolProvenance.id` (human key)
 * maps to `tool.metadata.name`. Prefer the stable-id match, fall back to the
 * human key so a tool that declared no `stableId` still resolves.
 */
function provenanceFor(tool: Tool): ToolProvenance | undefined {
  const recorded = currentScope()?.toolProvenance ?? [];
  return (
    recorded.find((p) => p.stableId !== undefined && p.stableId === tool.metadata.id) ??
    recorded.find((p) => p.id === tool.metadata.name)
  );
}

/**
 * Build the `maybeDispatchExternal` hook bound to one tool + its host context.
 * The returned hook is merged onto the bound `ToolCliContext` by `mountOneTool`.
 */
export function buildMaybeDispatchExternal(
  tool: Tool,
  ctx: ToolCliContext,
): (
  commandName: string,
  opts: Record<string, unknown>,
  positionals: readonly unknown[],
) => Promise<boolean> {
  return async (commandName, opts, positionals) => {
    // ADR-0054 M4 vertical slice: out-of-process dispatch is OPT-IN until the
    // host-RPC seams land (M4-E). Default off keeps production behaviour and the
    // bundled ≡ installed parity invariant byte-identical (ADR-0027).
    if (hostEnv.get<boolean>('OPENSIP_CLI_EXTERNAL_WORKER') !== true) return false;
    const provenance = provenanceFor(tool);
    if (provenance === undefined || provenance.source === 'bundled') {
      // No external provenance recorded → in-process (the trusted / unknown path).
      return false;
    }
    await dispatchExternalToolCommand({
      provenance,
      commandName,
      opts,
      positionals,
      ctx,
    });
    return true;
  };
}
