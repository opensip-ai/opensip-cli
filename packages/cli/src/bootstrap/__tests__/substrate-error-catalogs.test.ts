import {
  ErrorDefinitionError,
  ToolRegistry,
  defineErrorCatalog,
  coreErrorCatalog,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { HOST_SUBSTRATE_ERROR_CATALOGS } from '../substrate-error-catalogs.js';

import type { Tool } from '@opensip-cli/core';

const registryWithSubstrates = (): ToolRegistry => {
  const registry = new ToolRegistry();
  for (const contribution of HOST_SUBSTRATE_ERROR_CATALOGS) {
    registry.registerSubstrateCatalog(contribution);
  }
  return registry;
};

/** Minimal admissible tool carrying one error-catalog contribution. */
const toolClaiming = (code: string): Tool => {
  const owner = {
    id: 'ffffffff-0000-4000-8000-000000000001',
    displayName: 'squatter',
    packageName: '@third-party/squatter',
  };
  return {
    metadata: { id: owner.id, name: 'squatter', version: '1.0.0', description: 'test' },
    extensionPoints: {
      errorCatalog: defineErrorCatalog(owner, {
        [code]: {
          code,
          source: 'application',
          defaultResponsibility: 'user',
          kind: 'validation',
          retry: 'never',
          severity: 'error',
          exposure: 'public',
          exitClass: 'configuration',
          operatorAction: 'fix it',
          stability: 'public',
          lifecycle: 'active',
        },
      }),
    },
  } as unknown as Tool;
};

describe('HOST_SUBSTRATE_ERROR_CATALOGS', () => {
  it('registers without a self-collision', () => {
    // The two core catalogs share one owner id, so listing coreErrorCatalog here is only
    // safe because it is disjoint from coreSystemErrorCatalog. If that ever stops being
    // true, this is where it surfaces — at host bootstrap, on every command.
    expect(() => registryWithSubstrates()).not.toThrow();
  });

  it('is idempotent per package, so a second scope in one process does not self-collide', () => {
    // The lightweight command probe builds a second registry in the same process.
    const registry = registryWithSubstrates();
    expect(() => {
      for (const contribution of HOST_SUBSTRATE_ERROR_CATALOGS) {
        registry.registerSubstrateCatalog(contribution);
      }
    }).not.toThrow();
  });

  it('refuses a third-party tool that claims a substrate-owned code', () => {
    // THE POINT OF THE WIRING. Without the composition root supplying substrates, this
    // registration succeeded and the third-party definition silently became the resolved
    // one for a code core owns.
    const registry = registryWithSubstrates();
    expect(() => registry.register(toolClaiming('CORE.LOCK.MALFORMED'))).toThrow(
      ErrorDefinitionError,
    );
  });

  it('still admits a third-party tool that stays in its own namespace', () => {
    const registry = registryWithSubstrates();
    expect(() => registry.register(toolClaiming('SQUATTER.DEMO.OK'))).not.toThrow();
    expect(registry.getErrorCatalogIndex().byCode.get('SQUATTER.DEMO.OK')?.toolName).toBe(
      'squatter',
    );
  });

  it('leaves every Wave 1 core code resolvable through the runtime aggregate', () => {
    // Without the coreErrorCatalog entry the aggregate is seeded from coreSystemErrorCatalog
    // alone, so all ~80 codes authored in Wave 1 would be absent from the index that decides
    // collisions — and a squatter could take any of them.
    const { byCode } = registryWithSubstrates().getErrorCatalogIndex();
    const missing = coreErrorCatalog.list.map((d) => d.code).filter((c) => !byCode.has(c));
    expect(missing).toEqual([]);
  });

  it('would leave those codes unowned if the substrate list were dropped', () => {
    // Proves the assertion above is load-bearing rather than incidentally true: a registry
    // without the substrate list resolves NONE of the Wave 1 codes, so a squatter would be
    // admitted rather than refused.
    const bare = new ToolRegistry();
    expect(bare.getErrorCatalogIndex().byCode.has('CORE.LOCK.MALFORMED')).toBe(false);
    expect(() => bare.register(toolClaiming('CORE.LOCK.MALFORMED'))).not.toThrow();
  });
});
