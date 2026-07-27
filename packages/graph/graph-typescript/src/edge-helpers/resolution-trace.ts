// @fitness-ignore-file env-via-registry -- debug-only diagnostic harness, opt-in via the GRAPH_SITE_LOG / GRAPH_ENGINE env vars; NOT production configuration. Reading process.env directly is intentional and isolated to this one module so the production resolvers stay registry-clean. See a local working note
/**
 * Per-site resolution trace (debug-only). When `GRAPH_SITE_LOG` points at a
 * file, every `resolveDeclToHash` decision appends one TSV row:
 *   engine \t ownerFile \t callee \t decl=<file> \t dts=<bool> \t spec=<...> \t out=<hash|DECLINE-*>
 *
 * This is the harness that root-caused the exact↔sharded divergence classes
 * (the decl-file discriminator + the matching-strictness asymmetry). It is OFF
 * with zero production cost when the env var is unset; kept so the next
 * divergence investigation starts from measurement, not a rebuilt harness.
 */

import { appendFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { logger, normalizeFailure, scrubText } from '@opensip-cli/core';

import type { ResolutionTraceSink, ResolverContext } from '../edge-resolvers/types.js';
import type ts from 'typescript';

const MAX_TRACE_ROWS = 10_000;
const MAX_TRACE_BYTES = 2_000_000;
const MAX_TRACE_FIELD_LENGTH = 300;

/** Create one bounded, failure-latched trace sink for an enclosing resolution pass. */
export function createResolutionTrace(): ResolutionTraceSink | undefined {
  const logPath = process.env.GRAPH_SITE_LOG;
  if (logPath === undefined) return;
  let enabled = true;
  let rows = 0;
  let bytes = 0;
  return {
    append(fields): void {
      if (!enabled || rows >= MAX_TRACE_ROWS) return;
      const line = `${fields.map(safeTraceField).join('\t')}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (bytes + lineBytes > MAX_TRACE_BYTES) {
        enabled = false;
        logger.warn({
          evt: 'graph.resolution_trace.disabled',
          module: 'graph:resolution-trace',
          condition: 'size-cap',
        });
        return;
      }
      try {
        appendFileSync(logPath, line);
        rows += 1;
        bytes += lineBytes;
      } catch (error) {
        enabled = false;
        const failure = normalizeFailure(error);
        logger.warn({
          evt: 'graph.resolution_trace.disabled',
          module: 'graph:resolution-trace',
          condition: 'write-failed',
          errorCode: failure.code,
        });
      }
    },
  };
}

function safeTraceField(value: string): string {
  return scrubText(value.replaceAll(/[\t\r\n]/gu, ' '), MAX_TRACE_FIELD_LENGTH);
}

/** The inputs of one `resolveDeclToHash` decision, as traced by {@link traceResolveDecl}. */
export interface ResolveDeclDecision {
  readonly ctx: ResolverContext;
  readonly candidateNames: readonly string[];
  readonly bindingNames: readonly string[];
  readonly declSourceFile: ts.SourceFile;
  readonly dts: boolean;
  readonly out: string | null;
}

/** Append one resolveDeclToHash decision row when GRAPH_SITE_LOG is set; else a no-op. */
export function traceResolveDecl(decision: ResolveDeclDecision): void {
  const { ctx, candidateNames, bindingNames, declSourceFile, dts, out } = decision;
  if (ctx.resolutionTrace === undefined) return;
  const owner = relative(ctx.projectDirAbs, ctx.sourceFile.fileName).split(sep).join('/');
  const declRel = relative(ctx.projectDirAbs, declSourceFile.fileName).split(sep).join('/');
  const specifiers = bindingNames.map((b) => ctx.importSpecifiers.get(b) ?? '-').join(',');
  const declineStr = dts ? 'DECLINE-dts-hop' : 'DECLINE-source';
  const outStr = out === null ? declineStr : out.slice(0, 10);
  ctx.resolutionTrace.append([
    process.env.GRAPH_ENGINE ?? '?',
    owner,
    candidateNames.join('|'),
    `decl=${declRel}`,
    `dts=${String(dts)}`,
    `spec=${specifiers}`,
    `out=${outStr}`,
  ]);
}
