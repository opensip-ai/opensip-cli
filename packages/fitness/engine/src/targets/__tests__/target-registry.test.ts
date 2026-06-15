import { LanguageRegistry, RunScope, runWithScopeSync } from '@opensip-cli/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { TargetRegistry } from '../target-registry.js';

import type { Target } from '../types.js';
import type { LanguageAdapter } from '@opensip-cli/core';

const stub = (
  name: string,
  opts: { tags?: string[]; languages?: string[]; concerns?: string[] } = {},
): Target => ({
  config: {
    name,
    description: name,
    include: [`${name}/**`],
    exclude: [],
    ...(opts.tags && { tags: opts.tags }),
    ...(opts.languages && { languages: opts.languages }),
    ...(opts.concerns && { concerns: opts.concerns }),
  },
});

const stubAdapter = (id: string, aliases: readonly string[] = []): LanguageAdapter => ({
  id,
  fileExtensions: [`.${id}`],
  aliases,
  parse: () => null,
  stripStrings: (s) => s,
  stripComments: (s) => s,
});

describe('TargetRegistry', () => {
  it('register adds new targets and returns this for chaining', () => {
    const reg = new TargetRegistry();
    const result = reg.register(stub('a')).register(stub('b'));
    expect(result).toBe(reg);
    expect(reg.size).toBe(2);
  });

  it('register silently skips duplicate names', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a'));
    reg.register(stub('a'));
    expect(reg.size).toBe(1);
  });

  it('getByName / has lookups', () => {
    const reg = new TargetRegistry();
    const a = stub('a');
    reg.register(a);
    expect(reg.getByName('a')).toBe(a);
    expect(reg.getByName('nope')).toBeUndefined();
    expect(reg.has('a')).toBe(true);
    expect(reg.has('nope')).toBe(false);
  });

  it('getAll returns the live set, but a fresh array each call', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a'));
    const snapshot = reg.getAll();
    expect(snapshot).toHaveLength(1);
    (snapshot as Target[]).pop();
    expect(reg.getAll()).toHaveLength(1); // not affected
  });

  it('getByTag filters by config.tags', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a', { tags: ['fast'] }));
    reg.register(stub('b', { tags: ['slow'] }));
    reg.register(stub('c'));
    expect(reg.getByTag('fast').map((t) => t.config.name)).toEqual(['a']);
  });

  describe('findByScope', () => {
    it('returns targets whose languages intersect when both sides specify', () => {
      const reg = new TargetRegistry();
      reg.register(stub('ts', { languages: ['typescript'], concerns: ['backend'] }));
      reg.register(stub('rs', { languages: ['rust'], concerns: ['backend'] }));
      const matched = reg.findByScope(['typescript'], ['backend']);
      expect(matched.map((t) => t.config.name)).toEqual(['ts']);
    });

    it('treats empty check languages as "matches any"', () => {
      const reg = new TargetRegistry();
      reg.register(stub('ts', { languages: ['typescript'], concerns: ['backend'] }));
      reg.register(stub('rs', { languages: ['rust'], concerns: ['backend'] }));
      expect(reg.findByScope([], ['backend'])).toHaveLength(2);
    });

    it('treats targets with no languages as "matches any check language"', () => {
      const reg = new TargetRegistry();
      reg.register(stub('any-lang', { concerns: ['backend'] })); // no languages
      expect(reg.findByScope(['typescript'], ['backend'])).toHaveLength(1);
    });

    it('treats empty check concerns as "matches any"', () => {
      const reg = new TargetRegistry();
      reg.register(stub('ts', { languages: ['typescript'], concerns: ['backend'] }));
      expect(reg.findByScope(['typescript'], [])).toHaveLength(1);
    });

    it('requires both dimensions to match', () => {
      const reg = new TargetRegistry();
      reg.register(stub('ts-frontend', { languages: ['typescript'], concerns: ['frontend'] }));
      expect(reg.findByScope(['typescript'], ['backend'])).toEqual([]);
    });
  });

  it('clear removes everything', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a'));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.getAll()).toEqual([]);
  });

  describe('findByScope alias canonicalisation', () => {
    // Register language adapters with the bundled aliases on a per-test
    // scope so the target registry's canonicalize call (which reads
    // `currentScope()?.languages`) resolves them. The previously-exported
    // `defaultLanguageRegistry` module global was removed; tests now
    // construct their own `RunScope` and wrap `findByScope` calls in
    // `runWithScopeSync`.
    let scope: RunScope;

    beforeEach(() => {
      const reg = new LanguageRegistry();
      reg.register(stubAdapter('cpp', ['c', 'c++']));
      reg.register(stubAdapter('rust', ['rs']));
      reg.register(stubAdapter('go', ['golang']));
      reg.register(stubAdapter('python', ['py']));
      scope = new RunScope({ languages: reg });
    });

    function findByScopeInScope(
      reg: TargetRegistry,
      langs: string[],
      concerns: string[],
    ): readonly Target[] {
      return runWithScopeSync(scope, () => reg.findByScope(langs, concerns));
    }

    it('a target with languages: ["c"] matches a check scoped to cpp', () => {
      const reg = new TargetRegistry();
      reg.register(stub('c-target', { languages: ['c'] }));
      expect(findByScopeInScope(reg, ['cpp'], []).map((t) => t.config.name)).toEqual(['c-target']);
    });

    it('a target with languages: ["c++"] matches a check scoped to cpp', () => {
      const reg = new TargetRegistry();
      reg.register(stub('cpp-target', { languages: ['c++'] }));
      expect(findByScopeInScope(reg, ['cpp'], []).map((t) => t.config.name)).toEqual([
        'cpp-target',
      ]);
    });

    it('a target with languages: ["rs"] matches a check scoped to rust', () => {
      const reg = new TargetRegistry();
      reg.register(stub('rs-target', { languages: ['rs'] }));
      expect(findByScopeInScope(reg, ['rust'], []).map((t) => t.config.name)).toEqual([
        'rs-target',
      ]);
    });

    it('a target with languages: ["golang"] matches a check scoped to go', () => {
      const reg = new TargetRegistry();
      reg.register(stub('golang-target', { languages: ['golang'] }));
      expect(findByScopeInScope(reg, ['go'], []).map((t) => t.config.name)).toEqual([
        'golang-target',
      ]);
    });

    it('a target with languages: ["py"] matches a check scoped to python', () => {
      const reg = new TargetRegistry();
      reg.register(stub('py-target', { languages: ['py'] }));
      expect(findByScopeInScope(reg, ['python'], []).map((t) => t.config.name)).toEqual([
        'py-target',
      ]);
    });

    it('canonicalisation is symmetric — scope alias matches canonical target', () => {
      const reg = new TargetRegistry();
      reg.register(stub('cpp-target', { languages: ['cpp'] }));
      expect(findByScopeInScope(reg, ['c'], []).map((t) => t.config.name)).toEqual(['cpp-target']);
      expect(findByScopeInScope(reg, ['c++'], []).map((t) => t.config.name)).toEqual([
        'cpp-target',
      ]);
    });

    it('canonical inputs are unchanged (no behaviour change for callers using ids)', () => {
      const reg = new TargetRegistry();
      reg.register(stub('cpp-target', { languages: ['cpp'] }));
      reg.register(stub('rust-target', { languages: ['rust'] }));
      expect(findByScopeInScope(reg, ['cpp'], []).map((t) => t.config.name)).toEqual([
        'cpp-target',
      ]);
      expect(findByScopeInScope(reg, ['rust'], []).map((t) => t.config.name)).toEqual([
        'rust-target',
      ]);
    });

    it('unknown languages fall through case-folded so they still match themselves', () => {
      const reg = new TargetRegistry();
      reg.register(stub('custom-target', { languages: ['ada'] }));
      // 'ada' is not registered as id or alias — registry has no canonical
      // form, so we compare lowercased copies and the target still matches.
      expect(findByScopeInScope(reg, ['ada'], []).map((t) => t.config.name)).toEqual([
        'custom-target',
      ]);
      expect(findByScopeInScope(reg, ['ADA'], []).map((t) => t.config.name)).toEqual([
        'custom-target',
      ]);
    });
  });
});
