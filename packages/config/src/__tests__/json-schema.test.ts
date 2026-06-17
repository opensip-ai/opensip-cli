import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { composeConfigSchema } from '../composer.js';
import { decorateToolConfigDeclarationsWithGateKeys } from '../gate-keys.js';
import { toJsonSchema } from '../json-schema.js';

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
