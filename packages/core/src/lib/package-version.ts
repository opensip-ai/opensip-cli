import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-`metaUrl` cache. Each call site (typically a Tool's metadata
 * factory) hands in a stable `import.meta.url`, so the resolved
 * version is constant for the process lifetime. Memoizing avoids the
 * O(depth) `package.json` walk on every call as the helper sees more
 * adoption from third-party tools.
 */
const versionCache = new Map<string, string>();

/**
 * Read the nearest enclosing package.json's `version` field.
 *
 * Pass `import.meta.url` from the calling module. The function walks
 * up from that module's directory until it finds a package.json, then
 * returns its `version`. This is the standard way for a Tool to set
 * its `metadata.version` without duplicating the literal in source.
 *
 * Result is cached per `metaUrl` so subsequent calls from the same
 * module are O(1).
 *
 * Returns `'0.0.0'` if no package.json is found or if it lacks a
 * version field — Tools should treat that as "version unknown" rather
 * than crash. In practice this only happens in malformed installs.
 */
export function readPackageVersion(metaUrl: string): string {
  const cached = versionCache.get(metaUrl);
  if (cached !== undefined) return cached;

  let dir = dirname(fileURLToPath(metaUrl));
  const { root } = parse(dir);

  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        versionCache.set(metaUrl, pkg.version);
        return pkg.version;
      }
    } catch {
      // No package.json at this level — keep walking up.
    }

    if (dir === root) {
      versionCache.set(metaUrl, '0.0.0');
      return '0.0.0';
    }
    dir = dirname(dir);
  }
}
