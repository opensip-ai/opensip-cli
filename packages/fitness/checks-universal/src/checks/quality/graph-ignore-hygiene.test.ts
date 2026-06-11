/**
 * Coverage for the `graph-ignore-hygiene` check (ADR-0014): validates that
 * `@graph-ignore` directives carry a `graph:`-namespaced rule id and a
 * `-- reason`, and flags files with an excessive number of suppressions.
 *
 * The pure detector behind this check is not exported, so the test drives the
 * real wired check via `Check.run(cwd, { targetFiles })` against on-disk `.ts`
 * fixtures (the check is `fileTypes: ['ts']`, `contentFilter: 'raw'`). Each
 * violation's `type` is carried into `signal.metadata.type` by the framework,
 * which is what we assert on. Runs inside a `RunScope` because the check path
 * reads the current scope (content-filter dispatch, directive filtering).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTestScope, withScope } from '@opensip-tools/core/test-utils/with-scope.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { graphIgnoreHygiene } from './graph-ignore-hygiene.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'graph-hygiene-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Write `content` to `name.ts` under the temp root, run the check against just
 * that file, and return the violation `type`s it produced.
 */
async function violationTypes(name: string, content: string): Promise<(string | undefined)[]> {
  const filePath = join(root, name);
  await writeFile(filePath, content, 'utf8');
  const result = await withScope(makeTestScope(), () =>
    graphIgnoreHygiene.run(root, { targetFiles: [filePath] }),
  );
  return result.signals.map((s) => s.metadata.type as string | undefined);
}

describe('graph-ignore-hygiene', () => {
  it('flags a directive missing a -- reason as ignore-without-reason', async () => {
    const types = await violationTypes(
      'a.ts',
      '// @graph-ignore-next-line graph:cycle\nfunction visit() {}\n',
    );
    expect(types).toContain('ignore-without-reason');
  });

  it('flags a non-graph-namespaced id as invalid-ignore-slug', async () => {
    const types = await violationTypes(
      'b.ts',
      '// @graph-ignore-next-line cycle -- has a reason\nfunction visit() {}\n',
    );
    expect(types).toContain('invalid-ignore-slug');
  });

  it('accepts a valid graph: id with a reason — no violation', async () => {
    const types = await violationTypes(
      'c.ts',
      '// @graph-ignore-next-line graph:cycle -- intentional recursion\nfunction visit() {}\n',
    );
    expect(types).toHaveLength(0);
  });

  it('flags more than 7 directives in one file as excessive-ignores', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(
        `// @graph-ignore-next-line graph:cycle -- reason ${String(i)}`,
        `function visit${String(i)}() {}`,
      );
    }
    const types = await violationTypes('d.ts', lines.join('\n'));
    expect(types).toContain('excessive-ignores');
  });
});
