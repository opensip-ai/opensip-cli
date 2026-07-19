/**
 * Host-owned baseline, durable state, governance, audit, and entitlement seams.
 *
 * Kept separate from the command/output portion of `ToolCliContext` so each
 * public contract stays reviewable while the composed context remains
 * structurally identical for tool authors.
 */

import type { WireSignalEnvelope } from './cli-context-wire.js';
import type { HostAudit, HostEntitlements, HostGovernance } from './host-planes.js';
import type { GateCompareResult } from './tool-results.js';

/** Host-owned persistent state and policy planes supplied to every tool command. */
export interface ToolCliHostState {
  /**
   * Host baseline/ratchet plane seams (ADR-0036). The host owns persistence
   * (`BaselineRepo`), the diff, and exit derivation; a tool inherits a CI ratchet
   * by emitting fingerprint-stamped signals. The seams are **read-only** of
   * `signal.fingerprint` — the tool stamps its envelope's signals
   * (`stampFingerprints`) at envelope-construction time; the plane NEVER
   * re-fingerprints. `tool` scopes every operation; `envelope` is the
   * `SignalEnvelope` typed `unknown` here for the same layer reason as
   * `writeSarif`/`deliverSignals`.
   */
  readonly saveBaseline: (tool: string, envelope: WireSignalEnvelope) => Promise<void>;
  /**
   * Compare the current (stamped) envelope against this tool's saved baseline.
   * Throws a `ConfigurationError` (→ exit 2) when no baseline exists. The host
   * derives the gate exit from `result.degraded` via the `deliverSignals`
   * runFailed override — no tool calls `setExitCode` for the gate path (ADR-0035).
   */
  readonly compareBaseline: (
    tool: string,
    envelope: WireSignalEnvelope,
  ) => Promise<GateCompareResult>;
  /**
   * Export this tool's baseline to a SARIF file by reconstructing a synthetic
   * envelope from the stored per-fingerprint payloads (no stored envelope to
   * reload). Throws when no baseline exists.
   */
  readonly exportBaselineSarif: (tool: string, path: string) => Promise<void>;
  /**
   * Export this tool's baseline as the git-trackable fingerprint JSON
   * (`{version,tool,capturedAt,fingerprints[]}`). Throws when no baseline exists.
   */
  readonly exportBaselineFingerprints: (tool: string, path: string) => Promise<void>;
  /**
   * Host-owned keyed tool state (ADR-0042) — durable, per-tool, opaque-JSON
   * persistence over the generic `tool_state` table, the third-party parity
   * mechanism beside sessions + baselines. ONE grouped member (not four flat
   * seams — the interface-segregation lesson from the baseline plane). Rules:
   *
   *   - `tool` scopes every operation; a tool never sees another's rows.
   *   - Payloads are opaque JSON, capped at 256 KiB per payload; an oversized
   *     `put` throws a `ValidationError` (error, never evict).
   *   - Durable: unlike baselines (drop-and-recapture), a release never drops
   *     these rows. `tools data purge <tool-id>` clears them on request.
   *   - Requires the entered project scope (the datastore is per-project);
   *     calls outside one reject with the host's datastore-unavailable error.
   */
  readonly toolState: {
    readonly get: (tool: string, key: string) => Promise<unknown>;
    readonly put: (tool: string, key: string, payload: unknown) => Promise<void>;
    readonly delete: (tool: string, key: string) => Promise<void>;
    readonly list: (tool: string) => Promise<readonly string[]>;
  };

  /**
   * Host-owned evolution bag for additional durable/governance planes.
   *
   * This is the combined Host-Owned Governance, Entitlements, and Audit Plane
   * (H1: Extension/Community Governance, H2: Per-Tool Audit/Provenance/Decision Records,
   * H3: Entitlements/Licensing/Paid-Extension State).
   *
   * See:
   * - the "Host-Owned Governance, Entitlements & Audit Plane" spec + plan
   *   (local-only working docs, by that title)
   * - ADR-0042 (toolState baseline this reuses)
   *
   * Design: typed seams here (host provides the impl), opaque/namespaced storage under the
   * existing toolState seam (and the single host-owned `tool_state` table). Tools never
   * touch raw datastore for these concerns. The bag prevents interface bloat on ToolCliContext
   * (symmetric to ToolExtensionPoints on the Tool side).
   *
   * All members are optional so this change is purely additive for GA-era code and stubs.
   */
  readonly hostPlanes?: {
    governance?: HostGovernance;
    audit?: HostAudit;
    entitlements?: HostEntitlements;
  };
}
