import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAgainstStableFiles } from '../../cache/stable-files-build.js';

describe('buildAgainstStableFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-stable-build-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
      code: 'GRAPH.CATALOG.SOURCE_CHANGED_DURING_BUILD',
    });
    expect(attempts).toBe(2);
  });
});
