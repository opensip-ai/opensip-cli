/**
 * Unit tests for `runSarifExportMode` (the `sarif-export` subcommand
 * helper, DEC-498). Drives the helper directly with synthetic signals —
 * the subcommand-wiring is covered by the command-list drift tests in
 * `tool.test.ts` / `tool-register.test.ts`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSarifExportMode } from '../../cli/sarif-export.js';

import type { Signal, ToolCliContext } from '@opensip-tools/core';

function makeSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: 'sig_orphan',
    source: 'graph',
    provider: 'opensip-tools',
    severity: 'medium',
    category: 'quality',
    ruleId: 'graph:orphan-subtree',
    message: "Function 'processOrder' appears unreachable from any entry point.",
    filePath: 'src/order/process.ts',
    line: 42,
    column: undefined,
    code: { file: 'src/order/process.ts', line: 42, column: undefined },
    metadata: {},
    createdAt: '2026-05-27T00:00:00.000Z',
    ...over,
  };
}

function makeCli(): { cli: ToolCliContext; setExitCode: ReturnType<typeof vi.fn> } {
  const setExitCode = vi.fn();
  const cli = { setExitCode } as unknown as ToolCliContext;
  return { cli, setExitCode };
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sarif-export-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('runSarifExportMode', () => {
  it('writes OpenSIP-convention SARIF v2.1.0 to the output path and sets exit 0', () => {
    const outPath = join(workDir, 'out.sarif');
    const { cli, setExitCode } = makeCli();

    runSarifExportMode(
      { outputSarif: outPath, tenantId: 't1', repoId: 'r1', runId: 'run-1' },
      [makeSignal()],
      cli,
    );

    expect(existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as {
      version: string;
      runs: { tool: { driver: { name: string } }; results: { ruleId: string }[] }[];
    };
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs[0]?.tool.driver.name).toBe('opensip-tools-graph');
    expect(parsed.runs[0]?.results[0]?.ruleId).toBe('graph.dead-code.orphan-subtree');
    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it('creates the parent directory when the output path is nested', () => {
    const outPath = join(workDir, 'nested', 'deep', 'out.sarif');
    const { cli } = makeCli();

    runSarifExportMode(
      { outputSarif: outPath, tenantId: 't1', repoId: 'r1' },
      [makeSignal()],
      cli,
    );

    expect(existsSync(outPath)).toBe(true);
  });

  it('writes a valid SARIF document with zero results for an empty signal set', () => {
    const outPath = join(workDir, 'empty.sarif');
    const { cli, setExitCode } = makeCli();

    runSarifExportMode(
      { outputSarif: outPath, tenantId: 't1', repoId: 'r1' },
      [],
      cli,
    );

    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as {
      version: string;
      runs: { results: unknown[] }[];
    };
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs[0]?.results).toHaveLength(0);
    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it('throws ConfigurationError (and writes nothing) when --tenant-id is missing', () => {
    const outPath = join(workDir, 'no-tenant.sarif');
    const { cli, setExitCode } = makeCli();

    expect(() =>
      runSarifExportMode({ outputSarif: outPath, repoId: 'r1' }, [makeSignal()], cli),
    ).toThrow(ConfigurationError);
    expect(existsSync(outPath)).toBe(false);
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('throws ConfigurationError when --repo-id is missing', () => {
    const outPath = join(workDir, 'no-repo.sarif');
    const { cli } = makeCli();

    expect(() =>
      runSarifExportMode({ outputSarif: outPath, tenantId: 't1' }, [makeSignal()], cli),
    ).toThrow(ConfigurationError);
    expect(existsSync(outPath)).toBe(false);
  });
});
