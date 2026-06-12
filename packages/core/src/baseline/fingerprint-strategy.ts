/**
 * @fileoverview Fingerprint strategy — the host-owned baseline/ratchet plane's
 * identity primitive (ADR-0036).
 *
 * A `FingerprintStrategy` maps a `Signal` to a stable string identity. Each tool
 * MAY declare one via `Tool.fingerprintStrategy`; a tool that declares nothing
 * inherits {@link defaultFingerprintStrategy}. The fingerprint is stamped onto
 * `Signal.fingerprint` at signal-creation / envelope-construction time (via
 * {@link stampFingerprints}) BEFORE the envelope reaches a host seam — the plane
 * itself NEVER re-fingerprints or re-derives the value (it treats it opaquely).
 *
 * This lives in `core` because `core` is the only layer every tool already
 * imports and it owns `Signal`; the strategy is pure (no persistence), so it is
 * kernel-safe.
 */

import type { Signal } from '../types/signal.js';

/** Maps a {@link Signal} to its stable, opaque baseline identity (ADR-0036). */
export type FingerprintStrategy = (signal: Signal) => string;

/**
 * The host default identity: `ruleId | filePath | line | column`.
 *
 * Verbatim shape from graph's `fingerprintSignal` so the host default and
 * graph's byte-preserved strategy are textually identical. Deliberately excludes
 * `message` — a fingerprint is an *identity*, and several rules embed run-varying
 * counts in their message text, which would make the same logical finding
 * fingerprint differently across runs (a spurious "resolved + new" flap).
 */
export const defaultFingerprintStrategy: FingerprintStrategy = (s) =>
  `${s.ruleId}|${s.filePath}|${String(s.line ?? 0)}|${String(s.column ?? 0)}`;

/**
 * Stamp `fingerprint` onto each signal using `strategy`, returning new signal
 * objects (spread + override). Called by each tool at envelope-construction time
 * (ADR-0036), BEFORE the envelope reaches a host seam.
 *
 * **Idempotent**: a signal whose `fingerprint` is already a non-empty string is
 * returned unchanged. This is a safety net (it lets a tool stamp earlier still,
 * e.g. at `createSignal`, without double-hashing), NOT a second stamping point —
 * the host seams only ever READ `signal.fingerprint`.
 */
export function stampFingerprints(
  signals: readonly Signal[],
  strategy: FingerprintStrategy,
): Signal[] {
  return signals.map((signal) =>
    signal.fingerprint ? signal : { ...signal, fingerprint: strategy(signal) },
  );
}
