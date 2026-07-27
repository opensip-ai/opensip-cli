import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { catalogBuildCoverage } from '../catalog-build-coverage.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

  it('names every dropped parse file in the run log without touching the payload', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-build-coverage-log-'));
    roots.push(root);
    const file = join(root, 'broken.ts');
    writeFileSync(file, 'const = ;\n');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const coverage = catalogBuildCoverage({
      projectRoot: root,
      files: [file],
      parseErrors: [{ filePath: 'broken.ts', message: "')' expected.\nsecond line" }],
    });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'graph.catalog.parse.dropped',
        module: 'graph:catalog-build-coverage',
        count: 1,
        files: ["broken.ts: ')' expected. second line"],
        overflow: 0,
      }),
    );
    // The persisted payload stays count-only — no paths, no messages.
    expect(coverage).toMatchObject({ parseErrorFiles: 1 });
    expect(JSON.stringify(coverage)).not.toContain('broken.ts');
  });

  it('includes a registered omission code in the bounded local diagnostic', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-build-coverage-code-'));
    roots.push(root);
    const file = join(root, 'unreadable.ts');
    writeFileSync(file, 'export const work = true;\n');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    catalogBuildCoverage({
      projectRoot: root,
      files: [file],
      parseErrors: [
        {
          filePath: 'unreadable.ts',
          message: 'Source file could not be read.',
          code: 'GRAPH.TS.SOURCE_UNREADABLE',
        },
      ],
    });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        files: ['unreadable.ts: [GRAPH.TS.SOURCE_UNREADABLE] Source file could not be read.'],
      }),
    );
  });

  it('caps the logged file list and message length, recording the overflow', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-build-coverage-cap-'));
    roots.push(root);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const parseErrors = Array.from({ length: 25 }, (_, index) => ({
      filePath: `broken-${String(index)}.ts`,
      message: 'x'.repeat(500),
    }));

    catalogBuildCoverage({ projectRoot: root, files: [], parseErrors });

    expect(warn).toHaveBeenCalledTimes(1);
    const event = warn.mock.calls[0]?.[0] as { count: number; files: string[]; overflow: number };
    expect(event.count).toBe(25);
    expect(event.files).toHaveLength(20);
    expect(event.overflow).toBe(5);
    for (const entry of event.files) expect(entry.length).toBeLessThanOrEqual(250);
  });

  it('stays silent when no parse errors occurred', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-build-coverage-quiet-'));
    roots.push(root);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    catalogBuildCoverage({ projectRoot: root, files: [], parseErrors: [] });

    expect(warn).not.toHaveBeenCalled();
  });

  it('persists registered post-parse degradation and marks coverage partial', () => {
    const root = mkdtempSync(join(tmpdir(), 'graph-build-coverage-degraded-'));
    roots.push(root);

    expect(
      catalogBuildCoverage({
        projectRoot: root,
        files: [],
        parseErrors: [],
        degradations: [
          {
            errorCode: 'GRAPH.ANALYSIS.SEMANTIC_RESOLUTION_DEGRADED',
            condition: 'typescript-exact-resolution',
            count: 3,
          },
        ],
      }),
    ).toMatchObject({
      status: 'partial',
      degradations: [
        {
          errorCode: 'GRAPH.ANALYSIS.SEMANTIC_RESOLUTION_DEGRADED',
          condition: 'typescript-exact-resolution',
          count: 3,
        },
      ],
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
