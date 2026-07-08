import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

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
    cacheKey: 'test-cache',
    filesFingerprint: 'test-fingerprint',
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

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initGitProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'opensip-fit-changed-'));
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 't@example.com']);
  git(cwd, ['config', 'user.name', 'T']);
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'callee.ts'), 'initial\n', 'utf8');
  git(cwd, ['add', 'src/callee.ts']);
  git(cwd, ['commit', '-m', 'init']);
  return cwd;
}

describe('restrictFileMapToChanged', () => {
  it('intersects per-file check targets with the changed set, KEEPING empty entries', () => {
    const cwd = '/proj';
    const changed = new Set([path.resolve(cwd, 'src/a.ts')]);
    const scopeMap = new Map<string, readonly string[]>([
      ['check-a', [path.resolve(cwd, 'src/a.ts'), path.resolve(cwd, 'src/b.ts')]],
      ['check-b', [path.resolve(cwd, 'src/c.ts')]],
    ]);
    const narrowed = restrictFileMapToChanged(scopeMap, changed, new Set());
    // check-b has no changed files, but it is NOT dropped — it keeps an EMPTY
    // entry so it scans nothing (an absent entry would fall back to the whole-repo
    // fileCache, which lacks the target-level test-file excludes).
    expect([...narrowed.keys()]).toEqual(['check-a', 'check-b']);
    expect(narrowed.get('check-a')).toEqual([path.resolve(cwd, 'src/a.ts')]);
    expect(narrowed.get('check-b')).toEqual([]);
  });

  it('keeps analyzeAll (full-scope) checks at their FULL file list', () => {
    const cwd = '/proj';
    const changed = new Set([path.resolve(cwd, 'src/a.ts')]);
    const full = [path.resolve(cwd, 'src/x.ts'), path.resolve(cwd, 'src/y.ts')];
    const scopeMap = new Map<string, readonly string[]>([
      ['per-file', [path.resolve(cwd, 'src/a.ts'), path.resolve(cwd, 'src/b.ts')]],
      ['whole-repo', full],
    ]);
    const narrowed = restrictFileMapToChanged(scopeMap, changed, new Set(['whole-repo']));
    // A whole-repo invariant check must not be narrowed — none of its files
    // changed, yet it keeps its full scope (or it would false-flag unchanged
    // targets as "missing").
    expect(narrowed.get('whole-repo')).toEqual(full);
    expect(narrowed.get('per-file')).toEqual([path.resolve(cwd, 'src/a.ts')]);
  });
});

describe('resolveChangedSet', () => {
  it('falls back to a full run when graphCatalog thunk is absent', () => {
    const cwd = initGitProject();
    writeFileSync(join(cwd, 'src', 'callee.ts'), 'changed\n', 'utf8');
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
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.trust).toMatchObject({
          coverage: 'partial',
          fallback: 'full-run',
          fullyVerified: false,
        });
        expect(result.warning).toContain('full fit target set');
      }
    });
    scope.dispose();
  });

  it('expands targets with impacted files when catalog thunk is wired', () => {
    const cwd = initGitProject();
    writeFileSync(join(cwd, 'src', 'callee.ts'), 'changed\n', 'utf8');
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
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.trust.fullyVerified).toBe(true);
        expect(result.files).toContain(path.resolve(cwd, 'src/callee.ts'));
        expect(result.files).toContain(path.resolve(cwd, 'src/caller.ts'));
      }
    });
    scope.dispose();
  });

  it('falls back to a full run when the graph catalog is incomplete', () => {
    const cwd = initGitProject();
    writeFileSync(join(cwd, 'src', 'callee.ts'), 'changed\n', 'utf8');
    const source = minimalImpactCatalog();
    const catalog: GraphCatalog = {
      version: source.version,
      tool: source.tool,
      language: source.language,
      builtAt: source.builtAt,
      functions: source.functions,
    };
    const scope = new RunScope({
      tools: new ToolRegistry(),
      languages: new LanguageRegistry(),
    });
    Object.assign(scope, { graphCatalog: () => catalog });
    runWithScopeSync(scope, () => {
      const result = resolveChangedSet({
        cwd,
        changed: true,
        includeImpacted: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.trust.fallback).toBe('full-run');
        expect(result.trust.uncertainties.map((item) => item.code)).toContain(
          'graph-catalog-incomplete',
        );
      }
    });
    scope.dispose();
  });

  it('falls back to a full run for deleted changed files even without impact expansion', () => {
    const cwd = initGitProject();
    rmSync(join(cwd, 'src', 'callee.ts'));
    const scope = new RunScope({
      tools: new ToolRegistry(),
      languages: new LanguageRegistry(),
    });
    runWithScopeSync(scope, () => {
      const result = resolveChangedSet({
        cwd,
        changed: true,
        includeImpacted: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.trust.fallback).toBe('full-run');
        expect(result.trust.uncertainties.map((item) => item.code)).toContain(
          'changed-file-deleted',
        );
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
