import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyContentFilter } from '../content-filter-dispatch.js';
import { defaultLanguageRegistry } from '../registry.js';

import type { LanguageAdapter } from '../adapter.js';

const fakeAdapter: LanguageAdapter = {
  id: 'fake',
  fileExtensions: ['.fake'],
  parse: () => null,
  stripStrings: (s: string) => s.replaceAll(/"[^"]*"/g, '"___"'),
  // eslint-disable-next-line sonarjs/slow-regex -- test-only fixture stripping `// ...` line comments
  stripComments: (s: string) => s.replaceAll(/\/\/.*$/gm, ''),
};

beforeEach(() => {
  defaultLanguageRegistry.register(fakeAdapter);
});

afterEach(() => {
  defaultLanguageRegistry.clear();
});

describe('applyContentFilter', () => {
  it('returns content unchanged for "raw" mode', () => {
    expect(applyContentFilter('a.fake', 'const x = "hi" // c', 'raw')).toBe('const x = "hi" // c');
  });

  it('returns content unchanged for "none" mode', () => {
    expect(applyContentFilter('a.fake', 'const x = "hi" // c', 'none')).toBe('const x = "hi" // c');
  });

  it('dispatches to adapter.stripStrings for "strip-strings" mode', () => {
    expect(applyContentFilter('a.fake', 'const x = "hi"', 'strip-strings')).toBe('const x = "___"');
  });

  it('dispatches to adapter.stripComments for "strip-strings-and-comments" mode', () => {
    expect(applyContentFilter('a.fake', 'const x = 1 // c\nconst y = 2', 'strip-strings-and-comments'))
      .toBe('const x = 1 \nconst y = 2');
  });

  it('returns raw content when no adapter matches the extension', () => {
    const text = 'const x = "hi"';
    expect(applyContentFilter('a.unknown', text, 'strip-strings')).toBe(text);
  });
});
