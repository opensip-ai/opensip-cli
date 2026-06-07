/**
 * json-schema — emit a JSON Schema for `opensip-tools.config.yml`.
 *
 * Editors and docs consume a JSON Schema for the whole document so an author
 * gets completion + validation in their editor. The schema is generated from
 * the composed Zod schema (see {@link ./composer}) — single source of truth, no
 * hand-maintained mirror.
 *
 * zod 4 ships a built-in `z.toJSONSchema`, so no extra dependency is needed.
 */

import { z, type ZodType } from 'zod';

/** A JSON Schema document (object form). */
export type JsonSchema = Record<string, unknown>;

/**
 * Emit a JSON Schema for the composed config document.
 *
 * @param composed The whole-document schema returned by `composeConfigSchema`.
 * @returns A JSON Schema object whose `properties` include each registered
 *   namespace. The document-level catchall (the 2.10.1 migration seam) renders
 *   as `additionalProperties`, so unclaimed top-level keys remain permitted.
 */
export function toJsonSchema(composed: ZodType): JsonSchema {
  // `io: 'input'` so the schema describes the *authored* document (pre-default
  // application), which is what an editor validates as the user types.
  return z.toJSONSchema(composed, { io: 'input' });
}
