import { describe, it, expect } from 'vitest';
import { generateId, generatePrefixedId, extractTimestamp, generateUUID } from '../../lib/ids.js';

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

describe('generateId', () => {
  it('returns a valid ULID when called without prefix', () => {
    const id = generateId();
    expect(id).toMatch(ULID_REGEX);
    expect(id.length).toBe(26);
  });

  it('returns a prefixed ULID when given a prefix', () => {
    const id = generateId('chk');
    expect(id).toMatch(/^chk_[0-9A-HJKMNP-TV-Z]{26}$/i);
  });

  it('generates unique IDs on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('supports various prefix strings', () => {
    expect(generateId('sig').startsWith('sig_')).toBe(true);
    expect(generateId('tik').startsWith('tik_')).toBe(true);
  });

  it('returns plain ULID with undefined prefix', () => {
    const id = generateId(undefined);
    expect(id).toMatch(ULID_REGEX);
  });
});

describe('generatePrefixedId', () => {
  it('returns an uppercased prefix with ULID', () => {
    const id = generatePrefixedId('run');
    expect(id).toMatch(/^RUN_[0-9A-HJKMNP-TV-Z]{26}$/i);
  });

  it('generates unique prefixed IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generatePrefixedId('ses')));
    expect(ids.size).toBe(50);
  });
});

describe('extractTimestamp', () => {
  it('extracts a timestamp from a ULID', () => {
    const before = Date.now();
    const id = generateId();
    const after = Date.now();

    const ts = extractTimestamp(id);
    expect(ts).toBeInstanceOf(Date);
    expect(ts!.getTime()).toBeGreaterThanOrEqual(before);
    expect(ts!.getTime()).toBeLessThanOrEqual(after);
  });

  it('extracts timestamp from a prefixed ID', () => {
    const before = Date.now();
    const id = generatePrefixedId('run');
    const after = Date.now();

    const ts = extractTimestamp(id);
    expect(ts).toBeInstanceOf(Date);
    expect(ts!.getTime()).toBeGreaterThanOrEqual(before);
    expect(ts!.getTime()).toBeLessThanOrEqual(after);
  });

  it('extracts timestamp from a multi-underscore prefixed ID', () => {
    // generatePrefixedId('my_tool') produces 'MY_TOOL_<ulid>' — earlier
    // implementations split on the first '_' and failed the length check.
    const before = Date.now();
    const id = generatePrefixedId('my_tool');
    const after = Date.now();

    const ts = extractTimestamp(id);
    expect(ts).toBeInstanceOf(Date);
    expect(ts!.getTime()).toBeGreaterThanOrEqual(before);
    expect(ts!.getTime()).toBeLessThanOrEqual(after);
  });

  it('returns null for invalid input', () => {
    expect(extractTimestamp('not-a-ulid')).toBeNull();
    expect(extractTimestamp('')).toBeNull();
    expect(extractTimestamp('abc')).toBeNull();
  });
});

describe('generateUUID', () => {
  it('returns a valid UUID v4', () => {
    const id = generateUUID();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
