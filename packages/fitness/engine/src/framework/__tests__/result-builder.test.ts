import { createSignal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { ResultBuilder, extractSnippet, getLineNumber, isAPIFile } from '../result-builder.js';

import type { Signal } from '@opensip-tools/core';

const sig = (overrides: Partial<Parameters<typeof createSignal>[0]> = {}): Signal =>
  createSignal({
    source: 'fitness',
    provider: 'opensip',
    severity: 'high',
    category: 'warning',
    ruleId: 'fit:test',
    message: 'something',
    code: { file: 'src/x.ts', line: 1 },
    ...overrides,
  });

describe('ResultBuilder', () => {
  it('builds an empty result with totalItems', () => {
    const result = ResultBuilder.create({ checkId: 'c1', itemType: 'files' })
      .totalItems(10)
      .build();
    expect(result.signals.length).toBe(0);
    expect(result.metadata.totalItems).toBe(10);
  });

  it('chains addSignal and addSignals', () => {
    const builder = ResultBuilder.create({ checkId: 'c1', itemType: 'files' });
    builder.addSignal(sig({ severity: 'high' }));
    builder.addSignals([sig({ severity: 'medium' }), sig({ severity: 'medium' })]);
    expect(builder.signalCount).toBe(3);
  });

  it('addSignals with empty array is a no-op', () => {
    const builder = ResultBuilder.create({ checkId: 'c1', itemType: 'files' });
    builder.addSignals([]);
    expect(builder.signalCount).toBe(0);
  });

  it('separates errors from warnings via signal severity', () => {
    const builder = ResultBuilder.create({ checkId: 'c1', itemType: 'files' });
    builder.addSignal(sig({ severity: 'high' }));
    builder.addSignal(sig({ severity: 'medium' }));
    expect(builder.errorCount).toBe(1);
    expect(builder.warningCount).toBe(1);
  });

  it('hasSignals reflects the signal collection', () => {
    const builder = ResultBuilder.create({ checkId: 'c1', itemType: 'files' });
    expect(builder.hasSignals).toBe(false);
    builder.addSignal(sig());
    expect(builder.hasSignals).toBe(true);
  });

  it('willPass is true when there are no errors', () => {
    const builder = ResultBuilder.create({ checkId: 'c1', itemType: 'files' });
    expect(builder.willPass).toBe(true);
    builder.addSignal(sig({ severity: 'medium' }));
    expect(builder.willPass).toBe(true); // warnings don't fail
    builder.addSignal(sig({ severity: 'high' }));
    expect(builder.willPass).toBe(false);
  });

  it('ignoredCount and incrementIgnored both update internal state', () => {
    const builder = ResultBuilder.create({ checkId: 'c1', itemType: 'files' });
    builder.ignoredCount(5);
    builder.incrementIgnored();
    builder.incrementIgnored(2);
    builder.totalItems(1);
    const built = builder.build();
    expect(built.ignoredCount).toBe(8);
  });

  it('duration is included on the built result', () => {
    const result = ResultBuilder.create({ checkId: 'c1', itemType: 'files' })
      .totalItems(1)
      .duration(123)
      .build();
    expect(result.metadata.durationMs).toBe(123);
  });

  it('filesScanned is included on the built result', () => {
    const result = ResultBuilder.create({ checkId: 'c1', itemType: 'files' })
      .totalItems(5)
      .filesScanned(3)
      .build();
    expect(result.metadata.filesScanned).toBe(3);
  });

  it('extra payload merges into the built result', () => {
    const result = ResultBuilder.create({ checkId: 'c1', itemType: 'files' })
      .totalItems(1)
      .extra({ foo: 'bar' })
      .extra({ baz: 1 })
      .build();
    expect(result.metadata.extra).toEqual({ foo: 'bar', baz: 1 });
  });

  it('buildError returns an error result with the given message', () => {
    const builder = ResultBuilder.create({ checkId: 'c1', itemType: 'files' });
    const out = builder.buildError('something exploded', new Error('boom'));
    expect(out.signals.length).toBe(0);
    expect(out.info.label).toMatch(/error|exploded/i);
  });

  it('clamps compliance to 0 when violations span more files than scanned', () => {
    const builder = ResultBuilder.create({ checkId: 'c1', itemType: 'files' });
    builder.totalItems(2);
    builder.addSignal(sig({ code: { file: 'a' } }));
    builder.addSignal(sig({ code: { file: 'b' } }));
    builder.addSignal(sig({ code: { file: 'c' } }));
    const result = builder.build();
    expect(result.metadata.totalItems).toBe(2);
    // No negative value should appear in info label
    expect(result.info.label).not.toContain('-');
  });

  it('builds violations-mode info when totalItems is 0', () => {
    const result = ResultBuilder.create({ checkId: 'c1', itemType: 'files' })
      .addSignal(sig({ severity: 'high' }))
      .build();
    expect(result.metadata.totalItems).toBe(0);
    expect(result.signals.length).toBe(1);
  });
});

describe('extractSnippet', () => {
  const content = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');

  it('extracts default 2 context lines around the target', () => {
    const out = extractSnippet(content, 3);
    expect(out.snippet).toContain('1 | line1');
    expect(out.snippet).toContain('5 | line5');
  });

  it('clamps to start of file', () => {
    const out = extractSnippet(content, 1);
    expect(out.snippet.split('\n')[0]).toBe('1 | line1');
  });

  it('clamps to end of file', () => {
    const out = extractSnippet(content, 5);
    expect(out.snippet).toContain('5 | line5');
  });

  it('honors a custom contextLines value', () => {
    const out = extractSnippet(content, 3, 0);
    expect(out.snippet).toBe('3 | line3');
  });
});

describe('getLineNumber', () => {
  it('returns the line number for a character index', () => {
    const text = 'line1\nline2\nline3';
    expect(getLineNumber(text, 0)).toBe(1);
    expect(getLineNumber(text, 6)).toBe(2);
    expect(getLineNumber(text, 12)).toBe(3);
  });

  it('returns 1 for negative indices', () => {
    expect(getLineNumber('abc', -5)).toBe(1);
  });
});

describe('isAPIFile', () => {
  it.each([
    ['src/api/users.ts', true],
    ['src/routes/foo.ts', true],
    ['src/users-handler.ts', true],
    ['src/users.handler.ts', true],
    ['src/lib/util.ts', false],
    ['src/components/Button.tsx', false],
  ])('isAPIFile(%s) === %s', (path, expected) => {
    expect(isAPIFile(path)).toBe(expected);
  });
});
