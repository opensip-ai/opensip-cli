/**
 * Tool contract conformance test (AC-2).
 *
 * Asserts:
 *  - graphTool.metadata.name === 'graph' (human key); .id is stable UUID
 *  - graphTool.metadata.version matches package.json
 *  - graphTool.commands lists the unified `graph` analysis subcommand
 *    plus the nested catalog query commands (`graph lookup`, `graph index`)
 *    added alongside the codeindex-parity work. Orphans and entry-points
 *    were folded into the unified `graph` output — they remain output
 *    sections, not separate commands.
 *  - Since release 2.11.0 Phase 5 graph mounts via declarative
 *    `commandSpecs`, not the deprecated `register()` hook.
 *  - graphTool does NOT import from opensip-cli (compile-time
 *    via TypeScript imports — if it did, package wouldn't build)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { graphTool } from '../tool.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('graphTool contract conformance (AC-2)', () => {
  const pkgPath = resolve(HERE, '../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

  it("metadata.name is the human key 'graph'; id is the stable UUID", () => {
    expect(graphTool.metadata.name).toBe('graph');
    expect(graphTool.metadata.id).toBe('3873f1c2-02a9-4719-930a-bca74b62b706');
  });

  it('metadata.version matches package.json', () => {
    expect(graphTool.metadata.version).toBe(pkg.version);
  });

  it('commands lists the unified graph subcommand plus the nested export/lookup/index/recipes/list queries', () => {
    const names = graphTool.commands.map((c) => c.name);
    expect(names).toEqual([
      'graph',
      'graph-shard-worker',
      'graph-equivalence-check',
      'graph-run-worker',
      // Canonical nested export — mounts as `graph export` (parent: 'graph').
      'export',
      // Grouped Tier-2 children (the canonical `<tool> <verb>` grammar) —
      // name 'recipes' / 'lookup' / 'index' / 'list', parent 'graph'.
      'recipes',
      'lookup',
      'index',
      'list',
    ]);
    // The legacy flat-root aliases are gone.
    for (const legacy of [
      'graph-lookup',
      'graph-symbol-index',
      'graph-baseline-export',
      'catalog-export',
      'sarif-export',
      'graph-recipes',
    ]) {
      expect(names).not.toContain(legacy);
    }
  });

  it('mounts via commandSpecs, not the deprecated register() hook', () => {
    // One spec per declared command, in declaration order.
    const specNames = (graphTool.commandSpecs ?? []).map((s) => s.name);
    expect(specNames).toEqual([
      'graph',
      'graph-shard-worker',
      'graph-run-worker',
      // Canonical nested export spec — name 'export', parent 'graph'.
      'export',
      // Grouped Tier-2 children (the canonical `<tool> <verb>` grammar) —
      // name 'recipes' / 'lookup' / 'index' / 'list', parent 'graph'.
      'recipes',
      'lookup',
      'index',
      'list',
      'graph-equivalence-check',
    ]);
  });
});
