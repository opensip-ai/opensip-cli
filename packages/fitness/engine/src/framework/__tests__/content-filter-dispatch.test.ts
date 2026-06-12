/**
 * @fileoverview Pin the contentFilter dispatch in define-check.ts and
 * file-accessor.ts. Two modes are intentional and distinct:
 *
 *   - `strip-strings`             → strings blanked, COMMENTS PRESERVED.
 *                                   Use when a rule reads comment markers
 *                                   (e.g. `// @swallow-ok`).
 *   - `strip-strings-and-comments` → both blanked. Use when the same
 *                                    forbidden phrase could appear in a
 *                                    comment and would false-fire.
 *
 * Mixing them was the bug behind a 2026-05-05 mis-fix that mapped both
 * modes to codeNoComments, breaking every rule that scans comments for
 * directives. This test pins the contract.
 *
 * The legacy `'code-only'` / `'no-strings-no-comments'` aliases were
 * removed in 0.5.0; this file used to assert the alias mapping and now
 * just asserts the canonical names.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope } from '@opensip-cli/core';
import { filterContent } from '@opensip-cli/lang-typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { createFileAccessor } from '../file-accessor.js';

import type { LanguageAdapter } from '@opensip-cli/core';

// FileAccessor.read dispatches strip via the registered LanguageAdapter
// for the file's extension. Register a minimal TS adapter for the test
// scope so the dispatch resolves and the existing core filterContent
// implementation produces the expected output. Lang packages live in
// their own workspaces and core can't depend on @opensip-cli/lang-typescript
// directly without creating a cycle.
const inProcessTypescriptAdapter: LanguageAdapter = {
  id: 'typescript-test-shim',
  fileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  parse: () => null,
  stripStrings: (s) => filterContent(s).code,
  stripComments: (s) => filterContent(s).codeNoComments,
};

let scope: RunScope;

beforeAll(() => {
  const reg = new LanguageRegistry();
  reg.register(inProcessTypescriptAdapter);
  scope = new RunScope({ languages: reg });
});

function inScope<T>(fn: () => Promise<T>): Promise<T> {
  return runWithScope(scope, fn);
}

async function writeTempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-dispatch-'));
  const filePath = join(dir, 'sample.ts');
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('FileAccessor contentFilter dispatch', () => {
  describe('strip-strings — strings blanked, comments preserved', () => {
    it('preserves line-comment text so rules can scan markers', async () => {
      await inScope(async () => {
        const filePath = await writeTempFile(
          `const a = 1\n// @swallow-ok intentional fallthrough\nconst b = 2`,
        );
        const accessor = createFileAccessor([filePath], { contentFilter: 'strip-strings' });
        const content = await accessor.read(filePath);

        expect(content).toContain('@swallow-ok');
        expect(content).toContain('const a = 1');
        expect(content).toContain('const b = 2');
      });
    });

    it('preserves block-comment text including JSDoc directives', async () => {
      await inScope(async () => {
        const filePath = await writeTempFile(
          `/** @deprecated use Y instead */\nexport function legacy() {}`,
        );
        const accessor = createFileAccessor([filePath], { contentFilter: 'strip-strings' });
        const content = await accessor.read(filePath);

        expect(content).toContain('@deprecated');
        expect(content).toContain('export function legacy');
      });
    });

    it('blanks string-literal contents', async () => {
      await inScope(async () => {
        const filePath = await writeTempFile(`const url = 'phrase_in_string'`);
        const accessor = createFileAccessor([filePath], { contentFilter: 'strip-strings' });
        const content = await accessor.read(filePath);

        expect(content).not.toContain('phrase_in_string');
        expect(content).toContain('const url = ');
      });
    });
  });

  describe('strip-strings-and-comments — both blanked', () => {
    it("blanks comment text so rules don't false-fire on prose", async () => {
      await inScope(async () => {
        const filePath = await writeTempFile(
          `const a = 1\n// forbidden_phrase_in_comment\nconst b = 2`,
        );
        const accessor = createFileAccessor([filePath], {
          contentFilter: 'strip-strings-and-comments',
        });
        const content = await accessor.read(filePath);

        expect(content).not.toContain('forbidden_phrase_in_comment');
        expect(content).toContain('const a = 1');
        expect(content).toContain('const b = 2');
      });
    });

    it('blanks both strings and comments in the same content', async () => {
      await inScope(async () => {
        const filePath = await writeTempFile(`const url = 'phrase_in_string' // phrase_in_comment`);
        const accessor = createFileAccessor([filePath], {
          contentFilter: 'strip-strings-and-comments',
        });
        const content = await accessor.read(filePath);

        expect(content).not.toContain('phrase_in_string');
        expect(content).not.toContain('phrase_in_comment');
      });
    });
  });

  describe('default (raw) — no filter applied', () => {
    it('preserves both strings and comments verbatim', async () => {
      // raw passthrough doesn't need a scope; applyContentFilter short-circuits.
      const src = `const url = 'phrase'\n// also phrase`;
      const filePath = await writeTempFile(src);
      const accessor = createFileAccessor([filePath]); // no contentFilter → raw passthrough
      const content = await accessor.read(filePath);

      expect(content).toBe(src);
    });
  });
});
