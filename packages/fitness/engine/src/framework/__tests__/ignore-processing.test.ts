/**
 * @fileoverview Tests for filterSignalsByDirectives and buildFilteredResult.
 *
 * Covers the two main entrypoints the engine uses to suppress signals
 * via `@fitness-ignore-file` and `@fitness-ignore-next-line`. Also
 * covers the anti-recursion guard (signals pointing AT a directive
 * line are never suppressed, otherwise directive-auditing checks would
 * silently hide their own findings).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createSignal } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fileCache } from '../file-cache.js';
import { buildFilteredResult, filterSignalsByDirectives } from '../ignore-processing.js';

import type { CheckResult } from '../../types/findings.js';
import type { Signal } from '@opensip-tools/core';

let testDir: string;

function fixture(rel: string, content: string): string {
  const abs = join(testDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function mkSignal(file: string, line: number, message = 'finding'): Signal {
  return createSignal({
    source: 'fitness',
    provider: 'opensip',
    severity: 'high',
    category: 'quality',
    ruleId: 'fit:no-foo',
    message,
    code: { file, line, column: 1 },
  });
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-ignore-proc-'));
});

afterEach(() => {
  fileCache.clear();
  rmSync(testDir, { recursive: true, force: true });
});

describe('filterSignalsByDirectives — file-level ignore', () => {
  it('suppresses every signal in a file marked `@fitness-ignore-file <slug>`', async () => {
    const file = fixture(
      'src/a.ts',
      '// @fitness-ignore-file no-foo -- justified\nconst x = "FOO";\nconst y = "FOO";',
    );
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const signals = [mkSignal(file, 2), mkSignal(file, 3)];
    const out = await filterSignalsByDirectives(signals, 'no-foo', 0);
    expect(out.filteredSignals).toEqual([]);
    expect(out.ignoredCount).toBe(2);
    expect(out.appliedDirectives).toHaveLength(1);
    expect(out.appliedDirectives[0]?.type).toBe('file');
    expect(out.appliedDirectives[0]?.checkId).toBe('no-foo');
  });

  it('does not suppress signals when the file ignore targets a different check', async () => {
    const file = fixture('src/a.ts', '// @fitness-ignore-file other-check\nconst x = "FOO";');
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const signals = [mkSignal(file, 2)];
    const out = await filterSignalsByDirectives(signals, 'no-foo', 0);
    expect(out.filteredSignals).toHaveLength(1);
    expect(out.ignoredCount).toBe(0);
  });
});

describe('filterSignalsByDirectives — line-level ignore', () => {
  it('suppresses a signal on the line immediately following a `@fitness-ignore-next-line` directive', async () => {
    const file = fixture(
      'src/a.ts',
      [
        'const a = 1',
        '// @fitness-ignore-next-line no-foo -- justified',
        'const x = "FOO"', // line 3 — suppressed
        'const y = "FOO"', // line 4 — not suppressed
      ].join('\n'),
    );
    await fileCache.prewarm(testDir, ['**/*.ts']);

    const signals = [mkSignal(file, 3), mkSignal(file, 4)];
    const out = await filterSignalsByDirectives(signals, 'no-foo', 0);
    expect(out.filteredSignals).toHaveLength(1);
    expect(out.filteredSignals[0]?.code?.line).toBe(4);
    expect(out.ignoredCount).toBe(1);
    expect(out.appliedDirectives).toHaveLength(1);
    expect(out.appliedDirectives[0]?.type).toBe('next-line');
  });

  it('never suppresses a signal pointing at a directive line itself (anti-recursion)', async () => {
    const file = fixture(
      'src/a.ts',
      ['// @fitness-ignore-next-line no-foo -- bad', 'const x = "FOO"'].join('\n'),
    );
    await fileCache.prewarm(testDir, ['**/*.ts']);

    // A directive-auditing check pointing at the directive line (1) MUST
    // pass through, otherwise its own findings would silently disappear.
    const signals = [mkSignal(file, 1, 'directive findings')];
    const out = await filterSignalsByDirectives(signals, 'no-foo', 0);
    expect(out.filteredSignals).toHaveLength(1);
    expect(out.ignoredCount).toBe(0);
  });
});

describe('filterSignalsByDirectives — edge cases', () => {
  it('ignores signals without a filePath', async () => {
    const signals = [
      createSignal({
        source: 'fitness',
        provider: 'opensip',
        severity: 'high',
        category: 'quality',
        ruleId: 'fit:no-foo',
        message: 'no-file',
        code: { line: 1, column: 1, file: '' },
      }),
    ];
    const out = await filterSignalsByDirectives(signals, 'no-foo', 0);
    // Empty file path makes uniqueFiles set skip it; signal is kept as-is
    expect(out.filteredSignals).toHaveLength(1);
  });

  it('preserves the initialIgnoredCount when no signals are filtered', async () => {
    const out = await filterSignalsByDirectives([], 'no-foo', 5);
    expect(out.ignoredCount).toBe(5);
    expect(out.filteredSignals).toEqual([]);
  });

  it('handles a signal pointing at a non-existent file gracefully', async () => {
    const signals = [mkSignal('/does/not/exist.ts', 1)];
    const out = await filterSignalsByDirectives(signals, 'no-foo', 0);
    expect(out.filteredSignals).toHaveLength(1);
    expect(out.ignoredCount).toBe(0);
  });
});

function mkResult(signals: readonly Signal[]): CheckResult {
  return {
    passed: signals.every((s) => s.severity !== 'high'),
    errors: signals.filter((s) => s.severity === 'high').length,
    warnings: signals.filter((s) => s.severity !== 'high').length,
    signals: [...signals],
    info: { label: 'test result' },
    metadata: {
      durationMs: 100,
      totalItems: 0,
      filesScanned: 0,
      itemType: 'files',
      signals: [...signals],
    },
  };
}

describe('buildFilteredResult', () => {
  it('returns the original result when filteredSignals is not an array', () => {
    const result = mkResult([]);
    // @ts-expect-error — exercising the runtime guard
    const out = buildFilteredResult(result, undefined, 0, Date.now());
    expect(out).toBe(result);
  });

  it('recomputes errors / warnings / passed from filtered signals', () => {
    const file = '/virtual/a.ts';
    const errSig = mkSignal(file, 1);
    const warnSig = createSignal({
      source: 'fitness',
      provider: 'opensip',
      severity: 'medium',
      category: 'quality',
      ruleId: 'fit:warn',
      message: 'w',
      code: { file, line: 2, column: 1 },
    });

    const original = mkResult([errSig, warnSig]);
    const out = buildFilteredResult(original, [warnSig], 1, Date.now() - 10);
    expect(out.errors).toBe(0);
    expect(out.warnings).toBe(1);
    expect(out.passed).toBe(true);
    expect(out.signals).toHaveLength(1);
    expect(out.ignoredCount).toBe(1);
  });

  it('omits ignoredCount when zero', () => {
    const file = '/virtual/a.ts';
    const sig = mkSignal(file, 1);
    const out = buildFilteredResult(mkResult([sig]), [sig], 0, Date.now());
    expect(out.ignoredCount).toBeUndefined();
  });

  it('uses metadata.durationMs when available', () => {
    const result = mkResult([]);
    const out = buildFilteredResult(result, [], 0, Date.now());
    expect(out.metadata.durationMs).toBe(100);
  });
});
