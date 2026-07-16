/**
 * Union-Find used by near-duplicate component clustering.
 * Kept separate so the detection algorithm file stays under the soft length limit.
 */

export class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
    this.rank = Array.from({ length: size }, () => 0);
  }

  find(x: number): number {
    const p = this.parent[x];
    if (p === undefined || p === x) return x;
    const root = this.find(p);
    this.parent[x] = root;
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank[ra] ?? 0;
    const rankB = this.rank[rb] ?? 0;
    if (rankA < rankB) {
      this.parent[ra] = rb;
    } else if (rankA > rankB) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra] = rankA + 1;
    }
  }
}
