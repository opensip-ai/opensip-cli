import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ValidationError } from '../errors.js';
import { logger } from '../logger.js';
import { Registry, type Registerable } from '../registry.js';

interface TestItem extends Registerable {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
}

function make(id: string, name: string, tags?: readonly string[]): TestItem {
  return { id, name, tags };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Registry<T> — duplicatePolicy: warn-first-wins', () => {
  it('first register succeeds', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'warn-first-wins',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    expect(reg.size).toBe(1);
    expect(reg.get('id-1')?.name).toBe('foo');
  });

  it('duplicate id: warn event fires, incumbent kept', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => { /* swallow */ });
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'warn-first-wins',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    reg.register(make('id-1', 'foo-alt'));

    expect(reg.size).toBe(1);
    expect(reg.get('id-1')?.name).toBe('foo'); // first writer wins
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      evt: 'test.registry.duplicate',
      module: 'test',
      id: 'id-1',
      name: 'foo-alt',
    });
  });

  it('duplicate name with different id: warn fires', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => { /* swallow */ });
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'warn-first-wins',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    reg.register(make('id-2', 'foo'));

    expect(reg.size).toBe(1);
    expect(reg.getById('id-1')?.name).toBe('foo');
    expect(reg.getById('id-2')).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('sourcePackage is included in the warn event when passed', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => { /* swallow */ });
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'warn-first-wins',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    reg.register(make('id-1', 'foo'), { sourcePackage: '@third-party/pkg' });

    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      sourcePackage: '@third-party/pkg',
    });
  });
});

describe('Registry<T> — duplicatePolicy: throw', () => {
  it('duplicate id throws ValidationError with configured validationCode', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'throw',
      evtPrefix: 'test.registry',
      validationCode: 'VALIDATION.TEST.DUPLICATE',
    });
    reg.register(make('id-1', 'foo'));
    try {
      reg.register(make('id-1', 'foo-alt'));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('VALIDATION.TEST.DUPLICATE');
    }
  });

  it('falls back to the default validation code when none configured', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'throw',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    try {
      reg.register(make('id-1', 'foo'));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('VALIDATION.REGISTRY.DUPLICATE');
    }
  });

  it('{ internal: true } bypasses the throw', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'throw',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    expect(() => reg.register(make('id-1', 'foo-alt'), { internal: true })).not.toThrow();
    // internal=true also updates the entry (it falls through to the byId.set path).
    expect(reg.get('id-1')?.name).toBe('foo-alt');
  });

  it('registerAll respects per-call options', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'throw',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    // Without internal, the second item (same id) would throw.
    expect(() => reg.registerAll([make('id-1', 'foo'), make('id-2', 'bar')], { internal: true })).not.toThrow();
    expect(reg.size).toBe(2);
  });
});

describe('Registry<T> — duplicatePolicy: overwrite', () => {
  it('duplicate id with different name: stale name mapping removed', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'overwrite',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    reg.register(make('id-1', 'foo-renamed'));
    expect(reg.size).toBe(1);
    expect(reg.getById('id-1')?.name).toBe('foo-renamed');
    expect(reg.getByName('foo')).toBeUndefined(); // stale mapping removed
    expect(reg.getByName('foo-renamed')?.id).toBe('id-1');
  });

  it('duplicate name with different id: stale id mapping removed', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'overwrite',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    reg.register(make('id-2', 'foo'));
    expect(reg.size).toBe(1);
    expect(reg.getById('id-1')).toBeUndefined(); // stale id mapping removed
    expect(reg.getById('id-2')?.name).toBe('foo');
    expect(reg.getByName('foo')?.id).toBe('id-2');
  });

  it('overwrite keeps {byId, byName} consistent', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'overwrite',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    reg.register(make('id-1', 'foo')); // identical re-register
    expect(reg.size).toBe(1);
    expect(reg.getAll()).toHaveLength(1);
  });
});

describe('Registry<T> — duplicatePolicy: silent-skip', () => {
  it('duplicate id returns silently, incumbent kept, no event', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => { /* swallow */ });
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'silent-skip',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    reg.register(make('id-1', 'foo-alt'));
    reg.register(make('id-2', 'foo')); // duplicate name, different id
    expect(reg.size).toBe(1);
    expect(reg.getById('id-1')?.name).toBe('foo');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('Registry<T> — duplicatePolicy: allow-internal', () => {
  it('first non-internal register succeeds', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'allow-internal',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    expect(reg.size).toBe(1);
  });

  it('second non-internal register throws', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'allow-internal',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    expect(() => reg.register(make('id-1', 'foo-alt'))).toThrow(ValidationError);
  });

  it('{ internal: true } bypasses the guard', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'allow-internal',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    expect(() => reg.register(make('id-1', 'foo-alt'), { internal: true })).not.toThrow();
  });
});

describe("Registry<T> — nameCollisionMode: 'throw'", () => {
  it('same name, different id, mode=throw: throws', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'silent-skip',
      evtPrefix: 'test.registry',
      nameCollisionMode: 'throw',
    });
    reg.register(make('id-1', 'foo'));
    try {
      reg.register(make('id-2', 'foo'));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('VALIDATION.REGISTRY.NAME_COLLISION');
    }
  });

  it("same name, different id, mode='allow' (default): falls through to duplicatePolicy", () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'silent-skip',
      evtPrefix: 'test.registry',
    });
    reg.register(make('id-1', 'foo'));
    expect(() => reg.register(make('id-2', 'foo'))).not.toThrow();
    expect(reg.size).toBe(1); // silent-skipped
  });

  it('same name, same id: not a collision', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'silent-skip',
      evtPrefix: 'test.registry',
      nameCollisionMode: 'throw',
    });
    reg.register(make('id-1', 'foo'));
    expect(() => reg.register(make('id-1', 'foo'))).not.toThrow();
  });

  it('{ internal: true } bypasses name-collision throw', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'throw',
      evtPrefix: 'test.registry',
      nameCollisionMode: 'throw',
    });
    reg.register(make('id-1', 'foo'));
    expect(() => reg.register(make('id-2', 'foo'), { internal: true })).not.toThrow();
  });
});

function buildAccessorRegistry(): Registry<TestItem> {
  const reg = new Registry<TestItem>({
    module: 'test',
    duplicatePolicy: 'silent-skip',
    evtPrefix: 'test.registry',
  });
  reg.register(make('id-1', 'foo', ['x', 'y']));
  reg.register(make('id-2', 'bar', ['y', 'z']));
  reg.register(make('id-3', 'baz'));
  return reg;
}

describe('Registry<T> — accessors', () => {
  it('get / getById / getByName / has', () => {
    const reg = buildAccessorRegistry();
    expect(reg.get('id-1')?.name).toBe('foo');
    expect(reg.get('foo')?.id).toBe('id-1');
    expect(reg.getById('id-1')?.name).toBe('foo');
    expect(reg.getById('foo')).toBeUndefined();
    expect(reg.getByName('foo')?.id).toBe('id-1');
    expect(reg.getByName('id-1')).toBeUndefined();
    expect(reg.has('id-1')).toBe(true);
    expect(reg.has('foo')).toBe(true);
    expect(reg.has('missing')).toBe(false);
  });

  it('getAll', () => {
    const reg = buildAccessorRegistry();
    expect(reg.getAll()).toHaveLength(3);
    expect(reg.getAll().map((i) => i.id).sort()).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('getByTag', () => {
    const reg = buildAccessorRegistry();
    expect(reg.getByTag('y').map((i) => i.id).sort()).toEqual(['id-1', 'id-2']);
    expect(reg.getByTag('x').map((i) => i.id)).toEqual(['id-1']);
    expect(reg.getByTag('missing')).toEqual([]);
  });

  it('remove', () => {
    const reg = buildAccessorRegistry();
    expect(reg.remove('id-1')).toBe(true);
    expect(reg.size).toBe(2);
    expect(reg.get('id-1')).toBeUndefined();
    expect(reg.get('foo')).toBeUndefined();
    expect(reg.remove('missing')).toBe(false);
  });

  it('clear', () => {
    const reg = buildAccessorRegistry();
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.getAll()).toEqual([]);
  });

  it('size', () => {
    const reg = new Registry<TestItem>({
      module: 'test',
      duplicatePolicy: 'silent-skip',
      evtPrefix: 'test.registry',
    });
    expect(reg.size).toBe(0);
    reg.register(make('id-1', 'foo'));
    expect(reg.size).toBe(1);
  });
});
