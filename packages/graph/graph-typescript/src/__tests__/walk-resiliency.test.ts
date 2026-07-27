import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { walkProgram } from '../walk.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureSource(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

describe('walkProgram resiliency', () => {
  it('discards every staged record when a file inventory visitor faults', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-ts-walk-fault-'));
    roots.push(root);
    const fileName = join(root, 'fault.ts');
    const sourceFile = fixtureSource(fileName, 'export function fault(): void {}\n');
    const declaration = sourceFile.statements[0];
    expect(declaration).toBeDefined();
    vi.spyOn(declaration, 'getStart').mockImplementation(() => {
      throw new Error(`visitor fault at ${fileName}`);
    });

    const result = walkProgram({
      sourceFiles: [sourceFile],
      files: [fileName],
      projectDirAbs: root,
    });

    expect(result.functions).toEqual({});
    expect(result.callSites).toEqual([]);
    expect(result.dependencySites).toEqual([]);
    expect(result.reExports).toEqual([]);
    expect(result.parseErrors).toEqual([
      {
        filePath: 'fault.ts',
        message: 'TypeScript graph inventory failed for this source file.',
        code: 'GRAPH.TS.WALK_FAULT',
      },
    ]);
    expect(result.parseErrors[0]?.message).not.toContain(root);
  });

  it('bounds recursive AST traversal and reports the guarded condition', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-ts-walk-depth-'));
    roots.push(root);
    const fileName = join(root, 'deep.ts');
    const source = `export const value = ${'('.repeat(600)}1${')'.repeat(600)};`;
    const sourceFile = fixtureSource(fileName, source);

    const result = walkProgram({
      sourceFiles: [sourceFile],
      files: [fileName],
      projectDirAbs: root,
    });

    expect(result.functions).toEqual({});
    expect(result.parseErrors).toEqual([
      {
        filePath: 'deep.ts',
        message: 'TypeScript source exceeds the supported graph AST nesting depth.',
        code: 'GRAPH.TS.WALK_DEPTH_EXCEEDED',
      },
    ]);
  });
});
