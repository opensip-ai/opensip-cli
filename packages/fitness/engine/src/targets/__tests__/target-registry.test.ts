import { describe, expect, it } from 'vitest';

import { TargetRegistry } from '../target-registry.js';

import type { Target } from '../types.js';

const stub = (name: string, opts: { tags?: string[]; languages?: string[]; concerns?: string[] } = {}): Target => ({
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
});
