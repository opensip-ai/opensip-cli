import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RunScope,
  createSignal,
  runWithScope,
  runWithScopeSync,
  type TargetResolver,
  type ToolCliContext,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { executeYagni } from '../cli/execute-yagni.js';
import { YagniConfigSchema } from '../cli/yagni-config-schema.js';
import { duplicateBodyCandidateDetector } from '../detectors/duplicate-body-candidate.js';
import { buildTsInventory } from '../lib/build-ts-inventory.js';

import type { YagniDetector } from '../detectors/types.js';
function stubCli(): ToolCliContext {
  return {
    scope: { datastore: () => undefined },
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
}

function targetResolver(entrypoints: readonly string[]): TargetResolver {
  return {
    getByName: () => undefined,
    getAll: () => [
      {
        config: {
          name: 'app',
          description: 'Application',
          include: ['src/**/*.ts'],
          exclude: [],
          conventions: { entrypoints },
        },
      },
    ],
    getByTag: () => [],
    has: () => false,
    resolveTargets: () => [],
    applyGlobalExcludes: (files) => files,
    globalExcludes: [],
  };
}

describe('yagni hardening (H1–H4)', () => {
  it('rejects unknown keys in the strict yagni config block (H1)', () => {
    expect(YagniConfigSchema.safeParse({ graphMode: 'build' }).success).toBe(false);
  });

  it('emits project-relative paths under the project root (H2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yagni-hardening-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(
        join(dir, 'src', 'sample.ts'),
        `export function secretFn() { return 'SECRET_TOKEN_abc123'; }\n`,
      );
      const scope = new RunScope();
      const candidates = runWithScopeSync(scope, () => buildTsInventory(dir));
      for (const c of candidates) {
        expect(c.filePath.startsWith('../')).toBe(false);
        expect(c.filePath.includes('..')).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never surfaces raw body source in logger events or signals (H4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yagni-secret-'));
    const secret = 'SECRET_TOKEN_abc123';
    const info = vi.fn();
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(
        join(dir, 'src', 'secret.ts'),
        `export function leak() { return '${secret}'; }\n`,
      );
      const scope = new RunScope({
        logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
      });
      const result = await runWithScope(scope, () =>
        duplicateBodyCandidateDetector.run({
          cwd: dir,
          config: {},
          graphCatalog: null,
          includeTests: true,
        }),
      );
      const logText = JSON.stringify(info.mock.calls);
      const signalText = JSON.stringify(result.signals);
      expect(logText).not.toContain(secret);
      expect(signalText).not.toContain(secret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors documented @yagni-ignore-next-line directives', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yagni-ignore-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(
        join(dir, 'src', 'sample.ts'),
        [
          '// @yagni-ignore-next-line duplicate-body-candidate -- fixture documents an intentional duplicate shape',
          'export function mirrored(): number { return 1; }',
        ].join('\n'),
      );
      const detector: YagniDetector = {
        id: 'duplicate-body-candidate',
        slug: 'yagni:duplicate-body-candidate',
        description: 'test detector',
        run: () =>
          Promise.resolve({
            durationMs: 0,
            signals: [
              createSignal({
                source: 'yagni:duplicate-body-candidate',
                provider: 'yagni',
                ruleId: 'yagni:duplicate-body-candidate',
                severity: 'medium',
                category: 'quality',
                message: 'duplicate',
                code: { file: 'src/sample.ts', line: 2, column: 0 },
              }),
            ],
          }),
      };

      const outcome = await executeYagni(
        { cwd: dir, config: { defaultMinConfidence: 'low' } },
        stubCli(),
        [detector],
      );

      expect(outcome.envelope.signals).toHaveLength(0);
      expect(outcome.envelope.units[0]).toMatchObject({
        slug: 'yagni:duplicate-body-candidate',
        violationCount: 0,
        ignoredCount: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lowers convention-owned candidate confidence before min-confidence filtering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yagni-conventions-'));
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true });
      mkdirSync(join(dir, 'src/lib'), { recursive: true });
      writeFileSync(join(dir, 'src/routes/page.ts'), 'export function routeOnly() {}\n');
      writeFileSync(join(dir, 'src/lib/helper.ts'), 'export function helper() {}\n');

      const detector: YagniDetector = {
        id: 'fixture-detector',
        slug: 'yagni:fixture-detector',
        description: 'test detector',
        run: () =>
          Promise.resolve({
            durationMs: 0,
            signals: [
              yagniSignal('src/routes/page.ts', 'route candidate'),
              yagniSignal('src/lib/helper.ts', 'helper candidate'),
            ],
          }),
      };
      const scope = new RunScope();
      Object.assign(scope, { targets: targetResolver(['src/routes/**']) });

      const outcome = await runWithScope(scope, () =>
        executeYagni({ cwd: dir, minConfidence: 'high' }, stubCli(), [detector]),
      );

      expect(outcome.envelope.signals.map((signal) => signal.message)).toEqual([
        'helper candidate',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function yagniSignal(filePath: string, message: string) {
  return createSignal({
    source: 'yagni:fixture-detector',
    provider: 'yagni',
    ruleId: 'yagni:fixture-detector',
    severity: 'medium',
    category: 'quality',
    message,
    code: { file: filePath, line: 1, column: 0 },
    metadata: {
      yagni: {
        detector: 'fixture-detector',
        reductionCategory: 'delete',
        confidence: 'high',
        preservationArgument: 'test fixture',
        validationRequired: [],
        riskTags: [],
        evidence: [],
      },
    },
  });
}
