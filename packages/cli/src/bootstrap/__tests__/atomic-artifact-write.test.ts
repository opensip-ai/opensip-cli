import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunScope, runWithScopeSync } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeArtifactAtomically } from '../atomic-artifact-write.js';

import type { Logger } from '@opensip-cli/core';

const POLICY = { waitMs: 500, staleMs: 10_000, heartbeatMs: 20 };

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('writeArtifactAtomically', () => {
  let dir = '';

  afterEach(() => {
    if (dir.length > 0) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('creates parent directories before acquiring the per-target lock', () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-write-'));
    const target = join(dir, 'nested', 'reports', 'out.sarif');

    writeArtifactAtomically(target, '{"ok":true}\n', {
      policy: POLICY,
      logger: makeLogger(),
      command: 'test',
      cwdBasename: 'repo',
    });

    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}\n');
    expect(existsSync(`${target}.artifact.lock`)).toBe(false);
  });

  it('emits a `persist` diagnostics event on success (parity with the lock/baseline bridges)', () => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-write-'));
    const target = join(dir, 'out.sarif');
    const scope = new RunScope({ logger: makeLogger(), runId: 'r-artifact-1' });

    runWithScopeSync(scope, () => {
      writeArtifactAtomically(target, '{"ok":true}\n', {
        policy: POLICY,
        logger: makeLogger(),
        command: 'test',
        cwdBasename: 'repo',
      });
    });

    const persist = scope.diagnostics
      .snapshot()
      .events.find((e) => e.message === 'state.artifact.write.complete');
    expect(persist).toBeDefined();
    expect(persist?.phase).toBe('persist');
  });
});
