import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunScope, createSignal, runWithScope } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeYagni } from '../execute-yagni.js';

import type { YagniDetector } from '../../detectors/types.js';

let tempDir: string | undefined;

function fixtureDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'opensip-yagni-execute-'));
  writeFileSync(join(tempDir, 'subject.ts'), 'export const subject = true;\n', 'utf8');
  return tempDir;
}

function warningDetector(): YagniDetector {
  return {
    id: 'warning-detector',
    slug: 'yagni:warning-detector',
    description: 'fixture warning detector',
    run: () =>
      Promise.resolve({
        durationMs: 1,
        signals: [
          createSignal({
            source: 'yagni:warning-detector',
            provider: 'yagni',
            severity: 'medium',
            category: 'architecture',
            ruleId: 'yagni:warning-detector',
            message: 'warning policy should fail this run',
            code: { file: 'subject.ts', line: 1, column: 1 },
          }),
        ],
      }),
  };
}

function cleanDetector(): YagniDetector {
  return {
    id: 'clean-detector',
    slug: 'yagni:clean-detector',
    description: 'fixture clean detector',
    run: () => Promise.resolve({ durationMs: 1, signals: [] }),
  };
}

afterEach(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('executeYagni', () => {
  it('persists a failing verdict when warning policy fails the run', async () => {
    const result = await executeYagni(
      {
        cwd: fixtureDir(),
        config: { failOnErrors: 0, failOnWarnings: 1 },
      },
      [warningDetector()],
    );

    expect(result.envelope.verdict.passed).toBe(false);
    expect(result.session.passed).toBe(false);
  });

  it('persists a passing verdict for a clean run', async () => {
    const result = await executeYagni(
      {
        cwd: fixtureDir(),
        config: { failOnErrors: 0, failOnWarnings: 1 },
      },
      [cleanDetector()],
    );

    expect(result.envelope.verdict.passed).toBe(true);
    expect(result.session.passed).toBe(true);
  });

  it('rejects an unknown explicit detector instead of reporting an empty pass', async () => {
    await expect(
      executeYagni(
        {
          cwd: fixtureDir(),
          detectors: ['ghost-detector'],
        },
        [cleanDetector()],
      ),
    ).rejects.toMatchObject({
      code: 'YAGNI.DETECTOR.NOT_FOUND',
      message: "Unknown YAGNI detector 'ghost-detector'.",
    });
  });

  it('contains a detector crash as a redacted fault and continues', async () => {
    const result = await executeYagni({ cwd: fixtureDir() }, [
      {
        id: 'broken-detector',
        slug: 'yagni:broken-detector',
        description: 'fixture broken detector',
        run: () => Promise.reject(new Error('/private/repo: detector exploded')),
      },
      cleanDetector(),
    ]);

    expect(result.envelope.verdict.faulted).toBe(true);
    expect(result.envelope.units).toHaveLength(2);
    expect(result.envelope.units[0]).toMatchObject({
      slug: 'yagni:broken-detector',
      passed: false,
      error: 'The operation failed.',
    });
    expect(result.envelope.units[0]?.error).not.toContain('/private/repo');
    expect(result.envelope.units[1]?.slug).toBe('yagni:clean-detector');
  });

  it('propagates host cancellation instead of recording a detector fault', async () => {
    const controller = new AbortController();
    const scope = new RunScope({ abortSignal: controller.signal });
    const detector: YagniDetector = {
      id: 'cancelled-detector',
      slug: 'yagni:cancelled-detector',
      description: 'fixture cancelled detector',
      run: () => {
        controller.abort();
        return new Promise(() => undefined);
      },
    };

    try {
      await expect(
        runWithScope(scope, () => executeYagni({ cwd: fixtureDir() }, [detector])),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      scope.dispose();
    }
  });

  it('settles live rows for detectors excluded by an explicit filter', async () => {
    const onDetectorsSkipped = vi.fn();

    await executeYagni(
      {
        cwd: fixtureDir(),
        detectors: ['warning-detector'],
        onDetectorsSkipped,
      },
      [warningDetector(), cleanDetector()],
    );

    expect(onDetectorsSkipped).toHaveBeenCalledWith(['yagni:clean-detector']);
  });
});
