/**
 * Gate baseline save / compare per §10 P6.
 *
 * --gate-save writes the current Signal set to baseline.json
 * --gate-compare diffs current vs baseline; non-zero exit on
 * regression. Comparison is fingerprint-based: rule + file + line +
 * message identifies a finding.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { logger, SystemError, ValidationError } from '@opensip-tools/core';

import type { Signal } from '@opensip-tools/core';

interface BaselineFile {
  readonly version: '1';
  readonly tool: 'graph';
  readonly capturedAt: string;
  readonly fingerprints: readonly string[];
}

export interface GateCompareResult {
  readonly degraded: boolean;
  readonly newSignals: readonly Signal[];
  readonly resolvedFingerprints: readonly string[];
}

export function fingerprintSignal(s: Signal): string {
  return `${s.ruleId}|${s.filePath}|${String(s.line ?? 0)}|${s.message}`;
}

export function saveBaseline(signals: readonly Signal[], baselinePath: string): void {
  const data: BaselineFile = {
    version: '1',
    tool: 'graph',
    capturedAt: new Date().toISOString(),
    fingerprints: signals.map((s) => fingerprintSignal(s)).sort(),
  };
  try {
    mkdirSync(dirname(baselinePath), { recursive: true });
    const tmp = `${baselinePath}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, baselinePath);
    logger.info({
      evt: 'graph.gate.save.complete',
      module: 'graph:gate',
      path: baselinePath,
      count: signals.length,
    });
  } catch (error) {
    throw new SystemError(
      `Failed to write graph baseline: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function compareToBaseline(
  signals: readonly Signal[],
  baselinePath: string,
): GateCompareResult {
  if (!existsSync(baselinePath)) {
    throw new ValidationError(
      `Graph baseline not found at ${baselinePath}. Run with --gate-save first.`,
    );
  }
  let parsed: BaselineFile;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as BaselineFile;
  } catch (error) {
    throw new ValidationError(
      `Graph baseline at ${baselinePath} is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const baselineSet = new Set(parsed.fingerprints);
  const currentByFp = new Map<string, Signal>();
  for (const s of signals) currentByFp.set(fingerprintSignal(s), s);

  const newSignals: Signal[] = [];
  for (const [fp, s] of currentByFp.entries()) {
    if (!baselineSet.has(fp)) newSignals.push(s);
  }
  const resolved: string[] = [];
  for (const fp of baselineSet) {
    if (!currentByFp.has(fp)) resolved.push(fp);
  }

  return {
    degraded: newSignals.length > 0,
    newSignals,
    resolvedFingerprints: resolved,
  };
}
