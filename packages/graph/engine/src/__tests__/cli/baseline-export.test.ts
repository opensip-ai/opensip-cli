/**
 * Tests for `graph-baseline-export` — datastore-to-JSON dump of the
 * graph gate baseline. Verifies:
 *
 *  - reads the SQLite-backed baseline back into the v1 JSON shape
 *  - returns a structured error when no baseline has been captured
 *  - writes the file with deterministic byte count + fingerprint count
 *  - creates the output directory tree if it does not exist
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignal } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { exportGraphBaseline } from '../../cli/baseline-export.js';
import { saveBaseline } from '../../gate.js';
import { GraphBaselineRepo } from '../../persistence/baseline-repo.js';

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

describe('exportGraphBaseline', () => {
  let datastore: DataStore;
  let workDir: string;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    workDir = mkdtempSync(join(tmpdir(), 'graph-baseline-export-'));
  });

  afterEach(() => {
    datastore.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns error when no baseline has been captured', () => {
    const out = join(workDir, 'baseline.json');
    const result = exportGraphBaseline(datastore, out);
    expect(result.type).toBe('error');
    if (result.type !== 'error') return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain('No graph baseline');
  });

  it('writes the v1 JSON file shape after a save', () => {
    const repo = new GraphBaselineRepo(datastore);
    saveBaseline(
      [
        sig({ ruleId: 'graph:orphan-subtree', message: 'foo', filePath: 'src/a.ts', line: 1 }),
        sig({ ruleId: 'graph:orphan-subtree', message: 'bar', filePath: 'src/b.ts', line: 2 }),
      ],
      repo,
    );
    const out = join(workDir, 'baseline.json');
    const result = exportGraphBaseline(datastore, out);
    expect(result.type).toBe('graph-baseline-export');
    if (result.type !== 'graph-baseline-export') return;
    expect(result.outPath).toBe(out);
    expect(result.fingerprintCount).toBe(2);
    expect(result.bytesWritten).toBeGreaterThan(0);

    const parsed = JSON.parse(readFileSync(out, 'utf8')) as {
      version: string;
      tool: string;
      capturedAt: string;
      fingerprints: readonly string[];
    };
    expect(parsed.version).toBe('1');
    expect(parsed.tool).toBe('graph');
    expect(parsed.fingerprints).toHaveLength(2);
    // ISO-8601 timestamp
    expect(Number.isNaN(Date.parse(parsed.capturedAt))).toBe(false);
    expect(result.bytesWritten).toBe(Buffer.byteLength(JSON.stringify(parsed, null, 2), 'utf8'));
  });

  it('creates missing parent directories', () => {
    const repo = new GraphBaselineRepo(datastore);
    saveBaseline([sig({ ruleId: 'r', message: 'a', filePath: 'src/x.ts' })], repo);
    const out = join(workDir, 'deep', 'nested', 'subdir', 'baseline.json');
    const result = exportGraphBaseline(datastore, out);
    expect(result.type).toBe('graph-baseline-export');
    if (result.type !== 'graph-baseline-export') return;
    expect(result.outPath).toBe(out);
    // File must be readable
    expect(() => readFileSync(out, 'utf8')).not.toThrow();
  });

  it('saved-but-empty baseline serializes to an empty fingerprints array', () => {
    const repo = new GraphBaselineRepo(datastore);
    saveBaseline([], repo);
    const out = join(workDir, 'baseline.json');
    const result = exportGraphBaseline(datastore, out);
    expect(result.type).toBe('graph-baseline-export');
    if (result.type !== 'graph-baseline-export') return;
    expect(result.fingerprintCount).toBe(0);
    const parsed = JSON.parse(readFileSync(out, 'utf8')) as { fingerprints: readonly string[] };
    expect(parsed.fingerprints).toEqual([]);
  });
});
