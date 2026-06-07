import { describe, expect, it, vi } from 'vitest';

import {
  CapabilitySchemaMismatchError,
  NotFoundError,
  UnknownCapabilityDomainError,
  ValidationError,
} from '../../lib/errors.js';
import { RunScope, runWithScopeSync } from '../../lib/run-scope.js';
import {
  isCapabilityValidator,
  isStructuralContributionSchema,
  type CapabilityDomainSpec,
} from '../../tools/capability.js';
import {
  CapabilityRegistry,
  createCapabilityRegistry,
  currentCapabilityRegistry,
} from '../capability-registry.js';

/** A no-op registrar for tests that only assert registration/lookup. */
const noopRegistrar = (): void => undefined;

function domain(overrides: Partial<CapabilityDomainSpec> = {}): CapabilityDomainSpec {
  return {
    id: 'audit-rule',
    ownerToolId: 'audit',
    apiVersion: 1,
    contributionSchema: { requiredKeys: ['id', 'name'] },
    contributionKind: 'module-export',
    ...overrides,
  };
}

describe('CapabilityRegistry', () => {
  describe('registerDomain', () => {
    it('registers a domain and surfaces it via getDomain/hasDomain/listDomains', () => {
      const reg = new CapabilityRegistry();
      const spec = domain();
      reg.registerDomain(spec, noopRegistrar);

      expect(reg.hasDomain('audit-rule')).toBe(true);
      expect(reg.getDomain('audit-rule')).toEqual(spec);
      expect(reg.listDomains()).toEqual([spec]);
    });

    it('first-writer-wins on duplicate domain id (second registration is a no-op)', () => {
      const reg = new CapabilityRegistry();
      const first = vi.fn();
      const second = vi.fn();
      reg.registerDomain(domain(), first);
      reg.registerDomain(domain({ apiVersion: 99 }), second);

      // Incumbent kept — getDomain returns the first spec's apiVersion.
      expect(reg.getDomain('audit-rule')?.apiVersion).toBe(1);
      reg.routeContribution('audit-rule', { id: 'x', name: 'X' });
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
    });
  });

  describe('setRegistrar (Phase 4 — real registrar replaces deferred placeholder)', () => {
    it('replaces the registrar for a declared domain so routeContribution reaches the real one', () => {
      const reg = new CapabilityRegistry();
      const placeholder = vi.fn(() => {
        throw new Error('deferred placeholder must not run');
      });
      const real = vi.fn();
      reg.registerDomain(domain(), placeholder);

      // Swap the placeholder for the real registrar, then route.
      reg.setRegistrar('audit-rule', real);
      reg.routeContribution('audit-rule', { id: 'x', name: 'X' });

      expect(placeholder).not.toHaveBeenCalled();
      expect(real).toHaveBeenCalledOnce();
      expect(real).toHaveBeenCalledWith({ id: 'x', name: 'X' });
    });

    it('keeps the manifest-declared spec verbatim when the registrar is swapped', () => {
      const reg = new CapabilityRegistry();
      const spec = domain();
      reg.registerDomain(spec, noopRegistrar);
      reg.setRegistrar('audit-rule', vi.fn());
      expect(reg.getDomain('audit-rule')).toEqual(spec);
    });

    it('throws UnknownCapabilityDomainError for an undeclared domain', () => {
      const reg = new CapabilityRegistry();
      expect(() => reg.setRegistrar('not-declared', vi.fn())).toThrow(UnknownCapabilityDomainError);
    });
  });

  describe('routeContribution', () => {
    it('routes a schema-valid contribution to the owner registrar without interpreting it', () => {
      const reg = new CapabilityRegistry();
      const registrar = vi.fn();
      reg.registerDomain(domain(), registrar);

      const contribution = { id: 'c1', name: 'Check One', extra: 42 };
      reg.routeContribution('audit-rule', contribution);

      expect(registrar).toHaveBeenCalledExactlyOnceWith(contribution);
    });

    it('throws NotFoundError (CAPABILITY.DOMAIN.UNKNOWN) for an unknown domain', () => {
      const reg = new CapabilityRegistry();
      reg.registerDomain(domain(), noopRegistrar);

      let caught: unknown;
      try {
        reg.routeContribution('does-not-exist', { id: 'x', name: 'X' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnknownCapabilityDomainError);
      expect(caught).toBeInstanceOf(NotFoundError); // subclass — existing handling still catches it
      const err = caught as UnknownCapabilityDomainError;
      expect(err.code).toBe('CAPABILITY.DOMAIN.UNKNOWN');
      expect(err.domainId).toBe('does-not-exist');
      expect(err.knownDomains).toEqual(['audit-rule']);
    });

    it('throws ValidationError (SCHEMA_MISMATCH) with a structured diagnostic on a structural miss', () => {
      const reg = new CapabilityRegistry();
      const registrar = vi.fn();
      reg.registerDomain(domain(), registrar);

      let caught: unknown;
      try {
        reg.routeContribution('audit-rule', { id: 'only-id' }); // missing `name`
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CapabilitySchemaMismatchError);
      expect(caught).toBeInstanceOf(ValidationError); // subclass — existing handling still catches it
      const err = caught as CapabilitySchemaMismatchError;
      expect(err.code).toBe('CAPABILITY.CONTRIBUTION.SCHEMA_MISMATCH');
      expect(err.domainId).toBe('audit-rule');
      expect(err.ownerToolId).toBe('audit');
      expect(err.diagnostic).toContain('name');
      expect(registrar).not.toHaveBeenCalled();
    });

    it('rejects a non-object contribution against a structural schema', () => {
      const reg = new CapabilityRegistry();
      reg.registerDomain(domain(), noopRegistrar);
      expect(() => reg.routeContribution('audit-rule', 'nope')).toThrow(ValidationError);
    });

    it('validates via an owner-supplied validator function', () => {
      const reg = new CapabilityRegistry();
      const registrar = vi.fn();
      reg.registerDomain(
        domain({
          contributionSchema: (c: unknown) =>
            typeof c === 'number' ? true : 'expected a number',
        }),
        registrar,
      );

      reg.routeContribution('audit-rule', 7);
      expect(registrar).toHaveBeenCalledExactlyOnceWith(7);

      expect(() => reg.routeContribution('audit-rule', 'x')).toThrow(/expected a number/);
    });

    it('accepts any contribution when the schema declares no constraint', () => {
      const reg = new CapabilityRegistry();
      const registrar = vi.fn();
      reg.registerDomain(domain({ contributionSchema: undefined }), registrar);
      reg.routeContribution('audit-rule', { anything: true });
      expect(registrar).toHaveBeenCalledOnce();
    });
  });
});

describe('scope-owned reader (per-RunScope, no module singleton)', () => {
  it('currentCapabilityRegistry returns the scope-bound instance', () => {
    const scope = new RunScope();
    const reg = createCapabilityRegistry();
    scope.capabilities = reg;
    runWithScopeSync(scope, () => {
      expect(currentCapabilityRegistry()).toBe(reg);
    });
  });

  it('isolates two concurrent scopes', () => {
    const scopeA = new RunScope();
    const scopeB = new RunScope();
    scopeA.capabilities = createCapabilityRegistry();
    scopeB.capabilities = createCapabilityRegistry();
    scopeA.capabilities.registerDomain(domain({ id: 'a-domain' }), noopRegistrar);
    scopeB.capabilities.registerDomain(domain({ id: 'b-domain' }), noopRegistrar);

    runWithScopeSync(scopeA, () => {
      expect(currentCapabilityRegistry().hasDomain('a-domain')).toBe(true);
      expect(currentCapabilityRegistry().hasDomain('b-domain')).toBe(false);
    });
    runWithScopeSync(scopeB, () => {
      expect(currentCapabilityRegistry().hasDomain('b-domain')).toBe(true);
      expect(currentCapabilityRegistry().hasDomain('a-domain')).toBe(false);
    });
  });

  it('throws when read outside any RunScope', () => {
    expect(() => currentCapabilityRegistry()).toThrow(/outside a RunScope/);
  });

  it('throws when the scope has no capability registry attached', () => {
    const scope = new RunScope();
    runWithScopeSync(scope, () => {
      expect(() => currentCapabilityRegistry()).toThrow(/scope\.capabilities is missing/);
    });
  });
});

describe('schema type guards', () => {
  it('isCapabilityValidator detects a function schema', () => {
    expect(isCapabilityValidator(() => true)).toBe(true);
    expect(isCapabilityValidator({ requiredKeys: [] })).toBe(false);
  });

  it('isStructuralContributionSchema detects a requiredKeys record', () => {
    expect(isStructuralContributionSchema({ requiredKeys: ['a'] })).toBe(true);
    expect(isStructuralContributionSchema({ requiredKeys: [1] })).toBe(false);
    expect(isStructuralContributionSchema(undefined)).toBe(false);
    expect(isStructuralContributionSchema(() => true)).toBe(false);
  });
});
