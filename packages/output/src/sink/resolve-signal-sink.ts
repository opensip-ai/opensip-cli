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
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  currentScope,
  logger,
  noopSignalSink,
  normalizeFailure,
  scrubText,
  toOperatorFailureProjection,
} from '@opensip-cli/core';

import { createCloudSignalSink } from './cloud-signal-sink.js';
import { checkEntitlement, invalidateEntitlement } from './entitlement.js';
import { isHttpsUrl } from './https-url.js';

import type { EmitResult, SignalBatch, SignalSink } from '@opensip-cli/core';

/** Built-in OpenSIP Cloud base URL; the sink appends `/signals`. Overridable via config. */
export const DEFAULT_CLOUD_ENDPOINT = 'https://opensip.ai/api';

const MODULE_TAG = 'resolve-signal-sink';

// Bound + scrub the egress failure cause before it reaches the local log: a
// cloud error can echo the endpoint URL with query credentials or an auth
// header value in its message. Never log the API key or a request/response
// body — only this scrubbed, truncated cause.
const MAX_ERR_CHARS = 300;
/** Scrubbed, length-bounded error cause for `output.sink.emit.error`. */
function scrubbedErrorCause(error: unknown): string {
  const projection = toOperatorFailureProjection(normalizeFailure(error));
  const message =
    typeof projection.message === 'string' ? projection.message : 'The operation failed.';
  return message.length > MAX_ERR_CHARS ? `${message.slice(0, MAX_ERR_CHARS)}…` : message;
}

export interface ResolveSignalSinkInput {
  readonly apiKey?: string;
  readonly cloud?: { readonly sync?: boolean; readonly endpoint?: string };
  /** `--no-cloud` per-run opt-out. */
  readonly noCloud?: boolean;
  /** Directory for the entitlement cache (user-level). */
  readonly cacheDir: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * One-time privacy notice the first time the cloud sink goes active, telling
 * the user what is synced and how to opt out (ADR-0008). Marker lives in the
 * entitlement cache dir; best-effort — a failure just shows it again next run.
 */
async function maybeShowFirstRunNotice(cacheDir: string): Promise<void> {
  const marker = join(cacheDir, 'signal-sync-notice');
  try {
    await access(marker);
    return; // already shown
  } catch {
    /* not shown yet */
  }
  try {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(marker, new Date().toISOString());
    process.stderr.write(
      'OpenSIP Cloud signal sync is on: each run sends its signals (file paths,\n' +
        'messages, suggestions, code-location hints) to your OpenSIP Cloud account.\n' +
        'Local results are unaffected. Disable with --no-cloud or `cloud.sync: false`.\n',
    );
  } catch {
    /* best-effort */
  }
}

export function resolveSignalSink(input: ResolveSignalSinkInput): SignalSink {
  const { apiKey } = input;
  // Cheap opt-out paths — no IO.
  if (!apiKey) return noopSignalSink;
  if (input.noCloud || input.cloud?.sync === false) return noopSignalSink;

  const endpoint = input.cloud?.endpoint ?? DEFAULT_CLOUD_ENDPOINT;
  if (!isHttpsUrl(endpoint)) {
    // Never send the credential-bearing X-API-Key over plaintext.
    try {
      logger.warn({
        evt: 'cli.signal-sync.insecure-endpoint',
        module: MODULE_TAG,
        endpoint: scrubText(endpoint, 512),
      });
    } catch {
      // The opt-out decision must remain synchronous and non-throwing.
    }
    return noopSignalSink;
  }

  const cloudSink = createCloudSignalSink({ endpoint, apiKey, fetchImpl: input.fetchImpl });

  // Deferred sink: entitlement is checked lazily/cached on first emit.
  return {
    async emit(batch: SignalBatch): Promise<EmitResult> {
      try {
        const rootSignal = currentScope()?.abortSignal;
        const ent = await checkEntitlement({
          apiKey,
          endpoint,
          now: Date.now(),
          cacheDir: input.cacheDir,
          fetchImpl: input.fetchImpl,
          ...(rootSignal === undefined ? {} : { signal: rootSignal }),
        });
        if (!ent.entitled) return { accepted: 0, authRejected: false, skippedReason: 'unentitled' };

        await maybeShowFirstRunNotice(input.cacheDir);
        const result = await cloudSink.emit(batch);
        if (result.authRejected) {
          await invalidateEntitlement({ apiKey, cacheDir: input.cacheDir });
        }
        return result;
      } catch (error) {
        // Belt and suspenders — emit MUST NOT throw into the run. But the
        // user-facing "cloud sync skipped — see the run log" notice must
        // resolve to a real entry, so log the cause first (itself guarded:
        // a logging failure must not break the never-throws contract).
        try {
          logger.warn({
            evt: 'output.sink.emit.error',
            module: MODULE_TAG,
            err: scrubbedErrorCause(error),
          });
        } catch {
          /* never-throws contract outranks the diagnostic */
        }
        return { accepted: 0, authRejected: false, skippedReason: 'error' };
      }
    },
  };
}
