import { type JsonSchemaObject } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { composeConfigSchema } from '../composer.js';
import { decorateToolConfigDeclarationsWithGateKeys } from '../gate-keys.js';
import { jsonSchemaObjectToZod, toJsonSchema } from '../json-schema.js';

import type { ToolConfigDeclaration } from '../declaration.js';

const declarations: readonly ToolConfigDeclaration[] = [
  {
    namespace: 'fitness',
    schema: z.object({ failOnErrors: z.number().int().min(0).optional() }),
  },
  {
    namespace: 'graph',
    schema: z.object({ recipe: z.string().optional() }),
  },
  {
    namespace: 'simulation',
    schema: z.object({ recipe: z.string().optional() }),
  },
];

describe('toJsonSchema', () => {
  it('emits an object JSON Schema for the composed document', () => {
    const schema = toJsonSchema(composeConfigSchema(declarations));
    expect(schema).toMatchObject({ type: 'object' });
    expect(schema).toHaveProperty('properties');
  });

  it('includes each registered namespace as a property', () => {
    const schema = toJsonSchema(composeConfigSchema(declarations)) as {
      properties: Record<string, unknown>;
    };
    for (const decl of declarations) {
      expect(schema.properties).toHaveProperty(decl.namespace);
    }
  });

  it('renders strict-within-namespace as additionalProperties:false', () => {
    const schema = toJsonSchema(composeConfigSchema(declarations)) as {
      properties: Record<string, { additionalProperties?: unknown }>;
    };
    expect(schema.properties.fitness.additionalProperties).toBe(false);
    expect(schema.properties.graph.additionalProperties).toBe(false);
  });

  it('renders tolerant top-level keys (uninstalled-tool forward compat) as a permissive additionalProperties', () => {
    const schema = toJsonSchema(composeConfigSchema(declarations)) as {
      additionalProperties?: unknown;
    };
    // Document-level catchall(z.unknown()) → additionalProperties is not `false`,
    // so the namespace block of a tool not installed in this run stays allowed.
    expect(schema.additionalProperties).not.toBe(false);
  });

  it('surfaces a namespace field constraint in its sub-schema', () => {
    const schema = toJsonSchema(composeConfigSchema(declarations)) as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(schema.properties.fitness.properties).toHaveProperty('failOnErrors');
  });

  it('can surface reserved gate keys when generated from decorated tool declarations', () => {
    const schema = toJsonSchema(
      composeConfigSchema(decorateToolConfigDeclarationsWithGateKeys(declarations)),
    ) as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(schema.properties.graph.properties).toHaveProperty('failOnErrors');
    expect(schema.properties.graph.properties).toHaveProperty('failOnWarnings');
    expect(schema.properties.graph.properties).toHaveProperty('failOnDegraded');
  });
});

/**
 * ADR-0054 M4-E COARSE pass (JSON Schema → Zod): an EXTERNAL tool's static,
 * plain-data manifest descriptor is converted to a Zod schema the host folds into
 * the composed document — without ever importing the tool's real Zod. These tests
 * cover every modelled draft-07 subset branch (`jsonSchemaObjectToZod` + the
 * `nodeToZod`/`objectNodeToZod`/`primitiveToZod`/`unionOf` recursion).
 */
describe('jsonSchemaObjectToZod (coarse manifest descriptor → Zod)', () => {
  it('no properties → coarse "is an object" (permits unknown keys, defers to the worker deep pass)', () => {
    const zod = jsonSchemaObjectToZod({ type: 'object' });
    expect(zod.safeParse({ anything: 1, goes: 'here' }).success).toBe(true);
    expect(zod.safeParse('not an object').success).toBe(false);
  });

  it('known primitive keys are type-checked; optional by default', () => {
    const schema: JsonSchemaObject = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
        whole: { type: 'integer' },
        flag: { type: 'boolean' },
        nothing: { type: 'null' },
      },
    };
    const zod = jsonSchemaObjectToZod(schema);
    expect(
      zod.safeParse({ name: 'a', count: 1.5, whole: 2, flag: true, nothing: null }).success,
    ).toBe(true);
    // All optional → an empty object passes.
    expect(zod.safeParse({}).success).toBe(true);
    // Wrong primitive type fails.
    expect(zod.safeParse({ name: 123 }).success).toBe(false);
    // `integer` rejects a non-integer number.
    expect(zod.safeParse({ whole: 2.5 }).success).toBe(false);
  });

  it('required keys must be present', () => {
    const zod = jsonSchemaObjectToZod({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(zod.safeParse({ name: 'present' }).success).toBe(true);
    expect(zod.safeParse({}).success).toBe(false);
  });

  it('strict by default (additionalProperties omitted) rejects unknown keys', () => {
    const zod = jsonSchemaObjectToZod({
      type: 'object',
      properties: { known: { type: 'string' } },
    });
    expect(zod.safeParse({ known: 'x', surprise: 1 }).success).toBe(false);
  });

  it('additionalProperties:false rejects unknown keys', () => {
    const zod = jsonSchemaObjectToZod({
      type: 'object',
      properties: { known: { type: 'string' } },
      additionalProperties: false,
    });
    expect(zod.safeParse({ known: 'x', surprise: 1 }).success).toBe(false);
  });

  it('additionalProperties:true permits unknown keys', () => {
    const zod = jsonSchemaObjectToZod({
      type: 'object',
      properties: { known: { type: 'string' } },
      additionalProperties: true,
    });
    expect(zod.safeParse({ known: 'x', extra: { any: 'shape' } }).success).toBe(true);
  });

  it('additionalProperties as a schema type-checks the catchall values', () => {
    const zod = jsonSchemaObjectToZod({
      type: 'object',
      properties: { known: { type: 'string' } },
      additionalProperties: { type: 'number' },
    });
    expect(zod.safeParse({ known: 'x', extra: 7 }).success).toBe(true);
    expect(zod.safeParse({ known: 'x', extra: 'not-a-number' }).success).toBe(false);
  });

  it('enum is a coarse literal membership check (single + multi)', () => {
    const multi = jsonSchemaObjectToZod({
      type: 'object',
      properties: { mode: { enum: ['fast', 'exact'] } },
    });
    expect(multi.safeParse({ mode: 'fast' }).success).toBe(true);
    expect(multi.safeParse({ mode: 'nope' }).success).toBe(false);

    const single = jsonSchemaObjectToZod({
      type: 'object',
      properties: { only: { enum: ['x'] } },
    });
    expect(single.safeParse({ only: 'x' }).success).toBe(true);
    expect(single.safeParse({ only: 'y' }).success).toBe(false);
  });

  it('a type union (`type: ["string","null"]`) accepts either member', () => {
    const zod = jsonSchemaObjectToZod({
      type: 'object',
      properties: { val: { type: ['string', 'null'] } },
    });
    expect(zod.safeParse({ val: 'a' }).success).toBe(true);
    expect(zod.safeParse({ val: null }).success).toBe(true);
    expect(zod.safeParse({ val: 1 }).success).toBe(false);
  });

  it('a key with no type/enum is unconstrained (coarse z.unknown)', () => {
    const zod = jsonSchemaObjectToZod({ type: 'object', properties: { any: {} } });
    expect(zod.safeParse({ any: 1 }).success).toBe(true);
    expect(zod.safeParse({ any: { nested: true } }).success).toBe(true);
  });

  it('arrays: typed items are element-checked; a bare array accepts any elements', () => {
    const typed = jsonSchemaObjectToZod({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    });
    expect(typed.safeParse({ tags: ['a', 'b'] }).success).toBe(true);
    expect(typed.safeParse({ tags: ['a', 2] }).success).toBe(false);

    const bare = jsonSchemaObjectToZod({
      type: 'object',
      properties: { items: { type: 'array' } },
    });
    expect(bare.safeParse({ items: [1, 'two', { three: 3 }] }).success).toBe(true);
    expect(bare.safeParse({ items: 'not-array' }).success).toBe(false);
  });

  it('a bare object property (no nested properties) is a coarse "any object"', () => {
    const zod = jsonSchemaObjectToZod({
      type: 'object',
      properties: { meta: { type: 'object' } },
    });
    expect(zod.safeParse({ meta: { a: 1, b: 'x' } }).success).toBe(true);
    expect(zod.safeParse({ meta: 'not-object' }).success).toBe(false);
  });

  it('nested object properties recurse (required + strict carry through)', () => {
    const zod = jsonSchemaObjectToZod({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { inner: { type: 'string' } },
          required: ['inner'],
        },
      },
    });
    expect(zod.safeParse({ nested: { inner: 'ok' } }).success).toBe(true);
    expect(zod.safeParse({ nested: {} }).success).toBe(false);
    // Strict carries into the nested object.
    expect(zod.safeParse({ nested: { inner: 'ok', extra: 1 } }).success).toBe(false);
  });
});
