// @fitness-ignore-file env-via-registry -- debug-only diagnostic harness, opt-in via the GRAPH_SITE_LOG / GRAPH_ENGINE env vars; NOT production configuration. Reading process.env directly is intentional and isolated to this one module so the cross-shard resolver stays registry-clean. See docs/internal/graph-resolution-trace.md.
/**
 * Per-boundary-call resolution trace (debug-only). The cross-shard counterpart
 * of graph-typescript's `traceResolveDecl`: when `GRAPH_SITE_LOG` points at a
 * file, every `resolveOne` decision appends one TSV row keyed by the full
 * project-relative `ownerFile:line:column` so the exact and sharded logs join
 * exactly. OFF with zero cost when the env var is unset.
 */

/* v8 ignore start -- debug-only; exercised manually via GRAPH_SITE_LOG, never in the test suite */
import { appendFileSync } from 'node:fs';

import type { CrossBoundaryCall } from '../../types.js';

/** Append one resolveOne decision row when GRAPH_SITE_LOG is set; else a no-op. */
export function traceResolveOne(
  bc: CrossBoundaryCall,
  branch: string,
  to: readonly string[],
): void {
  const logPath = process.env.GRAPH_SITE_LOG;
  if (logPath === undefined) return;
  const line =
    [
      `${process.env.GRAPH_ENGINE ?? '?'}:resolveOne`,
      `${bc.ownerFile}:${String(bc.line)}:${String(bc.column)}`,
      bc.calleeName,
      `branch=${branch}`,
      `spec=${bc.importSpecifier ?? '-'}`,
      `out=${to.length > 0 ? to[0]?.slice(0, 10) : 'DECLINE'}`,
    ].join('\t') + '\n';
  appendFileSync(logPath, line);
}
/* v8 ignore stop */
