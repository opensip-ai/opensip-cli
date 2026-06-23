/**
 * @fileoverview Regression tests for the `toctou-race-condition` FP fix.
 *
 * The classifier treated a *chained* receiver (`state.lowlink.get(...)` then
 * `state.lowlink.set(...)`) as an unknown — hence shared — receiver, so the
 * "state bag of Maps" pattern common to iterative graph/DP algorithms (e.g.
 * Tarjan SCC's `TarjanState`) was flagged as a TOCTOU even though it is
 * single-threaded in-memory work. The fix recognizes `<obj>.<field>` where
 * `<obj>` is a parameter/local typed as a file-local interface/type whose
 * `<field>` is a `Map`/`Set`. These tests pin the FP and confirm genuine
 * read-then-update on shared persistent state still fires.
 */

import { describe, expect, it } from 'vitest';

import { analyzeFileForToctou } from '../toctou-race-condition.js';

function analyze(src: string): readonly { line: number }[] {
  // src/svc/* avoids the cache/cli/config/etc. safe-path skips.
  return analyzeFileForToctou('src/svc/sample.ts', src);
}

describe('toctou-race-condition — state-bag-of-Maps FP regression', () => {
  it('does NOT flag read-then-update on a state object whose interface fields are Maps', () => {
    const src = `
      interface TarjanState {
        readonly index: Map<string, number>;
        readonly lowlink: Map<string, number>;
        readonly onStack: Set<string>;
      }
      function step(state: TarjanState, v: string): void {
        const iv = state.lowlink.get(v);
        state.index.get(v);
        if (iv !== undefined) state.lowlink.set(v, iv);
        state.onStack.has(v);
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('recognizes the same pattern for a locally-declared state variable', () => {
    const src = `
      type Acc = { counts: Map<string, number> };
      function tally(keys: string[]): Acc {
        const acc: Acc = { counts: new Map() };
        for (const k of keys) {
          const cur = acc.counts.get(k) ?? 0;
          acc.counts.set(k, cur + 1);
        }
        return acc;
      }
    `;
    expect(analyze(src)).toHaveLength(0);
  });

  it('does NOT flag registry register() with destructured Map aliases', () => {
    const src = `
      class Registry {
        private readonly byId = new Map<string, string>();
        private readonly byName = new Map<string, string>();
        register(item: { id: string; name: string }): void {
          const { byId, byName } = this;
          const incumbent = byName.get(item.name);
          if (incumbent) return;
          byId.set(item.id, item.name);
          byName.set(item.name, item.name);
        }
      }
    `;
    expect(analyzeFileForToctou('packages/core/src/lib/registry.ts', src)).toHaveLength(0);
  });

  it('does NOT flag nested closures over a local Map', () => {
    const src = `
      function derive(): void {
        const nodeById = new Map<string, { id: string }>();
        const ensure = (id: string) => {
          let n = nodeById.get(id);
          if (!n) {
            n = { id };
            nodeById.set(id, n);
          }
          return n;
        };
        ensure('a');
      }
    `;
    expect(
      analyzeFileForToctou('packages/dashboard/src/code-paths/graph-view-model.ts', src),
    ).toHaveLength(0);
  });

  it('does NOT flag parse-cache filteredContent chains', () => {
    const src = `
      function filterContent(scope: { parseCache: { filteredContent: Map<string, string> } }, content: string): string {
        const cached = scope.parseCache.filteredContent.get(content);
        if (cached) return cached;
        scope.parseCache.filteredContent.set(content, content);
        return content;
      }
    `;
    expect(
      analyzeFileForToctou('packages/languages/lang-typescript/src/filter.ts', src),
    ).toHaveLength(0);
  });

  it('STILL flags genuine read-then-update on a shared persistent receiver', () => {
    const src = `
      async function updateUser(userRepo: UserRepository, id: string): Promise<void> {
        const user = await userRepo.findOne(id);
        user.lastSeen = Date.now();
        await userRepo.save(user);
      }
    `;
    expect(analyze(src).length).toBeGreaterThan(0);
  });
});
