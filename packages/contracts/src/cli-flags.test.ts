import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { applyCommonFlags, commonFlags, MANDATORY_COMMON_FLAGS, type CommonFlagKey } from './cli-flags.js';

describe('commonFlags registry', () => {
  it('pins the canonical flag strings + descriptions (drift fails here)', () => {
    expect(commonFlags.json).toEqual({ flags: '--json', description: 'Output structured JSON', defaultValue: false });
    expect(commonFlags.cwd).toEqual({ flags: '--cwd <path>', description: 'Target directory' });
    expect(commonFlags.verbose.flags).toBe('-v, --verbose');
    expect(commonFlags.quiet.flags).toBe('-q, --quiet');
    // The drift this registry exists to prevent: one canonical --report-to string.
    expect(commonFlags.reportTo.description).toBe('POST findings to OpenSIP Cloud or a compatible endpoint');
    expect(commonFlags.apiKey.description).toBe('API key for --report-to authentication');
  });

  it('mandatory set is the parity-enforced flags (open is optional)', () => {
    expect([...MANDATORY_COMMON_FLAGS].sort()).toEqual(
      ['apiKey', 'cwd', 'debug', 'json', 'quiet', 'reportTo', 'verbose'].sort(),
    );
    expect(MANDATORY_COMMON_FLAGS).not.toContain('open');
  });
});

describe('applyCommonFlags', () => {
  it('registers exactly the requested flags with their registry specs', () => {
    const cmd = new Command('demo');
    applyCommonFlags(cmd, ['json', 'verbose', 'reportTo']);
    const longNames = cmd.options.map((o) => o.long);
    expect(longNames).toEqual(['--json', '--verbose', '--report-to']);
    const verbose = cmd.options.find((o) => o.long === '--verbose');
    expect(verbose?.short).toBe('-v');
    expect(verbose?.description).toBe('Show the detailed report body inline');
  });

  it('applies literal defaults and honors the cwd override', () => {
    const cmd = new Command('demo');
    applyCommonFlags(cmd, ['json', 'cwd'], { cwd: '/work/proj' });
    const parsed = cmd.opts();
    expect(parsed.json).toBe(false); // literal default from the registry
    expect(parsed.cwd).toBe('/work/proj'); // per-invocation override
  });

  it('returns the same command for chaining', () => {
    const cmd = new Command('demo');
    expect(applyCommonFlags(cmd, ['debug'])).toBe(cmd);
  });

  it('covers every registry key without throwing', () => {
    const cmd = new Command('demo');
    const allKeys = Object.keys(commonFlags) as CommonFlagKey[];
    applyCommonFlags(cmd, allKeys, { cwd: process.cwd() });
    expect(cmd.options.length).toBe(allKeys.length);
  });
});
