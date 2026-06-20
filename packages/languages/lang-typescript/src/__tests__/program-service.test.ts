import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTypeCheckedProgram, isTypeNullable } from '../program-service.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opensip-progsvc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

/** Map of bare-identifier call expressions → their resolved result type. */
function callTypes(sf: ts.SourceFile, checker: ts.TypeChecker): Map<string, ts.Type> {
  const out = new Map<string, ts.Type>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      out.set(n.expression.text, checker.getTypeAtLocation(n));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Resolve the type of a top-level `const <name>` initializer site by name. */
function varType(sf: ts.SourceFile, checker: ts.TypeChecker, name: string): ts.Type {
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name) {
        return checker.getTypeAtLocation(decl.name);
      }
    }
  }
  throw new Error(`variable ${name} not found`);
}

describe('createTypeCheckedProgram', () => {
  it('builds a bound Program that resolves real (non-null vs nullable) return types', () => {
    const file = write(
      'src/sample.ts',
      [
        'export function getNullable(): string | null { return null; }',
        'export function getMaybe(): number | undefined { return undefined; }',
        "export function getSafe(): string { return ''; }",
        'export function use() {',
        '  return [getNullable(), getMaybe(), getSafe()];',
        '}',
      ].join('\n'),
    );

    const { checker, getSourceFile } = createTypeCheckedProgram([file], { projectRoot: dir });
    const sf = getSourceFile(file);
    expect(sf).toBeDefined();

    const types = callTypes(sf!, checker);
    expect(isTypeNullable(types.get('getNullable')!)).toBe(true);
    expect(isTypeNullable(types.get('getMaybe')!)).toBe(true);
    expect(isTypeNullable(types.get('getSafe')!)).toBe(false);
  });

  it('isTypeNullable fails open: `any`/`unknown` are not treated as nullable', () => {
    const file = write(
      'src/loose.ts',
      ['export const a: any = 1;', 'export const b: unknown = 1;'].join('\n'),
    );
    const { program, checker, getSourceFile } = createTypeCheckedProgram([file], {
      projectRoot: dir,
    });
    expect(program.getSourceFiles().some((s) => s.fileName === file)).toBe(true);
    const sf = getSourceFile(file)!;
    expect(isTypeNullable(varType(sf, checker, 'a'))).toBe(false);
    expect(isTypeNullable(varType(sf, checker, 'b'))).toBe(false);
  });

  it('honors an explicit tsconfig (strictNullChecks off → string|null reads non-nullable)', () => {
    // A real project tsconfig with strict OFF: under it, `string | null` is the
    // pre-strict `string` (null absorbed), so the service reflects the project's
    // own type config rather than imposing strictness.
    write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }));
    const file = write('src/proj.ts', 'export const n: string | null = null;');
    const built = createTypeCheckedProgram([file], {
      projectRoot: dir,
      tsconfigPath: 'tsconfig.json',
    });
    expect(built.tsconfigPath).toBeDefined();
    const sf = built.getSourceFile(file)!;
    expect(isTypeNullable(varType(sf, built.checker, 'n'))).toBe(false);
  });

  it('degrades gracefully when no tsconfig is found (fallback options, tsconfigPath undefined)', () => {
    const file = write('src/orphan.ts', 'export const m: string | null = null;');
    const built = createTypeCheckedProgram([file], { projectRoot: dir });
    // The temp dir has no tsconfig and is outside any project tree.
    expect(built.tsconfigPath).toBeUndefined();
    const sf = built.getSourceFile(file)!;
    // Fallback options enable strict, so `string | null` still reads as nullable.
    expect(isTypeNullable(varType(sf, built.checker, 'm'))).toBe(true);
  });
});
