/**
 * Graph performance profile writer.
 *
 * The CLI already emits structured stage progress for the live view and spans
 * for telemetry. This module turns the same progress stream into a portable
 * JSON artifact users can attach to performance reports without enabling an
 * OpenTelemetry SDK.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { RunGraphResult } from './orchestrate.js';
import type { GraphProgressEvent } from './orchestrate/types.js';
import type { Catalog, ResolutionMode } from '../types.js';

export interface GraphProfileStage {
  readonly name: string;
  readonly status: 'done' | 'cached';
  readonly durationMs?: number;
  readonly detail?: string;
}

export interface GraphProfileRunSummary {
  readonly cacheHit?: boolean;
  readonly files?: number;
  readonly functions?: number;
  readonly signals?: number;
  readonly totalCallSites?: number;
  readonly resolvedHigh?: number;
  readonly resolvedMedium?: number;
  readonly resolvedLow?: number;
  readonly unresolved?: number;
}

export interface GraphProfileRun {
  readonly label: string;
  readonly cwd: string;
  readonly mode: string;
  readonly startedAt: string;
  completedAt?: string;
  durationMs?: number;
  readonly stages: GraphProfileStage[];
  summary?: GraphProfileRunSummary;
}

export interface GraphProfileDocument {
  readonly version: '1.0';
  readonly tool: 'graph';
  readonly cwd: string;
  readonly mode: string;
  readonly resolutionMode?: ResolutionMode;
  readonly startedAt: string;
  completedAt?: string;
  durationMs?: number;
  readonly runs: GraphProfileRun[];
}

export class GraphProfileRunRecorder {
  private readonly activeStages = new Map<string, number>();
  private readonly startedMs = Date.now();

  constructor(private readonly run: GraphProfileRun) {}

  readonly onProgress = (event: GraphProgressEvent): void => {
    if (event.type === 'stage-start') {
      this.activeStages.set(event.stage, Date.now());
      return;
    }
    if (event.type === 'stage-cached') {
      this.run.stages.push({ name: event.stage, status: 'cached' });
      return;
    }
    this.recordStage(event.stage, event.durationMs, event.detail);
  };

  recordStage(name: string, durationMs?: number, detail?: string): void {
    const started = this.activeStages.get(name);
    const measured = durationMs ?? (started === undefined ? undefined : Date.now() - started);
    this.activeStages.delete(name);
    this.run.stages.push({
      name,
      status: 'done',
      ...(measured === undefined ? {} : { durationMs: measured }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  finish(result: RunGraphResult): void {
    this.finishSummary(summaryFromResult(result));
  }

  finishSummary(summary: GraphProfileRunSummary): void {
    const completedAt = new Date();
    this.run.completedAt = completedAt.toISOString();
    this.run.durationMs = Date.now() - this.startedMs;
    this.run.summary = summary;
  }
}

export class GraphProfileBuilder {
  private readonly startedMs = Date.now();
  private readonly document: GraphProfileDocument;

  constructor(input: {
    readonly cwd: string;
    readonly mode: string;
    readonly resolutionMode?: ResolutionMode;
    readonly startedAt?: string;
  }) {
    this.document = {
      version: '1.0',
      tool: 'graph',
      cwd: input.cwd,
      mode: input.mode,
      startedAt: input.startedAt ?? new Date().toISOString(),
      runs: [],
      ...(input.resolutionMode === undefined ? {} : { resolutionMode: input.resolutionMode }),
    };
  }

  startRun(input: {
    readonly label: string;
    readonly cwd: string;
    readonly mode: string;
  }): GraphProfileRunRecorder {
    const run: GraphProfileRun = {
      label: input.label,
      cwd: input.cwd,
      mode: input.mode,
      startedAt: new Date().toISOString(),
      stages: [],
    };
    this.document.runs.push(run);
    return new GraphProfileRunRecorder(run);
  }

  complete(): GraphProfileDocument {
    this.document.completedAt = new Date().toISOString();
    this.document.durationMs = Date.now() - this.startedMs;
    return this.document;
  }
}

export function writeGraphProfile(
  outputPath: string,
  cwd: string,
  profile: GraphProfileDocument,
): string {
  const resolved = isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  return resolved;
}

function summaryFromResult(result: RunGraphResult): GraphProfileRunSummary {
  const catalog = result.catalog;
  return {
    cacheHit: result.cacheHit,
    files: catalog === null ? 0 : countCatalogFiles(catalog),
    functions: catalog === null ? 0 : countCatalogFunctions(catalog),
    signals: result.signals.length,
    ...(result.resolutionStats === null
      ? {}
      : {
          totalCallSites: result.resolutionStats.totalCallSites,
          resolvedHigh: result.resolutionStats.resolvedHigh,
          resolvedMedium: result.resolutionStats.resolvedMedium,
          resolvedLow: result.resolutionStats.resolvedLow,
          unresolved: result.resolutionStats.unresolved,
        }),
  };
}

function countCatalogFiles(catalog: Catalog): number {
  const files = new Set<string>();
  for (const occs of Object.values(catalog.functions)) {
    for (const occ of occs) files.add(occ.filePath);
  }
  return files.size;
}

function countCatalogFunctions(catalog: Catalog): number {
  let count = 0;
  for (const occs of Object.values(catalog.functions)) count += occs.length;
  return count;
}
