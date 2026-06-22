import { createSignal } from '@opensip-cli/core';

import type { YagniFindingMetadata } from '../types/yagni-metadata.js';
import type { CreateSignalInput, Signal } from '@opensip-cli/core';

export interface YagniSignalInput extends Omit<CreateSignalInput, 'metadata'> {
  readonly yagni: YagniFindingMetadata;
}

/** Stamp a finding with full `metadata.yagni` and the canonical rule id shape. */
export function createYagniSignal(input: YagniSignalInput): Signal {
  return createSignal({
    ...input,
    provider: input.provider ?? 'yagni',
    metadata: { yagni: input.yagni },
  });
}
