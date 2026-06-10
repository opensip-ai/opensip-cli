/**
 * @fileoverview The graph cross-shard MERGE layer may not key/stitch call edges
 * by a bare `bodyHash`/`ownerHash` — it must route owner identity through the
 * ONE shared module, `cli/orchestrate/edge-identity.ts` (ADR-0003; the graph
 * engine-convergence work).
 *
 * WHY (the drift this freezes out):
 *   ADR-0003 mandates edges be keyed by OCCURRENCE — `ownerEdgeKey(bodyHash,
 *   filePath)` — not by `bodyHash` alone: two functions with byte-identical
 *   bodies in different files share a hash, so a hash-only edge bucket UNIONS
 *   their edges into phantom cross-package coupling, and a hash-only relative
 *   pin resolves against the wrong twin's directory. The EXACT path always
 *   complied; the CROSS-SHARD merge drifted — it bucketed/stitched edges and
 *   built a `bodyHash→file` map keyed by `ownerHash` alone (a second keying
 *   scheme). That was the F1 violation, now migrated onto `edge-identity.ts`.
 *
 *   This guardrail keeps the merge layer "pure orchestration": it fires when a
 *   file under `packages/graph/engine/src/cli/orchestrate/` (the merge/stitch
 *   layer) OTHER than `edge-identity.ts` performs a `Map` operation
 *   (`.get(...)` / `.set(...)`) or an `appendEdge(...)` whose KEY is a BARE
 *   `<x>.bodyHash` / `<x>.ownerHash` — i.e. an edge bucket keyed by a raw hash
 *   rather than through the shared `ownerEdgeKey` / `bucketEdgesByOwner` /
 *   `stitchEdgesByOwner` helpers.
 *
 * NOT flagged (the compliant tree):
 *   - keys wrapped in `ownerEdgeKey(<x>.bodyHash, <x>.filePath)` — the canonical
 *     occurrence key (the allowed path).
 *   - bare-hash reads that are NOT map keys (sort comparators `a.bodyHash`, set
 *     membership `set.add(o.bodyHash)`, edge TARGETS `o.bodyHash`, composite
 *     string keys `${o.bodyHash}@...`).
 *   - the per-adapter resolvers (`graph-typescript/go/java/...`) which bucket
 *     edges during in-program resolution — they are a different layer (the TS
 *     adapter already keys by `ownerEdgeKey`; the merge is what this freezes).
 *
 * SELF-TARGETING — inspects opensip-tools' own graph merge sources only. The
 * path guard makes the check inert in adopter repos and exempts the one allowed
 * home (`edge-identity.ts`).
 */
import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness';

/** The graph cross-shard MERGE layer (where the F1 drift lived). */
const MERGE_LAYER_SEGMENT = 'packages/graph/engine/src/cli/orchestrate/';

/** The ONE module allowed to key edges by a raw hash (it owns ownerEdgeKey). */
const IDENTITY_MODULE_SUFFIX = '/edge-identity.ts';

/** A `__tests__` file is fixture-shaped, not production merge code. */
const TEST_SEGMENT = '/__tests__/';

/** True when a path is a merge-layer source file this check governs. */
function isMergeLayerFile(filePath: string): boolean {
  const p = filePath.replaceAll('\\', '/');
  return (
    p.includes(MERGE_LAYER_SEGMENT) &&
    !p.endsWith(IDENTITY_MODULE_SUFFIX) &&
    !p.includes(TEST_SEGMENT)
  );
}

/**
 * A `Map` op (`.get`/`.set`) whose KEY (the FIRST argument) is a BARE
 * `<ident>.bodyHash` / `<ident>.ownerHash`. A key wrapped in `ownerEdgeKey(...)`
 * is compliant and never matches — the `.get(`/`.set(` immediately precedes the
 * hash member access only when the raw hash IS the key.
 */
const MAP_OP_KEY_RE = /\.(?:get|set)\(\s*[A-Za-z_$][\w$]*\.(bodyHash|ownerHash)\b/g;

/**
 * An `appendEdge(<map>, <key>, ...)` whose KEY (the SECOND argument) is a BARE
 * `<ident>.bodyHash` / `<ident>.ownerHash`. Same compliance rule: a key wrapped
 * in `ownerEdgeKey(...)` does not match (the member access isn't immediately
 * after the comma).
 */
const APPEND_EDGE_KEY_RE =
  /appendEdge\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\.(bodyHash|ownerHash)\b/g;

/**
 * Pure analysis over one merge-layer source file. Returns a finding for each
 * bare-hash edge-map key (a `Map` op / `appendEdge` keyed by `<x>.bodyHash` or
 * `<x>.ownerHash`). Exported for unit tests.
 */
export function analyzeNoBodyhashKeyingOutsideIdentity(
  content: string,
  filePath: string,
): CheckViolation[] {
  if (!isMergeLayerFile(filePath)) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, rawLine] of lines.entries()) {
    // Skip comment lines so prose explaining the keying isn't flagged.
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    const matches = [...rawLine.matchAll(MAP_OP_KEY_RE), ...rawLine.matchAll(APPEND_EDGE_KEY_RE)];
    for (const m of matches) {
      const hashField = m[1];
      violations.push({
        line: i + 1,
        filePath,
        message:
          `Edge map keyed by a bare '${hashField}' in the graph cross-shard merge ` +
          `layer, outside cli/orchestrate/edge-identity.ts. ADR-0003 requires edges ` +
          `be keyed by OCCURRENCE — ownerEdgeKey(bodyHash, filePath) — so body-twins ` +
          `(identical bodies in different files) never smear each other's edges.`,
        severity: 'error',
        suggestion:
          `Route owner identity through cli/orchestrate/edge-identity.ts: bucket via ` +
          `bucketEdgesByOwner, stitch via stitchEdgesByOwner, and form keys with ` +
          `ownerEdgeKey(<x>.bodyHash, <x>.filePath) — never a raw '${hashField}'. The ` +
          `cross-shard merge is pure orchestration; it owns no independent keying.`,
        type: 'no-bodyhash-keying-outside-identity',
      });
    }
  }
  return violations;
}

/**
 * Walk every scanned file and run {@link analyzeNoBodyhashKeyingOutsideIdentity}.
 * Exported so unit tests can drive it with an in-memory `FileAccessor`.
 */
export async function analyzeAllNoBodyhashKeyingOutsideIdentity(
  files: FileAccessor,
): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = [];
  const candidates = files.paths.filter((p) => p.endsWith('.ts') && isMergeLayerFile(p));
  const contents = await files.readMany(candidates);
  for (const [filePath, content] of contents) {
    violations.push(...analyzeNoBodyhashKeyingOutsideIdentity(content, filePath));
  }
  return violations;
}

export const noBodyhashKeyingOutsideIdentity = defineCheck({
  id: 'f3a2c1d4-5b6e-4f70-8a9c-0d1e2f3a4b5c',
  slug: 'no-bodyhash-keying-outside-identity',
  description:
    'The graph cross-shard merge must key/stitch edges through ownerEdgeKey in cli/orchestrate/edge-identity.ts, never by a bare bodyHash/ownerHash (ADR-0003)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  // raw content: the map-key shape is a code member-access, not a string.
  contentFilter: 'raw',
  analyzeAll: analyzeAllNoBodyhashKeyingOutsideIdentity,
});
