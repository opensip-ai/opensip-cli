/**
 * json-schema — emit a JSON Schema for `opensip-cli.config.yml`, and (ADR-0054
 * M4-E) convert a tool's COARSE manifest config descriptor into a Zod schema.
 *
 * Two directions:
 *   - {@link toJsonSchema} (Zod → JSON Schema): editors and docs consume a JSON
 *     Schema for the whole document so an author gets completion + validation.
 *     Generated from the composed Zod schema (see {@link ./composer}) — single
 *     source of truth, no hand-maintained mirror.
 *   - {@link jsonSchemaObjectToZod} (JSON Schema → Zod): an EXTERNAL tool ships a
 *     plain-data, draft-07-subset structural descriptor in its static manifest
 *     ({@link ToolConfigManifestDescriptor}). The host must NOT import the tool's
 *     real Zod (executable code — the ADR-0054 load-time hole), so the coarse
 *     host pass derives a Zod schema FROM THE DESCRIPTOR DATA and folds it into
 *     the SAME composed document as a bundled tool's Zod. The descriptor is plain
 *     data; this converter never executes tool code. The tool's real Zod runs
 *     later, in the worker (the deep pass).
 *
 * zod 4 ships a built-in `z.toJSONSchema`, so no extra dependency is needed.
 */

import {
  type JsonSchemaNode,
  type JsonSchemaObject,
  type JsonSchemaPrimitiveType,
} from '@opensip-cli/core';
import { z, type ZodType } from 'zod';

/** A JSON Schema document (object form). */
export type JsonSchema = Record<string, unknown>;

/**
 * Emit a JSON Schema for the composed config document.
 *
 * @param composed The whole-document schema returned by `composeConfigSchema`.
 * @returns A JSON Schema object whose `properties` include each registered
 *   namespace. The document-level catchall renders
 *   as `additionalProperties`, so unclaimed top-level keys remain permitted.
 */
export function toJsonSchema(composed: ZodType): JsonSchema {
  // `io: 'input'` so the schema describes the *authored* document (pre-default
  // application), which is what an editor validates as the user types.
  return z.toJSONSchema(composed, { io: 'input' });
}

/**
 * Build a coarse union over `members`. A single member returns as-is; an empty
 * list falls back to `z.unknown()` (a degenerate enum/type-union descriptor).
 * `z.union` requires a 2+ tuple at the type level, so the dynamic array is cast
 * once here (the runtime accepts any-length schema array).
 */
function unionOf(members: readonly ZodType[]): ZodType {
  if (members.length === 0) return z.unknown();
  if (members.length === 1) return members[0];
  return z.union(members as unknown as [ZodType, ZodType, ...ZodType[]]);
}

/** Convert ONE draft-07-subset primitive type to its Zod equivalent. */
function primitiveToZod(type: JsonSchemaPrimitiveType): ZodType {
  switch (type) {
    case 'string': {
      return z.string();
    }
    case 'number': {
      return z.number();
    }
    case 'integer': {
      return z.number().int();
    }
    case 'boolean': {
      return z.boolean();
    }
    case 'null': {
      return z.null();
    }
    case 'array': {
      // A bare `array` with no `items` is a coarse "any array" — element shape is
      // the worker's deep pass.
      return z.array(z.unknown());
    }
    case 'object': {
      // A bare `object` with no `properties` is a coarse "any object" — the deep
      // shape is the worker's Zod pass; the host only checks it IS an object.
      return z.record(z.string(), z.unknown());
    }
  }
}

/**
 * Convert one descriptor node to a coarse Zod schema. Recursion stays within the
 * modelled draft-07 subset (object `properties`/`required`/`additionalProperties`,
 * array `items`, `enum`, primitive `type`, or a type union). Anything richer is
 * deliberately treated as `z.unknown()` — the worker's deep Zod pass is
 * authoritative for semantics; the host pass is coarse by design.
 */
function nodeToZod(node: JsonSchemaNode): ZodType {
  if (node.enum !== undefined && node.enum.length > 0) {
    // Coarse literal membership: a union of literals over the declared values.
    return unionOf(node.enum.map((v) => z.literal(v as never)));
  }
  const type = node.type;
  if (type === undefined) {
    // No `type` (and no enum) → an unconstrained value at the coarse layer.
    return z.unknown();
  }
  if (typeof type !== 'string') {
    // A type UNION (`type: ['string', 'null']`) → a coarse union of primitives.
    return unionOf(type.map((t) => primitiveToZod(t)));
  }
  if (type === 'object' && node.properties !== undefined) {
    return objectNodeToZod(node);
  }
  if (type === 'array') {
    return node.items === undefined ? z.array(z.unknown()) : z.array(nodeToZod(node.items));
  }
  return primitiveToZod(type);
}

/**
 * Convert an OBJECT descriptor node (the namespace top-level shape or a nested
 * object) to a Zod object. Known keys take their coarse schema; non-required
 * keys are `.optional()`. `additionalProperties:false` (or omitted — the strict
 * default that mirrors the composer's `.strict()` rule-1) rejects unknown keys;
 * an explicit `additionalProperties:true`/schema permits them via a catchall.
 */
function objectNodeToZod(node: JsonSchemaNode): ZodType {
  const required = new Set(node.required);
  const shape: Record<string, ZodType> = {};
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const zChild = nodeToZod(child);
    shape[key] = required.has(key) ? zChild : zChild.optional();
  }
  const base = z.object(shape);
  // `additionalProperties` omitted ⇒ strict (the coarse pass enforces the same
  // unknown-key rejection the composer applies to a known namespace, rule-1).
  if (node.additionalProperties === undefined || node.additionalProperties === false) {
    return base.strict();
  }
  if (node.additionalProperties === true) {
    return base.catchall(z.unknown());
  }
  return base.catchall(nodeToZod(node.additionalProperties));
}

/**
 * Convert a tool's COARSE manifest config descriptor object schema into a Zod
 * schema for the host's pre-fork coarse pass (ADR-0054 M4-E).
 *
 * The result validates the namespace's TOP-LEVEL structural shape only — known
 * keys, primitive types, required/optional, and unknown-key rejection — derived
 * purely from the descriptor DATA. It never imports or executes the tool's real
 * Zod; the worker runs that (the deep pass). A descriptor with no `properties`
 * coarse-validates the namespace as an opaque object (IS-an-object only).
 *
 * @param schema The descriptor's top-level JSON-Schema object node.
 * @returns A Zod schema the composer folds into the whole-document schema.
 */
export function jsonSchemaObjectToZod(schema: JsonSchemaObject): ZodType {
  if (schema.properties === undefined) {
    // No declared keys → coarse "is an object" check; defer all shape to the
    // worker deep pass. Permit unknown keys (the deep pass owns rejection).
    return z.record(z.string(), z.unknown());
  }
  return objectNodeToZod(schema);
}
