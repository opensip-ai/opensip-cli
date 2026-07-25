import { describe, expect, it, vi } from 'vitest';

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

  it('copies mutable contribution data instead of retaining plugin-owned objects', () => {
    const definition = { ...def, code: 'A.DEMO.COPY' };
    const definitions = { 'A.DEMO.COPY': definition };
    const contrib = validateToolErrorCatalogContribution(
      { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION, definitions },
      ownerA,
    );

    definition.operatorAction = 'mutated after admission';
    Object.assign(definitions, {
      'A.DEMO.LATE': { ...def, code: 'A.DEMO.LATE' },
    });

    expect(contrib.catalog.require('A.DEMO.COPY').operatorAction).toBe('fix input');
    expect(contrib.catalog.get('A.DEMO.LATE')).toBeUndefined();
    expect(Object.isFrozen(contrib.catalog.require('A.DEMO.COPY'))).toBe(true);
  });

  it('rejects unsupported schema versions and malformed shapes', () => {
    expect(() =>
      validateToolErrorCatalogContribution({ schemaVersion: 999, catalog: {} }, ownerA),
    ).toThrow(ErrorDefinitionError);
    expect(() => validateToolErrorCatalogContribution(null, ownerA)).toThrow(ErrorDefinitionError);
    expect(() =>
      validateToolErrorCatalogContribution({ schemaVersion: ERROR_CATALOG_SCHEMA_VERSION }, ownerA),
    ).toThrow(ErrorDefinitionError);
    expect(() =>
      validateToolErrorCatalogContribution(
        {
          schemaVersion: ERROR_CATALOG_SCHEMA_VERSION,
          catalog: { schemaVersion: 999, definitions: {} },
        },
        ownerA,
      ),
    ).toThrow(/nested errorCatalog schemaVersion/);
  });

  it('rejects accessors without invoking plugin code', () => {
    const read = vi.fn(() => ({ schemaVersion: ERROR_CATALOG_SCHEMA_VERSION }));
    const contribution = { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION } as Record<string, unknown>;
    Object.defineProperty(contribution, 'catalog', { enumerable: true, get: read });

    expect(() => validateToolErrorCatalogContribution(contribution, ownerA)).toThrow(
      /must be a data property/,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects catalog owner id that does not match the tool owner', () => {
    const foreign = defineErrorCatalog(ownerB, {
      'B.ONLY.X': { ...def, code: 'B.ONLY.X' },
    });
    expect(() =>
      validateToolErrorCatalogContribution(
        { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION, catalog: foreign },
        ownerA,
      ),
    ).toThrow(/does not match tool owner/);
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

describe('aggregateErrorCatalogs — substrate catalogs (Plan 01 ruling D1)', () => {
  const substrateOwner = {
    id: '@opensip-cli/datastore',
    displayName: 'Datastore',
    packageName: '@opensip-cli/datastore',
  };

  it('registers a code owned by a non-Tool package', () => {
    // Before D1 the only registration path was ToolExtensionPoints.errorCatalog, so a
    // substrate had no way to own a code at all.
    const catalog = defineErrorCatalog(substrateOwner, {
      'DATASTORE.MIGRATION.FAILED': { ...def, code: 'DATASTORE.MIGRATION.FAILED' },
    });
    const { byCode, collisions } = aggregateErrorCatalogs(
      [],
      [{ packageName: '@opensip-cli/datastore', catalog }],
    );
    expect(collisions).toEqual([]);
    expect(byCode.get('DATASTORE.MIGRATION.FAILED')?.owner.id).toBe('@opensip-cli/datastore');
  });

  it('rejects a substrate registering a code it does not own', () => {
    // Ownership is the point: a package may not register a code attributed elsewhere.
    const catalog = defineErrorCatalog(substrateOwner, {
      'DATASTORE.MIGRATION.OTHER': { ...def, code: 'DATASTORE.MIGRATION.OTHER' },
    });
    const { byCode, collisions } = aggregateErrorCatalogs(
      [],
      [{ packageName: '@opensip-cli/output', catalog }],
    );
    expect(collisions).toHaveLength(1);
    expect(byCode.has('DATASTORE.MIGRATION.OTHER')).toBe(false);
  });

  it('reports a collision rather than letting a substrate overwrite core', () => {
    // Pick a core code that satisfies the OWNER.DOMAIN.CONDITION grammar, since legacy
    // single-token codes cannot be re-declared through defineErrorCatalog at all.
    const coreCode = coreSystemErrorCatalog.list.find((d) => d.code.split('.').length === 3)?.code;
    expect(coreCode).toBeDefined();
    const catalog = defineErrorCatalog(substrateOwner, {
      [coreCode as string]: { ...def, code: coreCode as string },
    });
    const { byCode, collisions } = aggregateErrorCatalogs(
      [],
      [{ packageName: '@opensip-cli/datastore', catalog }],
    );
    expect(collisions.some((c) => c.code === coreCode)).toBe(true);
    expect(byCode.get(coreCode as string)?.owner.id).not.toBe('@opensip-cli/datastore');
  });

  it('reports a collision when a tool claims a code a substrate already owns', () => {
    // Substrates fold in first precisely so this is caught rather than silently
    // reassigned to whichever contributor happened to be merged last.
    const shared = 'SHARED.CODE.X';
    const substrate = defineErrorCatalog(substrateOwner, { [shared]: { ...def, code: shared } });
    const toolCatalog = defineErrorCatalog(ownerA, { [shared]: { ...def, code: shared } });
    const { byCode, collisions } = aggregateErrorCatalogs(
      [{ toolName: 'a', toolId: ownerA.id, catalog: toolCatalog }],
      [{ packageName: '@opensip-cli/datastore', catalog: substrate }],
    );
    expect(collisions.some((c) => c.code === shared)).toBe(true);
    expect(byCode.get(shared)?.owner.id).toBe('@opensip-cli/datastore');
  });

  it('omitting substrate catalogs preserves the previous behaviour', () => {
    const toolCatalog = defineErrorCatalog(ownerA, { 'A.B.C': { ...def, code: 'A.B.C' } });
    const { byCode, collisions } = aggregateErrorCatalogs([
      { toolName: 'a', toolId: ownerA.id, catalog: toolCatalog },
    ]);
    expect(collisions).toEqual([]);
    expect(byCode.get('A.B.C')?.toolName).toBe('a');
  });
});
