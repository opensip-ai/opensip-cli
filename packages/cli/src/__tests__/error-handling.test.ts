import { getErrorSuggestion, EXIT_CODES } from '@opensip-cli/contracts';
import { describe, it, expect } from 'vitest';

describe('error handling', () => {
  describe('EXIT_CODES', () => {
    it('has SUCCESS = 0', () => {
      expect(EXIT_CODES.SUCCESS).toBe(0);
    });

    it('has RUNTIME_ERROR = 1', () => {
      expect(EXIT_CODES.RUNTIME_ERROR).toBe(1);
    });

    it('has CONFIGURATION_ERROR = 2', () => {
      expect(EXIT_CODES.CONFIGURATION_ERROR).toBe(2);
    });

    it('has CHECK_NOT_FOUND = 3', () => {
      expect(EXIT_CODES.CHECK_NOT_FOUND).toBe(3);
    });

    it('has REPORT_FAILED = 4', () => {
      expect(EXIT_CODES.REPORT_FAILED).toBe(4);
    });

    it('all exit codes are distinct', () => {
      const values = Object.values(EXIT_CODES);
      const uniqueValues = new Set(values);
      expect(uniqueValues.size).toBe(values.length);
    });
  });

  describe('getErrorSuggestion', () => {
    it('detects "Check not found" errors', () => {
      const err = new Error('Check not found: no-console-log');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('no-console-log');
      expect(suggestion!.action).toContain('--list');
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('no longer claims generic "not found" phrasing as a check error (narrowed for correctness)', () => {
      // Audit fix: broad "not found" substring was fragile and could steal
      // recipe/file/etc not-founds. Only explicit "Check not found: ..." or
      // a real NotFoundError (via mapToolErrorToExitCode) produce the CHECK_3 path.
      const err = new Error('Something not found: my-check');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).toBeNull();
    });

    it('detects "Unknown recipe" errors', () => {
      const err = new Error("Unknown recipe 'non-existent'");
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.action).toContain('--recipes');
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('detects config file errors (opensip-cli.config.yml)', () => {
      const err = new Error('Invalid opensip-cli.config.yml');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('Configuration error');
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('detects YAML errors', () => {
      const err = new Error('YAML parse error at line 5');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('does not match the bare "config" substring (narrowed to opensip-cli.config.yml + YAML)', () => {
      // Layer 2 Phase 1: the previous over-broad 'config' substring rule
      // matched 'configurable', 'reconfigure', and bare 'Invalid config'
      // messages. It has been narrowed into two explicit rules
      // (opensip-cli.config.yml + YAML); inputs that previously
      // matched by accident now fall through to the default null.
      const err = new Error('Invalid config value');
      expect(getErrorSuggestion(err)).toBeNull();
    });

    it('detects EACCES permission denied errors', () => {
      const err = new Error('EACCES: permission denied, open /etc/shadow');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('Permission denied');
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('detects "permission denied" errors (lowercase)', () => {
      const err = new Error('permission denied reading /root/file');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('detects "No checks registered" errors', () => {
      const err = new Error('No checks registered');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('No checks available');
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('detects "No checks to run" errors', () => {
      const err = new Error('No checks to run');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('detects network/fetch errors', () => {
      const err = new Error('fetch failed: ECONNREFUSED');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('Network error');
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('detects ECONNREFUSED errors', () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('detects generic network errors', () => {
      const err = new Error('network timeout');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('returns null for unknown/unrecognized errors', () => {
      const err = new Error('Something completely unexpected happened');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).toBeNull();
    });

    it('handles non-Error values (strings)', () => {
      const suggestion = getErrorSuggestion('Check not found: foo');
      expect(suggestion).not.toBeNull();
      expect(suggestion).not.toHaveProperty('exitCode');
    });

    it('handles non-Error values (numbers)', () => {
      const suggestion = getErrorSuggestion(42);
      expect(suggestion).toBeNull();
    });

    it('handles null/undefined errors', () => {
      expect(getErrorSuggestion(null)).toBeNull();
      expect(getErrorSuggestion(undefined)).toBeNull();
    });

    it('includes action suggestions for all recognized errors', () => {
      const testCases = [
        new Error('Check not found: x'),
        new Error('Unknown recipe'),
        new Error('opensip-cli.config.yml invalid'),
        new Error('EACCES denied'),
        new Error('No checks registered'),
        new Error('fetch error'),
      ];

      for (const err of testCases) {
        const suggestion = getErrorSuggestion(err);
        expect(suggestion).not.toBeNull();
        expect(suggestion!.action).toBeTruthy();
      }
    });
  });
});
