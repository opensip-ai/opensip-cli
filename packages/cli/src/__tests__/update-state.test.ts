/**
 * Unit coverage for the sticky update-state store: round-trip, malformed /
 * empty inputs degrading to "nothing known", churn-avoidance on unchanged
 * writes, and in-place clearing.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearKnownLatest,
  defaultUpdateStateFile,
  readKnownLatest,
  writeKnownLatest,
} from '../update-state.js';

let tmpDir: string;
let stateFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'osip-upd-state-'));
  stateFile = join(tmpDir, 'update-state.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('update-state store', () => {
  it('returns undefined when the file is absent', () => {
    expect(readKnownLatest(stateFile)).toBeUndefined();
  });

  it('round-trips a written version', () => {
    writeKnownLatest('2.4.1', stateFile);
    expect(readKnownLatest(stateFile)).toBe('2.4.1');
  });

  it('treats malformed JSON as nothing known', () => {
    writeFileSync(stateFile, '{ not json', 'utf8');
    expect(readKnownLatest(stateFile)).toBeUndefined();
  });

  it('treats a missing/empty latest field as nothing known', () => {
    writeFileSync(stateFile, JSON.stringify({ latest: '' }), 'utf8');
    expect(readKnownLatest(stateFile)).toBeUndefined();
    writeFileSync(stateFile, JSON.stringify({ other: 'x' }), 'utf8');
    expect(readKnownLatest(stateFile)).toBeUndefined();
  });

  it('skips the write when the value is unchanged (no churn)', () => {
    writeKnownLatest('2.4.1', stateFile);
    const before = readFileSync(stateFile, 'utf8');
    const mtimeBefore = existsSync(stateFile);
    writeKnownLatest('2.4.1', stateFile);
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
    expect(mtimeBefore).toBe(true);
  });

  it('overwrites when the value changes', () => {
    writeKnownLatest('2.4.1', stateFile);
    writeKnownLatest('2.5.0', stateFile);
    expect(readKnownLatest(stateFile)).toBe('2.5.0');
  });

  it('clears in place rather than deleting the file', () => {
    writeKnownLatest('2.4.1', stateFile);
    clearKnownLatest(stateFile);
    expect(readKnownLatest(stateFile)).toBeUndefined();
    expect(existsSync(stateFile)).toBe(true);
  });

  it('clear is a no-op when the file is already absent', () => {
    expect(() => clearKnownLatest(stateFile)).not.toThrow();
    expect(existsSync(stateFile)).toBe(false);
  });

  it('resolves the default path under ~/.opensip-cli/', () => {
    const path = defaultUpdateStateFile();
    expect(path.endsWith(join('.opensip-cli', 'update-state.json'))).toBe(true);
  });
});
