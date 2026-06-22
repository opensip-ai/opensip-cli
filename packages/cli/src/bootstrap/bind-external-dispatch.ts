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
 * ADR-0054 M4-E trust-tier flip: external tools fork the worker **by default**.
 * The former `OPENSIP_CLI_EXTERNAL_WORKER` opt-in gate is retired (M4-C landed
 * the full host-RPC seam surface, closing the parity gap that blocked the flip).
 * `OPENSIP_CLI_NO_WORKER` is now BUNDLED-ONLY — it never lets an external tool
 * run in-host (an external tool that cannot fork is a hard error, raised by the
 * supervisor, not a silent in-process fallback).
 *
 * Resolving provenance from the scope (not threading it through the mount chain)
 * keeps this additive: the mount signature is unchanged and host commands — whose
 * lean context has no run plane — never carry the hook.
 */

import {
  currentScope,
  type Tool,
  type ToolCliContext,
  type ToolPluginManifest,
} from '@opensip-cli/core';

import { dispatchExternalToolCommand } from './dispatch-external-tool-command.js';
import { provenanceRecordFor } from './tool-provenance.js';

/** Find the admitted manifest for `tool` (same stable-id-then-name match). */
function manifestFor(tool: Tool): ToolPluginManifest | undefined {
  const recorded = currentScope()?.toolManifests ?? [];
  return (
    recorded.find((m) => m.stableId !== undefined && m.stableId === tool.metadata.id) ??
    recorded.find((m) => m.id === tool.metadata.name)
  );
}

/**
 * Resolve the tool's RAW config namespace block for the WORKER deep pass
 * (ADR-0054 M4-E). The namespace is the tool's manifest config descriptor key;
 * the block is read from the host-validated document (`scope.configDocument`).
 * `undefined` when the tool declares no descriptor or the document has no block —
 * the worker then runs no deep pass for it.
 */
function deepConfigBlockFor(tool: Tool): unknown {
  const namespace = manifestFor(tool)?.config?.namespace;
  if (namespace === undefined) return undefined;
  return currentScope()?.configDocument?.[namespace];
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
    const provenance = provenanceRecordFor(tool, currentScope()?.toolProvenance ?? []);
    if (provenance === undefined || provenance.source === 'bundled') {
      // No external provenance recorded (or bundled) → in-process (the trusted /
      // unknown path), byte-identical to before. ADR-0054 trust tiers: bundled
      // tools are the trusted computing base.
      return false;
    }
    // ADR-0054 M4-E trust-tier flip: an external tool ALWAYS forks the worker
    // (no opt-in gate). `OPENSIP_CLI_NO_WORKER` does not apply here — it is
    // bundled-only; the supervisor hard-errors if the fork fails (never an
    // in-host run of untrusted code).
    await dispatchExternalToolCommand({
      provenance,
      commandName,
      opts,
      positionals,
      ctx,
      config: deepConfigBlockFor(tool),
    });
    return true;
  };
}
