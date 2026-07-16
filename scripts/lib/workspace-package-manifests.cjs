/**
 * workspace-package-manifests — canonical synchronous inventory of workspace
 * package.json records (modular boundary Phase 3).
 *
 * Shared by release ordering, export maps, tool inventory, and architecture
 * docs generators. Pure projection over repoRoot — no Strategy/Factory hierarchy.
 *
 * @module scripts/lib/workspace-package-manifests
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_WORKSPACE_MANIFEST_BYTES = 1024 * 1024;

/**
 * @param {string} parentReal
 * @param {string} candidateReal
 * @returns {boolean}
 */
function isContainedPath(parentReal, candidateReal) {
  return candidateReal === parentReal || candidateReal.startsWith(parentReal + path.sep);
}

/**
 * Parse the top-level `packages` sequence from pnpm-workspace.yaml.
 *
 * The repository intentionally supports only the simple, quoted scalar list
 * shape committed in this workspace. Unsupported YAML constructs fail loudly
 * instead of falling back to a second handwritten package inventory.
 *
 * @param {string} repoRoot
 * @returns {readonly string[]}
 */
function readWorkspaceGlobs(repoRoot) {
  const rootReal = fs.realpathSync(path.resolve(repoRoot));
  const workspaceLogicalPath = path.join(rootReal, 'pnpm-workspace.yaml');
  const workspacePath = fs.realpathSync(workspaceLogicalPath);
  if (!isContainedPath(rootReal, workspacePath)) {
    throw new Error('pnpm-workspace.yaml escapes repository root');
  }
  const workspaceStat = fs.statSync(workspacePath);
  if (workspaceStat.size > MAX_WORKSPACE_MANIFEST_BYTES) {
    throw new Error('pnpm-workspace.yaml exceeds 1 MiB');
  }

  const lines = fs.readFileSync(workspacePath, 'utf8').split(/\r?\n/u);
  const packagesLine = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/u.test(line));
  if (packagesLine < 0) {
    throw new Error('pnpm-workspace.yaml must declare a top-level packages sequence');
  }

  /** @type {string[]} */
  const globs = [];
  for (let index = packagesLine + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    if (/^\S/u.test(line)) break;

    const item = /^\s+-\s+(['"])([^'"\r\n]+)\1\s*(?:#.*)?$/u.exec(line);
    if (item === null) {
      throw new Error(
        `pnpm-workspace.yaml:${index + 1}: packages entries must be quoted scalar globs`,
      );
    }
    const pattern = item[2];
    if (
      path.isAbsolute(pattern) ||
      pattern.startsWith('../') ||
      pattern.includes('/../') ||
      pattern.includes('\\') ||
      pattern.startsWith('!')
    ) {
      throw new Error(`pnpm-workspace.yaml:${index + 1}: unsupported workspace glob '${pattern}'`);
    }
    if (globs.includes(pattern)) {
      throw new Error(`pnpm-workspace.yaml:${index + 1}: duplicate workspace glob '${pattern}'`);
    }
    globs.push(pattern);
  }

  if (globs.length === 0) {
    throw new Error('pnpm-workspace.yaml packages sequence must not be empty');
  }
  return Object.freeze(globs);
}

/**
 * @typedef {object} WorkspacePackageRecord
 * @property {string} name
 * @property {string} dir Absolute package directory
 * @property {string} relativeDir Repo-relative package directory
 * @property {boolean} private
 * @property {object} manifest Parsed package.json (immutable copy)
 */

/**
 * @param {string} repoRoot
 * @returns {readonly WorkspacePackageRecord[]}
 */
function readWorkspacePackageManifests(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('readWorkspacePackageManifests: repoRoot is required');
  }
  const rootReal = fs.realpathSync(path.resolve(repoRoot));
  /** @type {WorkspacePackageRecord[]} */
  const records = [];
  const seenNames = new Map();
  const seenDirs = new Set();
  const workspaceGlobs = readWorkspaceGlobs(rootReal);

  for (const pattern of workspaceGlobs) {
    // patterns are packages/* or packages/<ns>/*
    const parts = pattern.split('/');
    if (parts.length !== 2 || parts[1] !== '*') {
      // packages/fitness/* shape
      if (parts.length !== 3 || parts[2] !== '*') {
        throw new Error(`unsupported workspace glob: ${pattern}`);
      }
    }
    const parentLogicalPath =
      parts.length === 2 ? path.join(rootReal, parts[0]) : path.join(rootReal, parts[0], parts[1]);
    let parent;
    try {
      parent = fs.realpathSync(parentLogicalPath);
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') continue;
      throw error;
    }
    if (!isContainedPath(rootReal, parent)) {
      throw new Error(
        `workspace package parent escapes repository root: ${path.relative(rootReal, parentLogicalPath)}`,
      );
    }
    if (!fs.statSync(parent).isDirectory()) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      // Nested test fixtures are not workspace packages.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const dir = path.join(parent, entry.name);
      // Follow symlinks so an escaping package symlink fails closed (Phase 3).
      let realDir;
      try {
        realDir = fs.realpathSync(dir);
      } catch {
        continue;
      }
      if (!isContainedPath(rootReal, realDir)) {
        throw new Error(
          `workspace package path escapes repository root: ${path.relative(rootReal, dir)}`,
        );
      }
      if (!fs.statSync(realDir).isDirectory()) continue;
      const pkgLogicalPath = path.join(realDir, 'package.json');
      let pkgPath;
      try {
        pkgPath = fs.realpathSync(pkgLogicalPath);
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') continue;
        throw error;
      }
      if (!isContainedPath(realDir, pkgPath)) {
        throw new Error(
          `workspace package manifest escapes package root: ${path.relative(rootReal, pkgLogicalPath)}`,
        );
      }
      if (seenDirs.has(realDir)) {
        throw new Error(
          `duplicate workspace package directory: ${path.relative(rootReal, realDir)}`,
        );
      }
      seenDirs.add(realDir);

      const manifestStat = fs.statSync(pkgPath);
      if (manifestStat.size > MAX_MANIFEST_BYTES) {
        throw new Error(`package.json exceeds 1 MiB: ${path.relative(rootReal, pkgPath)}`);
      }
      const raw = fs.readFileSync(pkgPath, 'utf8');
      /** @type {Record<string, unknown>} */
      let manifest;
      try {
        manifest = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          `invalid package.json at ${path.relative(rootReal, pkgPath)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`package.json missing name: ${path.relative(rootReal, pkgPath)}`);
      }
      if (seenNames.has(manifest.name)) {
        throw new Error(
          `duplicate package name '${manifest.name}': ${seenNames.get(manifest.name)} and ${path.relative(rootReal, realDir)}`,
        );
      }
      seenNames.set(manifest.name, path.relative(rootReal, realDir));
      records.push(
        Object.freeze({
          name: manifest.name,
          dir: realDir,
          relativeDir: path.relative(rootReal, realDir).split(path.sep).join('/'),
          private: manifest.private === true,
          manifest: Object.freeze({ ...manifest }),
        }),
      );
    }
  }

  records.sort((a, b) => a.relativeDir.localeCompare(b.relativeDir));
  return Object.freeze(records);
}

module.exports = {
  readWorkspacePackageManifests,
  readWorkspaceGlobs,
  MAX_MANIFEST_BYTES,
  MAX_WORKSPACE_MANIFEST_BYTES,
};
