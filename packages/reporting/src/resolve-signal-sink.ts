/**
 * resolveSignalSink — choose the SignalSink for a run (ADR-0008).
 *
 * Sync and cheap: the opt-out paths (no API key, `cloud.sync: false`,
 * `--no-cloud`, a non-https endpoint) return `noopSignalSink` with zero IO, so
 * non-signal commands and the keyless OSS majority pay nothing. When cloud sync
 * is viable it returns a **deferred** sink: the entitlement check runs lazily on
 * the first `emit` (and is cached), so only signal-producing runs incur it, and
 * a revoked plan (401/403) busts the entitlement cache so it stops within one run.
 */
import { logger, noopSignalSink } from '@opensip-tools/core';

import { createCloudSignalSink } from './cloud-signal-sink.js';
import { checkEntitlement, invalidateEntitlement } from './entitlement.js';

import type { EmitResult, SignalBatch, SignalSink } from '@opensip-tools/core';

/** Built-in OpenSIP Cloud base URL; the sink appends `/signals`. Overridable via config. */
export const DEFAULT_CLOUD_ENDPOINT = 'https://opensip.ai/api';

const MODULE_TAG = 'resolve-signal-sink';

export interface ResolveSignalSinkInput {
  readonly apiKey?: string;
  readonly cloud?: { readonly sync?: boolean; readonly endpoint?: string };
  /** `--no-cloud` per-run opt-out. */
  readonly noCloud?: boolean;
  /** Directory for the entitlement cache (user-level). */
  readonly cacheDir: string;
  readonly fetchImpl?: typeof fetch;
}

export function resolveSignalSink(input: ResolveSignalSinkInput): SignalSink {
  const { apiKey } = input;
  // Cheap opt-out paths — no IO.
  if (!apiKey) return noopSignalSink;
  if (input.noCloud || input.cloud?.sync === false) return noopSignalSink;

  const endpoint = input.cloud?.endpoint ?? DEFAULT_CLOUD_ENDPOINT;
  if (!endpoint.startsWith('https://')) {
    // Never send the credential-bearing X-API-Key over plaintext.
    logger.warn({ evt: 'cli.signal-sync.insecure-endpoint', module: MODULE_TAG, endpoint });
    return noopSignalSink;
  }

  const cloudSink = createCloudSignalSink({ endpoint, apiKey, fetchImpl: input.fetchImpl });

  // Deferred sink: entitlement is checked lazily/cached on first emit.
  return {
    async emit(batch: SignalBatch): Promise<EmitResult> {
      try {
        const ent = await checkEntitlement({
          apiKey,
          endpoint,
          now: Date.now(),
          cacheDir: input.cacheDir,
          fetchImpl: input.fetchImpl,
        });
        if (!ent.entitled) return { accepted: 0, authRejected: false };

        const result = await cloudSink.emit(batch);
        if (result.authRejected) {
          await invalidateEntitlement({ apiKey, cacheDir: input.cacheDir });
        }
        return result;
      } catch {
        // Belt and suspenders — emit MUST NOT throw into the run.
        return { accepted: 0, authRejected: false };
      }
    },
  };
}
