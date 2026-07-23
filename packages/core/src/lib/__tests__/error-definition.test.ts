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
});

describe('deepFreeze', () => {
  it('freezes nested objects', () => {
    const value = deepFreeze({ a: { b: 1 } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
  });
});
