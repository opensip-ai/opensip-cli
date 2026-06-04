/**
 * OpenSIP Cloud SignalSink (ADR-0008).
 *
 * The Strategy implementation that POSTs a run's `SignalBatch` to OpenSIP
 * Cloud, chunked, via the shared `postChunked` transport with the best-effort
 * policy. Wraps the sync in a `signal-sync` span and returns
 * `{ accepted, authRejected }`; it NEVER throws (the non-blocking invariant) —
 * the CLI uses `accepted` for the "Sent N signals" line and `authRejected` to
 * bust the entitlement cache.
 */
import { logger, withSpanAsync } from '@opensip-tools/core';

import { postChunked } from './http-egress.js';

import type { EmitResult, RepoIdentity, Signal, SignalBatch, SignalSink } from '@opensip-tools/core';

const MODULE_TAG = 'cloud-signal-sink';
const MAX_SIGNALS_PER_CHUNK = 500;
// Best-effort policy: try a little harder than reportToCloud, but bound the
// whole sync so a throttling server can never hang the CLI.
const POLICY = { maxAttempts: 4, overallDeadlineMs: 120_000, honorRetryAfter: true } as const;

/** Construction options for the OpenSIP Cloud signal sink: target endpoint, API key, and an injectable `fetch` for tests. */
export interface CloudSignalSinkOptions {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

/** One POST body: the envelope context + this chunk's slice of signals. */
interface ChunkBody {
  readonly schemaVersion: 1;
  readonly tool: string;
  readonly recipe?: string;
  readonly repo: RepoIdentity;
  readonly runId: string;
  readonly createdAt: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly signals: readonly Signal[];
}

function chunkBatch(batch: SignalBatch, size: number): ChunkBody[] {
  const groups: Signal[][] = [];
  for (let i = 0; i < batch.signals.length; i += size) {
    groups.push(batch.signals.slice(i, i + size));
  }
  return groups.map((signals, chunkIndex) => ({
    schemaVersion: batch.schemaVersion,
    tool: batch.tool,
    recipe: batch.recipe,
    repo: batch.repo,
    runId: batch.runId,
    createdAt: batch.createdAt,
    chunkIndex,
    chunkCount: groups.length,
    signals,
  }));
}

/** Build the OpenSIP Cloud signal sink. Selection/gating happens at the CLI; this just emits. */
export function createCloudSignalSink(opts: CloudSignalSinkOptions): SignalSink {
  return {
    async emit(batch: SignalBatch): Promise<EmitResult> {
      try {
        if (batch.signals.length === 0) return { accepted: 0, authRejected: false };
        const url = opts.endpoint.endsWith('/signals') ? opts.endpoint : `${opts.endpoint}/signals`;
        const chunks = chunkBatch(batch, MAX_SIGNALS_PER_CHUNK);

        const result = await withSpanAsync(
          'reporting',
          'signal-sync',
          async (span) => {
            const r = await postChunked({
              url,
              apiKey: opts.apiKey,
              chunks,
              idempotencyKeyFor: (i) => `${batch.runId}:${i}`,
              // @fitness-ignore-next-line null-safety -- `i` is the in-range index of the chunks array being posted; chunks[i] is always defined
              timeoutFor: (_chunk, i) => Math.min(120_000, 30_000 + chunks[i].signals.length * 50),
              policy: POLICY,
              evtPrefix: 'cli.signal-sync',
              fetchImpl: opts.fetchImpl,
            });
            span.setAttributes({
              tool: batch.tool,
              runId: batch.runId,
              'signal.count': batch.signals.length,
              'chunk.count': chunks.length,
              throttled: r.throttled,
              outcome: r.outcome,
            });
            return r;
          },
          { tool: batch.tool, runId: batch.runId },
        );

        const accepted = chunks.reduce(
          (n, c, i) => (result.chunkResults[i] ? n + c.signals.length : n),
          0,
        );
        logger.info({
          evt: 'cli.signal-sync.done',
          module: MODULE_TAG,
          accepted,
          outcome: result.outcome,
          authRejected: result.authRejected,
        });
        return { accepted, authRejected: result.authRejected };
      } catch (error) {
        // Defense in depth — postChunked never throws, but emit MUST NOT either.
        logger.info({
          evt: 'cli.signal-sync.error',
          module: MODULE_TAG,
          error: error instanceof Error ? error.message : String(error),
        });
        return { accepted: 0, authRejected: false };
      }
    },
  };
}
