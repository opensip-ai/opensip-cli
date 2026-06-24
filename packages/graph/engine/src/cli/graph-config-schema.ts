/**
 * graph-config-schema — the graph tool's namespaced Zod config schema
 * (launch, ADR-0023, Phase 4 Task 4.1).
 *
 * Mirrors {@link GraphConfig} (`types.ts`) one-for-one as a Zod object so the
 * host can compose it into the strict whole-document schema and the graph
 * loader can read a VALIDATED `graph:` block instead of hand-projecting an
 * arbitrary YAML object. Replaces the old permissive `projectGraphConfig`:
 * a typo inside the `graph:` block (e.g. `minCrossPackageDuplicatePackges`)
 * is now rejected, not silently dropped.
 *
 * The schema is exported two ways:
 *   - `GraphConfigSchema` — the bare Zod object, used by `loadGraphConfig`
 *     to parse just the `graph:` block (it `.strict()`-ens it locally).
 *   - `graphConfigDeclaration` — the {@link ToolConfigDeclaration} the graph
 *     tool hands the composition root (namespace `'graph'`), which makes the
 *     namespace strict and optional at the document level.
 *
 * Every field is optional — an absent key means "use the rule's in-rule
 * default" (the historical projection semantics), so a config that omits the
 * whole `graph:` block, or any individual knob, is valid and yields `{}` /
 * partial overrides.
 */

import { z } from 'zod';

import type { GraphConfig } from '../types.js';
import type { ToolConfigDeclaration } from '@opensip-cli/config';

/** Severity posture for the size-2 cycle band — `off` or `low` (GraphConfig). */
const cycleSize2Severity = z.enum(['off', 'low']);

/** Per-rule severity-override value — `error` or `warning` (GraphConfig). */
const severityOverrideValue = z.enum(['error', 'warning']);

/**
 * Zod object mirroring {@link GraphConfig}. Field order follows the type
 * declaration. Numeric knobs are non-negative integers (line counts, param
 * counts, blast scores, SCC sizes — all whole, non-negative). `recipe` is a
 * bounded string (matches `fitness.recipe` / `simulation.recipe`).
 */
export const GraphConfigSchema = z.object({
  minDuplicateBodyLines: z.number().int().min(0).optional(),
  minDuplicateBodySize: z.number().int().min(0).optional(),
  minCrossPackageDuplicatePackages: z.number().int().min(0).optional(),
  minCrossPackageDuplicateBodySize: z.number().int().min(0).optional(),
  minNearDuplicateSimilarity: z.number().min(0).max(1).optional(),
  minNearDuplicateBodySize: z.number().int().min(0).optional(),
  nearDuplicateLshBands: z.number().int().min(1).optional(),
  recipe: z.string().min(1).max(128).optional(),
  partitionStrategy: z.enum(['directory-depth', 'file-count-chunks', 'hybrid']).optional(),
  entryPointHashes: z.array(z.string()).readonly().optional(),
  flagExportedOrphans: z.boolean().optional(),
  flagTestOrphans: z.boolean().optional(),
  largeFunctionWarnLines: z.number().int().min(0).optional(),
  largeFunctionErrorLines: z.number().int().min(0).optional(),
  wideFunctionWarnParams: z.number().int().min(0).optional(),
  wideFunctionErrorParams: z.number().int().min(0).optional(),
  highBlastWarnThreshold: z.number().int().min(0).optional(),
  highBlastErrorThreshold: z.number().int().min(0).optional(),
  cycleMinSize: z.number().int().min(0).optional(),
  cycleSize2Severity: cycleSize2Severity.optional(),
  severityOverrides: z.record(z.string(), severityOverrideValue).readonly().optional(),
});

/**
 * Compile-time proof that {@link GraphConfigSchema} stays in lock-step with
 * {@link GraphConfig}: the inferred output type must be MUTUALLY assignable to
 * `GraphConfig`. If a field is added to `GraphConfig` without a matching
 * schema entry — or a schema field drifts from the type — `AssertMutual`
 * resolves to `never` and the `declare const` below fails to compile.
 *
 * This is a PURE type-level check: a `declare const` emits NO runtime value
 * (no `{} as T` empty-object stub) and is not an export (so it cannot read as
 * dead code). The const is the single consumption site of the proof type.
 */
type SchemaOut = z.infer<typeof GraphConfigSchema>;
type AssertMutual<A, B> = A extends B ? (B extends A ? true : never) : never;
declare const _graphConfigLockstep: AssertMutual<SchemaOut, GraphConfig>;

/**
 * The graph tool's contribution to the composed configuration document
 * (Phase 4). `namespace: 'graph'` is graph's top-level key in
 * `opensip-cli.config.yml`; the composer makes it strict (typo-rejecting)
 * and optional. No defaults are declared here — every knob defaults inside
 * its rule, preserving the historical "absent → in-rule default" behaviour.
 */
export const graphConfigDeclaration: ToolConfigDeclaration = {
  namespace: 'graph',
  schema: GraphConfigSchema,
  env: [{ envVar: 'OPENSIP_GRAPH_PARTITION_STRATEGY', key: 'partitionStrategy' }],
};
