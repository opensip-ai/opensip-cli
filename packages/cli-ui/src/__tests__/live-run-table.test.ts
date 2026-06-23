import { describe, expect, it } from 'vitest';

import { liveRunTable } from '../live-run-table.js';
import { renderToText } from '../render-to-text.js';

describe('liveRunTable', () => {
  it('returns null for an empty row list', () => {
    expect(liveRunTable([])).toBeNull();
  });

  it('renders status, counts, and duration columns', () => {
    const node = liveRunTable([
      {
        unit: 'my-check',
        status: 'PASS',
        errors: 0,
        warnings: 1,
        durationMs: 1200,
      },
    ]);
    expect(node).not.toBeNull();
    const text = renderToText(node!);
    expect(text).toContain('my-check');
    expect(text).toContain('PASS');
    expect(text).toContain('1.2s');
  });

  it('renders the lean five-column graph table when no validated counts are present', () => {
    const node = liveRunTable([
      {
        unit: 'graph.architecture.cycle',
        status: 'FAIL',
        errors: 1,
        warnings: 0,
        durationMs: 0,
      },
    ]);
    const text = renderToText(node!);
    expect(text).toContain('Unit');
    expect(text).toContain('Duration');
    expect(text).not.toContain('Validated');
    expect(text).not.toContain('Ignores');
  });

  it('renders validated and ignores columns for fitness-shaped rows', () => {
    const node = liveRunTable([
      {
        unit: 'dead-code',
        status: 'FAIL',
        errors: 1,
        warnings: 0,
        durationMs: 50,
        validated: 4,
        ignored: 0,
        itemType: 'files',
      },
    ]);
    const text = renderToText(node!);
    expect(text).toContain('Validated');
    expect(text).toContain('Ignores');
    expect(text).toContain('4 files');
  });

  it('classifies ignore and duration thresholds while rendering fitness rows', () => {
    const node = liveRunTable([
      {
        unit: 'moderate-ignore-rate',
        status: 'ERROR',
        errors: 0,
        warnings: 0,
        durationMs: 35_000,
        validated: 100,
        ignored: 6,
        itemType: 'files',
      },
      {
        unit: 'high-ignore-rate',
        status: 'PASS',
        errors: 0,
        warnings: 0,
        durationMs: 65_000,
        validated: 100,
        ignored: 11,
        itemType: 'files',
      },
    ]);
    const text = renderToText(node!);
    expect(text).toContain('moderate-ignore-rate');
    expect(text).toContain('high-ignore-rate');
    expect(text).toContain('35.0s');
    expect(text).toContain('1m 5.0s');
  });

  it('sorts failing rows before passing rows', () => {
    const node = liveRunTable([
      {
        unit: 'clean',
        status: 'PASS',
        errors: 0,
        warnings: 0,
        durationMs: 1000,
      },
      {
        unit: 'broken',
        status: 'FAIL',
        errors: 2,
        warnings: 0,
        durationMs: 2000,
      },
    ]);
    const text = renderToText(node!);
    expect(text.indexOf('broken')).toBeLessThan(text.indexOf('clean'));
  });
});
