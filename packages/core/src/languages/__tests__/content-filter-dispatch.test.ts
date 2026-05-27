import { beforeEach, describe, expect, it } from 'vitest';

import { RunScope, runWithScopeSync } from '../../lib/run-scope.js';
import { applyContentFilter } from '../content-filter-dispatch.js';
import { LanguageRegistry } from '../registry.js';

import type { LanguageAdapter } from '../adapter.js';

const fakeAdapter: LanguageAdapter = {
  id: 'fake',
  fileExtensions: ['.fake'],
  parse: () => null,
  stripStrings: (s: string) => s.replaceAll(/"[^"]*"/g, '"___"'),
  // eslint-disable-next-line sonarjs/slow-regex -- test-only fixture stripping `// ...` line comments
  stripComments: (s: string) => s.replaceAll(/\/\/.*$/gm, ''),
};

let scope: RunScope;

beforeEach(() => {
  const reg = new LanguageRegistry();
  reg.register(fakeAdapter);
  scope = new RunScope({ languages: reg });
});

function inScope<T>(fn: () => T): T {
  return runWithScopeSync(scope, fn);
}

describe('applyContentFilter', () => {
  it('returns content unchanged for "raw" mode', () => {
    expect(inScope(() => applyContentFilter('a.fake', 'const x = "hi" // c', 'raw'))).toBe('const x = "hi" // c');
  });

  it('returns content unchanged for "none" mode', () => {
    expect(inScope(() => applyContentFilter('a.fake', 'const x = "hi" // c', 'none'))).toBe('const x = "hi" // c');
  });

  it('dispatches to adapter.stripStrings for "strip-strings" mode', () => {
    expect(inScope(() => applyContentFilter('a.fake', 'const x = "hi"', 'strip-strings'))).toBe('const x = "___"');
  });

  it('dispatches to adapter.stripComments for "strip-strings-and-comments" mode', () => {
    expect(inScope(() => applyContentFilter('a.fake', 'const x = 1 // c\nconst y = 2', 'strip-strings-and-comments')))
      .toBe('const x = 1 \nconst y = 2');
  });

  it('returns raw content when no adapter matches the extension', () => {
    const text = 'const x = "hi"';
    expect(inScope(() => applyContentFilter('a.unknown', text, 'strip-strings'))).toBe(text);
  });

  it('falls back to raw content when called outside runWithScope', () => {
    // Without a scope, applyContentFilter cannot resolve an adapter; it
    // returns raw content (matches the prior no-adapter contract). This
    // keeps tests that call `check.run(...)` directly working without
    // forcing every test through a runWithScope wrap.
    expect(applyContentFilter('a.fake', 'const x = "hi"', 'strip-strings')).toBe('const x = "hi"');
  });

  it('returns content unchanged for "raw" mode even without a scope', () => {
    // "raw" / "none" short-circuit before reading the scope — safe to call outside.
    expect(applyContentFilter('a.fake', 'const x', 'raw')).toBe('const x');
    expect(applyContentFilter('a.fake', 'const x', 'none')).toBe('const x');
  });
});
