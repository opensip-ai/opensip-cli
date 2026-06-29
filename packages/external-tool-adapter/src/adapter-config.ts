/**
 * @fileoverview The DEFAULT namespaced config contribution every adapter claims
 * (ADR-0090 §4.3 / ADR-0023 / ADR-0054 M4-E).
 *
 * Without a claimed namespace `cli.scope.toolConfig?.[<tool>]` is ALWAYS
 * `undefined`, so (1) the documented `binaries.<tool>.path` operator pin is dead,
 * (2) the per-tool verdict policy keys (`failOnErrors`/`failOnWarnings`/
 * `failOnDegraded`) are non-configurable, and (3) an operator adding a `<tool>:`
 * block to `opensip-cli.config.yml` hits the ADR-0043 unclaimed-namespace
 * rejection and BRICKS every project command. So an adapter claims its namespace
 * by default — on BOTH the runtime (the Zod schema the WORKER deep pass runs) and
 * the static manifest (the JSON-Schema descriptor the HOST coarse pass validates
 * against pre-fork, since the host never imports the tool's Zod — ADR-0054 M4-E).
 *
 * Two halves, kept in lock-step:
 *   - {@link defaultAdapterConfigSchema} — the runtime Zod. The DEEP pass
 *     (`runDeepConfigPass`, worker-side) runs THIS raw schema (it is NOT the
 *     gate-key-decorated one the host composes), so the gate keys MUST be declared
 *     here or a `<tool>: { failOnWarnings: … }` block would fail the deep pass.
 *   - {@link defaultAdapterConfigManifest} — the serializable JSON-Schema
 *     descriptor. Declares ONLY `binaries` (coarse — host validates structure
 *     pre-fork); the host folds in the reserved gate keys via
 *     `decorateToolConfigDeclarationsWithGateKeys` exactly as it does for a bundled
 *     tool, so the gate thresholds are configurable like any bundled tool.
 *
 * `binaries` is a `{ <tool>: { path } }` map (the resolver reads
 * `binaries[<tool>].path`, mirroring `binaries.<tool>.path` in the docs).
 */

import { z } from 'zod';

import type { JsonSchemaObject, ToolConfigManifestDescriptor } from '@opensip-cli/core';

/** The author-facing config slot (namespace is derived from identity by `defineTool`). */
export interface AdapterConfigContribution {
  /** The namespace Zod schema — a strict object claiming `binaries` + the gate keys. */
  readonly schema: z.ZodType;
}

/**
 * The runtime Zod schema the default adapter config claims for its namespace:
 * the operator binary pin (`binaries.<tool>.path`) PLUS the three reserved
 * verdict-policy keys. Strict, so a typo inside the block is rejected by the
 * worker deep pass. The gate keys are declared HERE (unlike a bundled tool, which
 * leans on the host decorator) because the worker deep pass runs this raw schema —
 * the decorated one only governs the host pre-fork pass.
 */
export function defaultAdapterConfigSchema(): z.ZodType {
  return z
    .object({
      binaries: z
        .record(z.string(), z.object({ path: z.string().min(1).optional() }).strict())
        .optional(),
      failOnErrors: z.number().int().min(0).optional(),
      failOnWarnings: z.number().int().min(0).optional(),
      failOnDegraded: z.boolean().optional(),
    })
    .strict();
}

/** The default config contribution forwarded to `defineTool` when a spec omits `config`. */
export function defaultAdapterConfig(): AdapterConfigContribution {
  return { schema: defaultAdapterConfigSchema() };
}

/**
 * The serializable JSON-Schema descriptor the host coarse pass validates an
 * installed adapter's `<tool>:` block against BEFORE forking (it never imports
 * the tool's Zod — ADR-0054 M4-E). Declares ONLY the `binaries` block as a coarse
 * object; the reserved gate keys are folded in host-side by
 * `decorateToolConfigDeclarationsWithGateKeys`, so they are NOT (and must not be)
 * duplicated here — that keeps the gate-key min(0) policy single-sourced in the
 * decorator, exactly as for a bundled tool. The deep, value-level validation of
 * `binaries.<tool>.path` runs worker-side via {@link defaultAdapterConfigSchema}.
 */
export function defaultAdapterConfigManifest(namespace: string): ToolConfigManifestDescriptor {
  const schema: JsonSchemaObject = {
    type: 'object',
    properties: {
      binaries: { type: 'object' },
    },
  };
  return { namespace, schema };
}
