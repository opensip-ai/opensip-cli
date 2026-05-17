/**
 * Tests for the table renderer.
 */

import { createSignal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { renderTable } from '../../render/table.js';

import type { Signal } from '@opensip-tools/core';

function sig(over: { ruleId: string; message: string; filePath: string; line?: number }): Signal {
  return createSignal({
    source: 'graph',
    severity: 'low',
    category: 'quality',
    ruleId: over.ruleId,
    message: over.message,
    code: { file: over.filePath, line: over.line, column: 0 },
  });
}

const ctx = { cwd: '/tmp', tool: 'graph' as const, command: 'graph' };

describe('renderTable', () => {
  it('emits the empty-findings sentinel when there are no signals', () => {
    expect(renderTable([], ctx)).toBe('graph: no findings.\n');
  });

  it('emits a header line with finding count', () => {
    const signals = [sig({ ruleId: 'r', message: 'm', filePath: 'src/a.ts', line: 1 })];
    expect(renderTable(signals, ctx)).toContain('graph: 1 finding(s).');
  });

  it('groups signals by ruleId in sorted order', () => {
    const signals = [
      sig({ ruleId: 'graph:zzz', message: 'z', filePath: 'src/z.ts', line: 1 }),
      sig({ ruleId: 'graph:aaa', message: 'a', filePath: 'src/a.ts', line: 1 }),
    ];
    const out = renderTable(signals, ctx);
    const aaaIdx = out.indexOf('[graph:aaa]');
    const zzzIdx = out.indexOf('[graph:zzz]');
    expect(aaaIdx).toBeGreaterThan(-1);
    expect(zzzIdx).toBeGreaterThan(-1);
    expect(aaaIdx).toBeLessThan(zzzIdx);
  });

  it('renders file:line — message lines with a leading colon when line is present', () => {
    const signals = [sig({ ruleId: 'r', message: 'foo', filePath: 'src/a.ts', line: 7 })];
    const out = renderTable(signals, ctx);
    expect(out).toContain('src/a.ts:7 — foo');
  });

  it('omits the colon-line when line is missing', () => {
    const signals = [sig({ ruleId: 'r', message: 'foo', filePath: 'src/a.ts' })];
    const out = renderTable(signals, ctx);
    expect(out).toContain('src/a.ts — foo');
    expect(out).not.toContain('src/a.ts:undefined');
  });
});
