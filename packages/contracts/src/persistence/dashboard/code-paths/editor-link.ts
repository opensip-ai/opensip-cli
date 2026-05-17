/**
 * Editor deep-link URL generator — vscode://file/<path>:<line> etc.
 *
 * Phase P0 stub: returns null. Phase P9 reads `dashboard.editor` from
 * the embedded `EDITOR_PROTOCOL` constant and produces real URLs.
 */

export function dashboardEditorLinkJs(): string {
  return String.raw`
function editorLinkUrl(filePath, line) {
  if (typeof EDITOR_PROTOCOL !== 'string' || !EDITOR_PROTOCOL) return null;
  if (EDITOR_PROTOCOL === 'vscode' || EDITOR_PROTOCOL === 'cursor') {
    return EDITOR_PROTOCOL + '://file/' + filePath + ':' + (line || 1);
  }
  return null;
}
`;
}
