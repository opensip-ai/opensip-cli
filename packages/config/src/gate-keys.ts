/**
 * Reserved gate-key decoration for tool config namespaces.
 *
 * Core resolves these keys from every tool namespace (`scope.toolConfig[tool]`),
 * but individual tools should not each have to remember to declare the host
 * contract. The composition root applies this decorator only to tool
 * declarations before it appends host document declarations; host blocks such as
 * `cli` and `plugins` must remain strict and must not accept these keys.
 */

import { z, type ZodType } from 'zod';

import type { ToolConfigDeclaration } from './declaration.js';

const RESERVED_GATE_KEY_SHAPE = {
  failOnErrors: z.number().int().min(0).optional(),
  failOnWarnings: z.number().int().min(0).optional(),
  failOnDegraded: z.boolean().optional(),
} satisfies Record<string, ZodType>;

function decorateSchemaWithGateKeys(schema: ZodType): ZodType {
  if (!(schema instanceof z.ZodObject)) {
    return schema;
  }

  const existingShape = schema.shape;
  const extensions: Record<string, ZodType> = {};
  for (const [key, gateSchema] of Object.entries(RESERVED_GATE_KEY_SHAPE)) {
    if (!Object.prototype.hasOwnProperty.call(existingShape, key)) {
      extensions[key] = gateSchema;
    }
  }

  if (Object.keys(extensions).length === 0) {
    return schema;
  }

  return schema.extend(extensions);
}

/**
 * Return tool config declarations whose object schemas accept host-reserved gate keys.
 *
 * Apply this only to tool-owned declarations before host document declarations
 * are appended; host namespaces such as `cli` and `plugins` intentionally stay
 * strict and must not accept gate policy keys.
 */
export function decorateToolConfigDeclarationsWithGateKeys(
  declarations: readonly ToolConfigDeclaration[],
): readonly ToolConfigDeclaration[] {
  return declarations.map((decl) => ({
    ...decl,
    schema: decorateSchemaWithGateKeys(decl.schema),
  }));
}
