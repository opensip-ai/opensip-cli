/**
 * @fileoverview RunScope augmentation for graph.
 *
 * D7 (see docs/plans/ready/architecture-runscope-and-registry/phase-0-audit-and-design.md):
 * tool-specific concerns nest under the tool's name on `RunScope` and
 * are added via TypeScript module augmentation from the tool's own
 * package. Core never imports graph-shaped types — the layer rule
 * stays intact (`core ← contracts ← {graph, ...}`).
 *
 * Two singletons used to hang off this package as module-level state:
 *
 *   - lang-adapter `registry` — per-process language adapter registry.
 *   - rules `registry`        — per-process rule registry (seeded with
 *                              the six built-in rules at construction).
 *
 * Both are now per-RunScope. The graph tool's `extendScope` hook (in
 * `tool.ts`) instantiates fresh registries and attaches them to
 * `scope.graph` once per CLI invocation. Tools and library code read
 * via `currentScope()?.graph?.{adapters,rules}`.
 *
 * The `graph` slot is intentionally optional and mutable (no
 * `readonly`) on the augmented interface: the kernel doesn't construct
 * it, and only the graph tool's `extendScope` writes to it during
 * scope construction. A run that doesn't load the graph tool carries
 * no `scope.graph`, and reads return `undefined`.
 */

import type { GraphAdapterRegistry } from './lang-adapter/registry.js';
import type { GraphRulesRegistry } from './rules/registry.js';

/**
 * Per-RunScope graph state. Constructed by the graph tool's
 * `extendScope(scope)` hook and attached to `scope.graph`.
 */
export interface GraphSubscope {
  /** Language-adapter registry — populated when first-party graph
   *  adapter packages (graph-typescript, graph-python, graph-rust)
   *  register via the CLI's discovery walker. */
  readonly adapters: GraphAdapterRegistry;
  /** Rule registry — pre-seeded with the six built-in rules. */
  readonly rules: GraphRulesRegistry;
}

declare module '@opensip-tools/core' {
  interface RunScope {
    /**
     * Graph tool's per-run state. Populated by the graph tool's
     * `extendScope` hook; absent in runs where the graph tool is not
     * registered. Consumers MUST null-check before reading.
     */
    graph?: GraphSubscope;
  }
}
