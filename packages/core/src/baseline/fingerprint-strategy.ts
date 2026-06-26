/**
 * @fileoverview Fingerprint strategy — the host-owned baseline/ratchet plane's
 * identity primitive (ADR-0036).
 *
 * A `FingerprintStrategyDescriptor` maps a `Signal` to a stable string identity
 * and carries `{ id, version }` metadata the host persists in baseline meta
 * (ADR-0075). Each tool MAY declare one via `Tool.fingerprintStrategy`; a tool
 * that declares nothing inherits {@link defaultFingerprintStrategy}. The
 * fingerprint is stamped onto `Signal.fingerprint` at envelope-construction time:
 * `buildSignalEnvelope` (`@opensip-cli/contracts`) calls {@link stampFingerprints}
 * with the tool's strategy (host default when none is passed), so every built
 * envelope reaches the host seams already stamped. The plane itself NEVER
 * re-fingerprints or re-derives the value (it treats it opaquely); the seam-side
 * stamped-ness check (`requireStampedEntries`, cli baseline-seams) remains as
 * defense in depth for envelopes assembled without the builder.
 *
 * This lives in `core` because `core` is the only layer every tool already
 * imports and it owns `Signal`; the strategy is pure (no persistence), so it is
 * kernel-safe.
 */

import { ValidationError } from '../lib/errors.js';

import type { Signal } from '../types/signal.js';

/** Maps a {@link Signal} to its stable, opaque baseline identity (ADR-0036). */
export interface FingerprintStrategyDescriptor {
  readonly id: string;
  readonly version: number;
  readonly fingerprint: (signal: Signal) => string;
}

/** The public fingerprint strategy type — a descriptor, not a bare function. */
export type FingerprintStrategy = FingerprintStrategyDescriptor;

/** Input to {@link defineFingerprintStrategy}. */
export interface DefineFingerprintStrategyInput {
  readonly id: string;
  readonly version: number;
  readonly fingerprint: (signal: Signal) => string;
}

/**
 * Validate and freeze a fingerprint strategy descriptor. Enforces a non-empty id
 * and a positive integer version.
 *
 * @throws {ValidationError} when id or version is invalid.
 */
export function defineFingerprintStrategy(
  input: DefineFingerprintStrategyInput,
): FingerprintStrategyDescriptor {
  const id = input.id.trim();
  if (id.length === 0) {
    throw new ValidationError('Fingerprint strategy id must be a non-empty string', {
      code: 'VALIDATION.FINGERPRINT_STRATEGY.INVALID_ID',
    });
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new ValidationError('Fingerprint strategy version must be a positive integer', {
      code: 'VALIDATION.FINGERPRINT_STRATEGY.INVALID_VERSION',
    });
  }
  return Object.freeze({
    id,
    version: input.version,
    fingerprint: input.fingerprint,
  });
}

/**
 * The host default identity: `ruleId | filePath | line | column`.
 *
 * Verbatim shape from graph's `fingerprintSignal` so the host default and
 * graph's byte-preserved strategy are textually identical. Deliberately excludes
 * `message` — a fingerprint is an *identity*, and several rules embed run-varying
 * counts in their message text, which would make the same logical finding
 * fingerprint differently across runs (a spurious "resolved + new" flap).
 *
 * WARNING for tool authors: this strategy collides for any two findings that
 * share ruleId+filePath but lack a stable line/col (e.g. synthetic whole-file
 * nodes like `<module-init>`, or rules that intentionally report at file level
 * with line/col omitted or zero). Tools that emit such findings MUST declare
 * their own `Tool.fingerprintStrategy` (see helpers below or a content hash)
 * or risk baseline ratchet flapping / lost distinct findings.
 */
export const defaultFingerprintStrategy: FingerprintStrategy = defineFingerprintStrategy({
  id: 'opensip.default.rule-file-line-col',
  version: 1,
  fingerprint: (s) => `${s.ruleId}|${s.filePath}|${String(s.line ?? 0)}|${String(s.column ?? 0)}`,
});

/**
 * A stable identity for file-level or synthetic (no reliable line/col) findings.
 * Differentiates by ruleId + filePath only. Suitable when the *rule* itself
 * is the distinguishing fact and there is at most one such finding per
 * (rule, file) in a run.
 */
export const fileLevelFingerprintStrategy: FingerprintStrategy = defineFingerprintStrategy({
  id: 'opensip.file-level.rule-file',
  version: 1,
  fingerprint: (s) => `${s.ruleId}|${s.filePath}`,
});

/**
 * A content-aware fallback that incorporates a short hash of the message when
 * line/col are absent. This reduces (but does not eliminate) collisions for
 * rules that legitimately emit multiple file-level findings that differ only
 * in the human message text.
 *
 * Tools that care about exact stability should prefer a strategy that hashes
 * the parts of the Signal that are semantically part of "the same finding"
 * (often ruleId + filePath + a normalized key extracted from the finding).
 */
export const contentHashFallbackFingerprintStrategy: FingerprintStrategy =
  defineFingerprintStrategy({
    id: 'opensip.content-hash-fallback',
    version: 1,
    fingerprint: (s) => {
      // Very small stable hash of message (or empty) to disambiguate file-level variants.
      const msg = s.message ?? '';
      let h = 2_166_136_261;
      for (let i = 0; i < msg.length; i++) {
        const cp = msg.codePointAt(i) ?? 0;
        h ^= cp & 0xff_ff;
        h = Math.imul(h, 16_777_619);
        if (cp > 0xff_ff) i += 1;
      }
      const suffix = (h >>> 0).toString(16).padStart(8, '0');
      const line = s.line ?? 0;
      const col = s.column ?? 0;
      // When we have real line/col prefer the default shape; otherwise use file+hash.
      if (line || col) {
        return defaultFingerprintStrategy.fingerprint(s);
      }
      return `${s.ruleId}|${s.filePath}|${suffix}`;
    },
  });

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
    signal.fingerprint ? signal : { ...signal, fingerprint: strategy.fingerprint(signal) },
  );
}
