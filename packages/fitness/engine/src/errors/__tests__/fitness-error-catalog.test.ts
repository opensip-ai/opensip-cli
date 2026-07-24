import { NotFoundError, normalizeFailure } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';


import { fitnessErrorCatalog } from '../fitness-error-catalog.js';

describe('fitnessErrorCatalog', () => {
  it('freezes recipe-not-found definition with public metadata keys', () => {
    const def = fitnessErrorCatalog.require('RESOURCE.NOT_FOUND.RECIPE');
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.kind).toBe('not-found');
    expect(def.publicMetadataKeys).toContain('identifier');
  });

  it('preserves metadata through NotFoundError + normalizeFailure', () => {
    const error = new NotFoundError('Recipe not found: demo', {
      code: 'RESOURCE.NOT_FOUND.RECIPE',
      definition: fitnessErrorCatalog.require('RESOURCE.NOT_FOUND.RECIPE'),
      metadata: { entity: 'recipe', identifier: 'demo', password: 'nope' },
    });
    expect(error.metadata).toEqual({ entity: 'recipe', identifier: 'demo' });
    expect(error.definition.operatorAction).toMatch(/fit recipes/i);
    const envelope = normalizeFailure(error);
    expect(envelope.code).toBe('RESOURCE.NOT_FOUND.RECIPE');
    expect(envelope.definition.exitClass).toBe('not-found');
  });
});
