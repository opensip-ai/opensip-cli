import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeFilesFingerprint } from '../../cache/invalidate.js';
import { buildAgainstStableFiles } from '../../cache/stable-files-build.js';

describe('buildAgainstStableFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-stable-build-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('retries once and returns the value and fingerprint from the stable second version', async () => {
    const file = join(dir, 'source.ts');
    writeFileSync(file, 'initial', 'utf8');
    const stableContent = 'stable-second-version';
    let attempts = 0;

    const result = await buildAgainstStableFiles({
      files: [file],
      build: (attempt) => {
        attempts += 1;
        const content = readFileSync(file, 'utf8');
        if (attempt === 0) writeFileSync(file, stableContent, 'utf8');
        return Promise.resolve({ attempt, content });
      },
    });

    expect(attempts).toBe(2);
    expect(result.value).toEqual({ attempt: 1, content: stableContent });
    expect(result.filesFingerprint).toBe(computeFilesFingerprint([file]));
  });

  it('fails after one retry when source files keep changing', async () => {
    const file = join(dir, 'source.ts');
    writeFileSync(file, 'initial', 'utf8');
    let attempts = 0;

    await expect(
      buildAgainstStableFiles({
        files: [file],
        build: () => {
          attempts += 1;
          writeFileSync(file, `changed-${'x'.repeat(attempts)}`, 'utf8');
          return Promise.resolve(attempts);
        },
      }),
    ).rejects.toMatchObject({
      code: 'GRAPH.BUILD.INCOMPLETE',
    });
    expect(attempts).toBe(2);
  });
});
