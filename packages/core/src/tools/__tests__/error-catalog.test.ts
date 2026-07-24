import { describe, expect, it } from 'vitest';

import {
  defineErrorCatalog,
  ERROR_CATALOG_SCHEMA_VERSION,
  ErrorDefinitionError,
} from '../../lib/error-definition.js';
import {
  aggregateErrorCatalogs,
  coreSystemErrorCatalog,
  validateToolErrorCatalogContribution,
} from '../error-catalog.js';

const ownerA = { id: 'tool-a-uuid', displayName: 'Tool A', packageName: '@scope/a' };
const ownerB = { id: 'tool-b-uuid', displayName: 'Tool B', packageName: '@scope/b' };

const def = {
  source: 'application' as const,
  defaultResponsibility: 'user' as const,
  kind: 'validation' as const,
  retry: 'never' as const,
  severity: 'error' as const,
  exposure: 'public' as const,
  exitClass: 'configuration' as const,
  operatorAction: 'fix input',
  stability: 'public' as const,
  lifecycle: 'active' as const,
};

describe('validateToolErrorCatalogContribution', () => {
  it('accepts a full catalog contribution', () => {
    const catalog = defineErrorCatalog(ownerA, {
      'A.DEMO.FAIL': { ...def, code: 'A.DEMO.FAIL' },
    });
    const contrib = validateToolErrorCatalogContribution(
      { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION, catalog },
      ownerA,
    );
    expect(contrib.schemaVersion).toBe(ERROR_CATALOG_SCHEMA_VERSION);
    expect(contrib.catalog.require('A.DEMO.FAIL').code).toBe('A.DEMO.FAIL');
  });

  it('accepts a definitions bag and freezes it under the owner', () => {
    const contrib = validateToolErrorCatalogContribution(
      {
        schemaVersion: ERROR_CATALOG_SCHEMA_VERSION,
        definitions: {
          'A.DEMO.BAG': { ...def, code: 'A.DEMO.BAG' },
        },
      },
      ownerA,
    );
    expect(Object.isFrozen(contrib.catalog)).toBe(true);
    expect(contrib.catalog.require('A.DEMO.BAG').owner.id).toBe(ownerA.id);
  });

  it('rejects unsupported schema versions and malformed shapes', () => {
    expect(() =>
      validateToolErrorCatalogContribution({ schemaVersion: 999, catalog: {} }, ownerA),
    ).toThrow(ErrorDefinitionError);
    expect(() => validateToolErrorCatalogContribution(null, ownerA)).toThrow(ErrorDefinitionError);
    expect(() =>
      validateToolErrorCatalogContribution({ schemaVersion: ERROR_CATALOG_SCHEMA_VERSION }, ownerA),
    ).toThrow(ErrorDefinitionError);
  });
});

describe('aggregateErrorCatalogs', () => {
  it('includes core system definitions', () => {
    const { byCode, collisions } = aggregateErrorCatalogs([]);
    expect(collisions).toEqual([]);
    expect(byCode.get('NOT_FOUND')?.code).toBe('NOT_FOUND');
    expect(byCode.size).toBeGreaterThanOrEqual(coreSystemErrorCatalog.list.length);
  });

  it('records cross-tool code collisions without overwriting the first owner', () => {
    const catalogA = defineErrorCatalog(ownerA, {
      'SHARED.CODE.X': { ...def, code: 'SHARED.CODE.X' },
    });
    const catalogB = defineErrorCatalog(ownerB, {
      'SHARED.CODE.X': { ...def, code: 'SHARED.CODE.X' },
    });
    const { byCode, collisions } = aggregateErrorCatalogs([
      { toolName: 'a', toolId: ownerA.id, catalog: catalogA },
      { toolName: 'b', toolId: ownerB.id, catalog: catalogB },
    ]);
    expect(collisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SHARED.CODE.X' })]),
    );
    expect(byCode.get('SHARED.CODE.X')?.owner.id).toBe(ownerA.id);
  });

  it('merges non-colliding tool codes', () => {
    const catalogA = defineErrorCatalog(ownerA, {
      'A.ONLY.ONE': { ...def, code: 'A.ONLY.ONE' },
    });
    const { byCode, collisions } = aggregateErrorCatalogs([
      { toolName: 'a', toolId: ownerA.id, catalog: catalogA },
    ]);
    expect(collisions).toEqual([]);
    expect(byCode.get('A.ONLY.ONE')?.toolName).toBe('a');
  });
});
