import { describe, it, expect } from 'vitest';

import {
  defineErrorCatalog,
  deepFreeze,
  coreSystemErrorCatalog,
  definitionFromLegacyCode,
  assertErrorCodeShape,
  ErrorDefinitionError,
  MACHINE_CONSUMER_COMPATIBILITY,
  ERROR_CATALOG_SCHEMA_VERSION,
} from '../error-definition.js';

describe('defineErrorCatalog', () => {
  it('freezes definitions at runtime', () => {
    const catalog = defineErrorCatalog(
      { id: 'test.owner', displayName: 'Test' },
      {
        'TEST.DEMO.FAIL': {
          code: 'TEST.DEMO.FAIL',
          source: 'application',
          defaultResponsibility: 'user',
          kind: 'validation',
          retry: 'never',
          severity: 'error',
          exposure: 'public',
          exitClass: 'configuration',
          operatorAction: 'Fix it',
          stability: 'public',
          lifecycle: 'active',
        },
      },
    );
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.definitions)).toBe(true);
    expect(Object.isFrozen(catalog.require('TEST.DEMO.FAIL'))).toBe(true);
    expect(catalog.require('TEST.DEMO.FAIL').code).toBe('TEST.DEMO.FAIL');
  });

  it('rejects duplicate codes and bad grammar', () => {
    expect(() =>
      defineErrorCatalog(
        { id: 't', displayName: 'T' },
        {
          a: {
            code: 'TEST.DEMO.A',
            source: 'application',
            defaultResponsibility: 'user',
            kind: 'validation',
            retry: 'never',
            severity: 'error',
            exposure: 'public',
            exitClass: 'runtime',
            operatorAction: 'x',
            stability: 'internal',
            lifecycle: 'active',
          },
          b: {
            code: 'TEST.DEMO.A',
            source: 'application',
            defaultResponsibility: 'user',
            kind: 'validation',
            retry: 'never',
            severity: 'error',
            exposure: 'public',
            exitClass: 'runtime',
            operatorAction: 'x',
            stability: 'internal',
            lifecycle: 'active',
          },
        },
      ),
    ).toThrow(ErrorDefinitionError);

    expect(() => assertErrorCodeShape('not-valid')).toThrow(ErrorDefinitionError);
  });

  it('maps legacy codes through core system catalog', () => {
    expect(coreSystemErrorCatalog.get('VALIDATION_ERROR')?.kind).toBe('validation');
    expect(definitionFromLegacyCode('VALIDATION_ERROR').exitClass).toBe('configuration');
    expect(definitionFromLegacyCode('NOPE_UNKNOWN').code).toBe('CORE.SYSTEM.UNKNOWN_FAILURE');
    expect(MACHINE_CONSUMER_COMPATIBILITY.catalogSchemaVersion).toBe(ERROR_CATALOG_SCHEMA_VERSION);
  });

  it('maps dotted subcodes to family exit classes instead of UNKNOWN_FAILURE', () => {
    expect(definitionFromLegacyCode('PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS').exitClass).toBe(
      'plugin-incompatible',
    );
    expect(definitionFromLegacyCode('CONFIGURATION.RECOVERY_REQUIRED').exitClass).toBe(
      'configuration',
    );
    expect(definitionFromLegacyCode('TIMEOUT.RUNTIME_ACCESS_COMPOSITE').exitClass).toBe('runtime');
    expect(definitionFromLegacyCode('CAPABILITY.DOMAIN.UNKNOWN').exitClass).toBe('not-found');
    expect(definitionFromLegacyCode('CAPABILITY.CONTRIBUTION.SCHEMA_MISMATCH').exitClass).toBe(
      'configuration',
    );
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects', () => {
    const value = deepFreeze({ a: { b: 1 } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
  });
});

describe('error definition axes coverage', () => {
  const owner = { id: 'test.owner', displayName: 'Test' };
  const base = {
    source: 'application' as const,
    defaultResponsibility: 'user' as const,
    kind: 'validation' as const,
    retry: 'never' as const,
    severity: 'error' as const,
    exposure: 'public' as const,
    exitClass: 'configuration' as const,
    operatorAction: 'act',
    stability: 'public' as const,
    lifecycle: 'active' as const,
  };

  it('accepts lifecycle tombstoned with supersededBy', () => {
    const catalog = defineErrorCatalog(owner, {
      'TEST.LIFE.OLD': {
        ...base,
        code: 'TEST.LIFE.OLD',
        lifecycle: 'tombstoned',
        supersededBy: 'TEST.LIFE.NEW',
      },
    });
    expect(catalog.require('TEST.LIFE.OLD').lifecycle).toBe('tombstoned');
    expect(catalog.require('TEST.LIFE.OLD').supersededBy).toBe('TEST.LIFE.NEW');
  });

  it('covers retry postures and exit classes used by core system catalog', () => {
    const retries = new Set(coreSystemErrorCatalog.list.map((d) => d.retry));
    const exits = new Set(coreSystemErrorCatalog.list.map((d) => d.exitClass));
    expect(retries.has('never')).toBe(true);
    expect(retries.has('transient')).toBe(true);
    expect(exits.has('configuration')).toBe(true);
    expect(exits.has('not-found')).toBe(true);
    expect(exits.has('runtime')).toBe(true);
  });

  it('rejects hostile non-plain catalog definitions', () => {
    expect(() =>
      defineErrorCatalog(owner, {
        bad: Object.create({ code: 'TEST.HOST.X', ...base }),
      } as never),
    ).toThrow();
  });

  it('accepts source × responsibility combinations used by core catalog', () => {
    const sources = new Set(coreSystemErrorCatalog.list.map((d) => d.source));
    const responsibilities = new Set(
      coreSystemErrorCatalog.list.map((d) => d.defaultResponsibility),
    );
    expect(sources.has('application')).toBe(true);
    expect(responsibilities.size).toBeGreaterThan(0);
    for (const d of coreSystemErrorCatalog.list) {
      expect(d.stability === 'public' || d.stability === 'internal').toBe(true);
      expect(['active', 'deprecated', 'tombstoned']).toContain(d.lifecycle);
    }
  });

  it('rejects empty operatorAction and invalid code shapes', () => {
    expect(() =>
      defineErrorCatalog(owner, {
        'TEST.BAD.EMPTY': {
          ...base,
          code: 'TEST.BAD.EMPTY',
          operatorAction: '',
        },
      }),
    ).toThrow(ErrorDefinitionError);
    expect(() => assertErrorCodeShape('lowercase.bad')).toThrow(ErrorDefinitionError);
    expect(() => assertErrorCodeShape('OK.CODE.SHAPE')).not.toThrow();
  });

  it('lists are stable ordered views of definitions map', () => {
    const catalog = defineErrorCatalog(owner, {
      'TEST.Z.LAST': { ...base, code: 'TEST.Z.LAST' },
      'TEST.A.FIRST': { ...base, code: 'TEST.A.FIRST' },
    });
    expect(catalog.list.map((d) => d.code).sort()).toEqual(['TEST.A.FIRST', 'TEST.Z.LAST']);
    expect(catalog.get('TEST.A.FIRST')?.code).toBe('TEST.A.FIRST');
    expect(catalog.get('MISSING')).toBeUndefined();
  });
});
