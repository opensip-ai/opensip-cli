// @fitness-ignore-file batch-operation-limits -- iterates a bounded collection (one symbol's declarations for a single method-call resolution), mirroring the property-access resolver.
/**
 * Type-attested cross-package METHOD target resolution (ADR-0033 follow-up).
 *
 * For a method call `recv.m()` the boundary extractor needs the TYPE-resolved
 * target file (not a syntactic name) to emit a cross-package boundary call. This
 * mirrors the symbol resolution `resolvePropertyAccessCall` does, but returns the
 * `m` decl's SOURCE file (the package's `dist/*.d.ts` mapped to source) rather
 * than a catalog hash — so the cross-shard linker can pin it post-merge against
 * the merged catalog, identically in both engines.
 */

import { relative, sep } from 'node:path';

import ts from 'typescript';

import { unaliasSymbol } from './unalias-symbol.js';

/**
 * The project-relative SOURCE file a method call's callee resolves to, when that
 * callee's declaration is a workspace package's built `dist/*.d.ts` — `null`
 * otherwise. `null` when: not a property-access call; the checker has no symbol;
 * the decl is SOURCE (the in-shard/inline pass handles it) or a non-workspace
 * `.d.ts` (`node_modules`, `lib.dom`, a non-`dist` ambient). The dist→src mapping
 * follows the tsc `outDir:dist` / `rootDir:src` convention; a wrong mapping just
 * fails to match an occurrence at the linker and declines (never fabricates).
 */
export function methodTargetFile(
  node: ts.Node,
  checker: ts.TypeChecker,
  projectDirAbs: string,
): string | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const symbol = checker.getSymbolAtLocation(node.expression);
  if (!symbol) return null;
  const real = unaliasSymbol(symbol, checker);
  for (const d of real.getDeclarations() ?? []) {
    const sf = d.getSourceFile();
    // A SOURCE decl means the method lives in a file the in-shard/inline pass can
    // hash directly — not a cross-package boundary. Stop (don't keep scanning
    // other decls): the first declaration is the canonical one.
    if (!sf.isDeclarationFile) return null;
    const rel = relative(projectDirAbs, sf.fileName).split(sep).join('/');
    if (!rel.endsWith('.d.ts') || !rel.includes('/dist/')) return null;
    // (1) Workspace-package built dist — how the single-program (EXACT) build
    //     resolves `@scope/pkg`: `packages/X/dist/sub.d.ts` -> `packages/X/src/sub.ts`.
    if (!rel.includes('/node_modules/')) {
      return rel.replace('/dist/', '/src/').replace(/\.d\.ts$/, '.ts');
    }
    // (2) The SAME workspace package resolved through pnpm's INJECTED copy — how
    //     each SHARDED shard's per-shard program resolves `@scope/pkg`:
    //     `node_modules/.pnpm/<pkg>@file+<encoded-workspace>/node_modules/<pkg>/dist/sub.d.ts`.
    //     pnpm encodes the workspace path with `+` for `/` (e.g. `@file+packages+core`,
    //     a trailing `_<peer-hash>`). Decode it so the shard maps to the SAME
    //     `packages/X/src/sub.ts` the exact build does; otherwise method boundary
    //     calls resolve in exact but decline sharded (a `/node_modules/` reject),
    //     breaking sharded≡exact. A real npm `.d.ts` (no `@file+`) stays declined.
    //     Done with index/slice (not one regex) to stay ReDoS-free (sonarjs/slow-regex).
    return decodeInjectedDist(rel);
  }
  return null;
}

/**
 * Decode a pnpm-injected workspace `.d.ts` path to its workspace SOURCE path, or
 * `null`. `rel` is a `/node_modules/`-bearing, `/dist/`-bearing `.d.ts` path; the
 * mapping recovers the `<workspace>/src/<sub>.ts` the EXACT build resolves to,
 * from the `@file+<encoded-workspace>` segment pnpm writes into the `.pnpm` dir
 * name (`/`→`+`, optional trailing `_<peer-hash>`). Pure `indexOf`/`slice` — no
 * unbounded-backtracking regex (sonarjs/slow-regex). A non-injected `node_modules`
 * `.d.ts` (no `@file+`) returns `null` — a real npm dependency, not a workspace pkg.
 */
export function decodeInjectedDist(rel: string): string | null {
  const PNPM = '/.pnpm/';
  const pnpmAt = rel.indexOf(PNPM);
  const distAt = rel.indexOf('/dist/');
  if (pnpmAt === -1 || distAt === -1) return null;
  const dirEnd = rel.indexOf('/', pnpmAt + PNPM.length);
  if (dirEnd === -1) return null;
  const pnpmDir = rel.slice(pnpmAt + PNPM.length, dirEnd);
  const encoded = encodedWorkspaceFromPnpmDir(pnpmDir);
  if (encoded === null) return null;
  const sub = rel.slice(distAt + '/dist/'.length).replace(/\.d\.ts$/, '.ts');
  return `${encoded.split('+').join('/')}/src/${sub}`;
}

/**
 * Extract the `@file+packages[+segment…]` workspace path from a pnpm virtual-store
 * directory name, stopping before peer-dep suffixes (`_@types+…`) or `/`.
 */
function encodedWorkspaceFromPnpmDir(pnpmDir: string): string | null {
  const marker = '@file+';
  const fileAt = pnpmDir.indexOf(marker);
  if (fileAt === -1) return null;
  const start = fileAt + marker.length;
  if (!pnpmDir.startsWith('packages', start)) return null;
  const end = scanEncodedSegments(pnpmDir, start + 'packages'.length);
  if (end === -1) return null;
  const encoded = pnpmDir.slice(start, end);
  return encoded.length > 0 ? encoded : null;
}

/**
 * From `pos`, consume `+segment` groups (`segment` = `[a-z0-9-]+`), stopping at a
 * peer-dep suffix (`_`), a `/`, or end-of-string. Returns the stop index, or `-1`
 * on a malformed run (an empty segment, or any char that is neither `+`/`_`/`/`).
 */
function scanEncodedSegments(pnpmDir: string, from: number): number {
  let pos = from;
  while (pos < pnpmDir.length) {
    const ch = pnpmDir[pos];
    if (ch === '_' || ch === '/') return pos;
    if (ch !== '+') return -1;
    pos++;
    const segStart = pos;
    while (pos < pnpmDir.length && isEncodedSegmentChar(pnpmDir[pos])) pos++;
    if (pos === segStart) return -1;
  }
  return pos;
}

function isEncodedSegmentChar(c: string | undefined): boolean {
  return c !== undefined && /[a-z0-9-]/.test(c);
}
