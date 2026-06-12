import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { logger } from '../../lib/logger.js';
import { VALID_NPM_SCOPE_REGEX, resolveScopes } from '../scope-validation.js';

describe('VALID_NPM_SCOPE_REGEX', () => {
  it('accepts well-formed npm scopes', () => {
    expect(VALID_NPM_SCOPE_REGEX.test('@opensip-cli')).toBe(true);
    expect(VALID_NPM_SCOPE_REGEX.test('@foo')).toBe(true);
    expect(VALID_NPM_SCOPE_REGEX.test('@foo-bar')).toBe(true);
    expect(VALID_NPM_SCOPE_REGEX.test('@foo.bar')).toBe(true);
    expect(VALID_NPM_SCOPE_REGEX.test('@foo_bar')).toBe(true);
    expect(VALID_NPM_SCOPE_REGEX.test('@0abc')).toBe(true);
  });

  it('rejects malformed scopes', () => {
    expect(VALID_NPM_SCOPE_REGEX.test('foo')).toBe(false); // missing @
    expect(VALID_NPM_SCOPE_REGEX.test('@')).toBe(false); // empty body
    expect(VALID_NPM_SCOPE_REGEX.test('@Foo')).toBe(false); // uppercase
    expect(VALID_NPM_SCOPE_REGEX.test('@foo/bar')).toBe(false); // slash
    expect(VALID_NPM_SCOPE_REGEX.test('@..')).toBe(false); // path traversal-ish
    expect(VALID_NPM_SCOPE_REGEX.test('@-foo')).toBe(false); // leading dash
    expect(VALID_NPM_SCOPE_REGEX.test('')).toBe(false);
  });
});

describe('resolveScopes', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('always includes the default scope first', () => {
    const out = resolveScopes('@opensip-cli', [], 'plugin.invalid_scope');
    expect(out).toEqual(['@opensip-cli']);
  });

  it('appends valid extra scopes after the default', () => {
    const out = resolveScopes('@opensip-cli', ['@other', '@third'], 'plugin.invalid_scope');
    expect(out).toEqual(['@opensip-cli', '@other', '@third']);
  });

  it('deduplicates extra scopes that match the default', () => {
    const out = resolveScopes(
      '@opensip-cli',
      ['@opensip-cli', '@other'],
      'plugin.invalid_scope',
    );
    expect(out).toEqual(['@opensip-cli', '@other']);
  });

  it('deduplicates duplicate extra scopes', () => {
    const out = resolveScopes(
      '@opensip-cli',
      ['@other', '@other', '@third'],
      'plugin.invalid_scope',
    );
    expect(out).toEqual(['@opensip-cli', '@other', '@third']);
  });

  it('drops invalid scopes with a structured warning', () => {
    const out = resolveScopes(
      '@opensip-cli',
      ['@valid', 'no-at-sign', '@Bad'],
      'plugin.invalid_scope',
    );
    expect(out).toEqual(['@opensip-cli', '@valid']);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      evt: 'plugin.invalid_scope',
      module: 'core:plugins',
      scope: 'no-at-sign',
    });
    expect(warnSpy.mock.calls[1]?.[0]).toMatchObject({
      evt: 'plugin.invalid_scope',
      scope: '@Bad',
    });
  });

  it('uses the supplied event name in warnings', () => {
    resolveScopes('@opensip-cli', ['bad'], 'plugin.scenario_package.invalid_scope');
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      evt: 'plugin.scenario_package.invalid_scope',
    });
  });
});
