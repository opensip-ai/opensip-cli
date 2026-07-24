/**
 * tool-command-rpc-types — the ADR-0054 host-RPC wire types (upcall union,
 * request/reply envelopes, host-plane method allowlist). Split from
 * `tool-command-dispatch-types.ts` (file-length budget); that module
 * re-exports everything here so importers keep one home.
 */

import type { ExternalAdapterProgressEvent } from '@opensip-cli/external-tool-adapter';

/**
 * The three datastore-backed host planes reachable via `ctx.hostPlanes.*`. A
 * generic `hostPlane` upcall names the plane + method + serializable args so the
 * host can dispatch to the real plane impl without a dedicated request variant
 * per method (the planes carry several opaque-record methods each; one generic
 * variant keeps this contract small and forward-compatible).
 */
export type HostPlaneKind = 'governance' | 'audit' | 'entitlements';

/**
 * Frozen allowlist of host-plane methods reachable via worker RPC (ADR-0146).
 * Runtime admission and the TypeScript wire union both derive from this table so
 * they cannot drift. Unbound project-wide methods (listForProject, exportForCloud)
 * are intentionally absent.
 */
export const HOST_PLANE_METHODS = Object.freeze({
  governance: Object.freeze([
    'getGovernanceState',
    'queryAudit',
    'recordInstallation',
    'recordApprovalDecision',
    'setBlock',
    'checkAllowed',
  ] as const),
  audit: Object.freeze(['append', 'query'] as const),
  entitlements: Object.freeze(['check', 'recordUsage', 'getLicenseState'] as const),
});

export type HostPlaneMethodName<P extends HostPlaneKind> = (typeof HOST_PLANE_METHODS)[P][number];

/** The serializable subset of `deliverSignals`'s opts (no functions/handles). */
export interface DeliverSignalsOpts {
  readonly cwd: string;
  readonly reportTo?: string;
  readonly apiKey?: string;
  readonly runFailed?: boolean;
}

/**
 * One host-RPC upcall, WITHOUT the correlation id — the shape the worker shim
 * builds and the host switch consumes. Discriminated by `seam`; each variant's
 * payload mirrors the arguments of the matching `ToolCliContext` seam (the
 * envelope/opts/payloads are all plain-data on those seams already).
 *
 * Kept as a standalone union (rather than `Omit<HostRpcRequest, 'rpcId'>`)
 * because `Omit` does not distribute over the `{ rpcId } & union` intersection
 * — it would collapse to only the common keys.
 */
export type HostRpcCall =
  | {
      readonly seam: 'deliverSignals';
      readonly envelope: unknown;
      readonly opts: DeliverSignalsOpts;
    }
  | {
      readonly seam: 'writeSarif';
      readonly envelope: unknown;
      readonly path: string;
    }
  | {
      readonly seam: 'writeArtifact';
      readonly path: string;
      readonly bytes: string;
    }
  | {
      readonly seam: 'ensureArtifactDir';
      readonly path: string;
    }
  | {
      readonly seam: 'saveBaseline';
      readonly tool: string;
      readonly envelope: unknown;
    }
  | {
      readonly seam: 'compareBaseline';
      readonly tool: string;
      readonly envelope: unknown;
    }
  | {
      readonly seam: 'exportBaselineSarif';
      readonly tool: string;
      readonly path: string;
    }
  | {
      readonly seam: 'exportBaselineFingerprints';
      readonly tool: string;
      readonly path: string;
    }
  | {
      readonly seam: 'toolState.get';
      readonly tool: string;
      readonly key: string;
    }
  | {
      readonly seam: 'toolState.put';
      readonly tool: string;
      readonly key: string;
      readonly payload: unknown;
    }
  | {
      readonly seam: 'toolState.delete';
      readonly tool: string;
      readonly key: string;
    }
  | { readonly seam: 'toolState.list'; readonly tool: string }
  | {
      readonly seam: 'maybeOpenReport';
      readonly opts: {
        readonly openRequested: boolean;
        readonly jsonOutput: boolean;
      };
    }
  | { readonly seam: 'getExitCode' }
  | {
      readonly seam: 'hostPlane';
      readonly plane: 'governance';
      readonly method: HostPlaneMethodName<'governance'>;
      readonly args: readonly unknown[];
    }
  | {
      readonly seam: 'hostPlane';
      readonly plane: 'audit';
      readonly method: HostPlaneMethodName<'audit'>;
      readonly args: readonly unknown[];
    }
  | {
      readonly seam: 'hostPlane';
      readonly plane: 'entitlements';
      readonly method: HostPlaneMethodName<'entitlements'>;
      readonly args: readonly unknown[];
    };

/**
 * One host-RPC upcall as it crosses the wire: a {@link HostRpcCall} stamped with
 * the monotonic `rpcId` that correlates the matching {@link RpcReply}.
 */
export type HostRpcRequest = HostRpcCall & { readonly rpcId: number };

export type DispatchProgressEvent =
  | { readonly kind: 'host-rpc'; readonly request: HostRpcRequest }
  | { readonly kind: 'adapter-progress'; readonly event: ExternalAdapterProgressEvent };

/**
 * The host's reply to one {@link HostRpcRequest} (parent → child). Discriminated
 * by `ok`: a resolved value crosses as `{ ok: true, value }`; a host-side fault
 * crosses as `{ ok: false, error }` (a STRUCTURED rejection the worker shim
 * re-throws so the handler sees it as a normal thrown error — never a host
 * crash, never a silent no-op).
 */
export type RpcReply =
  | {
      readonly kind: 'rpc-reply';
      readonly rpcId: number;
      readonly ok: true;
      readonly value: unknown;
      /**
       * Host exit code AFTER the effect (seams like `deliverSignals` mutate
       * it); mirrored into the worker accumulator so sync `getExitCode()`
       * observes what an in-process handler would.
       */
      readonly hostExitCode?: number;
    }
  | {
      readonly kind: 'rpc-reply';
      readonly rpcId: number;
      readonly ok: false;
      readonly error: {
        readonly message: string;
        readonly code?: string;
        readonly stack?: string;
        /**
         * The host fault's canonical exit-class `ToolErrorCode`
         * (`canonicalToolErrorCode`) when it was a typed `ToolError` (e.g. a
         * `compareBaseline` rejection: `BASELINE_MISSING` /
         * `BASELINE_IDENTITY_MISMATCH` → `CONFIGURATION_ERROR`). The worker shim
         * rebuilds the matching `ToolError` subclass from it
         * (`toolErrorFromCanonicalCode`) so the handler re-throws a TYPED error —
         * preserving the exit class across the boundary instead of degrading it
         * to a plain `Error` (→ SystemError → exit 1). `code` carries the original
         * subcode for diagnostics; this carries the exit-class bucket.
         */
        readonly toolErrorCode?: string;
      };
    };
