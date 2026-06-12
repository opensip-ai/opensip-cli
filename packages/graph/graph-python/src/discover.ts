/**
 * Python file discovery — Stage 0 for the Python adapter.
 *
 * Strategy:
 *   1. If `pyproject.toml` is present, use it as the language config
 *      anchor for cacheKey. We do NOT parse `[tool.opensip-graph].include`;
 *      that's a future enhancement. We just record the file path.
 *   2. If `setup.py` is present (and no pyproject.toml), use it as the
 *      anchor instead.
 *   3. Walk the project tree collecting all `.py` files, excluding
 *      common non-source directories (`.venv`, `venv`, `__pycache__`,
 *      `.tox`, `node_modules`, `dist`, `build`, `.eggs`).
 *
 * The collect-loop / realpath-dedup / config-precedence scaffolding lives
 * in `@opensip-cli/graph-adapter-common`; this module supplies only the
 * Python-specific inputs.
 */

import { createDiscover } from '@opensip-cli/graph-adapter-common';

const EXCLUDED_DIR_GLOBS: readonly string[] = [
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.tox/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.eggs/**',
];

const CONFIG_CANDIDATES: readonly string[] = ['pyproject.toml', 'setup.py'];

export const discoverFiles = createDiscover({
  extension: 'py',
  excludedDirGlobs: EXCLUDED_DIR_GLOBS,
  configCandidates: CONFIG_CANDIDATES,
  languageId: 'python',
});
