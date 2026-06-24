import { describe, expect, it } from 'vitest';

import { RunScope } from '../../lib/run-scope.js';
import { createToolScope } from '../create-tool-scope.js';
import { buildToolIdentityIndex, resolveToolFilterToLayoutKey } from '../identity-index.js';
import { validateToolIdentity } from '../identity.js';
import { ToolRegistry } from '../registry.js';

import type { Tool } from '../types.js';

declare module '../../lib/scope-types.js' {
  interface ScopeContribution {
    readonly testTool?: { readonly value: number };
  }
}

function makeTool(name: string, identity?: Tool['identity']): Tool {
  return {
    identity: identity ?? { name },
    metadata: {
      id: `00000000-0000-4000-8000-0000000000${name.length.toString().padStart(2, '0')}`,
      name,
      version: '0.0.0',
      description: `${name} tool`,
    },
    commands: [{ name, description: `${name} command` }],
  };
}

describe('validateToolIdentity', () => {
  it('normalizes aliases and default layoutKey', () => {
    expect(validateToolIdentity({ name: 'fit', aliases: ['f'] })).toEqual({
      name: 'fit',
      aliases: ['f'],
      layoutKey: 'fit',
    });
  });

  it('rejects malformed identities and alias drift', () => {
    expect(() => validateToolIdentity(undefined as never)).toThrow(/required/);
    expect(() => validateToolIdentity({ name: 'BadName' })).toThrow(/kebab-case/);
    expect(() => validateToolIdentity({ name: 'fit', aliases: 'f' as never })).toThrow(/aliases/);
    expect(() => validateToolIdentity({ name: 'fit', aliases: ['fit'] })).toThrow(/aliases/);
    expect(() => validateToolIdentity({ name: 'fit', aliases: ['f', 'f'] })).toThrow(/Duplicate/);
    expect(() => validateToolIdentity({ name: 'fit', layoutKey: 1 as never })).toThrow(/layoutKey/);
  });
});

describe('tool identity index', () => {
  it('resolves canonical names, aliases, and layout keys', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('fitness', { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' }));

    const index = buildToolIdentityIndex(registry);
    expect(index.resolveInput('fitness')?.layoutKey).toBe('fit');
    expect(index.resolveInput('fit')?.canonicalName).toBe('fitness');
    expect(index.canonicalForStoredTool('fit')).toBe('fitness');
    expect(index.canonicalForStoredTool('unknown')).toBe('unknown');
    expect(resolveToolFilterToLayoutKey(registry, 'fitness')).toBe('fit');
    expect(resolveToolFilterToLayoutKey(registry, undefined)).toBeUndefined();
  });

  it('throws on ambiguous identity inputs', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('alpha', { name: 'alpha', aliases: ['shared'] }));
    registry.register(makeTool('beta', { name: 'beta', aliases: ['shared'] }));

    expect(() => buildToolIdentityIndex(registry)).toThrow(/declared by both/);
  });

  it('requires every registered tool to declare identity', () => {
    const registry = new ToolRegistry();
    registry.register({ ...makeTool('legacy'), identity: undefined as never });

    expect(() => buildToolIdentityIndex(registry)).toThrow(/missing identity/);
  });
});

describe('createToolScope', () => {
  it('builds a contribution factory and applies it in tests', () => {
    const helper = createToolScope({
      slot: 'testTool',
      create: () => ({ value: 42 }),
    });
    const scope = new RunScope();

    expect(helper.contributeScope()).toEqual({ testTool: { value: 42 } });
    helper.applyInTests(scope);
    expect(scope.testTool?.value).toBe(42);
  });
});
