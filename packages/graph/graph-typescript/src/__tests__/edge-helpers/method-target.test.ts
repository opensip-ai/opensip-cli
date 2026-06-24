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

import { decodeInjectedDist, methodTargetFile } from '../../edge-helpers/method-target.js';

describe('decodeInjectedDist', () => {
  it('maps flat pnpm file: virtual-store dist paths to packages/<pkg>/src/...', () => {
    expect(
      decodeInjectedDist(
        'node_modules/.pnpm/@scope+lib@file+packages+lib/node_modules/@scope/lib/dist/registry.d.ts',
      ),
    ).toBe('packages/lib/src/registry.ts');
  });

  it('maps nested monorepo package paths (packages/fitness/engine)', () => {
    expect(
      decodeInjectedDist(
        'node_modules/.pnpm/@opensip-cli+fitness@file+packages+fitness+engine/node_modules/@opensip-cli/fitness/dist/framework/define-check.d.ts',
      ),
    ).toBe('packages/fitness/engine/src/framework/define-check.ts');
  });

  it('stops before pnpm peer-dep suffixes on file: virtual-store paths', () => {
    expect(
      decodeInjectedDist(
        'node_modules/.pnpm/@opensip-cli+graph@file+packages+graph+engine_@types+better-sqlite3@7.6.13/node_modules/@opensip-cli/graph/dist/lang-adapter/edge-helpers.d.ts',
      ),
    ).toBe('packages/graph/engine/src/lang-adapter/edge-helpers.ts');
  });

  it('returns null for non-workspace node_modules paths', () => {
    expect(
      decodeInjectedDist(
        'node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/lib.es5.d.ts',
      ),
    ).toBeNull();
  });
});

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
    // A pnpm-INJECTED workspace copy: the SAME built dist `.d.ts`, reached through
    // `node_modules/.pnpm/<pkg>@file+<encoded-workspace>/...` — how each SHARDED
    // shard's per-shard program resolves a workspace `@scope/pkg` import. The decode
    // must map it to the SAME source path the exact build (case 1) produces, or
    // method edges resolve exact-only (the sharded≡exact divergence this fixes).
    const injectedDir = join(
      root,
      'node_modules',
      '.pnpm',
      '@scope+lib@file+packages+lib',
      'node_modules',
      '@scope',
      'lib',
      'dist',
    );
    mkdirSync(injectedDir, { recursive: true });
    writeFileSync(
      join(injectedDir, 'injected.d.ts'),
      'export declare class IR { ping(): void; }\n',
    );
    const callerPath = join(root, 'packages', 'app', 'src', 'caller.ts');
    writeFileSync(
      callerPath,
      [
        `import type { Ctx, R } from '../../lib/dist/registry.js';`,
        `import type { A } from '../../lib/types/amb.js';`,
        `import type { IR } from '../../../node_modules/.pnpm/@scope+lib@file+packages+lib/node_modules/@scope/lib/dist/injected.js';`,
        `declare const r: R;`,
        `declare const ctx: Ctx;`,
        `declare const a: A;`,
        `declare const ir: IR;`,
        `class Local { foo(): void {} }`,
        `function caller(): void {`,
        `  r.getAll();`, // cross-package dist method → maps to source
        `  ctx.setExitCode(0);`, // INTERFACE-attested → maps to source; linker declines
        `  a.ambient();`, // .d.ts but not /dist/ → decline
        `  ir.ping();`, // pnpm-injected workspace dist → decode to source
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

  it('decodes a pnpm-INJECTED workspace dist/*.d.ts to its source (sharded-shard parity)', () => {
    // `@scope/lib` resolves to the injected `.pnpm/@scope+lib@file+packages+lib/.../
    // dist/injected.d.ts`; methodTargetFile must decode it to the SAME source the
    // exact build's `packages/lib/dist/*` path maps to — otherwise the cross-package
    // method edge resolves in exact but declines sharded (the divergence this fixes).
    expect(methodTargetFile(calls.get('ping')!, checker, root)).toBe(
      'packages/lib/src/injected.ts',
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
