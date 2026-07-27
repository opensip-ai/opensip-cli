import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { copyFixtureInventory } from './fixture-copy-files.js';
import { WorkspacePreparationError } from './workspace-preparation-error.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('copyFixtureInventory', () => {
  it('classifies a source race without exposing either absolute path', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-eval-copy-'));
    roots.push(root);
    const missingSource = join(root, 'source', 'missing.ts');
    const workspaceRoot = join(root, 'workspace');

    expect(() =>
      copyFixtureInventory(
        [{ absolutePath: missingSource, relativePath: 'missing.ts' }],
        workspaceRoot,
      ),
    ).toThrow(WorkspacePreparationError);
    try {
      copyFixtureInventory(
        [{ absolutePath: missingSource, relativePath: 'missing.ts' }],
        workspaceRoot,
      );
    } catch (error) {
      expect(error).toMatchObject({
        condition: 'fixture-copy',
        nativeCode: 'ENOENT',
        operationIndex: 0,
      });
      expect(String(error)).not.toContain(root);
    }
    expect(existsSync(join(workspaceRoot, 'missing.ts'))).toBe(false);
  });
});
