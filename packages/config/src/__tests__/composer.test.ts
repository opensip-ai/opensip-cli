import { ConfigurationError } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { composeConfigSchema, validateConfigDocument } from '../composer.js';

import type { ToolConfigDeclaration } from '../declaration.js';

const fitnessDecl: ToolConfigDeclaration = {
  namespace: 'fitness',
  schema: z.object({
    failOnErrors: z.number().int().min(0).optional(),
    recipe: z.string().min(1).optional(),
  }),
};

const graphDecl: ToolConfigDeclaration = {
  namespace: 'graph',
  schema: z.object({
    recipe: z.string().min(1).optional(),
    cycleMinSize: z.number().int().optional(),
  }),
};

describe('composeConfigSchema', () => {
  it('accepts a valid document with multiple namespaces', () => {
    const schema = composeConfigSchema([fitnessDecl, graphDecl]);
    const doc = {
      fitness: { failOnErrors: 1, recipe: 'strict' },
      graph: { recipe: 'default', cycleMinSize: 3 },
    };
    expect(() => validateConfigDocument(schema, doc)).not.toThrow();
    expect(validateConfigDocument(schema, doc)).toEqual(doc);
  });

  it('accepts a document that omits a tool block (namespaces are optional)', () => {
    const schema = composeConfigSchema([fitnessDecl, graphDecl]);
    expect(() => validateConfigDocument(schema, { fitness: { failOnErrors: 0 } })).not.toThrow();
    expect(() => validateConfigDocument(schema, {})).not.toThrow();
  });

  it('rejects an unknown key WITHIN a known namespace (strict)', () => {
    const schema = composeConfigSchema([fitnessDecl]);
    expect(() => validateConfigDocument(schema, { fitness: { faliOnErrors: 1 } })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects an unknown key in graph the SAME way as in fitness (one error shape)', () => {
    const schema = composeConfigSchema([fitnessDecl, graphDecl]);
    let fitnessErr: unknown;
    let graphErr: unknown;
    try {
      validateConfigDocument(schema, { fitness: { typo: 1 } });
    } catch (error) {
      fitnessErr = error;
    }
    try {
      validateConfigDocument(schema, { graph: { typo: 1 } });
    } catch (error) {
      graphErr = error;
    }
    expect(fitnessErr).toBeInstanceOf(ConfigurationError);
    expect(graphErr).toBeInstanceOf(ConfigurationError);
    expect((fitnessErr as ConfigurationError).code).toBe('CONFIGURATION_ERROR');
    expect((graphErr as ConfigurationError).code).toBe('CONFIGURATION_ERROR');
  });

  it('TOLERATES an unclaimed top-level key (the 2.10.1 migration seam)', () => {
    const schema = composeConfigSchema([fitnessDecl, graphDecl]);
    const doc = {
      fitness: { failOnErrors: 1 },
      // Not-yet-migrated blocks must pass through untouched in 2.10.0.
      cli: { verbose: true },
      targets: { backend: { include: ['src/**'] } },
      globalExcludes: ['dist/**'],
    };
    const parsed = validateConfigDocument(schema, doc) as Record<string, unknown>;
    expect(parsed.cli).toEqual({ verbose: true });
    expect(parsed.targets).toEqual({ backend: { include: ['src/**'] } });
    expect(parsed.globalExcludes).toEqual(['dist/**']);
  });

  it('still validates field-level constraints inside a namespace', () => {
    const schema = composeConfigSchema([fitnessDecl]);
    expect(() => validateConfigDocument(schema, { fitness: { failOnErrors: -1 } })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects duplicate namespaces at compose time', () => {
    expect(() => composeConfigSchema([fitnessDecl, fitnessDecl])).toThrow(ConfigurationError);
  });

  it('leaves a non-object namespace schema unchanged (no .strict() to apply)', () => {
    const recordDecl: ToolConfigDeclaration = {
      namespace: 'overrides',
      schema: z.record(z.string(), z.string()),
    };
    const schema = composeConfigSchema([recordDecl]);
    expect(() =>
      validateConfigDocument(schema, { overrides: { a: 'x', b: 'y' } }),
    ).not.toThrow();
    expect(() => validateConfigDocument(schema, { overrides: { a: 1 } })).toThrow(
      ConfigurationError,
    );
  });
});

describe('validateConfigDocument error shape', () => {
  it('surfaces a document-root issue when the whole document is the wrong type', () => {
    const schema = composeConfigSchema([fitnessDecl]);
    let caught: unknown;
    try {
      validateConfigDocument(schema, 'not an object');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).message).toContain('(document root)');
  });

  it('attaches the formatted issues for diagnosis', () => {
    const schema = composeConfigSchema([fitnessDecl]);
    try {
      validateConfigDocument(schema, { fitness: { failOnErrors: 'nope' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      const err = error as ConfigurationError & { issues?: unknown };
      expect(err).toBeInstanceOf(ConfigurationError);
      expect(Array.isArray(err.issues)).toBe(true);
      expect(err.message).toContain('fitness.failOnErrors');
    }
  });
});
