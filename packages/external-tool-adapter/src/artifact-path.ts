/**
 * @fileoverview Pure scanner-artifact path composition (ADR-0091, Phase-0
 * decision 1).
 *
 * `ProjectPaths.artifactDir(tool)` (host-owned) = `<artifacts>/<tool>`. The
 * RUN segment is substrate-side: `resolveScannerArtifactPath` composes
 * `<artifactDir(tool)>/<runId>/<name>`. So the immediate children of
 * `artifactDir(tool)` are the per-run dirs the host's `pruneArtifactRetention`
 * treats as retention units — host and substrate agree on the boundary without a
 * 3-arg `ProjectPaths` method.
 */

import { join } from 'node:path';

/** The minimal path scope the resolver needs (a `ProjectPaths` satisfies it). */
export interface ArtifactPathScope {
  /** `<artifacts>/<tool>` (host-owned path family, ADR-0091). */
  readonly artifactDir: (tool: string) => string;
  /** This invocation's run id — the per-run artifact segment. */
  readonly runId: string;
}

/**
 * Compose the host-owned artifact path for a scanner output file:
 * `<artifactDir(tool)>/<runId>/<name>`. Pure — no IO. The bytes are persisted
 * through `cli.writeArtifact(path, bytes)` (the host seam, ADR-0080), never a
 * raw `fs` write.
 */
export function resolveScannerArtifactPath(
  scope: ArtifactPathScope,
  tool: string,
  name: string,
): string {
  return join(scope.artifactDir(tool), scope.runId, name);
}
