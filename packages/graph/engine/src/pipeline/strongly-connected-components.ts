/**
 * Iterative Tarjan strongly-connected components (graph-internal).
 * Shared by occurrence SCC features and package-cycle queries.
 */

interface TarjanFrame {
  readonly v: string;
  ai: number;
}

/**
 * Compute SCCs over `nodes` with `neighbors(v)`. Deterministic: components'
 * members are sorted; input node order is preserved for discovery order.
 * Stack-safe iterative Tarjan; O(V+E).
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- iterative Tarjan SCC algorithm
export function stronglyConnectedComponents(
  nodes: readonly string[],
  neighbors: (v: string) => readonly string[],
): readonly (readonly string[])[] {
  const result: string[][] = [];
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let nextIndex = 0;

  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: TarjanFrame[] = [{ v: start, ai: 0 }];
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const v = frame.v;
      if (frame.ai === 0) {
        index.set(v, nextIndex);
        lowlink.set(v, nextIndex);
        nextIndex++;
        stack.push(v);
        onStack.add(v);
      }
      const adjV = neighbors(v);
      let descended = false;
      while (frame.ai < adjV.length) {
        const w = adjV[frame.ai++];
        if (w === undefined) continue;
        if (!index.has(w)) {
          work.push({ v: w, ai: 0 });
          descended = true;
          break;
        } else if (onStack.has(w)) {
          const iw = index.get(w)!;
          if (iw < lowlink.get(v)!) lowlink.set(v, iw);
        }
      }
      if (descended) continue;
      if (lowlink.get(v) === index.get(v)) {
        const members: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          members.push(w);
          if (w === v) break;
        }
        members.sort();
        result.push(members);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work.at(-1)!.v;
        if (lowlink.get(v)! < lowlink.get(parent)!) {
          lowlink.set(parent, lowlink.get(v)!);
        }
      }
    }
  }
  return result;
}
