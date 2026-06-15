/**
 * Editor deep-link URL generator.
 *
 * Reads the embedded `EDITOR_PROTOCOL` constant set by `generator.ts`
 * (passed through from `dashboard.editor` in opensip-cli.config.yml).
 * Recognized values: 'vscode', 'cursor'. Anything else returns null and
 * the Function Card falls back to a "Copy path" button.
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
