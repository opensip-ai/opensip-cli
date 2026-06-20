import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunScope, runWithScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getSharedTypeCheckedProgram } from '../shared/type-program.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'opensip-shared-prog-'));
  file = join(dir, 'a.ts');
  writeFileSync(file, 'export const x: string | null = null;\n');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getSharedTypeCheckedProgram', () => {
  it('builds the Program once per run and reuses it across calls (memoized on the subscope cell)', async () => {
    const scope = new RunScope();
    // Minimal fitness subscope: the helper only reads `fitness.tsProgram`.
    Object.assign(scope, { fitness: { tsProgram: { value: undefined } } });
    await runWithScope(scope, () => {
      const first = getSharedTypeCheckedProgram([file]);
      const second = getSharedTypeCheckedProgram([file]);
      expect(second).toBe(first); // same instance → built exactly once per run
      return Promise.resolve();
    });
  });

  it('builds a fresh, uncached Program when the run has no fitness subscope cell', async () => {
    // A bare scope (no fitness subscope) overrides any ambient test scope; with
    // no cell to memoize into, each call builds a fresh Program.
    const scope = new RunScope();
    await runWithScope(scope, () => {
      const a = getSharedTypeCheckedProgram([file]);
      const b = getSharedTypeCheckedProgram([file]);
      expect(a).not.toBe(b);
      return Promise.resolve();
    });
  });
});
