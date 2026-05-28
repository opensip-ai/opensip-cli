// @fitness-ignore-file error-handling-quality -- safeIsDir/walk helpers for the workspace-units scan: statSync exception → "not a directory", readdirSync exception → "unreadable subdir, skip"; failure IS the function contract in each catch (already marked v8-ignore at each site as defensive/unreachable on real input).
// @fitness-ignore-file detached-promises -- `walk` is a synchronous filesystem walk function (declared with `function`, returns void); heuristic flags it because it's invoked inside an async-returning enclosing function.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type { WorkspaceUnit } from '@opensip-tools/core'

const PACKAGES_SEARCH_ROOT = 'packages'
const SEARCH_MAX_DEPTH = 3

/**
 * Walk <rootDir>/packages/** for directories containing tsconfig.json.
 * Each match becomes a WorkspaceUnit. Behavior matches the legacy
 * `discoverWorkspacePackages` in graph's scope.ts which this replaces.
 *
 * Returns absolute paths, sorted lexicographically.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function discoverTypescriptWorkspaceUnits(
  rootDir: string,
): Promise<readonly WorkspaceUnit[]> {
  const root = resolve(rootDir, PACKAGES_SEARCH_ROOT)
  if (!existsSync(root) || !safeIsDir(root)) return []
  const out: WorkspaceUnit[] = []
  walk(root, 0)
  out.sort((a, b) => a.rootDir.localeCompare(b.rootDir))
  return out

  function walk(dir: string, depth: number): void {
    if (depth > SEARCH_MAX_DEPTH) return
    const tsconfigPath = join(dir, 'tsconfig.json')
    if (existsSync(tsconfigPath)) {
      out.push({
        id: basename(dir),
        rootDir: dir,
        configPath: tsconfigPath,
      })
      return
    }
    let entries: readonly string[]
    try {
      entries = readdirSync(dir)
    } catch {
      /* v8 ignore next */
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue
      const sub = join(dir, entry)
      if (!safeIsDir(sub)) continue
      walk(sub, depth + 1)
    }
  }
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
