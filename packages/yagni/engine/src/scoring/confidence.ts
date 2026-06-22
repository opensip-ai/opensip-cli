import type { Signal } from '@opensip-cli/core';

import type { YagniFindingMetadata } from '../types/yagni-metadata.js';

function readYagniMetadata(signal: Signal): YagniFindingMetadata | undefined {
  const raw = signal.metadata.yagni;
  if (typeof raw !== 'object' || raw === null) return undefined;
  return raw as YagniFindingMetadata;
}

/** Keep findings at or above the configured minimum confidence. */
export function filterByMinConfidence(
  signals: readonly Signal[],
  minConfidence: number,
): Signal[] {
  return signals.filter((signal) => {
    const meta = readYagniMetadata(signal);
    if (meta === undefined) return true;
    return meta.confidence >= minConfidence;
  });
}