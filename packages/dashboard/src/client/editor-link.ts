/**
 * Editor deep-link URL generator.
 *
 * Reads the embedded `EDITOR_PROTOCOL` constant set by `generator.ts`
 * (passed through from `dashboard.editor` in opensip-cli.config.yml).
 * Recognized values: 'vscode', 'cursor'. Anything else returns null and
 * the Function Card falls back to a "Copy path" button.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`. The
 * `EDITOR_PROTOCOL` page global is declared in `globals.ts`.
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

export function editorLinkUrl(filePath: string, line: number): string | null {
  if (!isSafeEditorLinkPath(filePath)) return null;
  if (typeof EDITOR_PROTOCOL !== 'string' || !EDITOR_PROTOCOL) return null;
  if (EDITOR_PROTOCOL === 'vscode' || EDITOR_PROTOCOL === 'cursor') {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    return EDITOR_PROTOCOL + '://file/' + encodedPath + ':' + (line || 1);
  }
  return null;
}
