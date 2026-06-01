import { describe, it, expect } from 'vitest';

import { LanguageRegistry } from '../../languages/registry.js';
import { RunScope, currentScope } from '../../lib/run-scope.js';
import { ToolRegistry } from '../../tools/registry.js';
import { makeTestScope, withScope, withScopeSync } from '../with-scope.js';

describe('makeTestScope', () => {
  it('constructs a RunScope with fresh empty registries by default', () => {
    const scope = makeTestScope();
    expect(scope).toBeInstanceOf(RunScope);
    expect(scope.languages).toBeInstanceOf(LanguageRegistry);
    expect(scope.tools).toBeInstanceOf(ToolRegistry);
    expect(scope.languages.list()).toHaveLength(0);
    expect(scope.tools.list()).toHaveLength(0);
    scope.dispose();
  });

  it('honours overrides passed via opts', () => {
    const languages = new LanguageRegistry();
    const tools = new ToolRegistry();
    const scope = makeTestScope({ languages, tools });
    expect(scope.languages).toBe(languages);
    expect(scope.tools).toBe(tools);
    scope.dispose();
  });
});

describe('withScope', () => {
  it('runs fn inside the scope and returns its resolved value', async () => {
    const scope = makeTestScope();
    const result = await withScope(scope, async () => {
      await Promise.resolve();
      expect(currentScope()).toBe(scope);
      return 'resolved';
    });
    expect(result).toBe('resolved');
    scope.dispose();
  });
});

describe('withScopeSync', () => {
  it('runs fn synchronously inside the scope and returns its value', () => {
    const scope = makeTestScope();
    const result = withScopeSync(scope, () => {
      expect(currentScope()).toBe(scope);
      return 42;
    });
    expect(result).toBe(42);
    scope.dispose();
  });
});
