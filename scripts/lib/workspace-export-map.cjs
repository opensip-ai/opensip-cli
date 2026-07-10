/**
 * workspace-export-map — flatten every declared package export to a source file
 * for dependency-cruiser path mapping (modular boundary Phase 3).
 *
 * @module scripts/lib/workspace-export-map
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  readWorkspacePackageManifests,
} = require('./workspace-package-manifests.cjs');

/**
 * @typedef {object} ExportMapEntry
 * @property {string} packageName
 * @property {string} exportPath '.' or './subpath'
 * @property {string} specifier '@opensip-cli/foo' or '@opensip-cli/foo/sub'
 * @property {string} distTarget Relative ./dist/... target from package.json
 * @property {string} sourceFile Absolute path to mapped source file
 * @property {string} relativeSource Repo-relative source path (posix)
 */

/**
 * Translate a `./dist/foo.js` export target to an existing source file.
 * @param {string} packageDir
 * @param {string} distTarget
 * @returns {string | undefined}
 */
function resolveExportSource(packageDir, distTarget) {
  if (typeof distTarget !== 'string') return undefined;
  if (!distTarget.startsWith('./dist/')) return undefined;
  if (distTarget.includes('..') || path.isAbsolute(distTarget)) return undefined;
  if (distTarget.includes('*') || distTarget.includes('?')) return undefined;

  const withoutDist = distTarget.slice('./dist/'.length); // e.g. index.js or read/index.js
  if (!withoutDist.endsWith('.js')) return undefined;
  const base = withoutDist.slice(0, -'.js'.length);

  const candidates = [
    path.join(packageDir, 'src', `${base}.ts`),
    path.join(packageDir, 'src', `${base}.tsx`),
    path.join(packageDir, 'src', base, 'index.ts'),
    path.join(packageDir, 'src', base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * @param {string} repoRoot
 * @returns {{ entries: readonly ExportMapEntry[], diagnostics: readonly string[] }}
 */
function readWorkspaceExportMap(repoRoot) {
  const rootReal = fs.realpathSync(path.resolve(repoRoot));
  const packages = readWorkspacePackageManifests(rootReal);
  /** @type {ExportMapEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const diagnostics = [];

  for (const pkg of packages) {
    const exportsField = pkg.manifest.exports;
    /** @type {Record<string, string>} */
    const flat = {};

    if (exportsField === undefined) {
      // Implicit main/types only — treat as '.' → ./dist/index.js when present.
      const main = pkg.manifest.main;
      if (typeof main === 'string' && main.startsWith('./dist/')) {
        flat['.'] = main;
      } else if (typeof main === 'string') {
        diagnostics.push(
          `${pkg.relativeDir}: unsupported main target '${main}' (expected ./dist/...)`,
        );
      } else if (
        pkg.manifest.bin !== undefined &&
        typeof pkg.manifest.bin === 'object' &&
        pkg.manifest.bin !== null
      ) {
        // Composition-root CLI packages may ship only bin entries.
        const bins = Object.values(pkg.manifest.bin).filter(
          (v) => typeof v === 'string' && v.startsWith('./dist/'),
        );
        if (bins[0] !== undefined) flat['.'] = bins[0];
      }
    } else if (typeof exportsField === 'string') {
      flat['.'] = exportsField;
    } else if (typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField)) {
      for (const [key, value] of Object.entries(exportsField)) {
        if (typeof value === 'string') {
          flat[key] = value;
        } else if (value !== null && typeof value === 'object') {
          diagnostics.push(
            `${pkg.relativeDir}: conditional export '${key}' is not supported (require exact string targets)`,
          );
        } else {
          diagnostics.push(
            `${pkg.relativeDir}: export '${key}' has unsupported value type`,
          );
        }
      }
    } else {
      diagnostics.push(`${pkg.relativeDir}: exports field has unsupported shape`);
    }

    for (const [exportPath, distTarget] of Object.entries(flat)) {
      if (exportPath.includes('*')) {
        diagnostics.push(
          `${pkg.relativeDir}: wildcard export '${exportPath}' is not supported`,
        );
        continue;
      }
      if (typeof distTarget !== 'string' || !distTarget.startsWith('./dist/')) {
        diagnostics.push(
          `${pkg.relativeDir}: export '${exportPath}' target '${String(distTarget)}' must be an exact ./dist/... string`,
        );
        continue;
      }
      if (distTarget.includes('..') || path.isAbsolute(distTarget)) {
        diagnostics.push(
          `${pkg.relativeDir}: export '${exportPath}' target escapes package via '${distTarget}'`,
        );
        continue;
      }
      const sourceFile = resolveExportSource(pkg.dir, distTarget);
      if (sourceFile === undefined) {
        diagnostics.push(
          `${pkg.relativeDir}: export '${exportPath}' → '${distTarget}' has no resolvable src/*.ts`,
        );
        continue;
      }
      const sourceReal = fs.realpathSync(sourceFile);
      if (!sourceReal.startsWith(pkg.dir + path.sep) && sourceReal !== pkg.dir) {
        diagnostics.push(
          `${pkg.relativeDir}: export '${exportPath}' source escapes package root`,
        );
        continue;
      }
      const sub =
        exportPath === '.'
          ? ''
          : exportPath.startsWith('./')
            ? exportPath.slice(1)
            : `/${exportPath}`;
      const specifier = `${pkg.name}${sub === '' ? '' : sub.startsWith('/') ? sub : `/${sub}`}`;
      // Normalize: '@opensip-cli/foo/read' from './read'
      const normalizedSpecifier =
        exportPath === '.'
          ? pkg.name
          : `${pkg.name}/${exportPath.replace(/^\.\//, '')}`;

      entries.push(
        Object.freeze({
          packageName: pkg.name,
          exportPath,
          specifier: normalizedSpecifier,
          distTarget,
          sourceFile: sourceReal,
          relativeSource: path
            .relative(rootReal, sourceReal)
            .split(path.sep)
            .join('/'),
        }),
      );
    }
  }

  entries.sort((a, b) => a.specifier.localeCompare(b.specifier));
  diagnostics.sort();
  return {
    entries: Object.freeze(entries),
    diagnostics: Object.freeze(diagnostics),
  };
}

module.exports = {
  readWorkspaceExportMap,
  resolveExportSource,
};
