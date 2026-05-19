/**
 * Python file discovery — Stage 0 for the Python adapter.
 *
 * Lands in PR 5 of plan docs/plans/10-graph-language-pluggability.md.
 *
 * Strategy:
 *   1. If `pyproject.toml` is present, use it as the language config
 *      anchor for cacheKey. The PR 5 implementation does NOT parse
 *      `[tool.opensip-graph].include`; that's a future enhancement
 *      flagged in plan 10 §8 Q4. We just record the file path.
 *   2. If `setup.py` is present (and no pyproject.toml), use it as the
 *      anchor instead.
 *   3. Walk the project tree collecting all `.py` files, excluding
 *      common non-source directories (`.venv`, `venv`, `__pycache__`,
 *      `.tox`, `node_modules`, `dist`, `build`, `.eggs`).
 *
 * Returns absolute, realpath-normalized, sorted, deduped paths so I-9
 * (referential transparency of discoverFiles) holds across runs.
 */

import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { logger } from '@opensip-tools/core';
import { glob } from 'glob';

import type { DiscoverInput, DiscoverOutput } from '../lang-adapter/types.js';

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

export function discoverFiles(input: DiscoverInput): DiscoverOutput {
  logger.info({
    evt: 'graph.discover.start',
    module: 'graph:discover:python',
    projectDir: input.cwd,
  });

  const projectDirAbs = normalizeProjectDir(input.cwd);
  const configPathAbs = resolveConfigPath(projectDirAbs, input.configPathOverride);
  const files = collectPythonFiles(projectDirAbs);

  logger.info({
    evt: 'graph.discover.complete',
    module: 'graph:discover:python',
    projectDir: projectDirAbs,
    configPath: configPathAbs ?? '(none)',
    fileCount: files.length,
  });

  const out: DiscoverOutput = configPathAbs === undefined
    ? { projectDirAbs, files }
    : { projectDirAbs, files, configPathAbs };
  return out;
}

function normalizeProjectDir(projectDir: string): string {
  const abs = resolve(projectDir);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function resolveConfigPath(
  projectDirAbs: string,
  override: string | undefined,
): string | undefined {
  if (override !== undefined && override.length > 0) {
    const abs = resolve(projectDirAbs, override);
    return existsSync(abs) ? realpathOrPath(abs) : abs;
  }
  const pyproject = resolve(projectDirAbs, 'pyproject.toml');
  if (existsSync(pyproject)) return realpathOrPath(pyproject);
  const setupPy = resolve(projectDirAbs, 'setup.py');
  if (existsSync(setupPy)) return realpathOrPath(setupPy);
  return undefined;
}

function realpathOrPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function collectPythonFiles(projectDirAbs: string): readonly string[] {
  const matches: string[] = glob.sync('**/*.py', {
    cwd: projectDirAbs,
    absolute: true,
    ignore: [...EXCLUDED_DIR_GLOBS],
    nodir: true,
    follow: false,
    dot: false,
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    let real: string = m;
    try {
      real = realpathSync(m);
    } catch {
      // fall through with original
    }
    const key = real.split(sep).join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  out.sort();
  return out;
}
