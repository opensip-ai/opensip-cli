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

import { NEAR_DUP_SIGNATURE_K } from '../lang-adapter/near-duplicate-signature.js';
import {
  MAX_AUDIT_TEST_SOURCE_GLOBS,
  MAX_AUDIT_TEST_SOURCE_GLOB_LENGTH,
  MAX_AUDIT_TEST_SOURCE_GLOB_TOKENS,
} from '../types.js';

import type { GraphConfig } from '../types.js';
import type { ToolConfigDeclaration } from '@opensip-cli/config';

/** Severity posture for the size-2 cycle band — `off` or `low` (GraphConfig). */
const cycleSize2Severity = z.enum(['off', 'low']);

/** Per-rule severity-override value — `error` or `warning` (GraphConfig). */
const severityOverrideValue = z.enum(['error', 'warning']);

const EXTGLOB_PREFIXES = ['?(', '*(', '+(', '@(', '!('] as const;

/** Count wildcard/character-class tokens (`* ? [ ]`) in one glob pattern. */
function countGlobTokens(pattern: string): number {
  let count = 0;
  for (const ch of pattern) {
    if (ch === '*' || ch === '?' || ch === '[' || ch === ']') count += 1;
  }
  return count;
}

/**
 * Validate ONE audit-test source-role glob, returning a human error or
 * `undefined` when acceptable (P2 Phase 1.3). The pattern must be a bounded,
 * project-relative POSIX glob with no absolute/drive root, backslash, parent
 * traversal, brace expansion, extglob, leading negation, or comment form.
 */
function auditGlobError(pattern: string): string | undefined {
  if (pattern.length === 0) return 'must be non-empty';
  if (pattern.length > MAX_AUDIT_TEST_SOURCE_GLOB_LENGTH) {
    return `must be at most ${String(MAX_AUDIT_TEST_SOURCE_GLOB_LENGTH)} characters`;
  }
  if (/\p{Cc}/u.test(pattern)) return 'must not contain NUL or control characters';
  if (pattern.includes('\\')) return 'must not contain a backslash (POSIX-relative only)';
  if (pattern.startsWith('/')) return 'must be project-relative (no leading "/")';
  if (/^[A-Za-z]:/.test(pattern)) return 'must not have a drive prefix';
  if (pattern.startsWith('!')) return 'must not start with a negation "!"';
  if (pattern.startsWith('#')) return 'must not be a comment form ("#")';
  if (pattern.includes('{') || pattern.includes('}')) return 'must not use brace expansion';
  if (EXTGLOB_PREFIXES.some((prefix) => pattern.includes(prefix))) {
    return 'must not use extglob operators';
  }
  if (pattern.split('/').includes('..')) return 'must not contain a ".." traversal segment';
  if ((pattern.match(/\[/g)?.length ?? 0) !== (pattern.match(/\]/g)?.length ?? 0)) {
    return 'has an unbalanced character class';
  }
  if (countGlobTokens(pattern) > MAX_AUDIT_TEST_SOURCE_GLOB_TOKENS) {
    return `must have at most ${String(MAX_AUDIT_TEST_SOURCE_GLOB_TOKENS)} wildcard/class tokens`;
  }
  return undefined;
}

/**
 * Bounded, unique, strictly-validated audit-test source-role glob list. Mirrors
 * `GraphConfig.auditTestSourceGlobs`; the composer folds it into the strict
 * whole-document schema.
 */
const auditTestSourceGlobsSchema = z
  .array(z.string())
  .max(MAX_AUDIT_TEST_SOURCE_GLOBS)
  .readonly()
  .superRefine((patterns, ctx) => {
    const seen = new Set<string>();
    for (const [index, pattern] of patterns.entries()) {
      const error = auditGlobError(pattern);
      if (error !== undefined) {
        ctx.addIssue({ code: 'custom', message: `glob ${error}`, path: [index] });
        continue;
      }
      if (seen.has(pattern)) {
        ctx.addIssue({ code: 'custom', message: 'duplicate glob pattern', path: [index] });
      }
      seen.add(pattern);
    }
  });

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
  nearDuplicateLshBands: z
    .number()
    .int()
    .min(1)
    .refine((n) => NEAR_DUP_SIGNATURE_K % n === 0, {
      message: `must divide the MinHash signature length (${String(NEAR_DUP_SIGNATURE_K)}) evenly`,
    })
    .optional(),
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
  auditTestSourceGlobs: auditTestSourceGlobsSchema.optional(),
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
