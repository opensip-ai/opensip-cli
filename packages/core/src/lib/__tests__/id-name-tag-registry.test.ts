import { describe, it, expect } from 'vitest';

import { ValidationError } from '../errors.js';
import { IdNameTagRegistry, type Registerable } from '../id-name-tag-registry.js';

interface TestItem extends Registerable {
  readonly id: string;
  readonly name: string;
  readonly tags?: readonly string[];
}

function makeItem(id: string, name: string, tags?: readonly string[]): TestItem {
  return { id, name, tags };
}

describe('IdNameTagRegistry', () => {
  it('registers an item and looks it up by id and name', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    reg.register(makeItem('id-1', 'foo'));
    expect(reg.get('id-1')).toEqual({ id: 'id-1', name: 'foo' });
    expect(reg.get('foo')).toEqual({ id: 'id-1', name: 'foo' });
  });

  it('returns undefined for unknown id/name', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    expect(reg.get('missing')).toBeUndefined();
  });

  it('has() reports true for both id and name, false otherwise', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    reg.register(makeItem('id-1', 'foo'));
    expect(reg.has('id-1')).toBe(true);
    expect(reg.has('foo')).toBe(true);
    expect(reg.has('missing')).toBe(false);
  });

  it('silently skips re-registering the same id', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    reg.register(makeItem('id-1', 'foo'));
    reg.register(makeItem('id-1', 'foo'));
    reg.register(makeItem('id-1', 'foo-alt')); // same id, different name — also ignored
    expect(reg.size).toBe(1);
    // The first registration wins; second is skipped.
    expect(reg.get('id-1')?.name).toBe('foo');
  });

  it('throws ValidationError on name collision with a different id', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    reg.register(makeItem('id-1', 'foo'));
    expect(() => reg.register(makeItem('id-2', 'foo'))).toThrow(ValidationError);
    try {
      reg.register(makeItem('id-3', 'foo'));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('VALIDATION.REGISTRY.NAME_COLLISION');
    }
  });

  it('getAll() returns every registered item', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    reg.register(makeItem('id-1', 'foo'));
    reg.register(makeItem('id-2', 'bar'));
    reg.register(makeItem('id-3', 'baz'));
    expect(reg.getAll()).toHaveLength(3);
    expect(reg.getAll().map((i) => i.id).sort()).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('getByTag() returns only items with the matching tag', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    reg.register(makeItem('id-1', 'foo', ['x', 'y']));
    reg.register(makeItem('id-2', 'bar', ['y', 'z']));
    reg.register(makeItem('id-3', 'baz'));
    expect(reg.getByTag('y').map((i) => i.id).sort()).toEqual(['id-1', 'id-2']);
    expect(reg.getByTag('x').map((i) => i.id)).toEqual(['id-1']);
    expect(reg.getByTag('nope')).toEqual([]);
  });

  it('size reflects the number of unique ids', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    expect(reg.size).toBe(0);
    reg.register(makeItem('id-1', 'foo'));
    expect(reg.size).toBe(1);
    reg.register(makeItem('id-2', 'bar'));
    expect(reg.size).toBe(2);
  });

  it('clear() empties both indexes', () => {
    const reg = new IdNameTagRegistry<TestItem>('test');
    reg.register(makeItem('id-1', 'foo'));
    reg.register(makeItem('id-2', 'bar'));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.get('id-1')).toBeUndefined();
    expect(reg.get('foo')).toBeUndefined();
  });
});
