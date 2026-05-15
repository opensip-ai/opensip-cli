import { describe, expect, it } from 'vitest';

import { executeCommand } from '../command-executor.js';

import type { CommandConfig } from '../check-config.js';

const cwd = process.cwd();

describe('executeCommand', () => {
  it('runs a command with array args and parses stdout', async () => {
    const config: CommandConfig = {
      bin: 'echo',
      args: ['hello'],
      parseOutput: (stdout) => [{
        line: 1,
        message: stdout.trim(),
        severity: 'warning',
      }],
    };
    const result = await executeCommand(config, [], { cwd });
    expect(result.aborted).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toBe('hello');
  });

  it('runs a command with function args derived from files', async () => {
    const config: CommandConfig = {
      bin: 'echo',
      args: (files) => [`got-${files.length}`],
      parseOutput: (stdout) => [{
        line: 1,
        message: stdout.trim(),
        severity: 'warning',
      }],
    };
    const result = await executeCommand(config, ['a', 'b', 'c'], { cwd });
    expect(result.violations[0]?.message).toBe('got-3');
  });

  it('returns an error when the bin is not installed (ENOENT)', async () => {
    const config: CommandConfig = {
      bin: 'definitely-not-a-real-binary-xyz123',
      args: [],
      parseOutput: () => [],
    };
    const result = await executeCommand(config, [], { cwd });
    expect(result.error).toContain('not installed');
    expect(result.violations).toEqual([]);
  });

  it('returns an error when exit code is unexpected', async () => {
    const config: CommandConfig = {
      bin: 'sh',
      args: ['-c', 'exit 5'],
      parseOutput: () => [],
      expectedExitCodes: [0],
    };
    const result = await executeCommand(config, [], { cwd });
    expect(result.error).toContain('unexpected code 5');
    expect(result.violations).toEqual([]);
  });

  it('honors expectedExitCodes when set', async () => {
    const config: CommandConfig = {
      bin: 'sh',
      args: ['-c', 'echo done; exit 1'],
      parseOutput: (stdout) => [{
        line: 1,
        message: stdout.trim(),
        severity: 'warning',
      }],
      expectedExitCodes: [0, 1],
    };
    const result = await executeCommand(config, [], { cwd });
    expect(result.violations).toHaveLength(1);
    expect(result.exitCode).toBe(1);
  });
});
