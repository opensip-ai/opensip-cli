import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { defineErrorCatalog, ErrorDefinitionError } from '../../lib/error-definition.js';
import { logger } from '../../lib/logger.js';
import { ToolRegistry } from '../registry.js';

import type { Tool } from '../types.js';

const stub = (id: string, version = '0.0.0'): Tool => ({
  identity: { name: 'test-tool' },
  metadata: {
    id: '00000000-0000-4000-8000-000000000000',
    name: id,
    version,
    description: `${id} stub`,
  },
  commands: [{ name: id, description: `${id} command` }],
});

const catalogDef = {
  source: 'application' as const,
  defaultResponsibility: 'user' as const,
  kind: 'validation' as const,
  retry: 'never' as const,
  severity: 'error' as const,
  exposure: 'public' as const,
  exitClass: 'configuration' as const,
  operatorAction: 'fix',
  stability: 'public' as const,
  lifecycle: 'active' as const,
};

function stubWithCatalog(name: string, toolId: string, code: string): Tool {
  const catalog = defineErrorCatalog(
    { id: toolId, displayName: name, packageName: `@scope/${name}` },
    { [code]: { ...catalogDef, code } },
  );
  return {
    identity: { name },
    metadata: {
      id: toolId,
      name,
      version: '0.0.0',
      description: `${name} stub`,
    },
    commands: [{ name, description: `${name} command` }],
    extensionPoints: { errorCatalog: catalog },
  };
}

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

  it('values lazily iterates tools in registration order', () => {
    const a = stub('a');
    const b = stub('b');
    reg.register(a);
    reg.register(b);

    const iterator = reg.values();
    expect(iterator.next()).toEqual({ value: a, done: false });
    expect(iterator.next()).toEqual({ value: b, done: false });
    expect(iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('supports direct iteration without routing through list()', () => {
    const a = stub('a');
    const b = stub('b');
    reg.register(a);
    reg.register(b);
    const listSpy = vi.spyOn(reg, 'list');

    expect([...reg]).toEqual([a, b]);
    expect(listSpy).not.toHaveBeenCalled();
  });

  describe('register with sourcePackage (third-party discovery path)', () => {
    it('registers when no incumbent exists', () => {
      const t = stub('a');
      reg.register(t, { sourcePackage: '@vendor/a' });
      expect(reg.get('a')).toBe(t);
    });

    it('rejects when an incumbent exists and surfaces the source package in the warning', () => {
      const incumbent = stub('a');
      reg.register(incumbent);
      reg.register(stub('a'), { sourcePackage: '@vendor/a' });
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

  describe('error catalog registration (Plan 00)', () => {
    it('indexes a tool catalog after register', () => {
      const tool = stubWithCatalog(
        'fit-like',
        '11111111-1111-4111-8111-111111111111',
        'FITLIKE.DEMO.CODE',
      );
      reg.register(tool);
      expect(reg.getErrorCatalogIndex().byCode.get('FITLIKE.DEMO.CODE')?.toolName).toBe('fit-like');
    });

    it('refuses register when a colliding code would leave a half-mounted tool', () => {
      const a = stubWithCatalog(
        'tool-a',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'SHARED.COLLISION.X',
      );
      const b = stubWithCatalog(
        'tool-b',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'SHARED.COLLISION.X',
      );
      reg.register(a);
      expect(() => reg.register(b)).toThrow(ErrorDefinitionError);
      // Colliding tool must not remain registered.
      expect(reg.get('tool-b')).toBeUndefined();
      expect(reg.list().map((t) => t.metadata.name)).toEqual(['tool-a']);
    });
  });
});
