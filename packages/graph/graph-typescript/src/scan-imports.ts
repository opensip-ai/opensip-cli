/**
 * Program-free file→file import scan (ADR-0045).
 *
 * Partition-time consumer: community shard partitioning needs a cheap,
 * deterministic import graph BEFORE any semantic program exists.
 * `ts.preProcessFile` lexically enumerates import / export-from /
 * require specifiers with no AST binding and no `ts.Program`; each
 * specifier is then resolved with `ts.resolveModuleName` against the
 * shared module-resolution host plus a per-invocation resolution cache.
 *
 * Contract (see `GraphLanguageAdapter.scanImports`):
 * - deterministic for a fixed file tree — output sorted by (from, to),
 *   deduplicated, independent of input `files` order;
 * - both edge endpoints inside `input.files` — external / bare
 *   specifiers (and `.d.ts` resolutions outside the set) are dropped;
 * - self-loops dropped.
 */

import { realpathSync } from 'node:fs';

import ts from 'typescript';

import { createModuleResolutionHost } from './module-resolution.js';

import type { ScanImportsInput, ScanImportsOutput } from '@opensip-tools/graph';

/**
 * Realpath a resolved target, falling back to the input path when the
 * probe fails (same pattern as discover.ts — file may sit in a
 * symlinked dir). Discovery files are realpath-normalized, so resolved
 * targets must be realpath'd before set-membership checks.
 */
function safeRealpath(path: string): string {
  /* v8 ignore start */
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
  /* v8 ignore stop */
}

/** Sort edges by (from, to) and drop adjacent duplicates. */
function dedupeSorted(edges: readonly (readonly [string, string])[]): [string, string][] {
  const sorted = [...edges].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  const out: [string, string][] = [];
  for (const [from, to] of sorted) {
    const last = out.at(-1);
    if (last !== undefined && last[0] === from && last[1] === to) continue;
    out.push([from, to]);
  }
  return out;
}

export function scanImports(input: ScanImportsInput): ScanImportsOutput {
  const fileSet = new Set(input.files);
  const compilerOptions = (input.compilerOptions ?? {}) as ts.CompilerOptions;
  const host = createModuleResolutionHost();
  // Per-invocation cache — NEVER module-level (no module-singleton state).
  const cache = ts.createModuleResolutionCache(input.projectDirAbs, (f) => f, compilerOptions);
  const edges: [string, string][] = [];
  for (const file of input.files) {
    const content = host.readFile(file);
    if (content === undefined) continue;
    const pre = ts.preProcessFile(
      content,
      /* readImportFiles */ true,
      /* detectJavaScriptImports */ true,
    );
    const specifiers = [...new Set(pre.importedFiles.map((r) => r.fileName))].sort();
    for (const specifier of specifiers) {
      const resolution = ts.resolveModuleName(specifier, file, compilerOptions, host, cache);
      const resolved = resolution.resolvedModule?.resolvedFileName;
      if (resolved === undefined) continue;
      const target = safeRealpath(resolved);
      // Self-loops + externals/.d.ts outside the candidate set are dropped.
      if (target === file || !fileSet.has(target)) continue;
      edges.push([file, target]);
    }
  }
  return { edges: dedupeSorted(edges) };
}
