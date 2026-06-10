import { RunScope, runWithScopeSync } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { filterContent } from '../filter.js';

describe('filterContent', () => {
  describe('string and comment masking', () => {
    it('replaces string-literal content with spaces but preserves length', () => {
      const src = `const x = 'hello'`;
      const { code } = filterContent(src);
      expect(code.length).toBe(src.length);
      expect(code).toBe(`const x = '     '`);
    });

    it('preserves comment content verbatim (comments tracked, not masked)', () => {
      const src = `const x = 1 // loadConfig() mentioned here\nconst y = 2`;
      const { code } = filterContent(src);
      // Line comments are left intact — directives live in comments
      expect(code).toContain('loadConfig() mentioned here');
    });
  });

  describe('template literals', () => {
    it('masks simple template body text', () => {
      const src = `const x = \`hello world\``;
      const { code } = filterContent(src);
      expect(code).toBe(`const x = \`           \``);
    });

    it('masks template-head and template-tail text, preserves expressions', () => {
      const src = `const x = \`pre \${value} post\``;
      const { code } = filterContent(src);
      // Expression `value` is code — preserved. Text around `${ ... }` is masked.
      expect(code).toContain('value');
      expect(code).not.toContain('pre ');
      expect(code).not.toContain(' post');
    });

    // Regression: nested templates inside `${...}` expressions used to desync the
    // scanner state (a plain `inTemplate` boolean flipped off by the inner
    // TemplateTail left the outer's CloseBrace unrescanned, which caused every
    // token after the inner template to be misinterpreted as part of a string).
    // The symptom was that real code — `loadConfig(process.cwd())`, type
    // annotations, anything — below the nested template got wiped to whitespace
    // silently, producing false negatives in every `contentFilter: 'strip-strings'`
    // check that scanned the affected file. Fix replaced the boolean with a
    // depth counter; this test keeps it fixed.
    it('handles nested templates inside ${} expressions — code below is preserved', () => {
      const src = [
        'const lines = items.map(f => `- ${sanitize(f)}`).join("\\n")',
        'const after = loadConfig(process.cwd())',
        'export function helper(cfg: ReturnType<typeof loadConfig>): string { return "" }',
      ].join('\n');
      const { code } = filterContent(src);
      // The nested template's inner text `- ` should be masked, but sanitize(f),
      // the .map/.join chain, and everything below must survive intact.
      expect(code).toContain('sanitize(f)');
      expect(code).toContain('loadConfig(process.cwd())');
      expect(code).toContain('ReturnType<typeof loadConfig>');
    });

    it('handles doubly-nested templates', () => {
      const src = [
        'const s = `a ${`b ${c}`} d`',
        'const survives = loadConfig(process.cwd())',
      ].join('\n');
      const { code } = filterContent(src);
      expect(code).toContain('survives');
      expect(code).toContain('loadConfig(process.cwd())');
      // The identifier `c` inside the innermost expression is code and must survive
      expect(code).toContain('${c}');
    });
  });

  describe('codeNoComments — strings AND comments masked', () => {
    it('masks line comments while preserving line/column offsets', () => {
      const src = `const x = 1 // calls getDatabase() somewhere\nconst y = 2`;
      const { code, codeNoComments } = filterContent(src);
      // `code` (strings-only) leaves the line comment intact
      expect(code).toContain('getDatabase()');
      // `codeNoComments` masks the comment text but keeps length
      expect(codeNoComments.length).toBe(src.length);
      expect(codeNoComments).not.toContain('getDatabase');
      // Code BEFORE the comment survives
      expect(codeNoComments).toContain('const x = 1');
      // Newlines are preserved so line numbers stay accurate
      expect(codeNoComments.split('\n')).toHaveLength(2);
      expect(codeNoComments.split('\n')[1]).toBe('const y = 2');
    });

    it('masks block / JSDoc comments across multiple lines', () => {
      const src = [
        '/**',
        ' * Replace getDatabase() with the constructor StoreDeps.',
        ' * The check guards against process-wide tenant accessors.',
        ' */',
        'export class TicketStore {}',
      ].join('\n');
      const { codeNoComments } = filterContent(src);
      expect(codeNoComments).not.toContain('getDatabase');
      expect(codeNoComments).not.toContain('StoreDeps');
      expect(codeNoComments).not.toContain('process-wide');
      // Code AFTER the JSDoc survives
      expect(codeNoComments).toContain('export class TicketStore');
      // Line count preserved
      expect(codeNoComments.split('\n')).toHaveLength(5);
    });

    it('masks both strings and comments in the same content', () => {
      const src = `const url = 'https://api.example.com' // call openai.messages.create() here`;
      const { codeNoComments } = filterContent(src);
      expect(codeNoComments).not.toContain('https');
      expect(codeNoComments).not.toContain('messages.create');
      expect(codeNoComments).toContain('const url = ');
    });

    it('does not strip comments when only `code` is requested', () => {
      // Regression guard: codeNoComments is a sibling field, not a replacement.
      // `code` must continue to leave comments intact (some checks scan
      // comments for `@deprecated` / `@fitness-ignore` directives).

      const src = `const x = 1 // @deprecated — use Y instead`;
      const { code, codeNoComments } = filterContent(src);
      expect(code).toContain('@deprecated');
      expect(codeNoComments).not.toContain('@deprecated');
    });
  });

  describe('isInString / isInComment range queries', () => {
    it('isInString reports true for positions inside a string literal', () => {
      const src = `const x = 'hello'`;
      const { isInString } = filterContent(src);
      expect(isInString(1, 12)).toBe(true);
    });

    it('isInString reports false for positions outside any string', () => {
      const src = `const x = 'hello'`;
      const { isInString } = filterContent(src);
      expect(isInString(1, 0)).toBe(false);
    });

    it('isInString returns false for an out-of-range line', () => {
      const src = `const x = 'a'`;
      const { isInString } = filterContent(src);
      expect(isInString(99, 0)).toBe(false);
    });

    it('isInString returns false when there are no strings', () => {
      const { isInString } = filterContent('const x = 1');
      expect(isInString(1, 5)).toBe(false);
    });

    it('isInComment reports true for positions inside a line comment', () => {
      const src = `const x = 1 // hello`;
      const { isInComment } = filterContent(src);
      expect(isInComment(1, 15)).toBe(true);
    });

    it('isInComment reports false outside any comment', () => {
      const src = `const x = 1 // hello`;
      const { isInComment } = filterContent(src);
      expect(isInComment(1, 2)).toBe(false);
    });
  });

  describe('cache behavior — scope-bound (Phase 6 Task 6.4)', () => {
    it('returns the same FilteredContent instance for repeated calls with identical content inside a scope', () => {
      const scope = new RunScope();
      runWithScopeSync(scope, () => {
        const src = `const x = 'cached'`;
        const first = filterContent(src);
        const second = filterContent(src);
        expect(second).toBe(first);
      });
    });

    it('a fresh scope re-parses (cache is per-scope)', () => {
      const src = `const x = 'cleared'`;
      const first = runWithScopeSync(new RunScope(), () => filterContent(src));
      const second = runWithScopeSync(new RunScope(), () => filterContent(src));
      // Two different scopes have independent caches; the FilteredContent
      // values are distinct identities though structurally equivalent.
      expect(second).not.toBe(first);
    });

    it('outside a scope, filterContent bypasses the cache (each call re-parses)', () => {
      const src = `const x = 'no-scope'`;
      const first = filterContent(src);
      const second = filterContent(src);
      // No scope -> no shared cache -> each call returns a fresh instance.
      expect(second).not.toBe(first);
    });
  });

  describe('template middle (multi-substitution)', () => {
    it('masks text between substitutions in a multi-${ } template', () => {
      const src = 'const x = `pre ${a} mid ${b} post`';
      const { code } = filterContent(src);
      expect(code).not.toContain(' mid ');
      expect(code).toContain('${a}');
      expect(code).toContain('${b}');
    });
  });
});
