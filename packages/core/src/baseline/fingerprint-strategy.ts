/**
 * @fileoverview Fingerprint strategy — the host-owned baseline/ratchet plane's
 * identity primitive (ADR-0036).
 *
 * A `FingerprintStrategy` maps a `Signal` to a stable string identity. Each tool
 * MAY declare one via `Tool.fingerprintStrategy`; a tool that declares nothing
 * inherits {@link defaultFingerprintStrategy}. The fingerprint is stamped onto
 * `Signal.fingerprint` at envelope-construction time: `buildSignalEnvelope`
 * (`@opensip-tools/contracts`) calls {@link stampFingerprints} with the tool's
 * strategy (host default when none is passed), so every built envelope reaches
 * the host seams already stamped. The plane itself NEVER re-fingerprints or
 * re-derives the value (it treats it opaquely); the seam-side stamped-ness check
 * (`requireStampedEntries`, cli baseline-seams) remains as defense in depth for
 * envelopes assembled without the builder.
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
 * objects (spread + override). Called by `buildSignalEnvelope` at
 * envelope-construction time (ADR-0036), BEFORE the envelope reaches a host seam.
 *
 * **Idempotent**: a signal whose `fingerprint` is already a non-empty string is
 * returned unchanged — and a fully pre-stamped array is returned by identity
 * (no re-allocation). This is a safety net (it lets a tool stamp earlier still,
 * e.g. at `createSignal`, without double-hashing), NOT a second stamping point —
 * the host seams only ever READ `signal.fingerprint`.
 */
export function stampFingerprints(
  signals: readonly Signal[],
  strategy: FingerprintStrategy,
): readonly Signal[] {
  if (signals.every((signal) => signal.fingerprint)) return signals;
  return signals.map((signal) =>
    signal.fingerprint ? signal : { ...signal, fingerprint: strategy(signal) },
  );
}
