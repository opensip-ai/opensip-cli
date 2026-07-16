import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';

export const DISTRIBUTION_NODE_GYP_MAX_DEPTH = 16;
export const DISTRIBUTION_NODE_GYP_MAX_ENTRIES = 16_384;
export const DISTRIBUTION_NODE_GYP_MAX_FILES = 8192;
export const DISTRIBUTION_NODE_GYP_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DISTRIBUTION_NODE_GYP_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const REQUIRED_TEXT_MAX_BYTES = 1024 * 1024;
const CONTROL_CHARACTER = /\p{Cc}/u;
const WINDOWS_NODE_ARCHITECTURES = new Set(['arm64', 'ia32', 'x64']);
const RELEASE_VERSION = /^(?:v)?(?<major>0|[1-9]\d*)\.(?<minor>0|[1-9]\d*)\.(?<patch>0|[1-9]\d*)$/u;

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeNodeVersion(value) {
  const match = RELEASE_VERSION.exec(value ?? '');
  if (match?.groups === undefined || String(value).length > 64) {
    throw new Error('Windows node-gyp preparation requires an exact release Node version.');
  }
  return `${match.groups.major}.${match.groups.minor}.${match.groups.patch}`;
}

function normalizeArchitecture(value) {
  if (!WINDOWS_NODE_ARCHITECTURES.has(value)) {
    throw new Error('Windows node-gyp preparation requires x64, arm64, or ia32 architecture.');
  }
  return value;
}

function requireAbsoluteWindowsPath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    !win32.isAbsolute(value) ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${label} must be an absolute Windows path.`);
  }
  return win32.normalize(value);
}

/** Resolve node-gyp's standard Windows cache root without reading npm configuration. */
export function defaultDistributionWindowsNodeGypDevDir(input = {}) {
  const environment = input.environment ?? process.env;
  const localAppData =
    typeof environment.LOCALAPPDATA === 'string' && environment.LOCALAPPDATA.length > 0
      ? environment.LOCALAPPDATA
      : win32.join(input.homeDirectory ?? homedir(), 'AppData', 'Local');
  return requireAbsoluteWindowsPath(
    win32.join(localAppData, 'node-gyp', 'Cache'),
    'Windows node-gyp cache root',
  );
}

function safeEntryName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !CONTROL_CHARACTER.test(name)
  );
}

function relativeKey(segments) {
  return segments.join('\\').toLowerCase();
}

function safeFileSize(stats) {
  return Number.isSafeInteger(stats.size);
}

function direntTypeAgrees(entry, stats) {
  if (entry.isDirectory() && stats.isDirectory()) return 'directory';
  if (entry.isFile() && stats.isFile()) return 'file';
}

async function inventoryNodeGypVersion(filesystem, sourceVersionRoot) {
  let rootStats;
  try {
    rootStats = await filesystem.lstat(sourceVersionRoot);
  } catch {
    throw new Error('The exact-version Windows node-gyp cache directory is unavailable.');
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('The exact-version Windows node-gyp cache must be a regular directory.');
  }

  const directories = [];
  const files = [];
  const fileByKey = new Map();
  const entryKeys = new Set();
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (directory, relativeSegments) => {
    const entries = [];
    const handle = await filesystem.opendir(directory);
    for await (const entry of handle) {
      entryCount += 1;
      if (entryCount > DISTRIBUTION_NODE_GYP_MAX_ENTRIES) {
        throw new Error('Windows node-gyp cache exceeds the bounded entry limit.');
      }
      entries.push(entry);
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));

    for (const entry of entries) {
      if (!safeEntryName(entry.name)) {
        throw new Error('Windows node-gyp cache contains an invalid entry name.');
      }
      const childSegments = [...relativeSegments, entry.name];
      if (childSegments.length > DISTRIBUTION_NODE_GYP_MAX_DEPTH) {
        throw new Error('Windows node-gyp cache exceeds the bounded depth limit.');
      }
      const key = relativeKey(childSegments);
      if (entryKeys.has(key)) {
        throw new Error('Windows node-gyp cache contains case-insensitive path collisions.');
      }
      entryKeys.add(key);
      const source = win32.join(sourceVersionRoot, ...childSegments);
      const stats = await filesystem.lstat(source);
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) {
        throw new Error('Windows node-gyp cache must not contain symbolic links or junctions.');
      }
      const kind = direntTypeAgrees(entry, stats);
      if (kind === 'directory') {
        directories.push(childSegments);
        await visit(source, childSegments);
        continue;
      }
      if (kind !== 'file' || !safeFileSize(stats)) {
        throw new Error('Windows node-gyp cache contains a special or inconsistent entry.');
      }
      fileCount += 1;
      if (fileCount > DISTRIBUTION_NODE_GYP_MAX_FILES) {
        throw new Error('Windows node-gyp cache exceeds the bounded file limit.');
      }
      if (stats.size > DISTRIBUTION_NODE_GYP_MAX_FILE_BYTES) {
        throw new Error('Windows node-gyp cache contains an oversized file.');
      }
      totalBytes += stats.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > DISTRIBUTION_NODE_GYP_MAX_TOTAL_BYTES) {
        throw new Error('Windows node-gyp cache exceeds the bounded byte limit.');
      }
      const row = { relativeSegments: childSegments, size: stats.size, source };
      fileByKey.set(key, row);
      files.push(row);
    }
  };

  await visit(sourceVersionRoot, []);
  return { directories, fileByKey, files };
}

async function requireRegularSourceRoot(filesystem, sourceDevDir) {
  let stats;
  try {
    stats = await filesystem.lstat(sourceDevDir);
  } catch {
    throw new Error('The Windows node-gyp source devdir is unavailable.');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('The Windows node-gyp source devdir must be a regular directory.');
  }
}

function requiredFile(fileByKey, relativeSegments, label) {
  const row = fileByKey.get(relativeKey(relativeSegments));
  if (row === undefined || row.size === 0) {
    throw new Error(`Windows node-gyp cache is missing required ${label}.`);
  }
  return row;
}

function numericHeaderMacro(text, name) {
  const match = new RegExp(`^\\s*#\\s*define\\s+${name}\\s+(\\d+)\\s*$`, 'mu').exec(text);
  return match === null ? undefined : Number.parseInt(match[1], 10);
}

async function validateRequiredFiles(filesystem, inventory, version, architecture) {
  requiredFile(inventory.fileByKey, ['include', 'node', 'node.h'], 'node.h');
  requiredFile(inventory.fileByKey, ['include', 'node', 'config.gypi'], 'config.gypi');
  requiredFile(inventory.fileByKey, ['include', 'node', 'common.gypi'], 'common.gypi');
  requiredFile(inventory.fileByKey, [architecture, 'node.lib'], `${architecture}/node.lib`);
  const versionHeader = requiredFile(
    inventory.fileByKey,
    ['include', 'node', 'node_version.h'],
    'node_version.h',
  );
  const installVersion = requiredFile(inventory.fileByKey, ['installVersion'], 'installVersion');
  if (
    versionHeader.size > REQUIRED_TEXT_MAX_BYTES ||
    installVersion.size > REQUIRED_TEXT_MAX_BYTES
  ) {
    throw new Error('Windows node-gyp cache required metadata is oversized.');
  }
  const [headerText, installVersionText] = await Promise.all([
    filesystem.readFile(versionHeader.source, 'utf8'),
    filesystem.readFile(installVersion.source, 'utf8'),
  ]);
  const headerVersion = [
    numericHeaderMacro(headerText, 'NODE_MAJOR_VERSION'),
    numericHeaderMacro(headerText, 'NODE_MINOR_VERSION'),
    numericHeaderMacro(headerText, 'NODE_PATCH_VERSION'),
  ].join('.');
  if (headerVersion !== version) {
    throw new Error('Windows node-gyp cache headers do not match the exact Node version.');
  }
  if (!/^[1-9]\d{0,5}\n?$/u.test(installVersionText)) {
    throw new Error('Windows node-gyp cache installVersion is invalid.');
  }
}

function isPathInside(root, candidate) {
  const child = win32.relative(root, candidate);
  return child === '' || (child !== '..' && !child.startsWith('..\\') && !win32.isAbsolute(child));
}

async function requireAbsentDestination(filesystem, destinationRoot) {
  try {
    await filesystem.lstat(destinationRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('Windows node-gyp destination could not be inspected.', {
      cause: error,
    });
  }
  throw new Error('Windows node-gyp destination must not already exist.');
}

async function cloneInventory(filesystem, inventory, sourceVersionRoot, destinationRoot, version) {
  const destinationVersionRoot = win32.join(destinationRoot, version);
  await filesystem.mkdir(destinationRoot, { mode: 0o700 });
  try {
    await filesystem.mkdir(destinationVersionRoot, { mode: 0o700 });
    const directories = [...inventory.directories].sort((left, right) => {
      const depthOrder = left.length - right.length;
      return depthOrder === 0 ? compareStrings(relativeKey(left), relativeKey(right)) : depthOrder;
    });
    for (const relativeSegments of directories) {
      await filesystem.mkdir(win32.join(destinationVersionRoot, ...relativeSegments), {
        mode: 0o700,
      });
    }
    for (const row of inventory.files.sort((left, right) =>
      compareStrings(relativeKey(left.relativeSegments), relativeKey(right.relativeSegments)),
    )) {
      const destination = win32.join(destinationVersionRoot, ...row.relativeSegments);
      await filesystem.copyFile(row.source, destination, fsConstants.COPYFILE_FICLONE);
      const [sourceStats, destinationStats] = await Promise.all([
        filesystem.lstat(row.source),
        filesystem.lstat(destination),
      ]);
      if (
        sourceStats.isSymbolicLink() ||
        destinationStats.isSymbolicLink() ||
        !sourceStats.isFile() ||
        !destinationStats.isFile() ||
        sourceStats.size !== row.size ||
        destinationStats.size !== row.size
      ) {
        throw new Error('Windows node-gyp cache changed during bounded cloning.');
      }
    }
  } catch (error) {
    await filesystem.rm(destinationRoot, { recursive: true, force: true }).catch(() => false);
    throw error;
  }
  let sourceIsStable = false;
  try {
    const sourceAfter = await filesystem.lstat(sourceVersionRoot);
    sourceIsStable = !sourceAfter.isSymbolicLink() && sourceAfter.isDirectory();
  } catch {
    // The source disappeared after the copy and the partial proof must be discarded.
  }
  if (!sourceIsStable) {
    await filesystem.rm(destinationRoot, { recursive: true, force: true });
    throw new Error('Windows node-gyp cache changed during bounded cloning.');
  }
}

/** Clone one cache version and return the isolated root for `npm_config_devdir`. */
export async function cloneDistributionWindowsNodeGypDevDir(input) {
  const filesystem = input.filesystem ?? fs;
  const version = normalizeNodeVersion(input.nodeVersion);
  const architecture = normalizeArchitecture(input.architecture);
  const sourceDevDir = requireAbsoluteWindowsPath(
    input.sourceDevDir ??
      defaultDistributionWindowsNodeGypDevDir({
        environment: input.environment,
        homeDirectory: input.homeDirectory,
      }),
    'Windows node-gyp source devdir',
  );
  const destinationRoot = requireAbsoluteWindowsPath(
    input.destinationRoot,
    'Windows node-gyp destination',
  );
  const sourceVersionRoot = win32.join(sourceDevDir, version);
  if (isPathInside(sourceDevDir, destinationRoot) || isPathInside(destinationRoot, sourceDevDir)) {
    throw new Error('Windows node-gyp source and destination must be isolated.');
  }
  await requireRegularSourceRoot(filesystem, sourceDevDir);
  await requireAbsentDestination(filesystem, destinationRoot);
  const inventory = await inventoryNodeGypVersion(filesystem, sourceVersionRoot);
  await validateRequiredFiles(filesystem, inventory, version, architecture);
  await cloneInventory(filesystem, inventory, sourceVersionRoot, destinationRoot, version);
  return destinationRoot;
}
