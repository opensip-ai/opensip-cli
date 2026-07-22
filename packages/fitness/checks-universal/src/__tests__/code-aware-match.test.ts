/**
 * @fileoverview Direct unit tests for the code-aware-match substrate
 * (`../checks/code-aware-match.ts`): the AST/code-mask matching layer shared
 * by every literal-sensitive check. These call the exported functions
 * directly (no fixture files, no check dispatch) so each edge case in the
 * static-literal extraction, template-offset mapping, JavaScript escape
 * decoding, and fallback (no-adapter) module-reference parser can be
 * exercised precisely.
 */
import { LanguageRegistry, RunScope, runWithScopeSync } from '@opensip-cli/core';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { describe, expect, it } from 'vitest';

import {
  createCodeMask,
  decodeJavaScriptStaticText,
  decodeJavaScriptStaticTextWithOffsets,
  findCodeMatch,
  findCodeMatches,
  findStaticModuleReferences,
  findStaticStringLiterals,
  findTaggedTemplateStarts,
  hasCodeMatch,
  templateRawSpans,
} from '../checks/code-aware-match.js';

const tsLanguages = new LanguageRegistry();
tsLanguages.register(typescriptAdapter);
const tsScope = new RunScope({ languages: tsLanguages });
const fallbackScope = new RunScope({ languages: new LanguageRegistry() });

function withTs<T>(fn: () => T): T {
  return runWithScopeSync(tsScope, fn);
}

function withFallback<T>(fn: () => T): T {
  return runWithScopeSync(fallbackScope, fn);
}

describe('decodeJavaScriptStaticText / decodeJavaScriptStaticTextWithOffsets', () => {
  it('decodes every simple single-character escape', () => {
    expect(decodeJavaScriptStaticText(String.raw`\b\f\n\r\t\v`)).toBe('\b\f\n\r\t\v');
  });

  it('decodes a bare \\0 as NUL rather than a legacy octal escape', () => {
    expect(decodeJavaScriptStaticText(String.raw`\0`)).toBe(String.fromCodePoint(0));
  });

  it('decodes a single-digit legacy octal escape at the end of the string', () => {
    // No character follows the '7', so the second-digit lookahead falls
    // off the end of the source and must default to '' rather than throw.
    expect(decodeJavaScriptStaticText(String.raw`\7`)).toBe(String.fromCodePoint(7));
  });

  it('decodes a two-digit legacy octal escape at the end of the string', () => {
    // No character follows the second digit, so the third-digit lookahead
    // must also default to '' instead of reading past the end of the string.
    expect(decodeJavaScriptStaticText(String.raw`\17`)).toBe(String.fromCodePoint(15));
  });

  it('treats an out-of-range octal-looking digit as a literal character', () => {
    expect(decodeJavaScriptStaticText(String.raw`\8`)).toBe('8');
  });

  it('decodes a valid 2-digit hex escape and rejects an invalid one', () => {
    expect(decodeJavaScriptStaticText(String.raw`\x41`)).toBe('A');
    // Invalid hex digits: only the backslash+x is consumed (as a literal
    // 'x'), the remaining characters pass through untouched.
    expect(decodeJavaScriptStaticText(String.raw`\xZZ`)).toBe('xZZ');
  });

  it('decodes a valid 4-digit unicode escape', () => {
    expect(decodeJavaScriptStaticText('\\u0041')).toBe('A');
  });

  it('decodes a valid extended \\u{...} unicode escape, including astral code points', () => {
    const decoded = decodeJavaScriptStaticTextWithOffsets(String.raw`\u{1F600}`);
    expect(decoded.text).toBe(String.fromCodePoint(0x1_f6_00));
    // The astral code point emits a UTF-16 surrogate pair (2 code units);
    // both units must map back to the escape's opening backslash.
    expect(decoded.rawOffsets).toEqual([0, 0]);
  });

  it('treats an unterminated \\u{ escape as literal text', () => {
    expect(decodeJavaScriptStaticText(String.raw`\u{`)).toBe('u{');
  });

  it('rejects non-hex digits inside a \\u{...} escape', () => {
    expect(decodeJavaScriptStaticText(String.raw`\u{ZZZZ}`)).toBe('u{ZZZZ}');
  });

  it('rejects a \\u{...} code point beyond the Unicode range', () => {
    expect(decodeJavaScriptStaticText(String.raw`\u{110000}`)).toBe('u{110000}');
  });

  it('consumes a backslash-CRLF line continuation entirely', () => {
    expect(decodeJavaScriptStaticText('ab\\\r\ncd')).toBe('abcd');
  });

  it('consumes a backslash-CR (no LF) line continuation', () => {
    expect(decodeJavaScriptStaticText('ab\\\rcd')).toBe('abcd');
  });

  it('drops a dangling backslash at the end of the string', () => {
    expect(decodeJavaScriptStaticText('abc\\')).toBe('abc');
  });
});

describe('templateRawSpans', () => {
  it('tracks nested brace depth inside a template interpolation before closing the raw span', () => {
    const content = '`a${ {b:1} }c`';
    const spans = templateRawSpans(content, content, 0);
    expect(spans).toEqual([
      { start: 1, end: 2 },
      { start: 12, end: 13 },
    ]);
  });
});

describe('findCodeMatches / findCodeMatch / hasCodeMatch', () => {
  it('advances past zero-length matches instead of looping forever', () => {
    const matches = findCodeMatches(/x*/g, 'abc', 'abc');
    expect(matches.map((match) => match.index)).toEqual([0, 1, 2]);
  });

  it('rejects a match whose token position is blanked out in the code mask', () => {
    const content = 'const x = "import foo";';
    const codeMask = content.replace('import foo', ' '.repeat('import foo'.length));
    expect(findCodeMatches(/import\s+\w+/, content, codeMask)).toHaveLength(0);
  });

  it('accepts a match whose token position is real code in the mask', () => {
    const content = 'import foo from "bar";';
    const matches = findCodeMatches(/import\s+\w+/, content, content);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.[0]).toBe('import foo');
  });

  it('findCodeMatch returns only the first match, or null when there is none', () => {
    expect(findCodeMatch(/x*/g, 'abc', 'abc')?.index).toBe(0);
    expect(findCodeMatch(/zzz/, 'abc', 'abc')).toBeNull();
  });

  it('hasCodeMatch reports whether any code match exists', () => {
    expect(hasCodeMatch(/foo/, 'foo bar', 'foo bar')).toBe(true);
    expect(hasCodeMatch(/qux/, 'foo bar', 'foo bar')).toBe(false);
  });
});

describe('createCodeMask (TypeScript AST mode)', () => {
  it('blanks JSX text content while preserving the surrounding code', () => {
    const content = 'const App = () => <div>Hello World</div>;';
    const mask = withTs(() => createCodeMask('component.tsx', content));
    expect(mask).toHaveLength(content.length);
    expect(mask).not.toContain('Hello World');
    expect(mask.startsWith('const App = () => <div>')).toBe(true);
    expect(mask.endsWith('</div>;')).toBe(true);
  });
});

describe('findStaticStringLiterals (TypeScript AST mode) — roles and computed property names', () => {
  function literalsOf(content: string) {
    return withTs(() => findStaticStringLiterals('component.ts', content));
  }

  it('resolves the static name of a computed property key through parens, a type cast, and a non-null assertion', () => {
    const literals = literalsOf(
      [
        'const parens = { [("key")]: "value1" };',
        'const cast = { [("key" as const)]: "value2" };',
        'const bang = { [("key")!]: "value3" };',
      ].join('\n'),
    );
    const byValue = (value: string) => literals.find((literal) => literal.value === value);
    expect(byValue('value1')?.propertyName).toBe('key');
    expect(byValue('value2')?.propertyName).toBe('key');
    expect(byValue('value3')?.propertyName).toBe('key');
  });

  it('does not resolve a dynamically computed property name', () => {
    const literals = literalsOf('const dyn = { [computeKey()]: "value" };');
    const literal = literals.find((candidate) => candidate.value === 'value');
    expect(literal?.role).toBe('object-property');
    expect(literal?.propertyName).toBeUndefined();
  });

  it('resolves the target name of a simple assignment to a bare identifier', () => {
    const literals = literalsOf('let secretValue;\nsecretValue = "hunter2";');
    const literal = literals.find((candidate) => candidate.value === 'hunter2');
    expect(literal?.role).toBe('assignment');
    expect(literal?.propertyName).toBe('secretValue');
  });
});

describe('findTaggedTemplateStarts', () => {
  it('resolves a tagged template start through explicit generic type arguments', () => {
    const starts = withTs(() =>
      findTaggedTemplateStarts('component.ts', 'const q = gql<Result>`hello`;', 'gql'),
    );
    expect(starts).toHaveLength(1);
  });
});

describe('findStaticModuleReferences — fallback parser (no adapter registered)', () => {
  it('decodes an escaped quote inside a fallback module specifier', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', String.raw`import x from "a\"b";`),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.moduleSpecifier).toBe('a"b');
  });

  it('skips a block comment before the fallback source clause', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import /* keep */ x from "moment";'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.moduleSpecifier).toBe('moment');
  });

  it('skips a line comment before the fallback source clause', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import // note\n x from "moment";'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.moduleSpecifier).toBe('moment');
  });

  it('treats an unterminated block comment as extending to end of file', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import /* unterminated'),
    );
    expect(refs).toHaveLength(0);
  });

  it('treats an unterminated line comment as extending to end of file', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import // trailing comment with no newline'),
    );
    expect(refs).toHaveLength(0);
  });

  it('uses nested-parenthesis matching to recognize a regex following an if condition', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'if ((a)) /oops; import x from "y"/.test(value);'),
    );
    // The "import" is genuinely embedded inside the regex literal, so it
    // must not be reported as a real declaration.
    expect(refs).toHaveLength(0);
  });

  it('treats a regex literal at the very start of a line as a valid regex context', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', '/;import x from "y"/;'),
    );
    expect(refs).toHaveLength(0);
  });

  it('does not let an unterminated regex-like slash swallow a later real import', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences(
        'fallback.ts',
        'return /oops; import moment from "moment";\nlast line',
      ),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.moduleSpecifier).toBe('moment');
  });

  it('does not let a properly closed escaped-slash regex swallow a later real import', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences(
        'fallback.ts',
        String.raw`const pattern = /a\/b/; import x from "moment";`,
      ),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.moduleSpecifier).toBe('moment');
  });

  it('does not let a slash inside a fallback regex character class close it early', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences(
        'fallback.ts',
        String.raw`const pattern = /[a/b]c/; import x from "moment";`,
      ),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.moduleSpecifier).toBe('moment');
  });

  it('resolves a fallback side-effect import as a runtime reference', () => {
    const refs = withFallback(() => findStaticModuleReferences('fallback.ts', 'import "moment";'));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      keyword: 'import',
      moduleSpecifier: 'moment',
      runtimeImport: true,
    });
  });

  it('resolves a fallback export...from declaration as non-runtime', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'export { x } from "moment";'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      keyword: 'export',
      moduleSpecifier: 'moment',
      runtimeImport: false,
    });
  });

  it('rejects a fallback import whose specifier is not quoted', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import x from moment;'),
    );
    expect(refs).toHaveLength(0);
  });

  it('does not treat a fallback dynamic import(...) call as a static module reference', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import("dynamic-thing");'),
    );
    expect(refs).toHaveLength(0);
  });

  it('rejects a fallback import with an unterminated specifier string', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import x from "moment'),
    );
    expect(refs).toHaveLength(0);
  });

  it('rejects fallback import-equals declarations that are malformed in various ways', () => {
    expect(
      withFallback(() =>
        findStaticModuleReferences('fallback.ts', 'import foo = notRequire("x");'),
      ),
    ).toHaveLength(0);
    expect(
      withFallback(() => findStaticModuleReferences('fallback.ts', 'import foo = require;')),
    ).toHaveLength(0);
    expect(
      withFallback(() => findStaticModuleReferences('fallback.ts', 'import foo = require(bar);')),
    ).toHaveLength(0);
    expect(
      withFallback(() => findStaticModuleReferences('fallback.ts', 'import foo = require(')),
    ).toHaveLength(0);
  });

  it('treats a fallback default type-only import as non-runtime', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import type Foo from "moment";'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.runtimeImport).toBe(false);
  });

  it('treats a fallback "import type from" as a runtime default import literally named type', () => {
    const refs = withFallback(() =>
      findStaticModuleReferences('fallback.ts', 'import type from "moment";'),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]?.runtimeImport).toBe(true);
    expect(refs[0]?.runtimeBindingNames).toEqual(['type']);
  });
});
