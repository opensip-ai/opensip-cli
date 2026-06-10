/**
 * `toPosixPath` — normalize OS path separators to POSIX `/`.
 *
 * The engine relativizes file paths against a project root and then matches them
 * with `/`-anchored logic (`packageOf`'s regex, the package-group keys, subpath
 * stems). On Windows `path.relative` yields `\`-separated paths, so every such
 * path must be normalized first. Backslashes are collapsed UNCONDITIONALLY (not
 * gated on `path.sep`) so a stray `\` from any caller still flattens to `/` and
 * the normalization is self-consistent regardless of the path's origin.
 *
 * One shared helper so the export index, the manifest index, and the shard
 * partitioner share a single normalization (they previously each inlined a
 * slightly different `toPosix`).
 */
export function toPosixPath(p: string): string {
  return p.replaceAll('\\', '/');
}
