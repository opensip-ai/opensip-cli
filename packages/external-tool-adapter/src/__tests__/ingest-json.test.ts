import { describe, expect, it } from 'vitest';

import {
  asArray,
  asObject,
  getNumber,
  getString,
  navigate,
  safeParseJson,
} from '../ingest-json.js';

describe('safeParseJson', () => {
  it('returns ok for valid JSON', () => {
    expect(safeParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(safeParseJson('[]')).toEqual({ ok: true, value: [] });
  });

  it('returns an error Result for malformed JSON instead of throwing', () => {
    const result = safeParseJson('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error).toBe('string');
  });
});

describe('asObject / asArray', () => {
  it('narrows plain objects but not arrays or null', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject([])).toBeUndefined();
    expect(asObject(null)).toBeUndefined();
    expect(asObject('x')).toBeUndefined();
  });

  it('narrows arrays only', () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({})).toBeUndefined();
  });
});

describe('getString / getNumber', () => {
  it('reads typed properties', () => {
    expect(getString({ k: 'v' }, 'k')).toBe('v');
    expect(getString({ k: 1 }, 'k')).toBeUndefined();
    expect(getString(undefined, 'k')).toBeUndefined();
  });

  it('coerces numeric strings for numbers', () => {
    expect(getNumber({ k: 3 }, 'k')).toBe(3);
    expect(getNumber({ k: '7.5' }, 'k')).toBe(7.5);
    expect(getNumber({ k: 'nope' }, 'k')).toBeUndefined();
    expect(getNumber({ k: Number.NaN }, 'k')).toBeUndefined();
    expect(getNumber({}, 'k')).toBeUndefined();
  });
});

describe('navigate', () => {
  const doc = { results: [{ packages: [{ id: 'GHSA-1' }] }] };

  it('descends objects and array indices', () => {
    expect(navigate(doc, ['results', '0', 'packages', '0', 'id'])).toBe('GHSA-1');
  });

  it('returns undefined on a missing or wrong-typed step', () => {
    expect(navigate(doc, ['results', '9', 'id'])).toBeUndefined();
    expect(navigate(doc, ['missing'])).toBeUndefined();
    expect(navigate(null, ['x'])).toBeUndefined();
    expect(navigate(doc, ['results', 'notanindex'])).toBeUndefined();
  });
});
