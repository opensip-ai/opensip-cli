/**
 * @fileoverview Run-owned Node-resolution bridge for fixed extension fixtures.
 *
 * Capability-pack fixtures declare the OpenSIP SDK packages they import as
 * peers. Native acceptance must bind those imports to the candidate under test,
 * never to a cached/published substitute. npm lays dependencies out differently
 * for packed consumers and global installs, so the runner creates three narrow
 * links at `<runRoot>/node_modules` to packages resolved by the pinned candidate.
 * The bridge remains outside the candidate integrity tree while ordinary ESM
 * ancestor resolution from `<runRoot>/journeys/...` can consume it.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

export const CANDIDATE_FIXTURE_PEERS = Object.freeze([
  '@opensip-cli/core',
  '@opensip-cli/fitness',
  '@opensip-cli/simulation',
]);

const MAX_PACKAGE_MANIFEST_BYTES = 1_048_576;

const REAL_FS = Object.freeze({
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
});

export class CandidatePeerBridgeError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'CandidatePeerBridgeError';
    this.kind = kind;
  }
}

const fail = (kind, message) => {
  throw new CandidatePeerBridgeError(kind, message);
};

function isUnderOrEqual(root, target) {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function captureConcreteDirectoryIdentity(fs, path, boundary, label) {
  const real = fs.realpathSync(path);
  const stat = fs.lstatSync(path);
  if (
    real !== path ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    !isUnderOrEqual(boundary, real)
  ) {
    fail('root-escape', `${label} was not a concrete directory inside the run root`);
  }
  if (
    (typeof stat.dev !== 'number' && typeof stat.dev !== 'bigint') ||
    (typeof stat.ino !== 'number' && typeof stat.ino !== 'bigint')
  ) {
    fail('root-escape', `${label} did not expose a stable filesystem identity`);
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino, realpath: real });
}

function matchesDirectoryIdentity(fs, path, identity) {
  try {
    const stat = fs.lstatSync(path);
    return (
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      fs.realpathSync(path) === identity.realpath &&
      stat.dev === identity.dev &&
      stat.ino === identity.ino
    );
  } catch {
    return false;
  }
}

function installedRuntimeRoot(fs, installed, runRootReal) {
  if (typeof installed?.packageDir !== 'string') {
    fail('candidate-invalid', 'installed candidate omitted packageDir');
  }
  const packageDir = fs.realpathSync(installed.packageDir);
  if (basename(packageDir) !== 'opensip-cli' || !isUnderOrEqual(runRootReal, packageDir)) {
    fail('candidate-invalid', 'installed candidate packageDir was outside the run root');
  }

  let runtimeRoot;
  if (installed.mode === 'packed-release') {
    runtimeRoot = dirname(packageDir);
  } else if (installed.mode === 'published-version' && typeof installed.globalPrefix === 'string') {
    runtimeRoot = fs.realpathSync(installed.globalPrefix);
  } else {
    fail('candidate-invalid', 'installed candidate mode/runtime root was incomplete');
  }
  if (!isUnderOrEqual(runRootReal, runtimeRoot)) {
    fail('candidate-invalid', 'installed candidate runtime root escaped the run root');
  }
  if (!isUnderOrEqual(runtimeRoot, packageDir)) {
    fail('candidate-invalid', 'installed candidate packageDir escaped its runtime root');
  }
  return runtimeRoot;
}

function readPackageManifest(fs, packageRoot) {
  const path = join(packageRoot, 'package.json');
  const stat = fs.statSync(path);
  if (!stat.isFile() || stat.size > MAX_PACKAGE_MANIFEST_BYTES) {
    fail('candidate-invalid', 'candidate peer package manifest was not a bounded regular file');
  }
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fail('candidate-invalid', 'candidate peer package manifest was invalid JSON');
  }
}

function locatePackageRoot(fs, resolvedEntry, packageName, runtimeRoot, expectedVersion) {
  const entryReal = fs.realpathSync(resolvedEntry);
  if (!isUnderOrEqual(runtimeRoot, entryReal)) {
    fail('candidate-invalid', `resolved ${packageName} outside the pinned candidate runtime`);
  }
  let current = dirname(entryReal);
  while (isUnderOrEqual(runtimeRoot, current)) {
    const manifestPath = join(current, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = readPackageManifest(fs, current);
      if (manifest?.name === packageName) {
        if (manifest.version !== expectedVersion) {
          fail('candidate-invalid', `${packageName} version did not match the candidate version`);
        }
        return current;
      }
    }
    if (current === runtimeRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fail('candidate-invalid', `could not locate the resolved ${packageName} package root`);
}

function safeRemoveBridge(fs, bridgeRoot, runRootReal) {
  if (!fs.existsSync(bridgeRoot)) return;
  try {
    const stat = fs.lstatSync(bridgeRoot);
    const real = fs.realpathSync(bridgeRoot);
    if (
      !stat.isSymbolicLink() &&
      stat.isDirectory() &&
      real === bridgeRoot &&
      isUnderOrEqual(runRootReal, real)
    ) {
      fs.rmSync(bridgeRoot, { recursive: true, force: true });
    }
  } catch {
    /* caller reports the authoritative bridge failure */
  }
}

/** Create a fresh bridge and return its pinned link identities. */
export function createCandidatePeerBridge({
  installed,
  runRoot,
  platform = process.platform,
  peers = CANDIDATE_FIXTURE_PEERS,
  fs = REAL_FS,
  resolvePackage,
}) {
  const runRootIdentity = captureConcreteDirectoryIdentity(
    fs,
    runRoot,
    fs.realpathSync(runRoot),
    'run root',
  );
  const runRootReal = runRootIdentity.realpath;
  const runtimeRoot = installedRuntimeRoot(fs, installed, runRootReal);
  if (typeof installed?.resolvedVersion !== 'string' || installed.resolvedVersion.length === 0) {
    fail('candidate-invalid', 'installed candidate omitted its resolved version');
  }
  const bridgeRoot = join(runRootReal, 'node_modules');
  if (fs.existsSync(bridgeRoot)) {
    fail('root-escape', 'candidate peer bridge path already existed');
  }

  const resolveFromCandidate =
    resolvePackage ?? createRequire(installed.jsEntrypoint.script).resolve;
  const links = [];
  const scopeIdentities = new Map();
  let rootIdentity;
  try {
    fs.mkdirSync(bridgeRoot);
    rootIdentity = captureConcreteDirectoryIdentity(
      fs,
      bridgeRoot,
      runRootReal,
      'candidate peer bridge',
    );
    for (const packageName of peers) {
      const resolvedEntry = resolveFromCandidate(packageName);
      const packageRoot = locatePackageRoot(
        fs,
        resolvedEntry,
        packageName,
        runtimeRoot,
        installed.resolvedVersion,
      );
      const scopeDir = join(bridgeRoot, dirname(packageName));
      if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir);
      const scopeIdentity = captureConcreteDirectoryIdentity(
        fs,
        scopeDir,
        runRootReal,
        'candidate peer bridge scope',
      );
      const priorScopeIdentity = scopeIdentities.get(scopeDir);
      if (
        priorScopeIdentity !== undefined &&
        !matchesDirectoryIdentity(fs, scopeDir, priorScopeIdentity)
      ) {
        fail('root-escape', 'candidate peer bridge scope changed during creation');
      }
      scopeIdentities.set(scopeDir, priorScopeIdentity ?? scopeIdentity);
      const linkPath = join(bridgeRoot, packageName);
      fs.symlinkSync(packageRoot, linkPath, platform === 'win32' ? 'junction' : 'dir');
      const linkedReal = fs.realpathSync(linkPath);
      const linkStat = fs.lstatSync(linkPath);
      if (!linkStat.isSymbolicLink() || linkedReal !== packageRoot) {
        fail('root-escape', `candidate peer bridge link for ${packageName} was substituted`);
      }
      links.push(
        Object.freeze({
          name: packageName,
          linkPath,
          targetRealpath: packageRoot,
          version: installed.resolvedVersion,
        }),
      );
    }
  } catch (error) {
    safeRemoveBridge(fs, bridgeRoot, runRootReal);
    if (error instanceof CandidatePeerBridgeError) throw error;
    fail('candidate-invalid', error instanceof Error ? error.message : String(error));
  }
  return Object.freeze({
    root: bridgeRoot,
    rootIdentity,
    runRoot: runRootReal,
    runtimeRoot,
    candidateVersion: installed.resolvedVersion,
    scopeIdentities: Object.freeze(
      [...scopeIdentities.entries()].map(([path, identity]) =>
        Object.freeze({ path, ...identity }),
      ),
    ),
    links: Object.freeze(links),
  });
}

/**
 * Prove that ordinary resolution from an extension host reaches the exact
 * candidate packages. A valid bridge can still be shadowed by a nearer
 * `node_modules`, so link identity alone is not sufficient evidence.
 */
export function verifyCandidatePeerResolution(
  bridge,
  { anchor, fs = REAL_FS, resolvePackage } = {},
) {
  verifyCandidatePeerBridge(bridge, { fs });
  if (
    typeof anchor !== 'string' ||
    !isAbsolute(anchor) ||
    !isUnderOrEqual(bridge.runRoot, anchor) ||
    isUnderOrEqual(bridge.root, anchor)
  ) {
    fail('root-escape', 'candidate peer resolution anchor escaped the journey tree');
  }
  rejectNearerPeerEntries(bridge, anchor, fs);
  const resolveFromExtension = resolvePackage ?? createRequire(anchor).resolve;
  for (const link of bridge.links) {
    let resolvedReal;
    try {
      resolvedReal = fs.realpathSync(resolveFromExtension(link.name));
    } catch {
      fail('root-escape', `candidate peer resolution for ${link.name} was unavailable`);
    }
    if (!isUnderOrEqual(link.targetRealpath, resolvedReal)) {
      fail('root-escape', `candidate peer resolution for ${link.name} was shadowed`);
    }
  }
  return bridge;
}

function rejectNearerPeerEntries(bridge, anchor, fs) {
  let current = dirname(anchor);
  while (isUnderOrEqual(bridge.runRoot, current)) {
    const nodeModules = join(current, 'node_modules');
    if (nodeModules === bridge.root) return;
    for (const link of bridge.links) {
      const peerPath = join(nodeModules, link.name);
      try {
        fs.lstatSync(peerPath);
      } catch (error) {
        if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
        fail('root-escape', `candidate peer shadow path for ${link.name} was unreadable`);
      }
      fail('root-escape', `candidate peer resolution for ${link.name} had a nearer entry`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail('root-escape', 'candidate peer resolution did not reach the run-owned bridge');
}

/** Revalidate every bridge link before another extension journey consumes it. */
export function verifyCandidatePeerBridge(bridge, { fs = REAL_FS } = {}) {
  if (!matchesDirectoryIdentity(fs, bridge.root, bridge.rootIdentity)) {
    fail('root-escape', 'candidate peer bridge root changed');
  }
  for (const scope of bridge.scopeIdentities) {
    if (!matchesDirectoryIdentity(fs, scope.path, scope)) {
      fail('root-escape', 'candidate peer bridge scope changed');
    }
  }
  for (const link of bridge.links) {
    let stat;
    let real;
    try {
      stat = fs.lstatSync(link.linkPath);
      real = fs.realpathSync(link.linkPath);
    } catch {
      fail('root-escape', `candidate peer bridge link for ${link.name} was unavailable`);
    }
    if (!stat.isSymbolicLink() || real !== link.targetRealpath) {
      fail('root-escape', `candidate peer bridge link for ${link.name} changed`);
    }
    const manifest = readPackageManifest(fs, link.targetRealpath);
    if (manifest?.name !== link.name || manifest.version !== link.version) {
      fail('candidate-invalid', `candidate peer identity for ${link.name} changed`);
    }
  }
  return bridge;
}

/** Remove only the concrete run-owned bridge; links are never followed. */
export function removeCandidatePeerBridge(bridge, { runRoot, fs = REAL_FS }) {
  verifyCandidatePeerBridge(bridge, { fs });
  const runRootReal = fs.realpathSync(runRoot);
  if (!matchesDirectoryIdentity(fs, bridge.root, bridge.rootIdentity)) {
    fail('root-escape', 'candidate peer bridge root changed before removal');
  }
  if (!isUnderOrEqual(runRootReal, bridge.rootIdentity.realpath)) {
    fail('root-escape', 'candidate peer bridge escaped before removal');
  }
  fs.rmSync(bridge.root, { recursive: true, force: true });
}
