import { describe, it, expect } from 'vitest';
import { getErrorSuggestion, EXIT_CODES } from '@opensip-tools/cli-shared';

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
      expect(suggestion!.exitCode).toBe(EXIT_CODES.CHECK_NOT_FOUND);
    });

    it('detects generic "not found" errors', () => {
      const err = new Error('Something not found: my-check');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.exitCode).toBe(EXIT_CODES.CHECK_NOT_FOUND);
    });

    it('detects "Unknown recipe" errors', () => {
      const err = new Error("Unknown recipe 'non-existent'");
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.action).toContain('--recipes');
      expect(suggestion!.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    });

    it('detects config file errors (opensip-tools.config.yml)', () => {
      const err = new Error('Invalid opensip-tools.config.yml');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('Configuration error');
      expect(suggestion!.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    });

    it('detects YAML errors', () => {
      const err = new Error('YAML parse error at line 5');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    });

    it('detects config keyword errors', () => {
      const err = new Error('Invalid config value');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.exitCode).toBe(EXIT_CODES.CONFIGURATION_ERROR);
    });

    it('detects EACCES permission denied errors', () => {
      const err = new Error('EACCES: permission denied, open /etc/shadow');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('Permission denied');
      expect(suggestion!.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    });

    it('detects "permission denied" errors (lowercase)', () => {
      const err = new Error('permission denied reading /root/file');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    });

    it('detects "No checks registered" errors', () => {
      const err = new Error('No checks registered');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('No checks available');
      expect(suggestion!.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    });

    it('detects "No checks to run" errors', () => {
      const err = new Error('No checks to run');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.exitCode).toBe(EXIT_CODES.RUNTIME_ERROR);
    });

    it('detects network/fetch errors', () => {
      const err = new Error('fetch failed: ECONNREFUSED');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.message).toContain('Network error');
      expect(suggestion!.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    });

    it('detects ECONNREFUSED errors', () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    });

    it('detects generic network errors', () => {
      const err = new Error('network timeout');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).not.toBeNull();
      expect(suggestion!.exitCode).toBe(EXIT_CODES.REPORT_FAILED);
    });

    it('returns null for unknown/unrecognized errors', () => {
      const err = new Error('Something completely unexpected happened');
      const suggestion = getErrorSuggestion(err);
      expect(suggestion).toBeNull();
    });

    it('handles non-Error values (strings)', () => {
      const suggestion = getErrorSuggestion('Check not found: foo');
      expect(suggestion).not.toBeNull();
      expect(suggestion!.exitCode).toBe(EXIT_CODES.CHECK_NOT_FOUND);
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
        new Error('opensip-tools.config.yml invalid'),
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
