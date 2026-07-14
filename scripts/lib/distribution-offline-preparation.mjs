import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_ENTRIES = 8192;
const MAX_METADATA_FILES = 4096;
const MAX_METADATA_FILE_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_DEPTH = 3;
const CONTROL_CHARACTER = /\p{Cc}/u;

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Extract the exact pnpm runtime version pinned by packageManager. */
export function expectedDistributionPnpmVersion(packageManager) {
  const match = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.+)?$/u.exec(packageManager ?? '');
  const version = match?.[1];
  if (
    version === undefined ||
    version.length === 0 ||
    version.length > 64 ||
    CONTROL_CHARACTER.test(version)
  ) {
    throw new Error('The repository must pin an exact pnpm packageManager version.');
  }
  return version;
}

function pathApiForPlatform(platform) {
  return platform === 'win32' ? win32 : posix;
}

function defaultCorepackHome(environment, platform, homeDirectory) {
  const pathApi = pathApiForPlatform(platform);
  if (typeof environment.COREPACK_HOME === 'string' && environment.COREPACK_HOME.length > 0) {
    return environment.COREPACK_HOME;
  }
  const cacheHome = environment.XDG_CACHE_HOME ?? environment.LOCALAPPDATA;
  if (typeof cacheHome === 'string' && cacheHome.length > 0) {
    return pathApi.join(cacheHome, 'node', 'corepack');
  }
  const home = homeDirectory ?? homedir();
  const defaultCache =
    platform === 'win32' ? pathApi.join(home, 'AppData', 'Local') : pathApi.join(home, '.cache');
  return pathApi.join(defaultCache, 'node', 'corepack');
}

function safeRuntimeCandidate(candidate, pathApi) {
  return (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= 4096 &&
    pathApi.isAbsolute(candidate) &&
    !CONTROL_CHARACTER.test(candidate) &&
    /^pnpm\.(?:cjs|mjs|js)$/u.test(pathApi.basename(candidate))
  );
}

/** Resolve the already-active pnpm JavaScript entrypoint without asking Corepack to download it. */
export async function resolveDistributionPnpmCommand(input) {
  const filesystem = input.filesystem ?? fs;
  const version = expectedDistributionPnpmVersion(input.packageManager);
  const pathApi = pathApiForPlatform(input.platform);
  const corepackHome = defaultCorepackHome(input.environment, input.platform, input.homeDirectory);
  const candidates = [
    input.environment.npm_execpath,
    pathApi.join(corepackHome, 'v1', 'pnpm', version, 'bin', 'pnpm.mjs'),
    pathApi.join(corepackHome, 'v1', 'pnpm', version, 'bin', 'pnpm.cjs'),
  ].filter((candidate) => safeRuntimeCandidate(candidate, pathApi));
  for (const candidate of [...new Set(candidates)]) {
    try {
      const stats = await filesystem.stat(candidate);
      if (stats.isFile()) return Object.freeze([input.processExecutable, candidate]);
    } catch {
      // Try the next local runtime candidate. No package-manager process is started here.
    }
  }
  throw new Error(
    `The pinned pnpm ${version} runtime is not available locally; run through the repository's pnpm runtime first.`,
  );
}

/** Locate pnpm's active default cache without honoring project or user registry configuration. */
export function defaultDistributionPnpmCacheDirectory(input) {
  const environment = input.environment;
  const pathApi = pathApiForPlatform(input.platform);
  if (typeof environment.XDG_CACHE_HOME === 'string' && environment.XDG_CACHE_HOME.length > 0) {
    return pathApi.join(environment.XDG_CACHE_HOME, 'pnpm');
  }
  if (
    input.platform === 'win32' &&
    typeof environment.LOCALAPPDATA === 'string' &&
    environment.LOCALAPPDATA.length > 0
  ) {
    return pathApi.join(environment.LOCALAPPDATA, 'pnpm-cache');
  }
  const home =
    input.platform !== 'win32' &&
    typeof environment.HOME === 'string' &&
    environment.HOME.length > 0
      ? environment.HOME
      : (input.homeDirectory ?? homedir());
  if (input.platform === 'win32') {
    return pathApi.join(home, 'AppData', 'Local', 'pnpm-cache');
  }
  return input.platform === 'darwin'
    ? pathApi.join(home, 'Library', 'Caches', 'pnpm')
    : pathApi.join(home, '.cache', 'pnpm');
}

async function inventoryMetadataTree(filesystem, root) {
  const files = [];
  let entryCount = 0;
  let totalBytes = 0;
  const visit = async (directory, relativeSegments) => {
    if (relativeSegments.length > MAX_METADATA_DEPTH) {
      throw new Error(`Public registry metadata exceeds depth ${MAX_METADATA_DEPTH}.`);
    }
    const entries = [];
    let handle;
    try {
      handle = await filesystem.opendir(directory);
      for await (const entry of handle) {
        entryCount += 1;
        if (entryCount > MAX_METADATA_ENTRIES) {
          throw new Error('Public registry metadata exceeds the bounded entry limit.');
        }
        entries.push(entry);
      }
    } catch (error) {
      await handle?.close().catch(() => false);
      throw error;
    }
    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const source = join(directory, entry.name);
      const childSegments = [...relativeSegments, entry.name];
      const stats = await filesystem.lstat(source);
      if (entry.isDirectory() && stats.isDirectory()) {
        await visit(source, childSegments);
        continue;
      }
      if (!entry.isFile() || !stats.isFile()) {
        throw new Error('Public registry metadata may contain only regular files and directories.');
      }
      if (stats.size > MAX_METADATA_FILE_BYTES) {
        throw new Error(
          `A public registry metadata file exceeds ${MAX_METADATA_FILE_BYTES} bytes.`,
        );
      }
      totalBytes += stats.size;
      files.push({ source, relativeSegments: childSegments });
      if (files.length > MAX_METADATA_FILES || totalBytes > MAX_METADATA_BYTES) {
        throw new Error('Public registry metadata exceeds the bounded clone limits.');
      }
    }
  };
  await visit(root, []);
  if (files.length === 0) throw new Error('The active public registry metadata cache is empty.');
  return files;
}

/** Reflink/copy a bounded public-registry-only pnpm metadata mirror into the isolated cache. */
export async function cloneDistributionRegistryMetadata(input) {
  const filesystem = input.filesystem ?? fs;
  const major = Number.parseInt(expectedDistributionPnpmVersion(input.packageManager), 10);
  if (!Number.isSafeInteger(major) || major < 1) {
    throw new Error('The pinned pnpm packageManager version has an invalid major version.');
  }
  const relativeMetadataRoot = join(`v${String(major)}`, 'metadata');
  const sourceRoot = join(input.sourceCacheDirectory, relativeMetadataRoot, 'registry.npmjs.org');
  const destinationRoot = join(
    input.destinationCacheDirectory,
    'pnpm',
    relativeMetadataRoot,
    distributionSentinelMetadataKey(input.destinationRegistryOrigin),
  );
  const files = await inventoryMetadataTree(filesystem, sourceRoot);
  await filesystem.mkdir(destinationRoot, { recursive: true });
  for (const file of files) {
    const destination = join(destinationRoot, ...file.relativeSegments);
    await filesystem.mkdir(dirname(destination), { recursive: true });
    await filesystem.copyFile(file.source, destination, fsConstants.COPYFILE_FICLONE);
  }
  return Object.freeze({ fileCount: files.length });
}

/** Encode the exact IPv4 loopback sentinel origin the same way pnpm keys registry metadata. */
export function distributionSentinelMetadataKey(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('The offline registry sentinel origin is invalid.');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('The offline registry sentinel must be an IPv4 loopback origin with a port.');
  }
  return `127.0.0.1+${String(port)}`;
}

function decodeYamlKey(raw) {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('pnpm lockfile contains an invalid quoted package key.');
    }
  }
  return raw;
}

/** Read only top-level `packages` keys from pnpm's v9 lockfile shape. */
export function distributionLockPackageKeys(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_LOCKFILE_BYTES) {
    throw new Error('pnpm lockfile exceeds the bounded parser limit.');
  }
  const keys = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/u)) {
    if (line === 'packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/u.test(line)) break;
    const match = inPackages ? /^ {2}(\S.*):$/u.exec(line) : null;
    if (match === null) continue;
    const key = decodeYamlKey(match[1]);
    if (key.length === 0 || key.length > 1024 || CONTROL_CHARACTER.test(key)) {
      throw new Error('pnpm lockfile contains an invalid package key.');
    }
    keys.push(key);
  }
  if (!inPackages || keys.length === 0) {
    throw new Error('pnpm lockfile must contain a non-empty packages map.');
  }
  return Object.freeze(keys);
}

function expectedLocalReleasePackageKeys(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 128) {
    throw new Error('The lock proof requires a bounded non-empty release tarball set.');
  }
  const names = new Set();
  const keys = new Set();
  for (const [index, row] of rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`releaseTarballs[${String(index)}] must be an object.`);
    }
    const { packageName, fileName } = row;
    if (
      typeof packageName !== 'string' ||
      !/^(?:opensip-cli|@opensip-cli\/[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(packageName) ||
      names.has(packageName)
    ) {
      throw new Error('The lock proof release package identities are invalid or duplicated.');
    }
    if (
      typeof fileName !== 'string' ||
      fileName.length === 0 ||
      fileName.length > 255 ||
      !/^[a-z0-9][a-z0-9.-]*\.tgz$/u.test(fileName) ||
      CONTROL_CHARACTER.test(fileName)
    ) {
      throw new Error('The lock proof release tarball filename is invalid.');
    }
    names.add(packageName);
    keys.add(`${packageName}@file:../artifacts/${fileName}`);
  }
  return keys;
}

/** Prove that offline resolution introduced no third-party package absent from the root lock. */
export function assertDistributionLockSubset(input) {
  const rootKeys = new Set(distributionLockPackageKeys(input.rootLockText));
  const localReleaseKeys = expectedLocalReleasePackageKeys(input.releaseTarballs);
  const unexpected = distributionLockPackageKeys(input.consumerLockText).filter((key) => {
    const openSipCoordinate = key.startsWith('opensip-cli@') || key.startsWith('@opensip-cli/');
    return openSipCoordinate ? !localReleaseKeys.has(key) : !rootKeys.has(key);
  });
  if (unexpected.length > 0) {
    throw new Error('The prepared consumer lock contains packages outside the repository lock.');
  }
}
