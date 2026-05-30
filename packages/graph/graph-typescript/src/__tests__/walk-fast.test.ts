/**
 * Tests that the walk yields the same occurrences/call-site records from
 * the fast source-file map as from an exact ts.Program — the walk is
 * structural and mode-agnostic, so the two parse tiers must produce an
 * identical inventory.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseProject } from '../parse.js';
import { walkProgram } from '../walk.js';

const SOURCE = `
import { dep } from './dep.js';
export function top() { return dep(); }
function helper() { return top(); }
export const arrow = () => helper();
class C { method() { return arrow(); } }
`;

describe('walkProgram — fast vs exact source files', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-walkfast-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('produces the same occurrence names and call-site count from either tier', () => {
    const a = join(dir, 'a.ts');
    const depFile = join(dir, 'dep.ts');
    writeFileSync(a, SOURCE, 'utf8');
    writeFileSync(depFile, 'export function dep() { return 0; }\n', 'utf8');
    const files = [a, depFile];

    const exactParsed = parseProject({ projectDirAbs: dir, files, resolutionMode: 'exact' });
    const fastParsed = parseProject({ projectDirAbs: dir, files, resolutionMode: 'fast' });
    if (exactParsed.project.kind !== 'exact' || fastParsed.project.kind !== 'fast') {
      throw new Error('unexpected parse tiers');
    }

    const exactSf: Iterable<ts.SourceFile> = exactParsed.project.program.getSourceFiles();
    const fastSf: Iterable<ts.SourceFile> = fastParsed.project.sourceFiles.values();

    const exactWalk = walkProgram({ sourceFiles: exactSf, files, projectDirAbs: dir });
    const fastWalk = walkProgram({ sourceFiles: fastSf, files, projectDirAbs: dir });

    const names = (w: typeof exactWalk): string[] => Object.keys(w.functions).sort();
    expect(names(fastWalk)).toEqual(names(exactWalk));
    // Same number of located call sites (resolution differs, location does not).
    expect(fastWalk.callSites.length).toBe(exactWalk.callSites.length);
    // Sanity: the inventory actually contains the declared functions.
    expect(names(fastWalk)).toEqual(expect.arrayContaining(['top', 'helper', 'arrow', 'method']));
  });
});
