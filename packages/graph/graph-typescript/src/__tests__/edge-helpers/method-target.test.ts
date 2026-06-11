/**
 * Unit tests for methodTargetFile — the type-attested cross-package method
 * target resolver. Builds a REAL `ts.Program` over temp fixtures so the checker
 * resolves a method call's callee to a `dist/*.d.ts` declaration (the cross-
 * package boundary case) vs a source / non-dist declaration (decline).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { methodTargetFile } from '../../edge-helpers/method-target.js';

describe('methodTargetFile', () => {
  let root: string;
  let checker: ts.TypeChecker;
  const calls = new Map<string, ts.CallExpression>();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'method-target-'));
    mkdirSync(join(root, 'packages', 'lib', 'dist'), { recursive: true });
    mkdirSync(join(root, 'packages', 'lib', 'types'), { recursive: true });
    mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true });
    // A workspace package's BUILT dist `.d.ts` (the cross-package boundary case).
    // `Ctx` is an INTERFACE: its member has no body, so the linker's occurrence
    // pin will find no concrete target — the polymorphic-dispatch decline class.
    writeFileSync(
      join(root, 'packages', 'lib', 'dist', 'registry.d.ts'),
      [
        'export declare class R { getAll(): void; }',
        'export interface Ctx { setExitCode(code: number): void; }',
        '',
      ].join('\n'),
    );
    // A `.d.ts` NOT under /dist/ (e.g. a hand-authored ambient) → must decline.
    writeFileSync(
      join(root, 'packages', 'lib', 'types', 'amb.d.ts'),
      'export declare class A { ambient(): void; }\n',
    );
    const callerPath = join(root, 'packages', 'app', 'src', 'caller.ts');
    writeFileSync(
      callerPath,
      [
        `import type { Ctx, R } from '../../lib/dist/registry.js';`,
        `import type { A } from '../../lib/types/amb.js';`,
        `declare const r: R;`,
        `declare const ctx: Ctx;`,
        `declare const a: A;`,
        `class Local { foo(): void {} }`,
        `function caller(): void {`,
        `  r.getAll();`, // cross-package dist method → maps to source
        `  ctx.setExitCode(0);`, // INTERFACE-attested → maps to source; linker declines
        `  a.ambient();`, // .d.ts but not /dist/ → decline
        `  new Local().foo();`, // SOURCE decl → decline (in-shard handles it)
        `  plain();`, // not a property access → decline
        `}`,
        `function plain(): void {}`,
        `caller();`,
      ].join('\n'),
    );
    const program = ts.createProgram([callerPath], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    });
    checker = program.getTypeChecker();
    const sf = program.getSourceFile(callerPath);
    if (sf === undefined) throw new Error('fixture program produced no caller source file');
    const calleeKey = (expr: ts.Expression): string => {
      if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
      if (ts.isIdentifier(expr)) return expr.text;
      return '?';
    };
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) calls.set(calleeKey(n.expression), n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('maps a cross-package dist/*.d.ts method decl to its SOURCE file', () => {
    expect(methodTargetFile(calls.get('getAll')!, checker, root)).toBe(
      'packages/lib/src/registry.ts',
    );
  });

  it('maps an INTERFACE-attested method to its source file (the decline happens at the linker, not here)', () => {
    // The polymorphic-dispatch class (ADR-0033 amendment #3/#4): the checker
    // attests `ctx.setExitCode()` to an interface SIGNATURE in dist/*.d.ts.
    // methodTargetFile still maps decl→source (it resolves FILES, not bodies);
    // soundness is downstream — the cross-shard linker's file-scoped occurrence
    // pin finds no concrete body for the name and DECLINES (never fabricates).
    expect(methodTargetFile(calls.get('setExitCode')!, checker, root)).toBe(
      'packages/lib/src/registry.ts',
    );
  });

  it('declines a `.d.ts` decl NOT under /dist/', () => {
    expect(methodTargetFile(calls.get('ambient')!, checker, root)).toBeNull();
  });

  it('declines a SOURCE-declared method (the in-shard/inline pass handles it)', () => {
    expect(methodTargetFile(calls.get('foo')!, checker, root)).toBeNull();
  });

  it('declines a plain (non-property-access) call', () => {
    expect(methodTargetFile(calls.get('plain')!, checker, root)).toBeNull();
  });
});
