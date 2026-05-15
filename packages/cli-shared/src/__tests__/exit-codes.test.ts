import { describe, expect, it } from 'vitest';

import { EXIT_CODES, getErrorSuggestion } from '../exit-codes.js';

describe('EXIT_CODES', () => {
  it('exposes the documented set', () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      RUNTIME_ERROR: 1,
      CONFIGURATION_ERROR: 2,
      CHECK_NOT_FOUND: 3,
      REPORT_FAILED: 4,
    });
  });
});

describe('getErrorSuggestion', () => {
  it('returns null when no pattern matches', () => {
    expect(getErrorSuggestion(new Error('something else entirely'))).toBeNull();
  });

  it('handles non-Error inputs', () => {
    expect(getErrorSuggestion('just a string')).toBeNull();
    expect(getErrorSuggestion(undefined)).toBeNull();
  });

  it('classifies "Check not found: <slug>" with the slug surfaced', () => {
    const out = getErrorSuggestion(new Error('Check not found: foo-check'));
    expect(out?.exitCode).toBe(EXIT_CODES.CHECK_NOT_FOUND);
    expect(out?.message).toContain('foo-check');
  });

  it('classifies "not found: <slug>" without the "Check" prefix', () => {
    const out = getErrorSuggestion(new Error('Recipe not found: my-recipe'));
    expect(out?.exitCode).toBe(EXIT_CODES.CHECK_NOT_FOUND);
    expect(out?.message).toContain('my-recipe');
  });

  it('falls back to "unknown" when slug cannot be extracted', () => {
    const out = getErrorSuggestion(new Error('not found'));
    expect(out?.message).toContain('unknown');
  });

  it('classifies "Unknown recipe ..." as configuration error', () => {
    const out = getErrorSuggestion(new Error('Unknown recipe foo'));
    expect(out?.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    expect(out?.action).toContain('--recipes');
  });

  it('classifies opensip-tools.config.yml errors', () => {
    const out = getErrorSuggestion(new Error('Failed to parse opensip-tools.config.yml'));
    expect(out?.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
  });

  it('classifies YAML errors as configuration', () => {
    const out = getErrorSuggestion(new Error('Bad YAML at line 3'));
    expect(out?.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
  });

  it('classifies generic config errors', () => {
    const out = getErrorSuggestion(new Error('config invalid'));
    expect(out?.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
  });

  it('classifies EACCES as a runtime permission error', () => {
    const out = getErrorSuggestion(new Error('EACCES: permission denied reading /etc'));
    expect(out?.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(out?.action).toContain('permissions');
  });

  it('classifies "No checks registered" as runtime error with check-pack guidance', () => {
    const out = getErrorSuggestion(new Error('No checks registered'));
    expect(out?.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    expect(out?.action).toContain('checks-*');
  });

  it('classifies "No checks to run" similarly', () => {
    const out = getErrorSuggestion(new Error('No checks to run'));
    expect(out?.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
  });

  it('classifies fetch/network errors as REPORT_FAILED', () => {
    expect(getErrorSuggestion(new Error('fetch failed'))?.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    expect(getErrorSuggestion(new Error('ECONNREFUSED'))?.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    expect(getErrorSuggestion(new Error('network unreachable'))?.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
  });
});
