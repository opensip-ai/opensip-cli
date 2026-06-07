/**
 * composer — merges the registered namespaced schemas into one strict
 * whole-document schema, and validates a raw config document against it.
 *
 * ADR-0023. Each tool contributes a {@link ToolConfigDeclaration}; the host
 * composes them into a single Zod object keyed by namespace. Two rules govern
 * unknown keys:
 *
 *   1. STRICT within a namespace — an unknown key inside a *known* namespace
 *      (e.g. `fitness.faliOnErrors`, a typo) is rejected. Achieved by making
 *      each namespace's object schema `.strict()`.
 *
 *   2. TOLERANT at the document level — an unknown *top-level* key not yet
 *      claimed by any registered namespace (e.g. `cli:`, `targets:`,
 *      `globalExcludes:`) is passed through, not rejected. This is the 2.10.1
 *      migration seam: those blocks have not been migrated to namespaced
 *      declarations in 2.10.0, so the composed document must not fail on them.
 *      Achieved by a `.catchall(z.unknown())` (a.k.a. passthrough) at the
 *      document level. When those blocks migrate to declarations in 2.10.1,
 *      they become known namespaces and gain the same strict treatment.
 *
 * A validation failure in ANY namespace throws the same typed
 * {@link ConfigurationError} (→ `CONFIGURATION_ERROR` exit), so a typo in
 * `fitness` and a typo in `graph` fail identically.
 */

import { ConfigurationError } from '@opensip-tools/core';
import { z, type ZodType } from 'zod';

import type { ToolConfigDeclaration } from './declaration.js';

/**
 * Make a namespace schema reject unknown keys.
 *
 * Object schemas gain `.strict()`. A non-object schema (a tool could contribute
 * a `z.record(...)` or a union) has no "unknown key" concept, so it is returned
 * unchanged — strictness is meaningful only for object shapes.
 */
function strictenNamespace(schema: ZodType): ZodType {
  if (schema instanceof z.ZodObject) {
    return schema.strict();
  }
  return schema;
}

/**
 * Compose the registered tool declarations into one strict whole-document
 * schema.
 *
 * The result is a Zod object whose keys are the registered namespaces (each a
 * strict version of the tool's schema, made optional so a config omitting a
 * tool's block is valid) plus a catchall that tolerates unclaimed top-level
 * keys (the 2.10.1 seam).
 *
 * @param declarations The tool declarations to compose. Duplicate namespaces
 *   are rejected — two tools may not own the same top-level key.
 */
export function composeConfigSchema(
  declarations: readonly ToolConfigDeclaration[],
): ZodType {
  const shape: Record<string, ZodType> = {};
  for (const decl of declarations) {
    if (Object.prototype.hasOwnProperty.call(shape, decl.namespace)) {
      throw new ConfigurationError(
        `Duplicate config namespace '${decl.namespace}': two tools cannot own the same top-level key.`,
        { code: 'CONFIGURATION_ERROR', namespace: decl.namespace },
      );
    }
    // Optional so a document that omits a tool's block stays valid; strict so a
    // typo *inside* the block is rejected.
    shape[decl.namespace] = strictenNamespace(decl.schema).optional();
  }
  // `.catchall(z.unknown())` tolerates unclaimed top-level keys — the 2.10.1
  // migration seam. Strictness lives inside each namespace, not at the document
  // root.
  return z.object(shape).catchall(z.unknown());
}

/**
 * Validate a raw config document against the composed schema.
 *
 * @returns The parsed, type-narrowed document on success.
 * @throws {ConfigurationError} On any validation failure, with the formatted
 *   Zod issues attached as `issues` for diagnosis. The same error shape is
 *   thrown regardless of which namespace failed.
 */
export function validateConfigDocument(schema: ZodType, raw: unknown): unknown {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues;
  const summary = issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(document root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  const error = new ConfigurationError(`Invalid configuration: ${summary}`, {
    code: 'CONFIGURATION_ERROR',
  });
  // Attach the formatted Zod issues for downstream diagnosis. The base
  // ToolError constructor only copies `code` off the options bag, so the
  // structured issues must be set on the instance directly.
  Object.defineProperty(error, 'issues', {
    value: issues,
    enumerable: true,
    writable: false,
  });
  throw error;
}
