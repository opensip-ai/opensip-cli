/**
 * SignalSink — the decoupling seam for cloud signal egress (ADR-0008).
 *
 * A Strategy: callers depend on this interface, never on a concrete cloud
 * client. The default is the Null-Object `noopSignalSink` (OSS / embedded /
 * not-entitled → nothing happens). The OpenSIP Cloud implementation lives in
 * @opensip-cli/output and depends *up* on core — core never imports it,
 * keeping the kernel free of network concerns.
 *
 * Non-blocking invariant: `emit` MUST NOT throw and MUST NOT affect the run's
 * exit code. A failing sink returns `{ accepted: 0, … }`. `authRejected` is the
 * single piece of feedback a caller acts on — the CLI invalidates the cached
 * entitlement on a 401/403 so a lapsed plan stops syncing within one run rather
 * than one cache-TTL.
 */
import type { SignalBatch } from '../types/signal-batch.js';

/** Outcome of an emit. `accepted` drives the "Sent N signals" message. */
export interface EmitResult {
  /** Signals the server acknowledged. */
  readonly accepted: number;
  /** Server rejected auth (401/403) — caller busts the entitlement cache. */
  readonly authRejected: boolean;
  /**
   * Why an active sink accepted nothing, when that is knowable. Best-effort
   * delivery stays non-blocking (ADR-0008) — this exists so the composition
   * root can SURFACE a skip ("0 of N signals delivered: not entitled") instead
   * of the user silently believing their signals shipped. `'unentitled'` — the
   * entitlement check said no; `'error'` — the emit faulted (network, server).
   * Omitted on success and on the no-op sink (where silence is correct: the
   * user opted out or never configured a key).
   */
  readonly skippedReason?: 'unentitled' | 'error';
}

/** A best-effort destination for a run's signals. Implementations MUST NOT throw. */
export interface SignalSink {
  emit(batch: SignalBatch): Promise<EmitResult>;
  /**
   * Marks an INTENTIONAL no-delivery sink (the user opted out or never
   * configured a key). The composition root keeps such sinks silent — no
   * "0 signals uploaded" notice — whereas an active sink that ships nothing
   * gets a skip notice. A behavioral discriminator, deliberately NOT an
   * identity check against {@link noopSignalSink}: any host (embedded/SaaS)
   * may construct its own no-op sink and it must substitute cleanly.
   */
  readonly noop?: true;
}

/** The default sink: does nothing, accepts nothing. Used whenever cloud sync is off. */
export const noopSignalSink: SignalSink = {
  noop: true,
  emit: () => Promise.resolve({ accepted: 0, authRejected: false }),
};
