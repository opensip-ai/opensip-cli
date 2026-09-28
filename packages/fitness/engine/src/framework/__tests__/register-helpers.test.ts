import { RunScope, applyToolContributeScope, runWithScopeSync } from '@opensip-cli/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { fitnessTool } from '../../tool.js';
import { defineCheck } from '../define-check.js';
import { CheckRegistry } from '../registry.js';
import { currentCheckRegistry } from '../scope-registry.js';

import { registerChecks } from './register-helpers.fixture.js';

import type { Check } from '../check-types.js';

let nextId = 0;
function uid(): string {
  nextId++;
  return `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`;
}

function stub(slug: string): Check {
  return defineCheck({
    id: uid(),
    slug,
    description: slug,
    tags: ['demo'],
    analyze: () => [],
  });
}

// `registerChecks` writes into the current scope's check registry. Each test
// enters a fresh RunScope with fitness's contributed subscope so the registry
// starts empty and is isolated from sibling tests.
let scope: RunScope;
beforeEach(() => {
  scope = new RunScope();
  applyToolContributeScope(scope, fitnessTool);
});

describe('registerChecks', () => {
  it('registers each check and returns the count', () =>
    runWithScopeSync(scope, () => {
      const sizeBefore = currentCheckRegistry().size;
      const count = registerChecks([stub('rc-a'), stub('rc-b')], 'test-ns-a');
      expect(count).toBe(2);
      expect(currentCheckRegistry().size).toBe(sizeBefore + 2);
    }));

  it('returns 0 for an empty list', () =>
    runWithScopeSync(scope, () => {
      expect(registerChecks([], 'test-ns-empty')).toBe(0);
    }));

  it('namespaces checks under the given namespace', () =>
    runWithScopeSync(scope, () => {
      registerChecks([stub('rc-hello')], 'test-ns-c');
      expect(currentCheckRegistry().getBySlug('test-ns-c:rc-hello')).toBeDefined();
    }));

  it('CheckRegistry can be instantiated standalone', () =>
    runWithScopeSync(scope, () => {
      const registry = new CheckRegistry();
      expect(registry.size).toBe(0);
      registry.register(stub('standalone'));
      expect(registry.size).toBe(1);
    }));
});
