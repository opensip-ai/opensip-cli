import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ValidationError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { RecipeRegistry, type RecipeBase } from '../registry.js';

interface TestRecipe extends RecipeBase {
  readonly extra?: string;
}

const stub = (id: string, name: string, opts: Partial<TestRecipe> = {}): TestRecipe => ({
  id,
  name,
  displayName: opts.displayName ?? name,
  description: opts.description ?? `${name} stub`,
  tags: opts.tags,
  extra: opts.extra,
});

describe('RecipeRegistry', () => {
  let reg: RecipeRegistry<TestRecipe>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reg = new RecipeRegistry<TestRecipe>({ module: 'test:recipes' });
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers and looks up by id and name', () => {
    const r = stub('A', 'alpha');
    reg.register(r);
    expect(reg.getById('A')).toBe(r);
    expect(reg.getByName('alpha')).toBe(r);
    expect(reg.has('A')).toBe(true);
    expect(reg.has('alpha')).toBe(true);
  });

  it('loadRecipe falls back from name to id', () => {
    const r = stub('A', 'alpha');
    reg.register(r);
    expect(reg.loadRecipe('alpha')).toBe(r);
    expect(reg.loadRecipe('A')).toBe(r);
    expect(reg.loadRecipe('nope')).toBeUndefined();
  });

  it('getAllRecipes returns the registered set in registration order', () => {
    reg.register(stub('A', 'alpha'));
    reg.register(stub('B', 'beta'));
    expect(reg.getAllRecipes().map((r) => r.id)).toEqual(['A', 'B']);
  });

  it('getNames returns all registered names', () => {
    reg.register(stub('A', 'alpha'));
    reg.register(stub('B', 'beta'));
    expect(reg.getNames()).toEqual(['alpha', 'beta']);
  });

  it('getByTag filters by recipe tags', () => {
    reg.register(stub('A', 'alpha', { tags: ['fast'] }));
    reg.register(stub('B', 'beta', { tags: ['slow'] }));
    reg.register(stub('C', 'gamma'));
    expect(reg.getByTag('fast').map((r) => r.id)).toEqual(['A']);
  });

  it('size reflects the registered count', () => {
    expect(reg.size).toBe(0);
    reg.register(stub('A', 'alpha'));
    expect(reg.size).toBe(1);
    reg.register(stub('B', 'beta'));
    expect(reg.size).toBe(2);
  });

  it('remove(id) drops both the byId and byName entries', () => {
    reg.register(stub('A', 'alpha'));
    expect(reg.remove('A')).toBe(true);
    expect(reg.getById('A')).toBeUndefined();
    expect(reg.getByName('alpha')).toBeUndefined();
    expect(reg.remove('A')).toBe(false);
  });

  it('clear() drops every entry', () => {
    reg.register(stub('A', 'alpha'));
    reg.register(stub('B', 'beta'));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.getAllRecipes()).toEqual([]);
  });

  it('registerAll registers a batch with shared options', () => {
    reg.registerAll([stub('A', 'alpha'), stub('B', 'beta')]);
    expect(reg.size).toBe(2);
  });

  describe('duplicate-id policy', () => {
    it('default: keeps the first entry, emits a warning', () => {
      const first = stub('A', 'alpha', { extra: 'first' });
      const second = stub('A', 'alpha', { extra: 'second' });
      reg.register(first);
      reg.register(second);
      expect(reg.getById('A')).toBe(first);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'recipe.registry.duplicate',
          module: 'test:recipes',
          id: 'A',
          name: 'alpha',
        }),
      );
    });

    it('also rejects on duplicate name (different id)', () => {
      reg.register(stub('A', 'alpha'));
      reg.register(stub('B', 'alpha'));
      expect(reg.size).toBe(1);
      expect(reg.getById('B')).toBeUndefined();
    });

    it('{ allowOverwrite: true } replaces the entry and keeps mappings consistent', () => {
      reg.register(stub('A', 'alpha', { extra: 'first' }));
      const replacement = stub('A', 'alpha', { extra: 'second' });
      reg.register(replacement, { allowOverwrite: true });
      expect(reg.getById('A')).toBe(replacement);
      expect(reg.getByName('alpha')).toBe(replacement);
      expect(reg.size).toBe(1);
    });

    it('{ allowOverwrite: true } with a different id but same name cleans up the stale id', () => {
      reg.register(stub('A', 'alpha'));
      const replacement = stub('B', 'alpha');
      reg.register(replacement, { allowOverwrite: true });
      expect(reg.getById('A')).toBeUndefined();
      expect(reg.getById('B')).toBe(replacement);
      expect(reg.getByName('alpha')).toBe(replacement);
      expect(reg.size).toBe(1);
    });

    it('{ throwOnDuplicate: true } throws ValidationError', () => {
      reg.register(stub('A', 'alpha'));
      expect(() => reg.register(stub('A', 'alpha'), { throwOnDuplicate: true })).toThrow(
        ValidationError,
      );
    });

    it('{ throwOnDuplicate: true } honours the per-call validationCode override', () => {
      reg.register(stub('A', 'alpha'));
      try {
        reg.register(stub('A', 'alpha'), {
          throwOnDuplicate: true,
          validationCode: 'VALIDATION.TEST.CUSTOM',
        });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).code).toBe('VALIDATION.TEST.CUSTOM');
      }
    });

    it('rejects { allowOverwrite: true, throwOnDuplicate: true } as mutually exclusive', () => {
      // The two flags advertise contradictory semantics; passing both
      // is a programmer error and should throw rather than silently
      // pick one (audit 2026-05-23 / N3).
      expect(() =>
        reg.register(stub('A', 'alpha'), {
          allowOverwrite: true,
          throwOnDuplicate: true,
        }),
      ).toThrow(ValidationError);
    });
  });
});
