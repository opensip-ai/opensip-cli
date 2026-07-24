/**
 * Editor deep-link URL generator.
 *
 * Reads the embedded `EDITOR_PROTOCOL` constant set by `generator.ts`
 * (passed through from `dashboard.editor` in opensip-cli.config.yml).
 * Recognized values: 'vscode', 'cursor'. Anything else returns null and
 * the Function Card falls back to a "Copy path" button.
 *
 * The `vscode://file/` / `cursor://file/` scheme requires an ABSOLUTE
 * filesystem path — catalog/risk paths are repo-relative, so the generator
 * also embeds the `PROJECT_ROOT` the report was built from (`generator.ts`),
 * and this module posix-joins the two into an absolute path before building
 * the URL. Legacy payloads that predate `PROJECT_ROOT` (or carry a malformed
 * one) hide the link rather than emit one the editor cannot resolve.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`. The
 * `EDITOR_PROTOCOL` / `PROJECT_ROOT` page globals are declared in `globals.ts`.
 */

function isSafeEditorLinkPath(filePath: string): boolean {
  if (
    filePath.length === 0 ||
    filePath.length > 4096 ||
    filePath.startsWith('/') ||
    filePath.startsWith('\\') ||
    /^[A-Za-z]:/u.test(filePath) ||
    filePath.includes('\\') ||
    /\p{Cc}/u.test(filePath)
  ) {
    return false;
  }
  return filePath.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

// PROJECT_ROOT must itself be an absolute path (posix `/...` or a Windows
// drive-letter root) — anything else (relative, empty, garbage) means the
// generator couldn't supply a resolvable root, so the caller hides the link.
function isAbsoluteProjectRoot(root: string): boolean {
  return root.length > 0 && (root.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(root));
}

// Posix-join the (trusted, host-supplied) project root with the (untrusted,
// catalog-supplied) repo-relative path. Backslashes in a Windows root are
// normalized to forward slashes so the joined path — and the resulting
// `file/`-scheme URL — stays posix-shaped throughout.
function toAbsoluteEditorPath(projectRoot: string, relativePath: string): string {
  const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/+$/u, '');
  return normalizedRoot + '/' + relativePath;
}

// Percent-encode each path segment for safe embedding in a `file/`-scheme
// URL, except a bare Windows drive letter ('C:') — RFC 3986 allows an
// unescaped ':' in a path segment, and re-encoding it (to '%3A') is not
// reliably understood by editor URL handlers.
function encodePathForEditorUrl(absolutePath: string): string {
  return absolutePath
    .split('/')
    .map((segment) => (/^[A-Za-z]:$/u.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
}

export function editorLinkUrl(filePath: string, line: number): string | null {
  if (!isSafeEditorLinkPath(filePath)) return null;
  if (typeof EDITOR_PROTOCOL !== 'string' || !EDITOR_PROTOCOL) return null;
  if (EDITOR_PROTOCOL !== 'vscode' && EDITOR_PROTOCOL !== 'cursor') return null;
  if (typeof PROJECT_ROOT !== 'string' || !isAbsoluteProjectRoot(PROJECT_ROOT)) return null;
  const absolutePath = toAbsoluteEditorPath(PROJECT_ROOT, filePath);
  const encodedPath = encodePathForEditorUrl(absolutePath);
  return EDITOR_PROTOCOL + '://file/' + encodedPath + ':' + (line || 1);
}
