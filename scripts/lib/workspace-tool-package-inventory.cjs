/**
 * workspace-tool-package-inventory — every production package whose
 * package.json declares opensipTools.kind === 'tool' (modular boundary Phase 3).
 *
 * @module scripts/lib/workspace-tool-package-inventory
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readWorkspacePackageManifests } = require('./workspace-package-manifests.cjs');

/**
 * @param {string} parentReal
 * @param {string} candidateReal
 * @returns {boolean}
 */
function isContainedPath(parentReal, candidateReal) {
  return candidateReal === parentReal || candidateReal.startsWith(parentReal + path.sep);
}

/**
 * @param {string} rootReal
 * @param {{ name: string, dir: string, relativeDir: string }} pkg
 * @returns {{ sourceRoot: string, srcDir: string }}
 */
function readToolSourceRoot(rootReal, pkg) {
  const srcLogicalPath = path.join(pkg.dir, 'src');
  let srcDir;
  try {
    srcDir = fs.realpathSync(srcLogicalPath);
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`tool package ${pkg.name} has no src/ at ${pkg.relativeDir}`);
    }
    throw error;
  }
  if (!isContainedPath(pkg.dir, srcDir)) {
    throw new Error(
      `tool package ${pkg.name} source directory escapes package root: ${pkg.relativeDir}/src`,
    );
  }
  if (!fs.statSync(srcDir).isDirectory()) {
    throw new Error(`tool package ${pkg.name} has no src/ at ${pkg.relativeDir}`);
  }
  return {
    srcDir,
    sourceRoot: `${path.relative(rootReal, srcDir).split(path.sep).join('/')}/`,
  };
}

/**
 * @typedef {object} ToolPackageRecord
 * @property {string} name
 * @property {string} relativeDir
 * @property {string} dir
 * @property {string} sourceRoot Repo-relative source root (posix, trailing slash)
 * @property {string} descriptorRelative Repo-relative tool.ts
 * @property {boolean} bundled
 * @property {object} opensipTools
 */

/**
 * @param {string} repoRoot
 * @returns {readonly ToolPackageRecord[]}
 */
function readProductionToolPackageInventory(repoRoot) {
  const rootReal = fs.realpathSync(path.resolve(repoRoot));
  const packages = readWorkspacePackageManifests(rootReal);

  let bundledNames = new Set();
  const bundledManifestPath = path.join(
    rootReal,
    'packages/cli/src/bootstrap/bundled-tools.manifest.json',
  );
  if (fs.existsSync(bundledManifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(bundledManifestPath, 'utf8'));
    if (Array.isArray(manifest.bundledPackages)) {
      bundledNames = new Set(manifest.bundledPackages.filter((n) => typeof n === 'string'));
    }
  }

  /** @type {ToolPackageRecord[]} */
  const tools = [];
  for (const pkg of packages) {
    const ot = pkg.manifest.opensipTools;
    if (ot === null || typeof ot !== 'object' || Array.isArray(ot)) continue;
    if (ot.kind !== 'tool') continue;

    const { sourceRoot, srcDir } = readToolSourceRoot(rootReal, pkg);
    const descriptorLogicalPath = path.join(srcDir, 'tool.ts');
    let descriptor;
    try {
      descriptor = fs.realpathSync(descriptorLogicalPath);
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        throw new Error(`tool package ${pkg.name} has no src/tool.ts at ${pkg.relativeDir}`);
      }
      throw error;
    }
    if (!isContainedPath(srcDir, descriptor)) {
      throw new Error(
        `tool package ${pkg.name} descriptor escapes source root: ${pkg.relativeDir}/src/tool.ts`,
      );
    }
    if (!fs.statSync(descriptor).isFile()) {
      throw new Error(`tool package ${pkg.name} has no src/tool.ts at ${pkg.relativeDir}`);
    }
    const descriptorRelative = path.relative(rootReal, descriptor).split(path.sep).join('/');

    tools.push(
      Object.freeze({
        name: pkg.name,
        relativeDir: pkg.relativeDir,
        dir: pkg.dir,
        sourceRoot,
        descriptorRelative,
        bundled: bundledNames.has(pkg.name),
        opensipTools: Object.freeze({ ...ot }),
      }),
    );
  }

  tools.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir));
  return Object.freeze(tools);
}

/**
 * Predicates / path helpers for fitness architecture checks.
 * @param {string} repoRoot
 */
function createToolPathPredicates(repoRoot) {
  const inventory = readProductionToolPackageInventory(repoRoot);
  const packages = readWorkspacePackageManifests(repoRoot);
  const substratePackage = packages.find(
    (pkg) => pkg.name === '@opensip-cli/external-tool-adapter',
  );
  const adapterSubstrate =
    substratePackage === undefined
      ? undefined
      : (() => {
          const { sourceRoot } = readToolSourceRoot(
            fs.realpathSync(path.resolve(repoRoot)),
            substratePackage,
          );
          return Object.freeze({
            name: substratePackage.name,
            relativeDir: substratePackage.relativeDir,
            dir: substratePackage.dir,
            sourceRoot,
            adapterSubstrate: true,
          });
        })();
  const productionTools = inventory;
  const bundled = productionTools.filter((t) => t.bundled);
  const allRoots = productionTools.map((t) => t.sourceRoot);
  const bundledRoots = bundled.map((t) => t.sourceRoot);
  // External-tool-adapter substrate is intentionally non-tool for peer rules
  // but is tool-shaped for path seam checks when requested.

  function escapeRe(value) {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }

  function rootsToRe(roots, suffix = '') {
    if (roots.length === 0) return /$^/; // never matches
    return new RegExp(`(?:${roots.map(escapeRe).join('|')})${suffix}`);
  }

  return {
    inventory,
    productionTools,
    bundledTools: bundled,
    adapterSubstrate,
    toolEnginePathRe: (suffix = '') => rootsToRe(allRoots, suffix),
    bundledToolEnginePathRe: (suffix = '') => rootsToRe(bundledRoots, suffix),
    toolSeamPathRe: (suffix = '') => {
      const roots = [...allRoots];
      if (adapterSubstrate) roots.push(adapterSubstrate.sourceRoot);
      return rootsToRe(roots, suffix);
    },
    toolDescriptorPathRe: () => {
      const descriptors = productionTools
        .map((t) => t.descriptorRelative)
        .filter((d) => typeof d === 'string');
      if (descriptors.length === 0) return /$^/;
      return new RegExp(`(?:^|/)(?:${descriptors.map(escapeRe).join('|')})$`);
    },
    bundledToolDescriptorPathRe: () => {
      const descriptors = bundled.map((tool) => tool.descriptorRelative);
      if (descriptors.length === 0) return /$^/;
      return new RegExp(`(?:^|/)(?:${descriptors.map(escapeRe).join('|')})$`);
    },
    isToolSourcePath: (filePath) => {
      const norm = String(filePath).replaceAll('\\', '/');
      return allRoots.some((root) => norm.includes(root));
    },
  };
}

module.exports = {
  readProductionToolPackageInventory,
  createToolPathPredicates,
};
