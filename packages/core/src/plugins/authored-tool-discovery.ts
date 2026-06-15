/**
 * @fileoverview Authored-Tool sidecar discovery (kernel).
 *
 * Finds authored `Tool` sidecars — `<root>/<name>/opensip-tool.manifest.json`
 * — under a single authored `tools/` root and returns source-tagged-by-caller
 * candidates the host can route through admission.
 *
 * This is the authored analogue of the npm-marker walker
 * (`marker-discovery.ts`): a `safeReaddir` over a directory, skipping
 * dotfiles, returning `{name, dir}`. It differs in *shape* — it scans an
 * authored `tools/` root (one level: each child dir is a tool), not a
 * `node_modules` tree, and keys on the SIDECAR FILE's presence rather than a
 * `package.json` marker. It reads NO module code (identity only) and does NOT
 * call `loadToolManifest`/`admitTool` — discovery is *location*, admission is
 * the caller's concern.
 *
 * The walk is intentionally SOURCE-AGNOSTIC: it takes a plain `string` root
 * and never infers a `ToolSource` from path shape. The caller assigns the
 * source per root (project root ⇒ `project-local`, global root ⇒
 * `user-global`), so one walk serves both authored roots and the source tag
 * is carried, never inferred inside the kernel.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../lib/logger.js';

import { PROJECT_LOCAL_MANIFEST_FILE } from './manifest-loader.js';
import { safeReaddir } from './node-modules-walk.js';

/** A directory under an authored `tools/` root that carries a sidecar manifest. */
export interface AuthoredToolCandidate {
  /** Directory containing the opensip-tool.manifest.json sidecar. */
  readonly dir: string;
  /** Directory name (the authored tool's folder name) — for diagnostics. */
  readonly name: string;
}

/**
 * Discover authored-Tool sidecars under an authored `tools/` root.
 *
 * Lists `root`'s immediate children (skipping dotfiles) and returns each child
 * directory that contains an `opensip-tool.manifest.json` sidecar. A missing
 * root yields `[]` (best-effort, mirrors `discoverPackagesInNodeModules`'s
 * `existsSync` guard). Presence of the sidecar IS the discovery signal —
 * validity/admission is the caller's concern, so the walk stays pure and
 * source-agnostic (one walk serves the project and global roots).
 *
 * @param root An authored `tools/` root — `<project>/opensip-cli/tools` or
 *   `~/.opensip-cli/tools`. NOT inferred-from here; the caller assigns the
 *   `ToolSource` per root.
 */
export function discoverAuthoredToolSidecars(root: string): AuthoredToolCandidate[] {
  if (!existsSync(root)) return [];
  const out: AuthoredToolCandidate[] = [];
  for (const name of safeReaddir(root)) {
    if (name.startsWith('.')) continue;
    const dir = join(root, name);
    if (!existsSync(join(dir, PROJECT_LOCAL_MANIFEST_FILE))) continue;
    out.push({ dir, name });
    logger.debug({
      evt: 'core.authored_tool.discovered',
      module: 'core:plugins',
      dir,
    });
  }
  return out;
}
