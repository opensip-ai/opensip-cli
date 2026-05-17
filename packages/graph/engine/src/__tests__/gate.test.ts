/**
 * Tests for gate baseline save / compare.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignal } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { compareToBaseline, fingerprintSignal, saveBaseline } from '../gate.js';

import type { Signal } from '@opensip-tools/core';

function sig(over: { ruleId: string; message: string; filePath: string; line?: number }): Signal {
  return createSignal({
    source: 'graph',
    severity: 'low',
    category: 'quality',
    ruleId: over.ruleId,
    message: over.message,
    code: { file: over.filePath, line: over.line ?? 1, column: 0 },
  });
}

describe('gate fingerprintSignal', () => {
  it('builds rule|file|line|message identifier', () => {
    const s = sig({ ruleId: 'graph:orphan-subtree', message: 'foo is unreachable', filePath: 'src/a.ts', line: 7 });
    expect(fingerprintSignal(s)).toBe('graph:orphan-subtree|src/a.ts|7|foo is unreachable');
  });

  it('treats missing line as 0', () => {
    const s = sig({ ruleId: 'r', message: 'm', filePath: 'src/a.ts' });
    // Cast to write line=undefined
    const noLine: Signal = { ...s, line: undefined };
    expect(fingerprintSignal(noLine)).toBe('r|src/a.ts|0|m');
  });
});

describe('saveBaseline / compareToBaseline', () => {
  let dir: string;
  let baselinePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-gate-'));
    baselinePath = join(dir, 'cache', 'baseline.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves a baseline (creating parent dirs) and compareToBaseline reports clean when current matches', () => {
    const signals = [
      sig({ ruleId: 'graph:orphan-subtree', message: 'foo', filePath: 'src/a.ts', line: 1 }),
      sig({ ruleId: 'graph:orphan-subtree', message: 'bar', filePath: 'src/b.ts', line: 2 }),
    ];
    saveBaseline(signals, baselinePath);
    const result = compareToBaseline(signals, baselinePath);
    expect(result.degraded).toBe(false);
    expect(result.newSignals).toHaveLength(0);
    expect(result.resolvedFingerprints).toHaveLength(0);
  });

  it('flags new signals as degraded', () => {
    const original = [sig({ ruleId: 'graph:orphan-subtree', message: 'foo', filePath: 'src/a.ts', line: 1 })];
    saveBaseline(original, baselinePath);
    const drift = [
      ...original,
      sig({ ruleId: 'graph:orphan-subtree', message: 'newOne', filePath: 'src/c.ts', line: 3 }),
    ];
    const result = compareToBaseline(drift, baselinePath);
    expect(result.degraded).toBe(true);
    expect(result.newSignals).toHaveLength(1);
    expect(result.newSignals[0]?.message).toBe('newOne');
  });

  it('records resolved fingerprints (signals in baseline but not in current)', () => {
    const original = [
      sig({ ruleId: 'r', message: 'a', filePath: 'src/a.ts', line: 1 }),
      sig({ ruleId: 'r', message: 'b', filePath: 'src/b.ts', line: 2 }),
    ];
    saveBaseline(original, baselinePath);
    const fewer = [original[0]] as readonly Signal[];
    const result = compareToBaseline(fewer, baselinePath);
    expect(result.degraded).toBe(false);
    expect(result.resolvedFingerprints).toHaveLength(1);
    expect(result.resolvedFingerprints[0]).toContain('|b');
  });

  it('throws ValidationError when baseline is missing', () => {
    expect(() => compareToBaseline([], join(dir, 'does-not-exist.json'))).toThrow(/Graph baseline not found/);
  });

  it('throws ValidationError when baseline JSON is malformed', () => {
    writeFileSync(baselinePath.replace('cache/', ''), 'not-json', 'utf8');
    const malformed = baselinePath.replace('cache/', '');
    expect(() => compareToBaseline([], malformed)).toThrow(/malformed/);
  });

  it('writes the file at the chosen path with deterministic shape', () => {
    const signals = [sig({ ruleId: 'graph:orphan-subtree', message: 'z', filePath: 'src/z.ts', line: 1 })];
    saveBaseline(signals, baselinePath);
    const raw = readFileSync(baselinePath, 'utf8');
    const parsed = JSON.parse(raw) as { version: string; tool: string; fingerprints: string[] };
    expect(parsed.version).toBe('1');
    expect(parsed.tool).toBe('graph');
    expect(parsed.fingerprints).toHaveLength(1);
    expect(parsed.fingerprints[0]).toBe('graph:orphan-subtree|src/z.ts|1|z');
  });

  it('save then compare against an empty current set marks every baseline entry resolved', () => {
    const signals = [
      sig({ ruleId: 'r', message: 'a', filePath: 'src/a.ts', line: 1 }),
      sig({ ruleId: 'r', message: 'b', filePath: 'src/b.ts', line: 2 }),
    ];
    saveBaseline(signals, baselinePath);
    const result = compareToBaseline([], baselinePath);
    expect(result.degraded).toBe(false);
    expect(result.resolvedFingerprints).toHaveLength(2);
  });

  it('save with no signals produces an empty baseline; later regressions are detected', () => {
    saveBaseline([], baselinePath);
    const drift = [sig({ ruleId: 'r', message: 'a', filePath: 'src/a.ts', line: 1 })];
    const result = compareToBaseline(drift, baselinePath);
    expect(result.degraded).toBe(true);
    expect(result.newSignals).toHaveLength(1);
  });

  it('wraps filesystem errors from saveBaseline as SystemError', () => {
    // Path under a file (not directory) -> ENOTDIR on mkdirSync
    const filePath = join(dir, 'a-file');
    writeFileSync(filePath, 'x', 'utf8');
    const bad = join(filePath, 'nested', 'baseline.json');
    expect(() => saveBaseline([], bad)).toThrow(/Failed to write graph baseline/);
  });
});
