import {
  ConfigurationError,
  NetworkError,
  NotFoundError,
  SystemError,
  TimeoutError,
  ToolError,
  ValidationError,
} from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import {
  EXIT_CODES,
  getErrorSuggestion,
  mapToolErrorToExitCode,
  type ErrorSuggestion,
} from '../exit-codes.js';

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

  // ---- Per-rule coverage (one input per rule + default fall-through) ----

  interface RuleCase {
    name: string;
    input: string;
    expect: Pick<ErrorSuggestion, 'exitCode'> & {
      messageContains?: string;
      actionContains?: string;
    };
  }

  const RULE_CASES: RuleCase[] = [
    {
      name: 'check-not-found rule fires for "Check not found: <slug>"',
      input: 'Check not found: foo-check',
      expect: { exitCode: EXIT_CODES.CHECK_NOT_FOUND, messageContains: 'foo-check' },
    },
    {
      // The fitness engine throws `Recipe not found: <id>` (recipes/service.ts);
      // this must route to CONFIGURATION_ERROR (the recipe name is wrong in
      // config) and not CHECK_NOT_FOUND. The recipe-not-found rule sits
      // ahead of the check-not-found rule precisely for this case.
      name: 'recipe-not-found rule fires for "Recipe not found: <slug>"',
      input: 'Recipe not found: my-recipe',
      expect: { exitCode: EXIT_CODES.CONFIGURATION_ERROR, messageContains: 'my-recipe' },
    },
    {
      // The `Recipe not found:` substring with no extractable slug — the
      // /Recipe not found: (.+)/ regex fails (nothing after the colon) but the
      // substring fallback still classifies it as a recipe error and the
      // suggest builder substitutes "unknown".
      name: 'recipe-not-found rule falls back to "unknown" when slug missing',
      input: 'Recipe not found:',
      expect: { exitCode: EXIT_CODES.CONFIGURATION_ERROR, messageContains: 'unknown' },
    },
    {
      name: 'check-not-found rule fires for bare "not found: <slug>"',
      input: 'not found: foo-check',
      expect: { exitCode: EXIT_CODES.CHECK_NOT_FOUND, messageContains: 'foo-check' },
    },
    {
      name: 'check-not-found rule falls back to "unknown" when slug missing',
      input: 'not found',
      expect: { exitCode: EXIT_CODES.CHECK_NOT_FOUND, messageContains: 'unknown' },
    },
    {
      name: 'unknown-recipe rule fires for "Unknown recipe ..."',
      input: 'Unknown recipe foo',
      expect: { exitCode: EXIT_CODES.CONFIGURATION_ERROR, actionContains: '--recipes' },
    },
    {
      name: 'config-file rule fires for opensip-tools.config.yml errors',
      input: 'Failed to parse opensip-tools.config.yml',
      expect: { exitCode: EXIT_CODES.CONFIGURATION_ERROR },
    },
    {
      name: 'yaml-parse rule fires for YAML errors',
      input: 'Bad YAML at line 3',
      expect: { exitCode: EXIT_CODES.CONFIGURATION_ERROR },
    },
    {
      name: 'permission rule fires for EACCES',
      input: 'EACCES: permission denied reading /etc',
      expect: { exitCode: EXIT_CODES.RUNTIME_ERROR, actionContains: 'permissions' },
    },
    {
      name: 'no-checks rule fires for "No checks registered"',
      input: 'No checks registered',
      expect: { exitCode: EXIT_CODES.RUNTIME_ERROR, actionContains: 'checks-*' },
    },
    {
      name: 'no-checks rule fires for "No checks to run"',
      input: 'No checks to run',
      expect: { exitCode: EXIT_CODES.RUNTIME_ERROR },
    },
    {
      name: 'network rule fires for fetch errors',
      input: 'fetch failed',
      expect: { exitCode: EXIT_CODES.REPORT_FAILED },
    },
    {
      name: 'network rule fires for ECONNREFUSED',
      input: 'ECONNREFUSED',
      expect: { exitCode: EXIT_CODES.REPORT_FAILED },
    },
    {
      name: 'network rule fires for generic network errors',
      input: 'network unreachable',
      expect: { exitCode: EXIT_CODES.REPORT_FAILED },
    },
  ];

  for (const c of RULE_CASES) {
    it(c.name, () => {
      const out = getErrorSuggestion(new Error(c.input));
      expect(out).not.toBeNull();
      expect(out?.exitCode).toBe(c.expect.exitCode);
      if (c.expect.messageContains !== undefined) {
        expect(out?.message).toContain(c.expect.messageContains);
      }
      if (c.expect.actionContains !== undefined) {
        expect(out?.action).toContain(c.expect.actionContains);
      }
    });
  }

  // ---- False-positive narrowing of the old broad 'config' substring ----
  //
  // The previous implementation treated any message containing the
  // literal substring 'config' as a configuration error. That matched
  // common English words like 'configurable', 'reconfigure', and bare
  // 'config invalid'. Phase 1 narrows this into two explicit rules
  // (opensip-tools.config.yml + YAML); inputs that previously matched
  // by accident now fall through to the default null.

  const NARROWED_FALSE_POSITIVES = [
    'config invalid',
    'this option is configurable',
    'reconfigure the engine',
    'unable to reconfig the runtime',
  ];

  for (const input of NARROWED_FALSE_POSITIVES) {
    it(`narrowed: bare 'config' substring no longer matches: "${input}"`, () => {
      expect(getErrorSuggestion(new Error(input))).toBeNull();
    });
  }

  // ---- First-match-wins: rule order is load-bearing ----

  it('first-match-wins: "Check not found" beats "YAML" if both substrings present', () => {
    // Constructed so it would match both the check-not-found rule and
    // the YAML rule; the table walks top-down, so the check-not-found
    // arm wins.
    const out = getErrorSuggestion(new Error('Check not found: foo-check (parsing YAML)'));
    expect(out?.exitCode).toBe(EXIT_CODES.CHECK_NOT_FOUND);
  });

  // ---- Regression / behavior parity sanity checks ----

  it('default fall-through returns null', () => {
    expect(getErrorSuggestion(new Error('totally unrelated message'))).toBeNull();
  });

  it('preserves the unknown-recipe message verbatim', () => {
    const out = getErrorSuggestion(new Error('Unknown recipe foo'));
    expect(out?.message).toBe('Unknown recipe foo');
  });
});

describe('mapToolErrorToExitCode (Tool error contract — audit-round-2 Finding C)', () => {
  it('NotFoundError → CHECK_NOT_FOUND', () => {
    expect(mapToolErrorToExitCode(new NotFoundError('missing'))).toBe(EXIT_CODES.CHECK_NOT_FOUND);
  });

  it('ConfigurationError → CONFIGURATION_ERROR', () => {
    expect(mapToolErrorToExitCode(new ConfigurationError('bad config'))).toBe(
      EXIT_CODES.CONFIGURATION_ERROR,
    );
  });

  it('ValidationError → CONFIGURATION_ERROR', () => {
    expect(mapToolErrorToExitCode(new ValidationError('bad input'))).toBe(
      EXIT_CODES.CONFIGURATION_ERROR,
    );
  });

  it('NetworkError → REPORT_FAILED', () => {
    expect(mapToolErrorToExitCode(new NetworkError('connection refused'))).toBe(
      EXIT_CODES.REPORT_FAILED,
    );
  });

  it('TimeoutError → RUNTIME_ERROR', () => {
    expect(mapToolErrorToExitCode(new TimeoutError('took too long'))).toBe(EXIT_CODES.RUNTIME_ERROR);
  });

  it('SystemError → RUNTIME_ERROR', () => {
    expect(mapToolErrorToExitCode(new SystemError('boom'))).toBe(EXIT_CODES.RUNTIME_ERROR);
  });

  it('bare ToolError → RUNTIME_ERROR (fallback)', () => {
    expect(mapToolErrorToExitCode(new ToolError('opaque', 'WHATEVER'))).toBe(
      EXIT_CODES.RUNTIME_ERROR,
    );
  });

  it('user-defined ToolError subclass routes by its nearest mapped ancestor', () => {
    class GatePolicyError extends ConfigurationError {}
    expect(mapToolErrorToExitCode(new GatePolicyError('policy violated'))).toBe(
      EXIT_CODES.CONFIGURATION_ERROR,
    );
  });
});
