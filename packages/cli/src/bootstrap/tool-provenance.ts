/**
 * tool-provenance — the shared per-run provenance classifier + the host/worker
 * hook-execution gate (ADR-0054 M4-F).
 *
 * Three sites resolve a tool's `ToolProvenance.source` from the per-run
 * provenance array (recorded by the bootstrap, matched by stable id then human
 * name): `bind-external-dispatch.ts` (dispatch gate), `config-and-capabilities.ts`
 * (config two-pass fold + capability wiring), and now the lifecycle host loops
 * (contributeScope / initialize / report / replay). This module is the ONE matcher
 * so they never drift.
 *
 * It also owns the **host-vs-worker** gate that makes the M4-F lifecycle skip
 * correct. M4-F stops the HOST from executing external-provenance lifecycle +
 * capability hooks — but the dispatch WORKER re-runs the SAME bootstrap code
 * (`build-per-run-scope` / `config-and-capabilities`) and MUST run the dispatched
 * external tool's hooks there (the worker is the legitimate isolation boundary —
 * that is the whole point: external runtime executes in the worker, not the host).
 *
 * So the skip is gated on "this process is the HOST, not a dispatch worker." The
 * supervisor sets {@link IN_TOOL_WORKER_ENV} on the forked child's env; inside the
 * worker {@link isExternalHookHostSkipActive} returns `false`, so the worker runs
 * ALL its registered tools' hooks worker-local exactly as a normal in-process
 * bootstrap would. In the host it returns `true`, so external hooks are skipped.
 */

import { type Tool, type ToolProvenance, type ToolSource } from '@opensip-cli/core';

/**
 * Env flag the dispatch supervisor sets on the forked `__tool-command-worker`
 * child so the worker can tell it is the isolation boundary (NOT the host). The
 * worker bootstrap runs the SAME lifecycle loops as the host; this flag disables
 * the M4-F external-hook host-skip inside the worker so the dispatched tool's
 * hooks run there. A separate process + env channel (symmetric to OPENSIP_RUN_ID
 * injection) keeps it deterministic and unit-testable.
 */
export const IN_TOOL_WORKER_ENV = 'OPENSIP_CLI_IN_TOOL_WORKER';

/**
 * Is the M4-F external-hook host-skip ACTIVE in this process? `true` in the host
 * (skip external hooks), `false` inside a dispatch worker (run them — the worker
 * is the isolation boundary). Reads the injected env (defaults to `process.env`)
 * so tests can flip it deterministically without a fork.
 */
export function isExternalHookHostSkipActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[IN_TOOL_WORKER_ENV] !== '1';
}

/**
 * Resolve a tool's provenance source from the per-run provenance array. Mirrors
 * the dispatch/config matchers: prefer the stable-id match (UUID → `metadata.id`),
 * fall back to the human key (`ToolProvenance.id` → `metadata.name`). A tool with
 * NO recorded provenance is the trusted/unknown path → `'bundled'` semantics (its
 * hooks run in-host, exactly as before M4-F).
 */
export function provenanceSourceFor(tool: Tool, provenance: readonly ToolProvenance[]): ToolSource {
  const recorded =
    provenance.find((p) => p.stableId !== undefined && p.stableId === tool.metadata.id) ??
    provenance.find((p) => p.id === tool.metadata.name);
  return recorded?.source ?? 'bundled';
}

/** Find the full provenance record for a tool (stable-id then human-name match). */
export function provenanceRecordFor(
  tool: Tool,
  provenance: readonly ToolProvenance[],
): ToolProvenance | undefined {
  return (
    provenance.find((p) => p.stableId !== undefined && p.stableId === tool.metadata.id) ??
    provenance.find((p) => p.id === tool.metadata.name)
  );
}

/**
 * Is this tool external-provenance (installed / project-local / user-global)? A
 * tool with no recorded provenance is treated as bundled (trusted/unknown path).
 */
export function isExternalToolProvenance(
  tool: Tool,
  provenance: readonly ToolProvenance[],
): boolean {
  return provenanceSourceFor(tool, provenance) !== 'bundled';
}

/**
 * The M4-F gate: should this tool's lifecycle/capability hook run IN THE HOST
 * process this invocation?
 *
 *   - Bundled (or no provenance recorded) → `true` (trusted computing base; runs
 *     in-host exactly as before M4-F).
 *   - External, host-skip ACTIVE (we are the host) → `false` (the host never
 *     executes external runtime hooks; they run worker-side).
 *   - External, host-skip INACTIVE (we are inside a dispatch worker) → `true`
 *     (the worker IS the isolation boundary — run the dispatched tool's hooks
 *     worker-local).
 *
 * @param env Injected env (defaults to `process.env`) for the worker-flag read.
 */
export function shouldRunHookInHost(
  tool: Tool,
  provenance: readonly ToolProvenance[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isExternalToolProvenance(tool, provenance)) return true;
  return !isExternalHookHostSkipActive(env);
}
