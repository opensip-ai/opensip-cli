/**
 * Tool contract conformance test (AC-2).
 *
 * Asserts:
 *  - graphTool.metadata.id === 'graph'
 *  - graphTool.metadata.version matches package.json
 *  - graphTool.commands lists the unified `graph` analysis subcommand
 *    plus the two read-only catalog query commands (`graph-lookup`,
 *    `graph-symbol-index`) added alongside the codeindex-parity work.
 *    Orphans and entry-points were folded into the unified `graph`
 *    output — they remain output sections, not separate commands.
 *  - Since release 2.11.0 Phase 5 graph mounts via declarative
 *    `commandSpecs`, not the deprecated `register()` hook.
 *  - graphTool does NOT import from opensip-tools (compile-time
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

  it("metadata.id is 'graph'", () => {
    expect(graphTool.metadata.id).toBe('graph');
  });

  it('metadata.version matches package.json', () => {
    expect(graphTool.metadata.version).toBe(pkg.version);
  });

  it('commands lists the unified graph subcommand plus the lookup/symbol-index/baseline-export queries', () => {
    const names = graphTool.commands.map((c) => c.name);
    expect(names).toEqual([
      'graph',
      'graph-lookup',
      'graph-symbol-index',
      'graph-baseline-export',
      'graph-shard-worker',
      'graph-equivalence-check',
      'graph-run-worker',
      'catalog-export',
      'sarif-export',
      'graph-recipes',
    ]);
  });

  it('mounts via commandSpecs, not the deprecated register() hook', () => {
    // One spec per declared command, in declaration order.
    const specNames = (graphTool.commandSpecs ?? []).map((s) => s.name);
    expect(specNames).toEqual([
      'graph',
      'graph-lookup',
      'graph-shard-worker',
      'graph-run-worker',
      'graph-symbol-index',
      'graph-baseline-export',
      'catalog-export',
      'sarif-export',
      'graph-recipes',
      'graph-equivalence-check',
    ]);
  });
});
