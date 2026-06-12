// @fitness-ignore-file null-safety -- Zod schema builder chains (.strict()/.optional()/.catchall()) always return valid schema objects; there is no nullable access
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
 *   2. TOLERANT at the document level — a top-level key claimed by NO
 *      registered declaration is passed through, not rejected. This is a
 *      deliberate, permanent forward-compatibility contract, NOT migration
 *      debt: a config document may carry a namespace block for a tool that is
 *      not installed in this run (a third-party plugin missing from
 *      `plugins.<domain>`, or one config shared across projects with
 *      different tool sets). Rejecting it would make installing/uninstalling
 *      a tool break the shared document. Achieved by a
 *      `.catchall(z.unknown())` at the document level. The moment a namespace
 *      IS claimed — by a tool declaration or a host declaration
 *      (`document/host-declarations.ts` claims `cli`, `targets`,
 *      `globalExcludes`, `checkOverrides`, `dashboard`, `plugins`,
 *      `schemaVersion`) — it gains the strict treatment of rule 1.
 *      (Historical note: pre-2.10.1 this catchall also covered the
 *      then-unclaimed host blocks; that migration use ended when
 *      host-declarations claimed them.)
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
 * keys (the uninstalled-tool forward-compat contract — see the module
 * docstring, rule 2).
 *
 * @param declarations The tool declarations to compose. Duplicate namespaces
 *   are rejected — two tools may not own the same top-level key.
 */
export function composeConfigSchema(declarations: readonly ToolConfigDeclaration[]): ZodType {
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
  // `.catchall(z.unknown())` tolerates unclaimed top-level keys — the
  // namespace block of a tool not installed in this run must pass through
  // (forward compat; module docstring rule 2). Strictness lives inside each
  // claimed namespace, not at the document root.
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
