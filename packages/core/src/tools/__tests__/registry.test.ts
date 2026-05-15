import { describe, it, expect, beforeEach } from 'vitest';

import { ToolRegistry, defaultToolRegistry } from '../registry.js';

import type { Tool } from '../types.js';

const stub = (id: string): Tool => ({
  metadata: { id, version: '0.0.0', description: `${id} stub` },
  commands: [{ name: id, description: `${id} command` }],
  register: () => undefined,
});

describe('ToolRegistry', () => {
  let reg: ToolRegistry;

  beforeEach(() => {
    reg = new ToolRegistry();
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

  it('register replaces an existing tool with the same id (last writer wins)', () => {
    const first = stub('a');
    const second = { ...stub('a'), metadata: { id: 'a', version: '9.9.9', description: 'replaced' } };
    reg.register(first);
    reg.register(second);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('a')).toBe(second);
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
});

describe('defaultToolRegistry', () => {
  it('is a ToolRegistry singleton', () => {
    expect(defaultToolRegistry).toBeInstanceOf(ToolRegistry);
  });
});
