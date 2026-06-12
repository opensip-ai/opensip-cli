import { describe, expect, it } from 'vitest';

import { TargetRegistry } from '../target-registry.js';

import type { Target } from '@opensip-cli/config';

/**
 * Substrate registry tests — the GENERIC surface only (register/get/byTag/has/
 * size/clear + silent-skip). The scope-matching `findByScope` is a check-domain
 * concept that stays in `@opensip-cli/fitness`, so it is NOT exercised here
 * (its tests live alongside the fitness subclass).
 */

const stub = (name: string, opts: { tags?: string[] } = {}): Target => ({
  config: {
    name,
    description: name,
    include: [`${name}/**`],
    exclude: [],
    ...(opts.tags && { tags: opts.tags }),
  },
});

describe('TargetRegistry (substrate)', () => {
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
    expect(reg.getByTag('missing')).toEqual([]);
  });

  it('clear removes everything', () => {
    const reg = new TargetRegistry();
    reg.register(stub('a'));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.getAll()).toEqual([]);
  });
});
