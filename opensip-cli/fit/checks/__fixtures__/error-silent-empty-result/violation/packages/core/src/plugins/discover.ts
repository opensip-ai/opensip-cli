/**
 * VIOLATION fixture (R1) — reduced from the REAL confirmed site
 * `packages/core/src/plugins/discover.ts` (`discoverLooseFilesInDir`).
 *
 * Every `readdirSync` errno is swallowed to the empty accumulator, so under fd
 * exhaustion or EIO the user-authored checks/scenarios/recipes tree contributes
 * ZERO plugins and the run still reports success. The caller cannot tell that
 * from "this project has no plugins".
 *
 * Expected: ONE `error-silent-empty-result` finding on the `return plugins;`.
 */
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

interface DiscoveredPlugin {
  readonly type: 'file';
  readonly entryPoint: string;
}

const LOOSE_FILE_EXTENSIONS = new Set(['.js', '.mjs']);

export function discoverLooseFilesInDir(dir: string): DiscoveredPlugin[] {
  const plugins: DiscoveredPlugin[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return plugins;
  }

  for (const entry of entries) {
    if (!LOOSE_FILE_EXTENSIONS.has(extname(entry))) continue;
    plugins.push({ type: 'file', entryPoint: join(dir, entry) });
  }

  return plugins;
}
