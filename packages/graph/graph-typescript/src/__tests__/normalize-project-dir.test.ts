/**
 * normalizeProjectDir tests (DRY-4).
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { normalizeProjectDir } from '../normalize-project-dir.js';

describe('normalizeProjectDir (DRY-4)', () => {
  const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'graph-norm-')));
  afterAll(() => {
    rmSync(realDir, { recursive: true, force: true });
  });

  it('passes absolute paths through to realpath', () => {
    const out = normalizeProjectDir(realDir);
    expect(out).toBe(realDir);
  });

  it('resolves relative paths against cwd', () => {
    const out = normalizeProjectDir('.');
    expect(out.startsWith('/')).toBe(true);
  });

  it('follows symlinks via realpath', () => {
    const linkPath = `${realDir}-link`;
    try {
      symlinkSync(realDir, linkPath, 'dir');
    } catch {
      return;
    }
    try {
      const out = normalizeProjectDir(linkPath);
      expect(out).toBe(realDir);
    } finally {
      rmSync(linkPath, { recursive: true, force: true });
    }
  });

  it('uses the registered not-found definition for a missing directory', () => {
    expect(() => normalizeProjectDir(`${realDir}-missing`)).toThrow(
      expect.objectContaining({ code: 'GRAPH.PROJECT_DIR.NOT_FOUND' }),
    );
  });

  it('uses the registered validation definition when the path is a file', () => {
    const filePath = join(realDir, 'a-file.txt');
    writeFileSync(filePath, 'not a dir', 'utf8');
    expect(() => normalizeProjectDir(filePath)).toThrow(
      expect.objectContaining({ code: 'GRAPH.PROJECT_DIR.NOT_A_DIRECTORY' }),
    );
  });
});
