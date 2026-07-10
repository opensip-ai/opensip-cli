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

/** Committed pnpm workspace package globs (mirrors pnpm-workspace.yaml). */
const WORKSPACE_GLOBS = Object.freeze([
  'packages/*',
  'packages/fitness/*',
  'packages/simulation/*',
  'packages/languages/*',
  'packages/graph/*',
  'packages/yagni/*',
]);

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

  for (const pattern of WORKSPACE_GLOBS) {
    // patterns are packages/* or packages/<ns>/*
    const parts = pattern.split('/');
    if (parts.length !== 2 || parts[1] !== '*') {
      // packages/fitness/* shape
      if (parts.length !== 3 || parts[2] !== '*') {
        throw new Error(`unsupported workspace glob: ${pattern}`);
      }
    }
    const parent =
      parts.length === 2 ? path.join(rootReal, parts[0]) : path.join(rootReal, parts[0], parts[1]);
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      // Nested test fixtures are not workspace packages.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const dir = path.join(parent, entry.name);
      // Follow symlinks so an escaping package symlink fails closed (Phase 3).
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let realDir;
      try {
        realDir = fs.realpathSync(dir);
      } catch {
        continue;
      }
      if (!realDir.startsWith(rootReal + path.sep) && realDir !== rootReal) {
        throw new Error(
          `workspace package path escapes repository root: ${path.relative(rootReal, dir)}`,
        );
      }
      const pkgPath = path.join(realDir, 'package.json');
      if (!fs.existsSync(pkgPath)) continue;
      if (seenDirs.has(realDir)) continue;
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
  WORKSPACE_GLOBS,
  MAX_MANIFEST_BYTES,
};
