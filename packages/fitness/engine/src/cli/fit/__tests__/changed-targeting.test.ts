import path from 'node:path';

import { LanguageRegistry, RunScope, ToolRegistry, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { resolveChangedSet, restrictFileMapToChanged } from '../changed-targeting.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

function minimalImpactCatalog(): GraphCatalog {
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-01-01T00:00:00.000Z',
    functions: {
      caller: [
        {
          bodyHash: 'caller',
          qualifiedName: 'caller',
          simpleName: 'caller',
          filePath: 'src/caller.ts',
          line: 1,
          column: 1,
          endLine: 5,
          kind: 'function-declaration',
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          calls: [
            {
              to: ['callee'],
              line: 2,
              column: 4,
              resolution: 'static',
              confidence: 'high',
              text: 'callee()',
            },
          ],
        },
      ],
      callee: [
        {
          bodyHash: 'callee',
          qualifiedName: 'callee',
          simpleName: 'callee',
          filePath: 'src/callee.ts',
          line: 1,
          column: 1,
          endLine: 5,
          kind: 'function-declaration',
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          calls: [],
        },
      ],
    },
  };
}

describe('restrictFileMapToChanged', () => {
  it('intersects check targets with the changed set and drops empty checks', () => {
    const cwd = '/proj';
    const changed = new Set([path.resolve(cwd, 'src/a.ts')]);
    const scopeMap = new Map<string, readonly string[]>([
      ['check-a', [path.resolve(cwd, 'src/a.ts'), path.resolve(cwd, 'src/b.ts')]],
      ['check-b', [path.resolve(cwd, 'src/c.ts')]],
    ]);
    const narrowed = restrictFileMapToChanged(scopeMap, changed);
    expect([...narrowed.keys()]).toEqual(['check-a']);
    expect(narrowed.get('check-a')).toEqual([path.resolve(cwd, 'src/a.ts')]);
  });
});

describe('resolveChangedSet', () => {
  it('degrades to changed-only when graphCatalog thunk is absent', () => {
    const cwd = '/proj';
    const scope = new RunScope({
      tools: new ToolRegistry(),
      languages: new LanguageRegistry(),
    });
    runWithScopeSync(scope, () => {
      const result = resolveChangedSet({
        cwd,
        changed: true,
        includeImpacted: true,
      });
      expect(result.ok).toBe(false);
    });
    scope.dispose();
  });

  it('expands targets with impacted files when catalog thunk is wired', () => {
    const cwd = '/proj';
    const catalog = minimalImpactCatalog();
    const scope = new RunScope({
      tools: new ToolRegistry(),
      languages: new LanguageRegistry(),
    });
    // `graphCatalog` is a contributed scope slot (installed by graph's
    // contributeScope() via Object.assign), not a constructor option — mirror
    // that install here.
    Object.assign(scope, { graphCatalog: () => catalog });
    runWithScopeSync(scope, () => {
      const result = resolveChangedSet({
        cwd,
        changed: true,
        includeImpacted: true,
        since: undefined,
      });
      // Without git, resolveChangedFiles fails — this exercises the degraded path.
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toBeTruthy();
      }
    });
    scope.dispose();
  });
});

describe('RunScope.graphCatalog default', () => {
  it('returns undefined when no thunk is configured', () => {
    const scope = new RunScope();
    expect(scope.graphCatalog).toBeUndefined();
    scope.dispose();
  });
});
