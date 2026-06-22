/**
 * Human presentation for YAGNI audit runs (spec §11).
 */

import { relative } from 'node:path';

import { buildYagniRunSummary, readYagniMetadata } from '../scoring/confidence.js';

import type { SkippedDetector } from '../detectors/types.js';
import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { RunPresentation, SignalEnvelope, VerboseDetail } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

const CONFIDENCE_SECTION_ORDER: readonly YagniConfidence[] = ['high', 'medium', 'low'];

function formatLocation(signal: Signal, cwd: string): string {
  if (signal.filePath === '') return '<unknown>';
  const rel = relative(cwd, signal.filePath).split('\\').join('/');
  return signal.line === undefined ? rel : `${rel}:${String(signal.line)}`;
}

function formatLocSuffix(signal: Signal): string {
  const meta = readYagniMetadata(signal);
  if (meta?.locDelta === undefined) return '';
  const { netEstimate, estimateKind } = meta.locDelta;
  return `(~${String(netEstimate)} LOC, ${estimateKind})`;
}

function formatCandidateBlock(signal: Signal, cwd: string, verbose: boolean): string[] {
  const meta = readYagniMetadata(signal);
  if (meta === undefined) return [];
  const loc = formatLocation(signal, cwd);
  const block = [
    `  ${meta.reductionCategory.padEnd(6)} ${meta.detector.padEnd(28)} ${loc}`,
    `           → ${meta.suggestedAction.padEnd(44)} ${formatLocSuffix(signal)}`,
  ];
  if (!verbose) return block;
  block.push(`           preservation: ${meta.preservationArgument}`);
  if (meta.validationRequired.length > 0) {
    block.push(`           validation: ${meta.validationRequired.join('; ')}`);
  }
  if (meta.riskTags.length > 0) {
    block.push(`           risks: ${meta.riskTags.join(', ')}`);
  }
  for (const ev of meta.evidence) {
    block.push(`           evidence [${ev.kind}]: ${ev.summary}`);
  }
  return block;
}

function candidateLines(signals: readonly Signal[], cwd: string, verbose: boolean): string[] {
  const lines: string[] = [];
  for (const confidence of CONFIDENCE_SECTION_ORDER) {
    const bucket = signals.filter((s) => readYagniMetadata(s)?.confidence === confidence);
    if (bucket.length === 0) continue;
    lines.push('', `${confidence.charAt(0).toUpperCase()}${confidence.slice(1)} confidence`);
    for (const signal of bucket) {
      lines.push(...formatCandidateBlock(signal, cwd, verbose));
    }
  }
  return lines;
}

export function buildYagniPresentationLines(
  envelope: SignalEnvelope,
  cwd: string,
  graphMode: string,
  skippedDetectors: readonly SkippedDetector[],
  verbose: boolean,
): string[] {
  const summary = buildYagniRunSummary(envelope.signals, graphMode, skippedDetectors);
  const visibleSignals = verbose
    ? envelope.signals
    : envelope.signals.filter((s) => {
        const conf = readYagniMetadata(s)?.confidence;
        return conf === 'high' || conf === 'medium';
      });

  const { high, medium } = summary.byConfidence;
  const headline = `YAGNI audit: ${String(summary.totalCandidates)} reduction candidates (${String(high)} high, ${String(medium)} medium)`;
  const ran = envelope.units.length;
  const skipped = skippedDetectors.length;
  const metaLine = `Graph: ${graphMode} · ${String(ran)} detectors ran · ${String(skipped)} skipped`;

  const lines = [headline, metaLine, ...candidateLines(visibleSignals, cwd, verbose)];

  if (summary.estimatedTotalLocReduction > 0) {
    lines.push('', `net: ~${String(summary.estimatedTotalLocReduction)} LOC possible`);
  }

  if (!verbose) {
    lines.push('', 'Run with --verbose for evidence and validation requirements.');
  }

  if (verbose && skippedDetectors.length > 0) {
    lines.push('', 'Skipped detectors:');
    for (const skip of skippedDetectors) {
      const detail = skip.detail === undefined ? '' : ` (${skip.detail})`;
      lines.push(`  ${skip.slug}: ${skip.reason}${detail}`);
    }
  }

  return lines;
}

export function buildYagniRunPresentation(input: {
  readonly envelope: SignalEnvelope;
  readonly cwd: string;
  readonly graphMode: string;
  readonly skippedDetectors: readonly SkippedDetector[];
  readonly verbose: boolean;
  readonly durationMs?: number;
}): RunPresentation {
  const lines = buildYagniPresentationLines(
    input.envelope,
    input.cwd,
    input.graphMode,
    input.skippedDetectors,
    input.verbose,
  );
  const verboseDetail: VerboseDetail = { kind: 'lines', lines };
  return {
    type: 'run-presentation',
    tool: 'yagni',
    envelope: input.envelope,
    verboseDetail,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  };
}
