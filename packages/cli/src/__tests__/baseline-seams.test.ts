/**
 * Host baseline-seam unit tests (ADR-0036): the export seams + the guards that
 * the toy-tool scenario doesn't reach. Includes the BYTE-IDENTICAL fingerprint
 * JSON acceptance ({version:'1',tool,capturedAt,fingerprints[]}, 2-space indent,
 * sorted) and the SARIF reconstruction from stored payloads.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignal, type Signal } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBaselineSeams, type BaselineSeams } from '../bootstrap/baseline-seams.js';

import type { SignalEnvelope } from '@opensip-tools/contracts';

let ds: DataStore;
let seams: BaselineSeams;
let dir: string;

function stampedSignal(fingerprint: string, ruleId = 'r', file = 'src/a.ts'): Signal {
  return {
    ...createSignal({
      source: 's',
      severity: 'high',
      ruleId,
      message: 'm',
      code: { file, line: 1 },
    }),
    fingerprint,
  };
}

function envelopeOf(signals: readonly Signal[]): SignalEnvelope {
  return {
    schemaVersion: 2,
    tool: 'graph',
    runId: 'r',
    createdAt: '1970-01-01T00:00:00.000Z',
    verdict: {
      score: 0,
      passed: true,
      summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
    },
    units: [],
    signals,
  };
}

beforeEach(() => {
  ds = DataStoreFactory.open({ backend: 'memory' });
  seams = buildBaselineSeams({ getDatastore: () => ds, logger: console });
  dir = mkdtempSync(join(tmpdir(), 'baseline-seams-'));
});

afterEach(() => {
  ds.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('saveBaseline / compareBaseline guards', () => {
  it('saveBaseline rejects an unstamped signal (the plane never fingerprints)', () => {
    const unstamped = createSignal({ source: 's', severity: 'high', ruleId: 'r', message: 'm' });
    // saveBaseline is sync-bodied (SQLite is synchronous), so the stamp guard
    // throws synchronously — an awaiting caller still catches it.
    expect(() => seams.saveBaseline('graph', envelopeOf([unstamped]))).toThrow(
      /not fingerprint-stamped/,
    );
  });

  it('compareBaseline throws a missing-baseline error before any save', async () => {
    await expect(seams.compareBaseline('graph', envelopeOf([]))).rejects.toThrow(/baseline/i);
  });
});

describe('exportBaselineFingerprints (byte-identical v1 JSON)', () => {
  it('writes {version,tool,capturedAt,fingerprints[]} sorted, 2-space indent', async () => {
    await seams.saveBaseline(
      'graph',
      envelopeOf([stampedSignal('b|x|2|0'), stampedSignal('a|x|1|0')]),
    );
    const out = join(dir, 'gb.json');
    await seams.exportBaselineFingerprints('graph', out);
    const text = readFileSync(out, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.version).toBe('1');
    expect(parsed.tool).toBe('graph');
    expect(typeof parsed.capturedAt).toBe('string');
    expect(parsed.fingerprints).toEqual(['a|x|1|0', 'b|x|2|0']); // sorted ascending
    // 2-space indent (byte shape): the fingerprints array is indented.
    expect(text).toContain('\n  "fingerprints": [');
  });

  it('throws the missing-baseline error when no baseline exists', async () => {
    await expect(seams.exportBaselineFingerprints('graph', join(dir, 'x.json'))).rejects.toThrow(
      /baseline/i,
    );
  });
});

describe('exportBaselineSarif (reconstruct from payloads)', () => {
  it('writes a SARIF document derived from the stored signal payloads', async () => {
    await seams.saveBaseline('graph', envelopeOf([stampedSignal('a|x|1|0', 'graph:cycle')]));
    const out = join(dir, 'b.sarif');
    await seams.exportBaselineSarif('graph', out);
    const sarif = JSON.parse(readFileSync(out, 'utf8')) as { runs?: { tool?: unknown }[] };
    expect(sarif.runs).toHaveLength(1);
    expect(readFileSync(out, 'utf8')).toContain('opensip-tools-graph');
  });

  it('throws the missing-baseline error when no baseline exists', async () => {
    await expect(seams.exportBaselineSarif('graph', join(dir, 'x.sarif'))).rejects.toThrow(
      /baseline/i,
    );
  });
});
