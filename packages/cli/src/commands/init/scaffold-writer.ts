/**
 * Pure `.gitignore` rendering for transactional Init planning.
 *
 * Every customer filesystem mutation is materialized through the authored
 * transaction only after the fixed promotion journal is durable.
 */

const GITIGNORE_LINE = 'opensip-cli/.runtime/';

/** Pure byte renderer for Init's managed `.gitignore` entry. */
export function renderGitignore(existing: string | undefined): {
  readonly content: string;
  readonly changed: boolean;
} {
  if (existing === undefined) {
    return { content: `${GITIGNORE_LINE}\n`, changed: true };
  }
  if (existing.split('\n').some((line) => line.trim() === GITIGNORE_LINE)) {
    return { content: existing, changed: false };
  }

  const separator = existing.endsWith('\n') ? '' : '\n';
  return {
    content: `${existing}${separator}\n# opensip-cli runtime state\n${GITIGNORE_LINE}\n`,
    changed: true,
  };
}
