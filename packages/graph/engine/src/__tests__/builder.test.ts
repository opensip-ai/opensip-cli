import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildCatalog } from '../catalog/builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SIMPLE_FIXTURE = join(__dirname, 'fixtures', 'simple-project');
const POLY_FIXTURE = join(__dirname, 'fixtures', 'poly-project');

describe('buildCatalog (simple-project)', () => {
  it('emits FunctionNodes for every function-like declaration', () => {
    const result = buildCatalog({
      projectDir: SIMPLE_FIXTURE,
      tsConfigPath: join(SIMPLE_FIXTURE, 'tsconfig.json'),
    });

    const names = result.catalog.functions.map((f) => f.simpleName).sort();
    // main, greet, unusedHelper, deadCode (from main.ts) + add, plus (from duplicates.ts)
    expect(names).toEqual(expect.arrayContaining(['main', 'greet', 'unusedHelper', 'deadCode', 'add', 'plus']));
  });

  it('records direct calls with static resolution', () => {
    const result = buildCatalog({
      projectDir: SIMPLE_FIXTURE,
      tsConfigPath: join(SIMPLE_FIXTURE, 'tsconfig.json'),
    });

    const main = result.catalog.functions.find((f) => f.simpleName === 'main');
    expect(main).toBeDefined();
    const callTexts = main!.calls.map((c) => c.text);
    expect(callTexts.some((t) => t.includes('greet'))).toBe(true);
    expect(callTexts.some((t) => t.includes('unusedHelper'))).toBe(true);
    // At least one call should resolve statically.
    const greetCall = main!.calls.find((c) => c.text.includes('greet'));
    expect(greetCall?.resolution).toBe('static');
    expect(greetCall?.confidence).toBe('high');
  });

  it('builds a usable callers index', () => {
    const result = buildCatalog({
      projectDir: SIMPLE_FIXTURE,
      tsConfigPath: join(SIMPLE_FIXTURE, 'tsconfig.json'),
    });

    const greet = result.catalog.functions.find((f) => f.simpleName === 'greet');
    expect(greet).toBeDefined();
    const callers = result.catalog.indexes.callers.get(greet!.id) ?? [];
    expect(callers.length).toBeGreaterThanOrEqual(1);
    // The caller's id should resolve back to a function whose simpleName is `main`.
    const callerFn = result.catalog.functions.find((f) => f.id === callers[0]);
    expect(callerFn?.simpleName).toBe('main');
  });

  it('detects content-hash collisions for byte-equal bodies', () => {
    const result = buildCatalog({
      projectDir: SIMPLE_FIXTURE,
      tsConfigPath: join(SIMPLE_FIXTURE, 'tsconfig.json'),
    });

    // add and plus both have body `{ return a + b; }` — identical bodies.
    let collisionFound = false;
    for (const ids of result.catalog.indexes.byContentHash.values()) {
      if (ids.length >= 2) {
        collisionFound = true;
        break;
      }
    }
    expect(collisionFound).toBe(true);
  });

  it('honors the unknown resolver mode (no static resolution)', () => {
    const result = buildCatalog({
      projectDir: SIMPLE_FIXTURE,
      tsConfigPath: join(SIMPLE_FIXTURE, 'tsconfig.json'),
      resolverMode: 'unknown',
    });

    for (const fn of result.catalog.functions) {
      for (const call of fn.calls) {
        expect(call.resolution).toBe('unknown');
        expect(call.resolvedTo).toEqual([]);
      }
    }
  });
});

describe('buildCatalog (poly-project)', () => {
  it('full mode resolves polymorphic dispatch into all implementations', () => {
    const result = buildCatalog({
      projectDir: POLY_FIXTURE,
      tsConfigPath: join(POLY_FIXTURE, 'tsconfig.json'),
      resolverMode: 'full',
    });

    const dispatch = result.catalog.functions.find((f) => f.simpleName === 'dispatchAlert');
    expect(dispatch).toBeDefined();
    const polyCall = dispatch!.calls.find((c) => c.text.includes('notifier.notify'));
    expect(polyCall).toBeDefined();
    // method-dispatch when at least one impl was found, with medium confidence.
    expect(polyCall!.resolution).toBe('method-dispatch');
    expect(polyCall!.confidence).toBe('medium');
    expect(polyCall!.resolvedTo.length).toBeGreaterThanOrEqual(2);
  });

  it('static mode leaves method calls unknown', () => {
    const result = buildCatalog({
      projectDir: POLY_FIXTURE,
      tsConfigPath: join(POLY_FIXTURE, 'tsconfig.json'),
      resolverMode: 'static',
    });

    const dispatch = result.catalog.functions.find((f) => f.simpleName === 'dispatchAlert');
    expect(dispatch).toBeDefined();
    const polyCall = dispatch!.calls.find((c) => c.text.includes('notifier.notify'));
    expect(polyCall).toBeDefined();
    expect(polyCall!.resolution).toBe('unknown');
  });
});
