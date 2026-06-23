/**
 * Coverage for the `yagni-ignore-hygiene` check (ADR-0014).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeFitnessTestScope, withScope } from '@opensip-cli/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { yagniIgnoreHygiene } from './yagni-ignore-hygiene.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yagni-hygiene-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function violationTypes(name: string, content: string): Promise<(string | undefined)[]> {
  const filePath = join(root, name);
  await writeFile(filePath, content, 'utf8');
  const result = await withScope(makeFitnessTestScope(), () =>
    yagniIgnoreHygiene.run(root, { targetFiles: [filePath] }),
  );
  return result.signals.map((s) => s.metadata.type as string | undefined);
}

describe('yagni-ignore-hygiene', () => {
  it('flags a directive missing a -- reason as ignore-without-reason', async () => {
    const types = await violationTypes(
      'a.ts',
      '// @yagni-ignore-next-line unused-config-surface\nconst x = 1;\n',
    );
    expect(types).toContain('ignore-without-reason');
  });

  it('flags an invalid detector slug as invalid-ignore-slug', async () => {
    const types = await violationTypes(
      'b.ts',
      '// @yagni-ignore-next-line Bad_Slug -- has a reason\nconst x = 1;\n',
    );
    expect(types).toContain('invalid-ignore-slug');
  });

  it('accepts valid directives with reasons', async () => {
    const types = await violationTypes(
      'c.ts',
      '// @yagni-ignore-file unused-config-surface -- fixture intentionally unused\n',
    );
    expect(types).toHaveLength(0);
  });
});
