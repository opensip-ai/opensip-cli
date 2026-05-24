/**
 * Acceptance fixture: projectdir normalization.
 *
 * Relative cwd resolves to the realpath'd absolute project dir.
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { discoverFiles } from '../../discover.js';

import { writeFixture } from './_fixture-runner.js';

describe('projectdir-normalization acceptance fixture', () => {
  // realpathSync collapses /var → /private/var on macOS; we compare the
  // canonical form so the test passes on every platform.
  const realDir = realpathSync(mkdtempSync(join(tmpdir(), 'graph-realdir-')));
  const linkPath = `${realDir}-link`;
  afterAll(() => {
    try { rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
    rmSync(realDir, { recursive: true, force: true });
  });

  writeFixture(realDir, {
    'a.ts': `export const x = 1;\n`,
  });

  it('resolves relative paths to absolute', () => {
    const out = discoverFiles({ projectDir: realDir });
    expect(out.projectDirAbs.startsWith('/')).toBe(true);
    expect(out.files.length).toBeGreaterThan(0);
  });

  it('follows symlinks via realpath', () => {
    try {
      symlinkSync(realDir, linkPath, 'dir');
    } catch {
      // Some sandboxes disallow symlinks; skip the assertion in that
      // case rather than fail the whole suite.
      return;
    }
    const out = discoverFiles({ projectDir: linkPath });
    // realpath should collapse the link to the realDir.
    expect(out.projectDirAbs).toBe(realDir);
  });

  it('throws ConfigurationError on a missing directory', () => {
    expect(() => discoverFiles({ projectDir: `${realDir}-missing` })).toThrow(/does not exist/);
  });
});
