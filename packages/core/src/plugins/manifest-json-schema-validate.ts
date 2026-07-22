/**
 * @fileoverview JSON-Schema node validation for a manifest `config` block.
 *
 * Validates every modelled JSON-Schema keyword before the config layer walks
 * it. Unknown keywords remain plain inert data for forward compatibility;
 * the host coarse pass only interprets this documented subset and the
 * worker owns deeper semantics.
 *
 * Extracted from `manifest-loader-helpers.ts` (file-length-limit): this is a
 * single cohesive concern — JSON-Schema keyword validation — with one public
 * entry point, {@link isJsonSchemaObject}; everything else here is a private
 * implementation detail of that entry point.
 */
import { isRecord, isStringArray } from './json-guards.js';

import type {
  JsonSchemaNode,
  JsonSchemaObject,
  JsonSchemaPrimitiveType,
} from '../tools/manifest-config.js';

const JSON_SCHEMA_PRIMITIVE_TYPES: ReadonlySet<JsonSchemaPrimitiveType> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

function isJsonSchemaPrimitiveType(value: unknown): value is JsonSchemaPrimitiveType {
  return (
    typeof value === 'string' && JSON_SCHEMA_PRIMITIVE_TYPES.has(value as JsonSchemaPrimitiveType)
  );
}

function isJsonSchemaType(
  value: unknown,
): value is JsonSchemaPrimitiveType | readonly JsonSchemaPrimitiveType[] {
  return (
    isJsonSchemaPrimitiveType(value) ||
    (Array.isArray(value) &&
      value.length > 0 &&
      new Set(value).size === value.length &&
      value.every(isJsonSchemaPrimitiveType))
  );
}

function isJsonSchemaEnum(value: unknown): boolean {
  // Zod's literal constructor accepts JSON scalars. Arrays are interpreted as
  // a list of separate literal values (and [] throws); objects use identity
  // rather than JSON-value equality. Neither can represent JSON-Schema enum
  // membership faithfully in the host's coarse converter.
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(
      (member) =>
        member === null ||
        typeof member === 'string' ||
        typeof member === 'number' ||
        typeof member === 'boolean',
    )
  );
}

function areJsonSchemaPropertiesValid(value: unknown): boolean {
  // The converter assembles its Zod shape in an ordinary `{}`. Assigning an own
  // `__proto__` property mutates that object's prototype and silently loses the
  // declared schema key, so reject precisely that unrepresentable property.
  return (
    value === undefined ||
    (isRecord(value) &&
      !Object.hasOwn(value, '__proto__') &&
      Object.values(value).every((child) => isJsonSchemaNode(child)))
  );
}

function isAdditionalPropertiesValid(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean' || isJsonSchemaNode(value);
}

function isJsonSchemaNode(value: unknown): value is JsonSchemaNode {
  if (!isRecord(value)) return false;

  return (
    (value.type === undefined || isJsonSchemaType(value.type)) &&
    (value.required === undefined || isStringArray(value.required)) &&
    (value.enum === undefined || isJsonSchemaEnum(value.enum)) &&
    areJsonSchemaPropertiesValid(value.properties) &&
    isAdditionalPropertiesValid(value.additionalProperties) &&
    (value.items === undefined || isJsonSchemaNode(value.items))
  );
}

/** A tool namespace is always object-shaped, even when its `type` is omitted. */
export function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return isJsonSchemaNode(value) && (value.type === undefined || value.type === 'object');
}
