import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  collectDeclaredInputs,
  collectDeclaredInputsForTool,
  stampDeclaredInputs,
} from '../declared-inputs.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

function envelope(): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'fit',
    runId: 'run-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    verdict: {
      score: 100,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals: [],
    baselineIdentity: {
      fingerprintStrategyId: 'rule-file-line-col',
      fingerprintStrategyVersion: 1,
    },
  };
}

describe('declared inputs', () => {
  it('collects runtime/package-manager facts from an explicit allowlist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-declared-inputs-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'fixture', packageManager: 'pnpm@11.0.0' }),
      );
      const now = vi.spyOn(Date, 'now');
      const manifest = collectDeclaredInputsForTool('fit', {
        cwd: dir,
        cliVersion: '0.1.16',
        nodeVersion: '24.0.0',
        platform: 'test/arch',
        env: { npm_config_user_agent: 'npm/10 secret-token/should-not-appear' },
      });

      expect(manifest).toEqual({
        cliVersion: '0.1.16',
        nodeVersion: '24.0.0',
        packageManager: 'pnpm@11.0.0',
        platform: 'test/arch',
        tool: 'fit',
        engineVersion: undefined,
      });
      expect(now).not.toHaveBeenCalled();
      now.mockRestore();
      const serialized = JSON.stringify(manifest);
      expect(serialized).not.toContain(dir);
      expect(serialized).not.toContain('secret-token');
      expect(serialized).not.toContain('OPENSIP_API_KEY');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to npm_config_user_agent without enumerating process.env', () => {
    const manifest = collectDeclaredInputsForTool('graph', {
      cwd: '/definitely/missing',
      cliVersion: '0.1.16',
      nodeVersion: '24.0.0',
      platform: 'test/arch',
      env: { npm_config_user_agent: 'pnpm/11.2.3 npm/? node/v24' },
    });
    expect(manifest.packageManager).toBe('pnpm@11.2.3');
  });

  it('attaches baseline identity when collecting from an envelope', () => {
    expect(collectDeclaredInputs(envelope(), { cliVersion: '0.1.16' }).baselineIdentity).toEqual(
      envelope().baselineIdentity,
    );
  });

  it('stamps envelopes additively and preserves an existing manifest', () => {
    const stamped = stampDeclaredInputs(envelope(), {
      cliVersion: '0.1.16',
      nodeVersion: '24.0.0',
      platform: 'test/arch',
      packageManager: 'pnpm@11',
    });
    expect(stamped.declaredInputs).toEqual(
      expect.objectContaining({
        cliVersion: '0.1.16',
        nodeVersion: '24.0.0',
        platform: 'test/arch',
        tool: 'fit',
      }),
    );

    const existing = {
      ...envelope(),
      declaredInputs: {
        cliVersion: 'existing',
        nodeVersion: 'existing',
        platform: 'existing',
        tool: 'fit',
      },
    } satisfies SignalEnvelope;
    expect(stampDeclaredInputs(existing).declaredInputs).toBe(existing.declaredInputs);
  });
});
