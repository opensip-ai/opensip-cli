import { createSignal, type GateCompareResult, type Signal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { renderGateCompareLines, renderGateSaveLines } from '../gate-render.js';

function sig(over: Partial<Parameters<typeof createSignal>[0]> = {}): Signal {
  return createSignal({
    source: 'examplescan',
    severity: 'high',
    ruleId: 'secret',
    message: 'A secret',
    code: { file: 'src/a.ts', line: 3 },
    ...over,
  });
}

function result(over: Partial<GateCompareResult> = {}): GateCompareResult {
  return { added: [], resolved: [], unchanged: [], degraded: false, ...over };
}

describe('renderGateSaveLines', () => {
  it('reports the tool + finding count', () => {
    expect(renderGateSaveLines('examplescan', 3)).toEqual([
      'examplescan: baseline saved (project SQLite store)',
      '  3 finding(s) recorded',
    ]);
  });
});

describe('renderGateCompareLines', () => {
  it('renders STABLE when there is no change', () => {
    const lines = renderGateCompareLines('examplescan', result({ unchanged: [sig()] }));
    expect(lines[0]).toBe('examplescan gate compare');
    expect(lines.at(-1)).toBe('✓ STABLE — no change');
    expect(lines.join('\n')).toContain('Unchanged (1):');
  });

  it('renders DEGRADED with the net-new finding + message when added is non-empty', () => {
    const added = sig({
      ruleId: 'aws-key',
      message: 'AWS Access Key',
      code: { file: 'p.env', line: 9 },
    });
    const lines = renderGateCompareLines('examplescan', result({ added: [added], degraded: true }));
    const text = lines.join('\n');
    expect(text).toContain('Added (1):');
    expect(text).toContain('aws-key');
    expect(text).toContain('p.env:9');
    expect(text).toContain('AWS Access Key');
    expect(lines.at(-1)).toBe('✗ DEGRADED — 1 new finding');
  });

  it('pluralizes the DEGRADED footer for multiple new findings', () => {
    const lines = renderGateCompareLines(
      'examplescan',
      result({ added: [sig({ ruleId: 'a' }), sig({ ruleId: 'b' })], degraded: true }),
    );
    expect(lines.at(-1)).toBe('✗ DEGRADED — 2 new findings');
  });

  it('renders IMPROVED when findings resolved and none added', () => {
    const lines = renderGateCompareLines(
      'examplescan',
      result({ resolved: [sig(), sig({ ruleId: 'b' })] }),
    );
    expect(lines.join('\n')).toContain('Resolved (2):');
    expect(lines.at(-1)).toBe('✓ IMPROVED — 2 findings resolved, none added');
  });

  it('samples the unchanged bucket to the first five with an overflow note', () => {
    const unchanged = Array.from({ length: 7 }, (_, i) =>
      sig({ ruleId: `r${i}`, code: { file: `f${i}.ts`, line: i } }),
    );
    const text = renderGateCompareLines('examplescan', result({ unchanged })).join('\n');
    expect(text).toContain('Unchanged (7):');
    expect(text).toContain('... and 2 more');
  });

  it('renders a no-location placeholder for a signal with no file', () => {
    const noFile = sig({ code: { file: '' } });
    const text = renderGateCompareLines(
      'examplescan',
      result({ added: [noFile], degraded: true }),
    ).join('\n');
    expect(text).toContain('(no location)');
  });

  it('orders same-rule findings by file then line, and truncates a long message', () => {
    const longMsg = 'x'.repeat(200);
    const added = [
      sig({ ruleId: 'dup', message: longMsg, code: { file: 'b.ts', line: 9 } }),
      sig({ ruleId: 'dup', message: longMsg, code: { file: 'a.ts', line: 2 } }),
      sig({ ruleId: 'dup', message: longMsg, code: { file: 'a.ts', line: 1 } }),
    ];
    const lines = renderGateCompareLines('examplescan', result({ added, degraded: true }));
    const locOrder = lines.filter((l) => l.includes('dup')).map((l) => l.split(/\s+/).at(-1));
    expect(locOrder).toEqual(['a.ts:1', 'a.ts:2', 'b.ts:9']);
    // The 200-char message is truncated with an ellipsis to <= 120 chars.
    const msgLine = lines.find((l) => l.trimStart().startsWith('x'));
    expect(msgLine?.trim().length).toBeLessThanOrEqual(120);
    expect(msgLine).toContain('…');
  });
});
