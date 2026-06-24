/**
 * Canonical language id by file extension — engine-homed for rule gating.
 *
 * The near-clone rule must gate candidate pairs to the same language. The
 * equivalent filter in graph-adapter-common cannot be imported from the engine
 * rule layer (adapter-common depends on the engine). This module is the
 * canonical extension map consumed by rules; adapter-common may delegate here
 * in a follow-up.
 */

/**
 * Extension suffix → canonical graph language id. Longest-match first per path.
 * `.js`/`.jsx`/`.mjs`/`.cjs` map to `typescript` because the graph-typescript
 * adapter analyzes them and a `.ts`↔`.js` (or `.js`↔`.js`) near-clone is a real,
 * actionable clone — omitting them would silently skip every JS clone pair.
 */
const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.ts': 'typescript',
  '.jsx': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
  '.js': 'typescript',
  '.pyi': 'python',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
};

const SORTED_EXTENSIONS = Object.keys(EXTENSION_TO_LANGUAGE).sort((a, b) => b.length - a.length);

/**
 * Return the canonical language id for `filePath` by extension, or `undefined`
 * when the extension is not recognized.
 */
export function languageOfFile(filePath: string): string | undefined {
  for (const ext of SORTED_EXTENSIONS) {
    if (filePath.endsWith(ext)) return EXTENSION_TO_LANGUAGE[ext];
  }
  return undefined;
}
