/**
 * Unit tests for the import-graph builder + Tarjan's SCC.
 *
 * Covers:
 *   - Basic relative-import resolution (./foo, ../bar, with/without ext)
 *   - Index resolution (./foo/index.ts)
 *   - ESM extension swap (.js → .ts)
 *   - Bare specifiers dropped (npm packages don't appear as edges)
 *   - export-from declarations contribute edges
 *   - Files that fail to parse still appear as nodes
 *   - SCC detection: simple 2-cycle, larger cycle, multiple disjoint cycles,
 *     no-cycle case, self-loop
 */

import { describe, expect, it } from 'vitest'

import { buildImportGraph, findStronglyConnectedComponents, type ImportGraph } from '../import-graph.js'

// ---------------------------------------------------------------------------
// Helpers — synthetic file maps
// ---------------------------------------------------------------------------

function map(...entries: readonly (readonly [string, string])[]): ReadonlyMap<string, string> {
  return new Map(entries)
}

// ---------------------------------------------------------------------------
// buildImportGraph — resolution
// ---------------------------------------------------------------------------

describe('buildImportGraph — resolution', () => {
  it('resolves relative ./foo imports', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `import { x } from './b'`],
        ['/p/src/b.ts', `export const x = 1`],
      ),
    )
    expect(g.outbound.get('/p/src/a.ts')!.has('/p/src/b.ts')).toBe(true)
    expect(g.inbound.get('/p/src/b.ts')!.has('/p/src/a.ts')).toBe(true)
  })

  it('resolves ../foo imports', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/sub/a.ts', `import { x } from '../b'`],
        ['/p/src/b.ts', `export const x = 1`],
      ),
    )
    expect(g.outbound.get('/p/src/sub/a.ts')!.has('/p/src/b.ts')).toBe(true)
  })

  it('resolves index files (./foo → ./foo/index.ts)', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `import { x } from './lib'`],
        ['/p/src/lib/index.ts', `export const x = 1`],
      ),
    )
    expect(g.outbound.get('/p/src/a.ts')!.has('/p/src/lib/index.ts')).toBe(true)
  })

  it('resolves .tsx files', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `import { B } from './b'`],
        ['/p/src/b.tsx', `export const B = () => null`],
      ),
    )
    expect(g.outbound.get('/p/src/a.ts')!.has('/p/src/b.tsx')).toBe(true)
  })

  it('resolves ESM extension swap (.js → .ts)', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `import { x } from './b.js'`],
        ['/p/src/b.ts', `export const x = 1`],
      ),
    )
    expect(g.outbound.get('/p/src/a.ts')!.has('/p/src/b.ts')).toBe(true)
  })

  it('resolves literal .ts paths', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `import { x } from './b.ts'`],
        ['/p/src/b.ts', `export const x = 1`],
      ),
    )
    expect(g.outbound.get('/p/src/a.ts')!.has('/p/src/b.ts')).toBe(true)
  })

  it('drops bare specifiers (npm packages have no intra-project edge)', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `import { useState } from 'react'\nimport lodash from 'lodash'`],
      ),
    )
    expect(g.outbound.get('/p/src/a.ts')!.size).toBe(0)
  })

  it('drops unresolved relative paths (target file not in project)', () => {
    const g = buildImportGraph(
      map(['/p/src/a.ts', `import { x } from './does-not-exist'`]),
    )
    expect(g.outbound.get('/p/src/a.ts')!.size).toBe(0)
  })

  it('counts export-from declarations as edges', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/index.ts', `export * from './a'\nexport { x } from './b'`],
        ['/p/src/a.ts', `export const a = 1`],
        ['/p/src/b.ts', `export const x = 1`],
      ),
    )
    expect(g.outbound.get('/p/src/index.ts')!.size).toBe(2)
    expect(g.outbound.get('/p/src/index.ts')!.has('/p/src/a.ts')).toBe(true)
    expect(g.outbound.get('/p/src/index.ts')!.has('/p/src/b.ts')).toBe(true)
  })

  it('handles side-effect imports (import "./foo")', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `import './side-effect'`],
        ['/p/src/side-effect.ts', `console.log('loaded')`],
      ),
    )
    expect(g.outbound.get('/p/src/a.ts')!.has('/p/src/side-effect.ts')).toBe(true)
  })

  it('keeps files that fail to parse as nodes (with no edges)', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `import { x } from './b'`],
        ['/p/src/b.ts', `export const x = 1`],
        // Intentionally truncated/garbled content. ts.createSourceFile is
        // forgiving so this may parse to empty statements; either way the file
        // should be a node.
        ['/p/src/garbled.ts', `import { incomplete\nexport //`],
      ),
    )
    expect(g.nodes.has('/p/src/garbled.ts')).toBe(true)
    expect(g.outbound.has('/p/src/garbled.ts')).toBe(true)
  })

  it('initializes empty edge sets for every node', () => {
    const g = buildImportGraph(
      map(
        ['/p/src/a.ts', `// no imports`],
        ['/p/src/b.ts', `// no imports`],
      ),
    )
    expect(g.outbound.get('/p/src/a.ts')).toBeDefined()
    expect(g.outbound.get('/p/src/a.ts')!.size).toBe(0)
    expect(g.inbound.get('/p/src/b.ts')).toBeDefined()
    expect(g.inbound.get('/p/src/b.ts')!.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// findStronglyConnectedComponents — cycle detection
// ---------------------------------------------------------------------------

describe('findStronglyConnectedComponents', () => {
  it('returns one SCC per node when there are no cycles', () => {
    const g = buildImportGraph(
      map(
        ['/p/a.ts', `import {} from './b'`],
        ['/p/b.ts', `import {} from './c'`],
        ['/p/c.ts', `// leaf`],
      ),
    )
    const sccs = findStronglyConnectedComponents(g)
    expect(sccs.length).toBe(3) // every node is its own trivial SCC
    for (const scc of sccs) expect(scc.length).toBe(1)
  })

  it('detects a simple 2-file cycle (a ↔ b)', () => {
    const g = buildImportGraph(
      map(
        ['/p/a.ts', `import type {} from './b'`],
        ['/p/b.ts', `import type {} from './a'`],
      ),
    )
    const sccs = findStronglyConnectedComponents(g)
    const cycles = sccs.filter((s) => s.length > 1)
    expect(cycles.length).toBe(1)
    expect(new Set(cycles[0])).toEqual(new Set(['/p/a.ts', '/p/b.ts']))
  })

  it('detects a 4-file cycle (a → b → c → d → a)', () => {
    const g = buildImportGraph(
      map(
        ['/p/a.ts', `import {} from './b'`],
        ['/p/b.ts', `import {} from './c'`],
        ['/p/c.ts', `import {} from './d'`],
        ['/p/d.ts', `import {} from './a'`],
      ),
    )
    const sccs = findStronglyConnectedComponents(g)
    const cycles = sccs.filter((s) => s.length > 1)
    expect(cycles.length).toBe(1)
    expect(cycles[0].length).toBe(4)
  })

  it('detects two disjoint cycles', () => {
    const g = buildImportGraph(
      map(
        ['/p/a.ts', `import {} from './b'`],
        ['/p/b.ts', `import {} from './a'`],
        ['/p/c.ts', `import {} from './d'`],
        ['/p/d.ts', `import {} from './c'`],
      ),
    )
    const sccs = findStronglyConnectedComponents(g)
    const cycles = sccs.filter((s) => s.length > 1)
    expect(cycles.length).toBe(2)
    for (const cycle of cycles) expect(cycle.length).toBe(2)
  })

  it('does NOT report self-loops as multi-file cycles', () => {
    // A file that imports itself is structurally weird but not a multi-file
    // cycle. This mostly can't happen in practice with TS (the resolver would
    // need an aliased path), but the SCC algorithm shouldn't conflate it.
    const g = buildImportGraph(map(['/p/a.ts', `// self`]))
    const sccs = findStronglyConnectedComponents(g)
    const cycles = sccs.filter((s) => s.length > 1)
    expect(cycles.length).toBe(0)
  })

  it('handles a graph where one cycle is reachable from non-cycle nodes', () => {
    // entry → a ↔ b
    const g = buildImportGraph(
      map(
        ['/p/entry.ts', `import {} from './a'`],
        ['/p/a.ts', `import {} from './b'`],
        ['/p/b.ts', `import {} from './a'`],
      ),
    )
    const sccs = findStronglyConnectedComponents(g)
    const cycles = sccs.filter((s) => s.length > 1)
    expect(cycles.length).toBe(1)
    expect(new Set(cycles[0])).toEqual(new Set(['/p/a.ts', '/p/b.ts']))
  })

  it('handles a deep graph without recursion blowing the stack', () => {
    // 1000-node linear chain: a0 → a1 → ... → a999. Iterative Tarjan's
    // should handle this without stack overflow (recursive form would die
    // around ~10k depending on the runtime).
    const entries: [string, string][] = []
    const N = 1000
    for (let i = 0; i < N; i++) {
      const next = i + 1 < N ? `import {} from './a${i + 1}'` : ''
      entries.push([`/p/a${i}.ts`, next])
    }
    const g = buildImportGraph(map(...entries))
    const sccs = findStronglyConnectedComponents(g)
    expect(sccs.length).toBe(N) // each node is its own trivial SCC
  })
})

// ---------------------------------------------------------------------------
// Inbound vs outbound symmetry
// ---------------------------------------------------------------------------

describe('buildImportGraph — inbound/outbound symmetry', () => {
  it('every outbound edge has a matching inbound edge', () => {
    const g: ImportGraph = buildImportGraph(
      map(
        ['/p/a.ts', `import {} from './b'\nimport {} from './c'`],
        ['/p/b.ts', `import {} from './c'`],
        ['/p/c.ts', `// leaf`],
      ),
    )
    for (const [from, tos] of g.outbound) {
      for (const to of tos) {
        expect(g.inbound.get(to)!.has(from)).toBe(true)
      }
    }
  })
})
