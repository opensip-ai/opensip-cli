import { describe, it, expect } from 'vitest';

import { RECOGNIZED_NON_CODE_FORMATS, isRecognizedNonCodeFormat } from '../non-code-formats.js';

describe('RECOGNIZED_NON_CODE_FORMATS', () => {
  it('contains the structured-data + markup tags used as adapter-less scope dimensions', () => {
    // These are the tags opensip configs legitimately declare on
    // package.json / table-ownership.json / docs targets.
    for (const tag of ['json', 'yaml', 'markdown', 'toml', 'plaintext']) {
      expect(RECOGNIZED_NON_CODE_FORMATS.has(tag)).toBe(true);
    }
  });

  it('does not absorb real code-language ids (those resolve via adapters, not this set)', () => {
    for (const tag of ['typescript', 'rust', 'python', 'go']) {
      expect(RECOGNIZED_NON_CODE_FORMATS.has(tag)).toBe(false);
    }
  });
});

describe('isRecognizedNonCodeFormat', () => {
  it('recognizes a known non-code format', () => {
    expect(isRecognizedNonCodeFormat('json')).toBe(true);
    expect(isRecognizedNonCodeFormat('markdown')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRecognizedNonCodeFormat('JSON')).toBe(true);
    expect(isRecognizedNonCodeFormat('Markdown')).toBe(true);
  });

  it('rejects a genuine typo (the case the validator must still warn on)', () => {
    expect(isRecognizedNonCodeFormat('pythonn')).toBe(false);
    expect(isRecognizedNonCodeFormat('jsonn')).toBe(false);
  });
});
