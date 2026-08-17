/**
 * Coverage for `parseTypeScriptDirectives` — the `@ts-expect-error` grammar
 * of the directive-audit parser family.
 */
import { describe, expect, it } from 'vitest';

import { parseTypeScriptDirectives } from './typescript.js';

const FILE = 'src/foo.ts';
const SHORT = 'foo.ts';

describe('parseTypeScriptDirectives', () => {
  // Regression: `[:-—]` was an unintended RANGE (U+003A ':' through U+2014
  // '—'), not a 3-member set — hyphen (U+002D) sits below the range start,
  // so this repo's own documented `--`/`-` separator convention (see
  // directive-audit.ts) never matched, and the reason was silently reported
  // as empty.
  it('extracts the reason after a single-hyphen separator', () => {
    const content = '// @ts-expect-error - legacy upstream types are wrong';
    const directives = parseTypeScriptDirectives(content, FILE, SHORT);
    expect(directives[0]?.reason).toBe('legacy upstream types are wrong');
  });

  it('extracts the reason after a double-hyphen separator', () => {
    const content = '// @ts-expect-error -- third-party type wrong';
    const directives = parseTypeScriptDirectives(content, FILE, SHORT);
    expect(directives[0]?.reason).toBe('third-party type wrong');
  });

  // Regression: any OTHER character within the unintended range (letters,
  // digits, punctuation) DID match and was silently eaten as the separator,
  // truncating the first character of the reason (e.g. "TS2345 ..." parsed
  // as if "T" were the separator, corrupting the reason to "S2345 ..."). A
  // bare space is not a documented separator (": or - or -- or em-dash"), so
  // the correct fixed behavior is no match at all (empty reason) — never a
  // silently truncated one.
  it('does not silently truncate a reason with no recognized separator', () => {
    const content = '// @ts-expect-error TS2345 upstream types are wrong';
    const directives = parseTypeScriptDirectives(content, FILE, SHORT);
    expect(directives[0]?.reason).toBe('');
  });

  it('extracts the reason after a colon separator', () => {
    const content = '// @ts-expect-error: upstream types are wrong';
    const directives = parseTypeScriptDirectives(content, FILE, SHORT);
    expect(directives[0]?.reason).toBe('upstream types are wrong');
  });

  it('extracts the reason after an em-dash separator', () => {
    const content = '// @ts-expect-error — upstream types are wrong';
    const directives = parseTypeScriptDirectives(content, FILE, SHORT);
    expect(directives[0]?.reason).toBe('upstream types are wrong');
  });
});
