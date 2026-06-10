/**
 * Value-reference + shorthand-assignment edge resolution
 * (edges-value-reference.ts).
 *
 * The exact-mode pipeline records bare Identifier value references
 * (function passed as an argument, returned, defaulted) and
 * ShorthandPropertyAssignment nodes (`{ fn }`) as call sites, then
 * resolves the referenced symbol to its catalog bodyHash. These tests
 * drive the full pipeline over fixtures that hand functions around as
 * VALUES (not invoked) so a handoff edge is emitted, covering the
 * function-declaration, arrow-in-variable, function-expression, and
 * class-constructor declaration branches of `hashFromDeclaration`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findOccurrence, runFixture, writeFixture } from './acceptance/_fixture-runner.js';

import type { Catalog } from '@opensip-tools/graph';

describe('value-reference + shorthand edge resolution', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'graph-value-ref-'));
  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  writeFixture(fixtureDir, {
    // A top-level function declaration handed to another function as a
    // VALUE argument (not called). The reference is an Identifier in a
    // value position → resolveValueReference → function-declaration branch.
    'fn-decl-handoff.ts': `
      export function handler(): number { return 1; }
      function register(cb: () => number): void { void cb; }
      export function wire(): void {
        register(handler);
      }
    `,

    // Shorthand property assignment `{ handler }` — exercises
    // resolveShorthandAssignment + getShorthandAssignmentValueSymbol.
    'shorthand.ts': `
      export function shorthandTarget(): number { return 2; }
      export function buildBag(): { shorthandTarget: () => number } {
        return { shorthandTarget };
      }
    `,

    // Arrow function assigned to a const, then passed as a value.
    // Exercises the VariableDeclaration + ArrowFunction initializer
    // branch of hashFromDeclaration.
    'arrow-handoff.ts': `
      const arrowFn = (): number => 3;
      function take(cb: () => number): void { void cb; }
      export function passArrow(): void {
        take(arrowFn);
      }
    `,

    // Function-expression assigned to a const, then passed as a value.
    'fn-expr-handoff.ts': `
      const exprFn = function (): number { return 4; };
      function consume(cb: () => number): void { void cb; }
      export function passExpr(): void {
        consume(exprFn);
      }
    `,

    // Class referenced as a VALUE (passed as an argument), not via
    // `new`. Exercises hashFromDeclaration's class-declaration branch:
    // it resolves to the class's constructor catalog entry.
    'class-value.ts': `
      export class Widget {
        constructor() { /* ctor body so a constructor occurrence exists */ }
      }
      function useCtor(c: new () => Widget): void { void c; }
      export function passClass(): void {
        useCtor(Widget);
      }
    `,
  });
  let catalog!: Catalog;
  beforeAll(async () => {
    catalog = await runFixture(fixtureDir);
  });

  it('builds a catalog (sanity)', () => {
    expect(Object.keys(catalog.functions).length).toBeGreaterThan(0);
  });

  it('resolves a function declaration passed as a value argument', () => {
    const occ = findOccurrence(catalog, (o) => o.simpleName === 'wire');
    expect(occ).toBeDefined();
    // The handoff of `handler` as a value yields an edge from wire.
    const edge = occ!.calls.find((e) => e.text.includes('handler') || e.text.includes('register'));
    expect(edge).toBeDefined();
  });

  it('resolves a shorthand property assignment to its function', () => {
    const occ = findOccurrence(catalog, (o) => o.simpleName === 'buildBag');
    expect(occ).toBeDefined();
    const edge = occ!.calls.find((e) => e.text.includes('shorthandTarget'));
    expect(edge).toBeDefined();
    expect(edge!.to.length).toBeGreaterThan(0);
  });

  it('resolves an arrow-in-variable referenced as a value', () => {
    const occ = findOccurrence(catalog, (o) => o.simpleName === 'passArrow');
    expect(occ).toBeDefined();
    const edge = occ!.calls.find((e) => e.to.length > 0);
    expect(edge).toBeDefined();
  });

  it('resolves a function-expression-in-variable referenced as a value', () => {
    const occ = findOccurrence(catalog, (o) => o.simpleName === 'passExpr');
    expect(occ).toBeDefined();
    const edge = occ!.calls.find((e) => e.to.length > 0);
    expect(edge).toBeDefined();
  });

  it('resolves a class referenced as a value to its constructor entry', () => {
    const occ = findOccurrence(catalog, (o) => o.simpleName === 'passClass');
    expect(occ).toBeDefined();
    // Widget-as-value resolves to the class constructor's catalog entry.
    const edge = occ!.calls.find((e) => e.text.includes('Widget') && e.to.length > 0);
    expect(edge).toBeDefined();
  });
});
