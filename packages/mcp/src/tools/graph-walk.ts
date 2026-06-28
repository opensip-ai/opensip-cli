/**
 * `boundedBfs` — the single MCP traversal primitive (ADR-0084, Task 4.2).
 *
 * `who_calls`, `callees_of`, and `trace_path` are three callers of ONE
 * generic bounded-adjacency walk → rule of three satisfied. This helper lives in
 * `packages/mcp/` because it is MCP-specific traversal vocabulary: blast scoring
 * stays in `@opensip-cli/graph` (`buildFeatures(['blast'])`, reused via the
 * port), symbol projection stays in graph (`buildSymbolIndexEntries`) — neither
 * is reinvented here, and `boundedBfs` is NEVER pushed down into `core`/`graph`.
 *
 * The walk is over a body-hash adjacency map (the graph engine's
 * `Indexes.callers` / `Indexes.callees`, twin-union per ADR-0003). It is:
 *   - cycle-safe — a `visited` set guards re-entry,
 *   - depth-bounded — at most {@link HARD_MAX_DEPTH} BFS levels,
 *   - count-capped — stops at `cap` discovered nodes and reports `truncated`,
 *   - optionally goal-directed — returns the moment a `goal` node is reached,
 *     recording `parents` so the caller can reconstruct the path.
 */

/** Hard node cap on a single walk before `truncated` is set (mirrors the port's ceiling). */
export const MAX_WALK_NODES = 2000;

/**
 * Defence-in-depth depth ceiling, mirroring `schemas.MAX_DEPTH`. The Zod input
 * schema already clamps `depth` to `[1, 5]` at the boundary; this keeps the pure
 * walk correct even if invoked directly (tests) with an out-of-range depth.
 */
const HARD_MAX_DEPTH = 5;

export interface BoundedBfsOptions {
  /** BFS levels to expand (clamped to `[1, HARD_MAX_DEPTH]`). */
  readonly depth: number;
  /** Discovered-node ceiling; `<= 0` falls back to {@link MAX_WALK_NODES}. */
  readonly cap: number;
  /** When set, the walk returns the instant this node is reached (`foundGoal`). */
  readonly goal?: string;
}

export interface BoundedBfsResult {
  /** Nodes reached, in discovery order, EXCLUDING `start`. */
  readonly order: readonly string[];
  /** `node → predecessor` for every reached node (for path reconstruction). */
  readonly parents: ReadonlyMap<string, string>;
  /** `true` iff `opts.goal` was provided and reached within the bounds. */
  readonly foundGoal: boolean;
  /** `true` iff a depth/node cap truncated the walk. */
  readonly truncated: boolean;
}

function clampDepth(depth: number): number {
  if (!Number.isFinite(depth)) return HARD_MAX_DEPTH;
  return Math.min(Math.max(Math.trunc(depth), 1), HARD_MAX_DEPTH);
}

/**
 * Bounded, cycle-safe BFS from `start` over `adjacency`. Returns the reached
 * node set (discovery order), the predecessor map, whether `goal` was reached,
 * and whether a cap truncated the walk.
 */
export function boundedBfs(
  adjacency: ReadonlyMap<string, readonly string[]>,
  start: string,
  opts: BoundedBfsOptions,
): BoundedBfsResult {
  const maxDepth = clampDepth(opts.depth);
  const cap = opts.cap > 0 ? Math.trunc(opts.cap) : MAX_WALK_NODES;
  const visited = new Set<string>([start]);
  const parents = new Map<string, string>();
  const order: string[] = [];
  let frontier: string[] = [start];

  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbor of adjacency.get(node) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parents.set(neighbor, node);
        order.push(neighbor);
        if (neighbor === opts.goal) {
          return { order, parents, foundGoal: true, truncated: false };
        }
        if (order.length >= cap) {
          return { order, parents, foundGoal: false, truncated: true };
        }
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return { order, parents, foundGoal: false, truncated: false };
}

/**
 * Rebuild the path `start → … → goal` from a {@link BoundedBfsResult.parents}
 * map. Only meaningful when the walk reached `goal` (`foundGoal`).
 */
export function reconstructPath(
  parents: ReadonlyMap<string, string>,
  start: string,
  goal: string,
): string[] {
  const path: string[] = [];
  let cursor: string | undefined = goal;
  while (cursor !== undefined) {
    path.unshift(cursor);
    if (cursor === start) break;
    cursor = parents.get(cursor);
  }
  return path;
}
