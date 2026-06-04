/**
 * @fileoverview The shared formatter contract (ADR-0011).
 *
 * A `Formatter` is a pure `(envelope) => string` transform — one per target
 * format (json, sarif, table). It is modelled on graph's `Renderer`
 * (`graph/engine/src/render/types.ts`, `(signals, context) => string`) but
 * keyed on the universal {@link SignalEnvelope} so every tool shares one set
 * of formatters.
 *
 * Formatter-purity contract: a formatter performs NO IO — no
 * `process.stdout`, no network, no `Date.now()`/`randomUUID`. The run id and
 * timestamp arrive on the envelope, so a fixed envelope renders to a fixed
 * string (snapshot-testable with zero mocks). All effects live in
 * `@opensip-tools/output/sink`; a sink may import a formatter, never the
 * reverse.
 */
import type { SignalEnvelope } from '@opensip-tools/contracts';

/** Pure `(envelope) => string` formatter. The shared output transform contract. */
export type Formatter = (envelope: SignalEnvelope) => string;
