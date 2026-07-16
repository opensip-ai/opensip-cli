import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { catalogBuildCoverage } from '../catalog-build-coverage.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('catalogBuildCoverage', () => {
  it('uses the canonical project root for realpath-normalized discovered files', () => {
    const physical = mkdtempSync(join(tmpdir(), 'graph-build-coverage-'));
    const links = mkdtempSync(join(tmpdir(), 'graph-build-coverage-link-'));
    roots.push(links, physical);
    mkdirSync(join(physical, 'src'));
    writeFileSync(join(physical, 'src', 'work.ts'), 'export const work = true;\n');
    const linkedRoot = join(links, 'project');
    symlinkSync(physical, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalFile = join(realpathSync(physical), 'src', 'work.ts');

    expect(
      catalogBuildCoverage({
        projectRoot: linkedRoot,
        files: [canonicalFile],
        parseErrors: [{ filePath: canonicalFile, message: 'fixture parse failure' }],
      }),
    ).toMatchObject({
      status: 'complete',
      discoveredFiles: 1,
      parseErrorFiles: 1,
      filesIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it('marks malformed adapter paths partial instead of crashing graph completion', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-build-coverage-partial-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    const file = join(root, 'src', 'work.ts');
    writeFileSync(file, 'export const work = true;\n');

    expect(
      catalogBuildCoverage({
        projectRoot: root,
        files: [file, join(root, '..', 'outside.ts')],
        parseErrors: [{ filePath: join(root, '..', 'outside.ts'), message: 'outside' }],
      }),
    ).toMatchObject({
      status: 'partial',
      discoveredFiles: 1,
      parseErrorFiles: 0,
    });
  });

  it('degrades a missing project root without masking the graph result', () => {
    const missingRoot = join(tmpdir(), `graph-build-coverage-missing-${String(Date.now())}`);

    expect(
      catalogBuildCoverage({
        projectRoot: missingRoot,
        files: ['src/work.ts'],
        parseErrors: [],
      }),
    ).toMatchObject({
      status: 'partial',
      discoveredFiles: 1,
      parseErrorFiles: 0,
      filesIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });
});
