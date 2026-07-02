import { currentScope, toPosixRelative } from '@opensip-cli/core';
import { minimatch } from 'minimatch';

import { readYagniMetadata, severityForConfidence } from '../scoring/confidence.js';

import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { Signal, TargetConventionsView } from '@opensip-cli/core';

type ConfidenceLoweringConventionKind = 'entrypoint' | 'alwaysUsed';

interface ConfidenceLoweringConventionMatch {
  readonly kind: ConfidenceLoweringConventionKind;
  readonly targetName: string;
  readonly pattern: string;
}

export function applyTargetConventionConfidence(signals: readonly Signal[], cwd: string): Signal[] {
  return signals.map((signal) => {
    const meta = readYagniMetadata(signal);
    if (meta === undefined) return signal;
    const match = matchConfidenceLoweringConvention(signal.filePath, cwd);
    if (!match) return signal;

    const confidence = lowerConfidence(meta.confidence);
    if (confidence === meta.confidence) return signal;
    return {
      ...signal,
      severity: severityForConfidence(confidence),
      metadata: {
        ...signal.metadata,
        yagni: {
          ...meta,
          confidence,
          conventionAdjustment: match,
        },
      },
    };
  });
}

function matchConfidenceLoweringConvention(
  filePath: string,
  cwd: string,
): ConfidenceLoweringConventionMatch | undefined {
  const relativePath = toPosixRelative(cwd, filePath);
  for (const target of currentScope()?.targets?.getAll() ?? []) {
    const conventions = target.config.conventions;
    if (!conventions) continue;
    const entrypoint = firstMatchingPattern(relativePath, conventions, 'entrypoints');
    if (entrypoint) {
      return { kind: 'entrypoint', targetName: target.config.name, pattern: entrypoint };
    }
    const alwaysUsed = firstMatchingPattern(relativePath, conventions, 'alwaysUsed');
    if (alwaysUsed) {
      return { kind: 'alwaysUsed', targetName: target.config.name, pattern: alwaysUsed };
    }
  }
  return undefined;
}

function firstMatchingPattern(
  relativePath: string,
  conventions: TargetConventionsView,
  field: 'entrypoints' | 'alwaysUsed',
): string | undefined {
  return conventions[field]?.find((pattern) => minimatch(relativePath, pattern, { dot: true }));
}

function lowerConfidence(confidence: YagniConfidence): YagniConfidence {
  if (confidence === 'high') return 'medium';
  if (confidence === 'medium') return 'low';
  return 'low';
}
