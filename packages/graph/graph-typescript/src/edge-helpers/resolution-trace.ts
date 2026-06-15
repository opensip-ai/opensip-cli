// @fitness-ignore-file env-via-registry -- debug-only diagnostic harness, opt-in via the GRAPH_SITE_LOG / GRAPH_ENGINE env vars; NOT production configuration. Reading process.env directly is intentional and isolated to this one module so the production resolvers stay registry-clean. See docs/internal/graph-resolution-trace.md.
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

/* v8 ignore start -- debug-only; exercised manually via GRAPH_SITE_LOG, never in the test suite */
import { appendFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import type { ResolverContext } from '../edge-resolvers/types.js';
import type ts from 'typescript';

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
  const logPath = process.env.GRAPH_SITE_LOG;
  if (logPath === undefined) return;
  const { ctx, candidateNames, bindingNames, declSourceFile, dts, out } = decision;
  const owner = relative(ctx.projectDirAbs, ctx.sourceFile.fileName).split(sep).join('/');
  const declRel = relative(ctx.projectDirAbs, declSourceFile.fileName).split(sep).join('/');
  const specifiers = bindingNames.map((b) => ctx.importSpecifiers.get(b) ?? '-').join(',');
  const declineStr = dts ? 'DECLINE-dts-hop' : 'DECLINE-source';
  const outStr = out === null ? declineStr : out.slice(0, 10);
  const line =
    [
      process.env.GRAPH_ENGINE ?? '?',
      owner,
      candidateNames.join('|'),
      `decl=${declRel}`,
      `dts=${String(dts)}`,
      `spec=${specifiers}`,
      `out=${outStr}`,
    ].join('\t') + '\n';
  appendFileSync(logPath, line);
}
/* v8 ignore stop */
