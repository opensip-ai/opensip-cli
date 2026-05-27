import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { logger } from '../../lib/logger.js';
import { ToolRegistry } from '../registry.js';

import type { Tool } from '../types.js';

const stub = (id: string, version = '0.0.0'): Tool => ({
  metadata: { id, version, description: `${id} stub` },
  commands: [{ name: id, description: `${id} command` }],
  register: () => undefined,
});

describe('ToolRegistry', () => {
  let reg: ToolRegistry;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reg = new ToolRegistry();
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('register + list round-trip', () => {
    const a = stub('a');
    reg.register(a);
    expect(reg.list()).toEqual([a]);
  });

  it('get returns the registered tool by id', () => {
    const a = stub('a');
    reg.register(a);
    expect(reg.get('a')).toBe(a);
  });

  it('get returns undefined for unknown ids', () => {
    expect(reg.get('nope')).toBeUndefined();
  });

  it('register preserves the first entry on duplicate id (first writer wins)', () => {
    const first = stub('a', '1.0.0');
    const second = stub('a', '9.9.9');
    reg.register(first);
    reg.register(second);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('a')).toBe(first);
  });

  it('register emits a structured warning on duplicate id', () => {
    reg.register(stub('a'));
    reg.register(stub('a'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'tool.registry.duplicate',
        module: 'core:tools',
        id: 'a',
      }),
    );
  });

  it('list() returns one entry per id even after a rejected duplicate', () => {
    reg.register(stub('a'));
    reg.register(stub('a'));
    reg.register(stub('b'));
    expect(reg.list()).toHaveLength(2);
  });

  it('clear removes every registered tool', () => {
    reg.register(stub('a'));
    reg.register(stub('b'));
    reg.clear();
    expect(reg.list()).toEqual([]);
  });

  it('list returns a fresh array each call (caller cannot mutate internal state)', () => {
    reg.register(stub('a'));
    const snapshot = reg.list();
    // Mutating the returned array must not affect the registry.
    (snapshot as Tool[]).pop();
    expect(reg.list()).toHaveLength(1);
  });

  describe('registerThirdParty', () => {
    it('registers when no incumbent exists', () => {
      const t = stub('a');
      reg.registerThirdParty(t, { sourcePackage: '@vendor/a' });
      expect(reg.get('a')).toBe(t);
    });

    it('rejects when an incumbent exists and surfaces the source package in the warning', () => {
      const incumbent = stub('a');
      reg.register(incumbent);
      reg.registerThirdParty(stub('a'), { sourcePackage: '@vendor/a' });
      expect(reg.get('a')).toBe(incumbent);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'tool.registry.duplicate',
          module: 'core:tools',
          id: 'a',
          sourcePackage: '@vendor/a',
        }),
      );
    });
  });
});

