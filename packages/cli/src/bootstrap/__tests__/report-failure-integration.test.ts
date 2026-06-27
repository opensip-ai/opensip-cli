/**
 * report-failure-integration — proves createReportFailure writes structured JSONL
 * through the scope-backed logger and fans out to render / emitError.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LoggerImpl, RunScope, runWithScope } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { buildToolCliContext, createLiveViewRegistry } from '../../cli-context.js';

function todayLogName(): string {
  // LoggerImpl.initLogFile partitions the daily file by the UTC calendar date
  // (`new Date().toISOString().slice(0, 10)`). Mirror that exactly — building
  // the name from the LOCAL date makes this test fail whenever the local and
  // UTC dates differ (e.g. afternoon/evening in the Americas).
  return `${new Date().toISOString().slice(0, 10)}.jsonl`;
}

describe('reportFailure integration', () => {
  it('writes tool.command.failed to the scope logger log file and renders human errors', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'report-failure-log-'));
    const scopeLogger = new LoggerImpl({
      level: 'debug',
      logDir,
      runId: 'run-integration-1',
    });
    const render = vi.fn(() => Promise.resolve());
    const scope = new RunScope({
      logger: scopeLogger,
      runId: 'run-integration-1',
    });

    await runWithScope(scope, async () => {
      const { ctx } = buildToolCliContext({
        render,
        liveViews: createLiveViewRegistry(),
        maybeOpenReport: vi.fn(() => Promise.resolve()),
        logger: scopeLogger,
      });
      await ctx.reportFailure({
        message: 'integration failure',
        exitCode: 3,
        code: 'TEST.FAIL',
      });
      expect(ctx.logger).toBe(scopeLogger);
    });

    const logPath = join(logDir, todayLogName());
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines.at(-1) ?? '{}') as {
      evt?: string;
      runId?: string;
      exitCode?: number;
      message?: string;
    };
    expect(entry.evt).toBe('tool.command.failed');
    expect(entry.runId).toBe('run-integration-1');
    expect(entry.exitCode).toBe(3);
    expect(entry.message).toBe('integration failure');
    expect(render).toHaveBeenCalledWith({
      type: 'error',
      message: 'integration failure',
      exitCode: 3,
    });
  });

  it('routes jsonRequested failures through emitError instead of render', async () => {
    const scopeLogger = new LoggerImpl({ level: 'debug' });
    const render = vi.fn(() => Promise.resolve());
    const scope = new RunScope({ logger: scopeLogger });

    await runWithScope(scope, async () => {
      const { ctx } = buildToolCliContext({
        render,
        liveViews: createLiveViewRegistry(),
        maybeOpenReport: vi.fn(() => Promise.resolve()),
        logger: scopeLogger,
      });
      let stdout = '';
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        stdout += typeof chunk === 'string' ? chunk : String(chunk);
        return true;
      });
      try {
        await ctx.reportFailure({
          message: 'json failure',
          exitCode: 3,
          code: 'TEST.JSON',
          jsonRequested: true,
        });
      } finally {
        spy.mockRestore();
      }
      expect(render).not.toHaveBeenCalled();
      const outcome = JSON.parse(stdout) as {
        status?: string;
        exitCode?: number;
      };
      expect(outcome.status).toBe('error');
      expect(outcome.exitCode).toBe(3);
    });
  });
});
