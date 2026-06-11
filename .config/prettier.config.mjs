// @ts-check
/**
 * Prettier config for the opensip-tools workspace.
 *
 * Boundary (matches the repo's separation-of-concerns ethos):
 *   - Prettier owns LAYOUT  — whitespace, quotes, semicolons, line width,
 *     trailing commas. Nothing semantic.
 *   - ESLint owns QUALITY   — correctness, complexity, imports, idioms.
 *   - eslint-config-prettier (last entry in .config/eslint.config.mjs) turns
 *     off any ESLint rule that could fight Prettier, so the two never argue.
 *
 * Not auto-discovered — like every other config under .config/, this is
 * invoked explicitly via `--config` from the package.json `format` scripts.
 * The ignore list is a sibling `.prettierignore` at the REPO ROOT (passed via
 * `--ignore-path`), not here: a .config/-located ignore file anchors its
 * slash-bearing patterns to .config/ and silently fails to match repo-root
 * paths (docs/, .claude/ worktrees, etc.).
 *
 * Style choices below are the existing house style (single quotes, semicolons,
 * 2-space indent); printWidth is set to 100 because the codebase already writes
 * long single-line import/export and signal-policy statements past 80.
 *
 * @type {import('prettier').Config}
 */
export default {
  singleQuote: true,
  semi: true,
  printWidth: 100,
  // trailingComma 'all', tabWidth 2, arrowParens 'always' are Prettier 3
  // defaults and already match the tree — left implicit.
};
