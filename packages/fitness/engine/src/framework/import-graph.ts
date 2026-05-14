/**
 * @fileoverview Project-wide import graph builder.
 *
 * Builds a file-level dependency graph from a set of TypeScript/JavaScript
 * source files, plus a Tarjan's strongly-connected-components implementation
 * for cycle detection. Used by structural-drift checks like
 * circular-import-detection and module-coupling-fan-out.
 *
 * Module resolution is deliberately a heuristic: relative imports are
 * resolved by trying common extension/index.ts suffixes; bare specifiers
 * (npm packages) are dropped; tsconfig path aliases are NOT resolved
 * (treated as unresolved — they simply don't appear as edges in the graph).
 *
 * This matches the heuristic the existing `phantom-dependency-detection`
 * check uses, which has been shipping reliably. Adding tsconfig-aware
 * resolution is a follow-up plan.
 */

import * as path from 'node:path'

import ts from 'typescript'

import { getSharedSourceFile } from './parse-cache.js'

// =============================================================================
// PUBLIC TYPES
// =============================================================================

/** A file-level import graph for a project. */
export interface ImportGraph {
  /** All node file paths (absolute, as supplied by the caller). */
  readonly nodes: ReadonlySet<string>
  /** Adjacency: file → set of files it imports (intra-project edges only). */
  readonly outbound: ReadonlyMap<string, ReadonlySet<string>>
  /** Reverse adjacency: file → set of files that import it. */
  readonly inbound: ReadonlyMap<string, ReadonlySet<string>>
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Build an import graph from a collection of file paths and their content.
 *
 * Each file's TS AST is walked for top-level `import` and `export ... from`
 * declarations. Relative specifiers (`./foo`, `../bar/baz.js`) are resolved
 * against the importing file's directory using the heuristic in
 * `resolveRelativeSpecifier`. Bare specifiers (`react`, `lodash`) are
 * dropped — they don't represent intra-project edges.
 *
 * Files that fail to parse are still added as nodes (with no edges) so the
 * graph remains complete.
 */
export function buildImportGraph(files: ReadonlyMap<string, string>): ImportGraph {
  const nodes = new Set<string>(files.keys())
  const outbound = new Map<string, Set<string>>()
  const inbound = new Map<string, Set<string>>()

  // Initialize empty edge sets for every node so callers can safely
  // outbound.get(file) without checking for undefined.
  for (const node of nodes) {
    outbound.set(node, new Set())
    inbound.set(node, new Set())
  }

  for (const [filePath, content] of files) {
    const specifiers = extractImportSpecifiers(filePath, content)
    for (const spec of specifiers) {
      const resolved = resolveRelativeSpecifier(filePath, spec, nodes)
      if (resolved !== null) {
        outbound.get(filePath)!.add(resolved)
        inbound.get(resolved)!.add(filePath)
      }
    }
  }

  return { nodes, outbound, inbound }
}

/**
 * Find strongly-connected components in the graph using Tarjan's algorithm.
 *
 * Returns an array of SCCs, each represented as an array of node names. SCCs
 * of size 1 represent a node with no cycle (or a self-loop, which is rare in
 * import graphs). Cycle-detection callers typically filter to `scc.length > 1`
 * to get only real multi-file cycles.
 *
 * Algorithm: standard iterative Tarjan's SCC. O(V + E), single pass.
 */
export function findStronglyConnectedComponents(
  graph: ImportGraph,
): readonly (readonly string[])[] {
  const indexOf = new Map<string, number>()
  const lowlinkOf = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let nextIndex = 0

  // Iterative Tarjan's — recursive form blows the stack on large graphs.
  // State machine: we replay each node's adjacency from where we left off.
  interface Frame {
    node: string
    neighbors: string[]
    next: number
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- iterative Tarjan SCC: explicit stack to avoid recursion; the algorithm is canonical and reads cleanest as a single function
  function strongConnect(start: string): void {
    const callStack: Frame[] = []

    indexOf.set(start, nextIndex)
    lowlinkOf.set(start, nextIndex)
    nextIndex++
    stack.push(start)
    onStack.add(start)
    callStack.push({
      node: start,
      neighbors: [...(graph.outbound.get(start) ?? [])],
      next: 0,
    })

    while (callStack.length > 0) {
      const frame = callStack.at(-1)!

      if (frame.next < frame.neighbors.length) {
        const w = frame.neighbors[frame.next]
        frame.next++

        if (!indexOf.has(w)) {
          // Recurse into w.
          indexOf.set(w, nextIndex)
          lowlinkOf.set(w, nextIndex)
          nextIndex++
          stack.push(w)
          onStack.add(w)
          callStack.push({
            node: w,
            neighbors: [...(graph.outbound.get(w) ?? [])],
            next: 0,
          })
          continue
        }

        if (onStack.has(w)) {
          // Back edge — update v's lowlink.
          const vLow = lowlinkOf.get(frame.node)!
          const wIdx = indexOf.get(w)!
          if (wIdx < vLow) lowlinkOf.set(frame.node, wIdx)
        }
        continue
      }

      // All neighbors processed — finalize this node.
      const v = frame.node
      const vLow = lowlinkOf.get(v)!
      const vIdx = indexOf.get(v)!

      if (vLow === vIdx) {
        // v is the root of an SCC — pop until v is removed.
        const scc: string[] = []
        let w: string
        do {
          w = stack.pop()!
          onStack.delete(w)
          scc.push(w)
        } while (w !== v)
        sccs.push(scc)
      }

      callStack.pop()

      // Propagate lowlink up to the parent frame.
      if (callStack.length > 0) {
        const parent = callStack.at(-1)!
        const parentLow = lowlinkOf.get(parent.node)!
        if (vLow < parentLow) lowlinkOf.set(parent.node, vLow)
      }
    }
  }

  for (const node of graph.nodes) {
    if (!indexOf.has(node)) {
      strongConnect(node)
    }
  }

  return sccs
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Walk the AST and collect top-level import / export-from specifiers. */
function extractImportSpecifiers(filePath: string, content: string): string[] {
  const sourceFile = getSharedSourceFile(filePath, content)
  if (sourceFile === null) return []

  const specifiers: string[] = []
  for (const stmt of sourceFile.statements) {
    // import foo from './bar';  import './side-effect';  import * as ns from './m';
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      specifiers.push(stmt.moduleSpecifier.text)
      continue
    }
    // export * from './foo';   export { x } from './foo';
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier !== undefined &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      specifiers.push(stmt.moduleSpecifier.text)
    }
  }
  return specifiers
}

/**
 * Resolve a module specifier to an actual file path in the project, or
 * return null if the specifier is non-relative (npm package, path alias) or
 * doesn't resolve to a known project file.
 *
 * Supports:
 *   - `./foo` → `<dir>/foo.ts`, `.tsx`, `/index.ts`, `/index.tsx`
 *   - `./foo.js` → `<dir>/foo.ts` (ESM extension swap, common in TS+ESM)
 *   - `./foo.ts` → `<dir>/foo.ts` (literal)
 *   - `../bar/baz` → resolved relative to importer's directory
 *
 * Does NOT support:
 *   - tsconfig `paths` aliases (deferred per plan)
 *   - npm packages (correctly dropped — out of scope for intra-project graph)
 */
function resolveRelativeSpecifier(
  importerPath: string,
  specifier: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  // Only relative specifiers participate in the intra-project graph.
  if (!specifier.startsWith('.')) return null

  const importerDir = path.dirname(importerPath)
  const base = path.resolve(importerDir, specifier)

  // Try the candidate paths in priority order. The first one that exists in
  // the project's file set wins.
  const candidates: string[] = [ base]

  // 1. Literal path (specifier already includes extension).

  // 2. ESM extension swap: `.js` → `.ts` / `.tsx` (TypeScript ESM convention).
  if (base.endsWith('.js')) {
    candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx')
  }
  if (base.endsWith('.jsx')) {
    candidates.push(base.slice(0, -4) + '.tsx')
  }

  // 3. Append common extensions if the specifier was extension-less.
  const hasExt = path.extname(base) !== ''
  if (!hasExt) {
    // Direct extensions and index resolution.
    candidates.push(
      base + '.ts',
      base + '.tsx',
      base + '.js',
      base + '.jsx',
      path.join(base, 'index.ts'),
      path.join(base, 'index.tsx'),
      path.join(base, 'index.js'),
      path.join(base, 'index.jsx'),
    )
  }

  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate
  }
  return null
}
