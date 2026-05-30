/**
 * Tests for the fast (checker-free) parse path — parse-fast.ts.
 *
 * The fast parse must (a) build no ts.Program and construct no type
 * checker, (b) populate parent pointers (setParentNodes), (c) surface
 * syntactic diagnostics into parseErrors, and (d) parse .tsx as JSX.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProject } from '../parse.js';
import { parseProjectFast } from '../parse-fast.js';

describe('parseProjectFast', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-parsefast-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces a fast project (no ts.Program) with one source file per input', () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, 'export function foo() { return 1; }\n', 'utf8');
    writeFileSync(b, 'export const bar = () => 2;\n', 'utf8');

    const out = parseProjectFast({
      projectDirAbs: dir,
      files: [a, b],
      resolutionMode: 'fast',
    });

    expect(out.project.kind).toBe('fast');
    // No type checker / Program is ever constructed on this path.
    expect('program' in out.project).toBe(false);
    expect(out.project.sourceFiles.size).toBe(2);
    expect(out.project.sourceFiles.has(a)).toBe(true);
    expect(out.parseErrors).toEqual([]);
  });

  it('populates parent pointers (the cheap substitute for the checker)', () => {
    const a = join(dir, 'a.ts');
    writeFileSync(a, 'export function foo() { return 1; }\n', 'utf8');

    const out = parseProjectFast({ projectDirAbs: dir, files: [a], resolutionMode: 'fast' });
    const sf = out.project.sourceFiles.get(a);
    expect(sf).toBeDefined();
    // The first statement's parent must point back at the source file —
    // proof setParentNodes ran without a binder/checker.
    const firstStmt = sf!.statements[0];
    expect(firstStmt).toBeDefined();
    expect(firstStmt!.parent).toBe(sf);
  });

  it('surfaces syntactic diagnostics into parseErrors for an unparseable file', () => {
    const broken = join(dir, 'broken.ts');
    // Missing identifier + dangling tokens → parse diagnostics.
    writeFileSync(broken, 'const = ;\nfunction (\n', 'utf8');

    const out = parseProjectFast({ projectDirAbs: dir, files: [broken], resolutionMode: 'fast' });
    expect(out.parseErrors.length).toBeGreaterThan(0);
    expect(out.parseErrors[0]?.filePath).toBe('broken.ts');
    // The (partial) tree is still retained for the walk stage.
    expect(out.project.sourceFiles.size).toBe(1);
  });

  it('parses .tsx as JSX (ScriptKind derived from extension)', () => {
    const tsx = join(dir, 'view.tsx');
    writeFileSync(tsx, 'export const View = () => <div className="x">hi</div>;\n', 'utf8');

    const out = parseProjectFast({ projectDirAbs: dir, files: [tsx], resolutionMode: 'fast' });
    // JSX parses with no syntactic error, and a JSX node exists in the tree.
    expect(out.parseErrors).toEqual([]);
    const sf = out.project.sourceFiles.get(tsx)!;
    let sawJsx = false;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) sawJsx = true;
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(sawJsx).toBe(true);
  });

  it('parseProject dispatches to the fast path when resolutionMode is fast', () => {
    const a = join(dir, 'a.ts');
    writeFileSync(a, 'export function foo() { return 1; }\n', 'utf8');

    const fast = parseProject({ projectDirAbs: dir, files: [a], resolutionMode: 'fast' });
    expect(fast.project.kind).toBe('fast');

    const exact = parseProject({ projectDirAbs: dir, files: [a], resolutionMode: 'exact' });
    expect(exact.project.kind).toBe('exact');
  });
});
