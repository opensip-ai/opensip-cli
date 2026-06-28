/**
 * @fileoverview Provenance stamping (ADR-0090 §8, ADR-0092 review bar item 4).
 *
 * Every normalized signal carries, on `metadata.provenance`, the facts a
 * reviewer/operator needs to trust the finding: the tool, the adapter package,
 * the resolved binary version + path, the exact args, and the config file path.
 * Pure — returns a new `Signal`; the matched secret is NEVER part of provenance.
 */

import type { AdapterProvenance } from './types.js';
import type { Signal } from '@opensip-cli/core';

/**
 * Return a copy of `signal` with {@link AdapterProvenance} merged under
 * `metadata.provenance`. Undefined provenance fields are dropped so the bag stays
 * compact and deterministic.
 */
export function stampProvenance(signal: Signal, provenance: AdapterProvenance): Signal {
  const bag: Record<string, unknown> = {
    tool: provenance.tool,
    binaryPath: provenance.binaryPath,
    args: [...provenance.args],
    ...(provenance.adapterPackage === undefined
      ? {}
      : { adapterPackage: provenance.adapterPackage }),
    ...(provenance.binaryVersion === undefined ? {} : { binaryVersion: provenance.binaryVersion }),
    ...(provenance.configPath === undefined ? {} : { configPath: provenance.configPath }),
  };
  return { ...signal, metadata: { ...signal.metadata, provenance: bag } };
}

/** Stamp provenance across a batch of signals. */
export function stampProvenanceAll(
  signals: readonly Signal[],
  provenance: AdapterProvenance,
): readonly Signal[] {
  return signals.map((signal) => stampProvenance(signal, provenance));
}
