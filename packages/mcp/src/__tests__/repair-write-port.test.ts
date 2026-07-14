import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliRepairWritePort, repairMutationChildEnv } from '../repair-write-port.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opensip-mcp-repair-port-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeChild(source: string): string {
  mkdirSync(root, { recursive: true });
  const file = join(root, 'child.cjs');
  writeFileSync(file, source);
  return file;
}

function port(entrypoint: string | undefined, timeoutMs = 5000): CliRepairWritePort {
  return new CliRepairWritePort({
    projectRoot: root,
    cliEntrypoint: entrypoint,
    timeoutMs,
  });
}

describe('CliRepairWritePort', () => {
  it('forwards the complete profiling contract to nested mutation runs', () => {
    const savedGate = process.env.OPENSIP_PROFILING;
    const savedDirectory = process.env.OPENSIP_PROFILE_DIR;
    try {
      process.env.OPENSIP_PROFILING = 'true';
      process.env.OPENSIP_PROFILE_DIR = '/opt/opensip/profiles';

      expect(repairMutationChildEnv()).toMatchObject({
        OPENSIP_MCP_MUTATION_CHILD: '1',
        OPENSIP_PROFILING: 'true',
        OPENSIP_PROFILE_DIR: '/opt/opensip/profiles',
      });
    } finally {
      if (savedGate === undefined) delete process.env.OPENSIP_PROFILING;
      else process.env.OPENSIP_PROFILING = savedGate;
      if (savedDirectory === undefined) delete process.env.OPENSIP_PROFILE_DIR;
      else process.env.OPENSIP_PROFILE_DIR = savedDirectory;
    }
  });

  it('returns a structured error when no CLI entrypoint is available', async () => {
    const result = await port('').applyVerify({
      ref: 'session:0',
      tool: 'fit',
      signal: '0',
      action: 'fix',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'repair-entrypoint-unavailable',
        message: 'could not resolve the current OpenSIP CLI entrypoint for repair apply verify',
      },
    });
  });

  it('runs repair apply verify through a child CLI process and parses the CommandOutcome', async () => {
    const entrypoint = writeChild(`
      const args = process.argv.slice(2);
      process.stdout.write(JSON.stringify({
        data: {
          type: 'repair-apply-verify',
          status: args.includes('--force') ? 'applied' : 'previewed',
          args,
        }
      }));
    `);

    const result = await port(entrypoint).applyVerify({
      ref: 'session:0',
      tool: 'fit',
      signal: '1',
      action: 'fix-test',
      force: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        type: 'repair-apply-verify',
        status: 'applied',
      });
      expect((result.value as unknown as { args: readonly string[] }).args).toEqual([
        'repair',
        'apply',
        'session:0',
        '--tool',
        'fit',
        '--signal',
        '1',
        '--action',
        'fix-test',
        '--verify',
        '--json',
        '--force',
      ]);
    }
  });

  it('returns invalid-output errors with bounded stderr context', async () => {
    const entrypoint = writeChild(`
      process.stderr.write('child failure detail');
      process.stdout.write('not json');
    `);

    const result = await port(entrypoint).applyVerify({
      ref: 'session:0',
      tool: 'fit',
      signal: '1',
      action: 'fix-test',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'repair-output-invalid',
        message: 'repair apply verify output was not JSON; stderr: child failure detail',
      },
    });
  });

  it('returns invalid-output errors when JSON lacks a repair result', async () => {
    const entrypoint = writeChild(
      `process.stdout.write(JSON.stringify({ data: { type: 'other' } }));`,
    );

    const result = await port(entrypoint).applyVerify({
      ref: 'session:0',
      tool: 'fit',
      signal: '1',
      action: 'fix-test',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'repair-output-invalid',
        message: 'repair apply verify output did not include a repair-apply-verify result',
      },
    });
  });

  it('times out long-running repair children', async () => {
    const entrypoint = writeChild(`setTimeout(() => {}, 10_000);`);

    const result = await port(entrypoint, 10).applyVerify({
      ref: 'session:0',
      tool: 'fit',
      signal: '1',
      action: 'fix-test',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'repair-timeout',
        message: 'repair apply verify timed out',
      },
    });
  });

  it('bounds child output capture', async () => {
    const entrypoint = writeChild(`process.stdout.write('x'.repeat(6 * 1024 * 1024));`);

    const result = await port(entrypoint).applyVerify({
      ref: 'session:0',
      tool: 'fit',
      signal: '1',
      action: 'fix-test',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'repair-output-too-large',
        message: 'repair output exceeded capture limit',
      },
    });
  });
});
