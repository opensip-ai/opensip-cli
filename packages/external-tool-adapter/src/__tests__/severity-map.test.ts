import { describe, expect, it } from 'vitest';

import {
  cvssToSeverity,
  nativeLabelToSeverity,
  parseCvss,
  sarifLevelToSeverity,
  withNativeSeverity,
} from '../severity-map.js';

describe('cvssToSeverity (FIRST/NVD v3 bands)', () => {
  it('maps the band boundaries', () => {
    expect(cvssToSeverity(9)).toBe('critical');
    expect(cvssToSeverity(9.8)).toBe('critical');
    expect(cvssToSeverity(10)).toBe('critical');
    expect(cvssToSeverity(8.9)).toBe('high');
    expect(cvssToSeverity(7)).toBe('high');
    expect(cvssToSeverity(6.9)).toBe('medium');
    expect(cvssToSeverity(4)).toBe('medium');
    expect(cvssToSeverity(3.9)).toBe('low');
    expect(cvssToSeverity(0.1)).toBe('low');
  });

  it('treats 0 / negative / non-finite as low', () => {
    expect(cvssToSeverity(0)).toBe('low');
    expect(cvssToSeverity(-1)).toBe('low');
    expect(cvssToSeverity(Number.NaN)).toBe('low');
    // Non-finite is treated defensively as low (not a real CVSS score).
    expect(cvssToSeverity(Number.POSITIVE_INFINITY)).toBe('low');
  });
});

describe('parseCvss', () => {
  it('reads numbers and numeric strings', () => {
    expect(parseCvss(7.5)).toBe(7.5);
    expect(parseCvss('9.8')).toBe(9.8);
    expect(parseCvss('  4.0 ')).toBe(4);
  });

  it('rejects vectors, empty, and non-numeric', () => {
    expect(parseCvss('CVSS:3.1/AV:N/AC:L')).toBeUndefined();
    expect(parseCvss('')).toBeUndefined();
    expect(parseCvss('  ')).toBeUndefined();
    expect(parseCvss('not-a-number')).toBeUndefined();
    expect(parseCvss(undefined)).toBeUndefined();
    expect(parseCvss(Number.NaN)).toBeUndefined();
    expect(parseCvss({})).toBeUndefined();
  });
});

describe('sarifLevelToSeverity (lossy fallback)', () => {
  it('maps error to high (never critical), warning to medium, note/none to low', () => {
    expect(sarifLevelToSeverity('error')).toBe('high');
    expect(sarifLevelToSeverity('warning')).toBe('medium');
    expect(sarifLevelToSeverity('note')).toBe('low');
    expect(sarifLevelToSeverity('none')).toBe('low');
  });

  it('defaults an absent/unknown level to the warning rung (medium)', () => {
    expect(sarifLevelToSeverity(undefined)).toBe('medium');
    expect(sarifLevelToSeverity('bogus')).toBe('medium');
  });
});

describe('withNativeSeverity', () => {
  it('records the raw label and null for missing', () => {
    expect(withNativeSeverity({ a: 1 }, 'HIGH')).toEqual({ a: 1, nativeSeverity: 'HIGH' });
    expect(withNativeSeverity({}, undefined)).toEqual({ nativeSeverity: null });
  });
});

describe('nativeLabelToSeverity (common scanner label → four-bucket)', () => {
  it('maps the critical / blocker band', () => {
    expect(nativeLabelToSeverity('critical')).toBe('critical');
    expect(nativeLabelToSeverity('BLOCKER')).toBe('critical');
  });

  it('maps the high band (high / error / fatal / major)', () => {
    for (const label of ['high', 'error', 'Fatal', 'MAJOR']) {
      expect(nativeLabelToSeverity(label)).toBe('high');
    }
  });

  it('maps the medium band (medium / moderate / warning / warn / minor)', () => {
    for (const label of ['medium', 'moderate', 'warning', 'warn', 'minor']) {
      expect(nativeLabelToSeverity(label)).toBe('medium');
    }
  });

  it('maps the low band (low / info / information / note / style)', () => {
    for (const label of ['low', 'info', 'information', 'note', 'style']) {
      expect(nativeLabelToSeverity(label)).toBe('low');
    }
  });

  it('is case/space-insensitive and falls back for unknown labels', () => {
    expect(nativeLabelToSeverity('  Error  ')).toBe('high');
    expect(nativeLabelToSeverity('nonsense')).toBe('medium');
    expect(nativeLabelToSeverity(undefined)).toBe('medium');
    expect(nativeLabelToSeverity('nonsense', 'low')).toBe('low');
  });
});
