/**
 * @fileoverview `InvariantScenarioConfig` — author-facing configuration.
 *
 * Extracted from `define.ts` into its own leaf module so `executor.ts`
 * can reference the config shape without forming a file-level cycle.
 * See `../chaos/config.ts` for the same pattern; the split here is
 * identical.
 */

import type { InvariantContext, InvariantContextDeps } from './context.js';

/** Author-facing configuration for an invariant scenario. */
export interface InvariantScenarioConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Doc anchor identifying which invariant this scenario verifies. */
  readonly relatesToInvariant: string;
  readonly setup: (ctx: InvariantContext) => Promise<void>;
  readonly act: (ctx: InvariantContext) => Promise<void>;
  readonly assert: (ctx: InvariantContext) => Promise<void>;
  /**
   * Optional override for the `InvariantContext` driver dependencies. Tests
   * inject fake drivers here; production scenarios omit this and get the
   * default (throw-NOT-IMPLEMENTED) drivers until Phase 7 wires real ones.
   */
  readonly deps?: Partial<InvariantContextDeps>;
}
