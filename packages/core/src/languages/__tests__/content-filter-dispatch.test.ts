import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../lib/logger.js';
import { RunScope, runWithScopeSync } from '../../lib/run-scope.js';
import {
  applyContentFilter,
  resetContentFilterWarningForTests,
} from '../content-filter-dispatch.js';
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
    expect(inScope(() => applyContentFilter('a.fake', 'const x = "hi" // c', 'raw'))).toBe(
      'const x = "hi" // c',
    );
  });

  it('returns content unchanged for "none" mode', () => {
    expect(inScope(() => applyContentFilter('a.fake', 'const x = "hi" // c', 'none'))).toBe(
      'const x = "hi" // c',
    );
  });

  it('dispatches to adapter.stripStrings for "strip-strings" mode', () => {
    expect(inScope(() => applyContentFilter('a.fake', 'const x = "hi"', 'strip-strings'))).toBe(
      'const x = "___"',
    );
  });

  it('dispatches to adapter.stripComments for "strip-strings-and-comments" mode', () => {
    expect(
      inScope(() =>
        applyContentFilter('a.fake', 'const x = 1 // c\nconst y = 2', 'strip-strings-and-comments'),
      ),
    ).toBe('const x = 1 \nconst y = 2');
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

  describe('degradation warning (C)', () => {
    beforeEach(() => {
      resetContentFilterWarningForTests();
    });

    it('warns once when stripping is requested but no scope is active', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
        /* swallow log output */
      });
      try {
        // Two no-scope strip calls — the warning must fire exactly once.
        expect(applyContentFilter('a.fake', 'x = "hi"', 'strip-strings')).toBe('x = "hi"');
        expect(applyContentFilter('b.fake', 'y = "yo"', 'strip-strings-and-comments')).toBe(
          'y = "yo"',
        );
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ evt: 'core.content_filter.degraded' }),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('does NOT warn for a genuinely unknown language (scope present, no adapter)', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
        /* swallow log output */
      });
      try {
        // Scope is active but no adapter owns `.unknown` — returning raw is
        // correct and expected here, so it must stay silent.
        expect(inScope(() => applyContentFilter('a.unknown', 'x = "hi"', 'strip-strings'))).toBe(
          'x = "hi"',
        );
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
