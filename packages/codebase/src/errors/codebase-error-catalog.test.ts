import { describe, expect, it } from 'vitest';

import { CODEBASE_ERROR_OWNER_ID, codebaseErrorCatalog } from './codebase-error-catalog.js';

describe('codebaseErrorCatalog', () => {
  it('is owned by the package name so substrate attribution stays honest (D1)', () => {
    // aggregateErrorCatalogs rejects any definition whose owner.id differs from the
    // registered package name, so this equality is the registration precondition.
    expect(codebaseErrorCatalog.owner.id).toBe('@opensip-cli/codebase');
    expect(codebaseErrorCatalog.owner.packageName).toBe('@opensip-cli/codebase');
    expect(CODEBASE_ERROR_OWNER_ID).toBe('@opensip-cli/codebase');
    for (const definition of codebaseErrorCatalog.list) {
      expect(definition.owner.id).toBe(CODEBASE_ERROR_OWNER_ID);
    }
  });

  it('keeps one definition per responsibility-and-kind cluster (D9)', () => {
    const clusters = codebaseErrorCatalog.list.map(
      (definition) => `${definition.defaultResponsibility}:${definition.kind}`,
    );
    expect(new Set(clusters).size).toBe(clusters.length);
  });

  it('allowlists the branch metadata each cluster carries instead of minting codes', () => {
    expect(
      codebaseErrorCatalog.require('VALIDATION.CODEBASE.CONFIG_IDENTITY_UNENCODABLE')
        .publicMetadataKeys,
    ).toEqual(['condition']);
    expect(
      codebaseErrorCatalog.require('VALIDATION.CODEBASE.INVENTORY_INPUT_INVALID')
        .publicMetadataKeys,
    ).toEqual(['condition', 'field']);
  });

  it('routes a user-fixable configuration fault and a caller fault to different exits', () => {
    const configIdentity = codebaseErrorCatalog.require(
      'VALIDATION.CODEBASE.CONFIG_IDENTITY_UNENCODABLE',
    );
    expect(configIdentity).toMatchObject({
      defaultResponsibility: 'user',
      exposure: 'public',
      exitClass: 'configuration',
      kind: 'validation',
      retry: 'never',
    });

    const input = codebaseErrorCatalog.require('VALIDATION.CODEBASE.INVENTORY_INPUT_INVALID');
    expect(input).toMatchObject({
      defaultResponsibility: 'tool-author',
      exposure: 'public',
      exitClass: 'runtime',
      kind: 'validation',
      retry: 'never',
    });
  });

  it('states an operator action for every definition', () => {
    for (const definition of codebaseErrorCatalog.list) {
      expect(definition.operatorAction.length).toBeGreaterThan(0);
      expect(definition.lifecycle).toBe('active');
      expect(definition.stability).toBe('public');
    }
  });
});
