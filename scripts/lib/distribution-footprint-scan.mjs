import {
  lstat as defaultLstat,
  opendir as defaultOpendir,
  realpath as defaultRealpath,
  stat as defaultStat,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  DISTRIBUTION_TREE_MAX_DEPTH,
  DISTRIBUTION_TREE_MAX_ENTRIES,
} from './distribution-footprint-constants.mjs';
import { addSafeIntegers, isPathInside, requireRecord } from './distribution-footprint-values.mjs';

const OPEN_SIP_PACKAGE_PATTERN = /^(?:opensip-cli|@opensip-cli\/[a-z0-9]+(?:-[a-z0-9]+)*)$/u;

/** Scan a physical tree without following symlinks; contained links count as link entries. */
export async function scanPhysicalTree(root, limits = {}, dependencies = {}) {
  const scanLimits = normalizeTreeLimits(limits);
  const fileSystem = scanFileSystem(dependencies);
  const rootPath = resolveRootPath(root);
  const rootInfo = await fileSystem.lstat(rootPath);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`physical tree root must be a real directory: ${rootPath}`);
  }
  const rootReal = await fileSystem.realpath(rootPath);
  const state = createScanState(scanLimits, rootReal);
  await scanPhysicalDirectory(rootReal, 0, new Set([rootReal]), state, fileSystem);
  return scanTotals(state);
}

/** Resolve and scan one named OpenSIP package, following only links contained in that package. */
export async function scanResolvedPackage(root, packageName, limits = {}, dependencies = {}) {
  if (typeof packageName !== 'string' || !OPEN_SIP_PACKAGE_PATTERN.test(packageName)) {
    throw new Error('packageName must be opensip-cli or an exact @opensip-cli package name');
  }
  const scanLimits = normalizeTreeLimits(limits);
  const fileSystem = scanFileSystem(dependencies);
  const rootPath = resolveRootPath(root);
  const rootReal = await fileSystem.realpath(rootPath);
  const packagePath = join(rootReal, ...packageName.split('/'));
  const packageReal = await fileSystem.realpath(packagePath);
  if (!isPathInside(rootReal, packageReal)) {
    throw new Error(`resolved package escapes the supplied root: ${packageName}`);
  }
  const packageInfo = await fileSystem.stat(packagePath);
  if (!packageInfo.isDirectory()) {
    throw new Error(`resolved package is not a directory: ${packageName}`);
  }

  const state = createScanState(scanLimits, packageReal);
  await scanResolvedDirectory(packageReal, 0, new Set([packageReal]), state, fileSystem);
  const totals = scanTotals(state);
  return {
    packageName,
    unpackedBytes: totals.bytes,
    fileCount: totals.fileCount,
    entryCount: totals.entryCount,
  };
}

function normalizeTreeLimits(limits) {
  const record = requireRecord(limits, 'tree scan limits');
  const maxEntries = record.maxEntries ?? DISTRIBUTION_TREE_MAX_ENTRIES;
  const maxDepth = record.maxDepth ?? DISTRIBUTION_TREE_MAX_DEPTH;
  if (
    !Number.isInteger(maxEntries) ||
    maxEntries <= 0 ||
    maxEntries > DISTRIBUTION_TREE_MAX_ENTRIES
  ) {
    throw new RangeError(
      `maxEntries must be between 1 and ${String(DISTRIBUTION_TREE_MAX_ENTRIES)}`,
    );
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > DISTRIBUTION_TREE_MAX_DEPTH) {
    throw new RangeError(`maxDepth must be between 0 and ${String(DISTRIBUTION_TREE_MAX_DEPTH)}`);
  }
  return { maxEntries, maxDepth };
}

function scanFileSystem(dependencies) {
  return {
    lstat: dependencies.lstat ?? defaultLstat,
    opendir: dependencies.opendir ?? defaultOpendir,
    realpath: dependencies.realpath ?? defaultRealpath,
    stat: dependencies.stat ?? defaultStat,
  };
}

function resolveRootPath(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('tree scan root must be a non-empty string');
  }
  return resolve(root);
}

function createScanState(limits, containmentRoot) {
  return {
    ...limits,
    containmentRoot,
    bytes: 0,
    fileCount: 0,
    entryCount: 0,
    seenDirectories: new Set([containmentRoot]),
    seenLogicalFiles: new Set(),
  };
}

async function scanPhysicalDirectory(directory, depth, ancestors, state, fileSystem) {
  let handle;
  try {
    handle = await fileSystem.opendir(directory);
    for await (const entry of handle) {
      accountEntry(state, depth + 1);
      const entryPath = join(directory, entry.name);
      const info = await fileSystem.lstat(entryPath);
      if (info.isSymbolicLink()) {
        await accountPhysicalSymlink(entryPath, info, ancestors, state, fileSystem);
      } else if (info.isDirectory()) {
        const real = await fileSystem.realpath(entryPath);
        assertContainedRealpath(state.containmentRoot, real, entryPath);
        if (state.seenDirectories.has(real)) {
          throw new Error(`directory cycle detected at ${entryPath}`);
        }
        state.seenDirectories.add(real);
        const childAncestors = new Set(ancestors);
        childAncestors.add(real);
        await scanPhysicalDirectory(real, depth + 1, childAncestors, state, fileSystem);
      } else {
        accountFile(info.size, state, entryPath);
      }
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => null);
    throw error;
  }
}

async function accountPhysicalSymlink(entryPath, info, ancestors, state, fileSystem) {
  const target = await fileSystem.realpath(entryPath);
  assertContainedRealpath(state.containmentRoot, target, entryPath);
  const targetInfo = await fileSystem.stat(entryPath);
  if (targetInfo.isDirectory() && ancestors.has(target)) {
    throw new Error(`directory cycle detected at ${entryPath}`);
  }
  accountFile(info.size, state, entryPath);
}

async function scanResolvedDirectory(directory, depth, ancestors, state, fileSystem) {
  let handle;
  try {
    handle = await fileSystem.opendir(directory);
    for await (const entry of handle) {
      accountEntry(state, depth + 1);
      const entryPath = join(directory, entry.name);
      const info = await fileSystem.lstat(entryPath);
      if (info.isSymbolicLink()) {
        await followResolvedSymlink(entryPath, depth, ancestors, state, fileSystem);
      } else if (info.isDirectory()) {
        const real = await fileSystem.realpath(entryPath);
        await visitResolvedDirectory(real, depth + 1, entryPath, ancestors, state, fileSystem);
      } else {
        const real = await fileSystem.realpath(entryPath);
        assertContainedRealpath(state.containmentRoot, real, entryPath);
        accountLogicalFile(real, info.size, state, entryPath);
      }
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => null);
    throw error;
  }
}

async function followResolvedSymlink(entryPath, depth, ancestors, state, fileSystem) {
  const target = await fileSystem.realpath(entryPath);
  assertContainedRealpath(state.containmentRoot, target, entryPath);
  const targetInfo = await fileSystem.stat(entryPath);
  if (targetInfo.isDirectory()) {
    await visitResolvedDirectory(target, depth + 1, entryPath, ancestors, state, fileSystem);
  } else {
    accountLogicalFile(target, targetInfo.size, state, entryPath);
  }
}

async function visitResolvedDirectory(real, depth, sourcePath, ancestors, state, fileSystem) {
  if (ancestors.has(real)) {
    throw new Error(`directory cycle detected at ${sourcePath}`);
  }
  assertContainedRealpath(state.containmentRoot, real, sourcePath);
  if (state.seenDirectories.has(real)) return;
  state.seenDirectories.add(real);
  const childAncestors = new Set(ancestors);
  childAncestors.add(real);
  await scanResolvedDirectory(real, depth, childAncestors, state, fileSystem);
}

function accountEntry(state, depth) {
  if (depth > state.maxDepth) {
    throw new RangeError(`tree scan exceeded maximum depth ${String(state.maxDepth)}`);
  }
  state.entryCount += 1;
  if (state.entryCount > state.maxEntries) {
    throw new RangeError(`tree scan exceeded maximum entries ${String(state.maxEntries)}`);
  }
}

function accountFile(size, state, filePath) {
  state.bytes = addSafeIntegers(state.bytes, size, `${filePath} size`);
  state.fileCount = addSafeIntegers(state.fileCount, 1, 'tree file count');
}

function accountLogicalFile(real, size, state, sourcePath) {
  if (state.seenLogicalFiles.has(real)) return;
  state.seenLogicalFiles.add(real);
  accountFile(size, state, sourcePath);
}

function scanTotals(state) {
  return { bytes: state.bytes, fileCount: state.fileCount, entryCount: state.entryCount };
}

function assertContainedRealpath(root, candidate, sourcePath) {
  if (!isPathInside(root, candidate)) {
    throw new Error(`tree scan symlink escapes root at ${sourcePath}`);
  }
}
