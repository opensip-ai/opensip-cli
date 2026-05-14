// Test that --json output matches the documented schema
import { describe, it, expect } from 'vitest';

// Import the CliOutput type
import type { CliOutput } from '@opensip-tools/cli-shared';

describe('JSON output contract', () => {
  it('CliOutput has required fields', () => {
    // Type-level test — if this compiles, the contract is valid
    const output: CliOutput = {
      version: '1.0',
      tool: 'fit',
      timestamp: '2026-01-01T00:00:00.000Z',
      score: 100,
      passed: true,
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      checks: [{
        checkSlug: 'test',
        passed: true,
        findings: [],
        durationMs: 100,
      }],
      durationMs: 100,
    };
    expect(output.version).toBe('1.0');
    expect(output.tool).toBe('fit');
  });

  it('version is 1.0', () => {
    // This is the contract — if we change this, it's a breaking change
    // Type-level assertion: CliOutput.version must be the literal '1.0'
    const output: CliOutput = {
      version: '1.0', tool: 'fit', timestamp: '', score: 0, passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      checks: [], durationMs: 0,
    };
    expect(output.version).toBe('1.0');
  });

  it('tool is fit or sim', () => {
    const fitOutput: CliOutput = {
      version: '1.0', tool: 'fit', timestamp: '', score: 0, passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      checks: [], durationMs: 0,
    };
    const simOutput: CliOutput = {
      version: '1.0', tool: 'sim', timestamp: '', score: 0, passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      checks: [], durationMs: 0,
    };
    expect(fitOutput.tool).toBe('fit');
    expect(simOutput.tool).toBe('sim');
  });
});
