/**
 * @fileoverview Isolated install / upgrade / removal state machine for platform
 * acceptance.
 *
 * A `CandidateLifecycle` owns everything a run does to the machine under test.
 * It installs ONLY the two trusted candidate forms resolved by
 * `candidate-source.mjs`, into run-owned npm state that never touches the real
 * user's HOME, npm prefix, cache, or config. It models the documented journey as
 * an explicit state machine — `empty → installed → (upgraded) →
 * cli-state-removed → package-removed → cleaned` — and rejects invalid
 * transitions.
 *
 * Guarantees:
 *   - Deterministic, credential-free child environment: run-owned HOME/TMP/npm
 *     paths on every platform; ambient npm auth/proxy/token vars and user config
 *     are dropped. Every child is spawned with an argv array — never a shell.
 *   - The customer invocation is ALWAYS the run-owned installed descriptor (an
 *     absolute path under the run root). A bare `opensip` from ambient PATH is
 *     never spawned; the count is proven zero after removal.
 *   - `opensip uninstall` (OpenSIP state) is kept strictly separate from
 *     `npm uninstall` (the package); each is asserted to remove only its
 *     documented boundary.
 *   - Cleanup is idempotent and safe: it realpaths every deletion target,
 *     requires ancestry under the run root, and returns evidence even after a
 *     journey failure.
 *   - The module never prints. It exposes lifecycle events; only failed events
 *     carry a bounded, redacted npm output tail.
 *
 * Dependency-free apart from Node built-ins and the sibling candidate-source
 * module, so a release script can import it with no build step.
 *
 * @typedef {import('./contract.d.mts').CleanupResult} CleanupResult
 * @typedef {import('./contract.d.mts').CandidateIdentity} CandidateIdentity
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  CANDIDATE_REASON_CODES,
  NPMJS_REGISTRY,
  resolveInstalledDescriptors,
} from './candidate-source.mjs';
import { runMeasuredProcess } from '../lib/measured-process.mjs';
import { registryIntegrityDigest } from '../lib/registry-integrity-inventory.mjs';
import { resolveInstalledCliInvocation, resolveNpmInvocation } from './node-cli-invocation.mjs';
import { verifyInstalledRegistryBinding } from './registry-install-binding.mjs';
import { redactSensitiveText } from './sensitive-text.mjs';
import { readBoundedFileBytes } from './bounded-owned-file.mjs';

/** Every state a lifecycle can occupy. */
export const CANDIDATE_LIFECYCLE_STATES = Object.freeze({
  EMPTY: 'empty',
  INSTALLED: 'installed',
  UPGRADED: 'upgraded',
  CLI_STATE_REMOVED: 'cli-state-removed',
  PACKAGE_REMOVED: 'package-removed',
  CLEANED: 'cleaned',
});

/** Lifecycle-phase reason codes (candidate-source owns source/descriptor codes). */
export const LIFECYCLE_REASON_CODES = Object.freeze({
  INVALID_TRANSITION: 'invalid-transition',
  REPRESENTATIVE_STATE_FAILED: 'representative-state-failed',
  STATE_MIGRATION_FAILED: 'state-migration-failed',
  CLI_STATE_REMOVAL_INCOMPLETE: 'cli-state-removal-incomplete',
  PACKAGE_REMOVAL_INCOMPLETE: 'package-removal-incomplete',
  CLEANUP_ESCAPE: 'cleanup-escape',
  CLEANUP_RESIDUAL: 'cleanup-residual',
  CANONICAL_INSTALLER_CHANGED: 'canonical-installer-changed',
});

const S = CANDIDATE_LIFECYCLE_STATES;
const L = LIFECYCLE_REASON_CODES;

const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_DIAGNOSTIC_TAIL_BYTES = 4096;
const MAX_CHILD_BUFFER = 16 * 1024 * 1024;
const MAX_LIFECYCLE_STEPS = 64;
const MAX_INSTALLED_ENTRYPOINT_BYTES = 16 * 1024 * 1024;
const MAX_INSTALLED_SHIM_BYTES = 1024 * 1024;
const MAX_PACKED_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_INSTALLED_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_CANONICAL_INSTALLER_BYTES = 1024 * 1024;
const MAX_RUNTIME_TREE_ENTRIES = 100_000;
const MAX_RUNTIME_TREE_DEPTH = 128;
const MAX_RUNTIME_TREE_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RUNTIME_TREE_TOTAL_BYTES = 2n * 1024n * 1024n * 1024n;
const MAX_RUNTIME_TREE_PATH_BYTES = 8 * 1024;
const MAX_RUNTIME_TREE_TOTAL_PATH_BYTES = 64 * 1024 * 1024;
const RUNTIME_TREE_HASH_BUFFER_BYTES = 64 * 1024;

// Network-ish npm failures map to `registry-unavailable`; everything else to
// `install-failed`. Kept deliberately broad — a false "unavailable" is a
// truthful "we could not prove the candidate", never a green-wash.
const REGISTRY_FAILURE =
  /enotfound|etimedout|econnrefused|econnreset|eai_again|getaddrinfo|network|socket hang up|etarget|e404|403 forbidden|401 unauthorized|registry/i;

const SESSION_PERSISTED_KEYS = Object.freeze([
  'id',
  'tool',
  'cwd',
  'suiteRunId',
  'suiteName',
  'recipe',
  'score',
  'passed',
  'runOutcome',
  'startedAt',
  'completedAt',
  'durationMs',
  'cliVersion',
  'engineVersion',
  'payload',
]);

function readSessionHistory(child) {
  if (!isCleanChildResult(child)) return { ok: false, message: 'session history command failed' };
  let parsed;
  try {
    parsed = JSON.parse(child.stdout);
  } catch {
    return { ok: false, message: 'session history was not valid JSON' };
  }
  const data = isPlainObject(parsed?.data) ? parsed.data : parsed;
  if (!Array.isArray(data?.sessions)) {
    return {
      ok: false,
      message: 'session history did not contain a sessions array',
    };
  }
  return { ok: true, sessions: data.sessions };
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (!isPlainObject(value)) throw new TypeError('session contains a non-JSON value');
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function snapshotSession(record) {
  if (
    !isPlainObject(record) ||
    typeof record.id !== 'string' ||
    record.id.length === 0 ||
    typeof record.tool !== 'string' ||
    record.tool.length === 0 ||
    typeof record.cwd !== 'string' ||
    record.cwd.length === 0 ||
    typeof record.startedAt !== 'string' ||
    typeof record.completedAt !== 'string' ||
    !Number.isFinite(record.score) ||
    typeof record.passed !== 'boolean' ||
    !Number.isFinite(record.durationMs)
  ) {
    return null;
  }
  const persisted = {};
  for (const key of SESSION_PERSISTED_KEYS) {
    if (Object.hasOwn(record, key)) persisted[key] = record[key];
  }
  try {
    return Object.freeze({
      id: record.id,
      digest: createHash('sha256').update(canonicalJson(persisted)).digest('hex'),
    });
  } catch {
    return null;
  }
}

function sameSessionSnapshot(record, expected) {
  const actual = snapshotSession(record);
  return actual !== null && actual.id === expected.id && actual.digest === expected.digest;
}

function regularFileIdentity(path, maxBytes, reasonPrefix) {
  let descriptor;
  try {
    const realPath = realpathSync(path);
    const pathBefore = lstatSync(realPath, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) return { ok: false };
    const noFollow =
      process.platform === 'win32' || typeof fsConstants.O_NOFOLLOW !== 'number'
        ? 0
        : fsConstants.O_NOFOLLOW;
    const nonBlock =
      process.platform === 'win32' || typeof fsConstants.O_NONBLOCK !== 'number'
        ? 0
        : fsConstants.O_NONBLOCK;
    descriptor = openSync(realPath, fsConstants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== pathBefore.dev ||
      opened.ino !== pathBefore.ino ||
      opened.size <= 0n ||
      opened.size > BigInt(maxBytes)
    ) {
      return { ok: false };
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return { ok: false };
    const completed = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(realPath, { bigint: true });
    if (
      !completed.isFile() ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      opened.dev !== completed.dev ||
      opened.ino !== completed.ino ||
      opened.size !== completed.size ||
      opened.ctimeNs !== completed.ctimeNs ||
      opened.mtimeNs !== completed.mtimeNs ||
      completed.dev !== pathAfter.dev ||
      completed.ino !== pathAfter.ino ||
      completed.size !== pathAfter.size ||
      completed.ctimeNs !== pathAfter.ctimeNs ||
      completed.mtimeNs !== pathAfter.mtimeNs ||
      completed.size !== BigInt(offset) ||
      realpathSync(path) !== realPath
    ) {
      return { ok: false };
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    return {
      ok: true,
      buffer: bytes,
      identity: Object.freeze({
        kind: 'regular-file',
        realPath,
        device: completed.dev.toString(),
        inode: completed.ino.toString(),
        sizeBytes: completed.size.toString(),
        changeTimeNanoseconds: completed.ctimeNs.toString(),
        modificationTimeNanoseconds: completed.mtimeNs.toString(),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    };
  } catch {
    return { ok: false, reasonPrefix };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Identity has already failed closed or was captured from the open fd.
      }
    }
  }
}

function symlinkIdentity(path, expectedRealPath) {
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isSymbolicLink()) return { ok: false };
    const linkTarget = readlinkSync(path);
    const realPath = realpathSync(path);
    const after = lstatSync(path, { bigint: true });
    if (
      realPath !== expectedRealPath ||
      !after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      readlinkSync(path) !== linkTarget
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      identity: Object.freeze({
        kind: 'symbolic-link',
        realPath,
        linkTarget,
        device: after.dev.toString(),
        inode: after.ino.toString(),
        sizeBytes: after.size.toString(),
        changeTimeNanoseconds: after.ctimeNs.toString(),
        modificationTimeNanoseconds: after.mtimeNs.toString(),
      }),
    };
  } catch {
    return { ok: false };
  }
}

function sameRuntimeNodeStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

function runtimeNodeRecord(kind, path, stat, extra = {}) {
  return Object.freeze({
    kind,
    path,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    userId: stat.uid.toString(),
    groupId: stat.gid.toString(),
    mode: stat.mode.toString(),
    links: stat.nlink.toString(),
    sizeBytes: stat.size.toString(),
    changeTimeNanoseconds: stat.ctimeNs.toString(),
    modificationTimeNanoseconds: stat.mtimeNs.toString(),
    ...extra,
  });
}

function relativeRuntimePath(root, target) {
  const rel = relative(root, target);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

function compareRuntimeNodePaths(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function expectedRuntimeHash(expectedByPath, observed) {
  if (expectedByPath === null) return { ok: true, sha256: null };
  const expected = expectedByPath.get(observed.path);
  if (!isPlainObject(expected)) return { ok: false };
  const projected = { ...expected };
  const sha256 = projected.sha256;
  delete projected.sha256;
  if (canonicalJson(projected) !== canonicalJson(observed)) {
    return { ok: false };
  }
  if (observed.kind === 'regular-file') {
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) {
      return { ok: false };
    }
    return { ok: true, sha256 };
  }
  return sha256 === undefined ? { ok: true, sha256: null } : { ok: false };
}

/**
 * Pin the whole installed runtime tree once, then revalidate its closed path and
 * filesystem identity inventory at every journey boundary. Regular files are
 * streamed into SHA-256 only during initial capture. A later observation may
 * reuse that digest only when path, type, inode, size, mode, link count, owner,
 * ctime, and mtime all still match. Symlinks are never traversed and must resolve
 * inside the runtime root; special filesystem nodes fail closed.
 */
function runtimeTreeIdentity(runtimeRoot, runRoot, expected = null) {
  try {
    const runRootReal = realpathSync(runRoot);
    const rootBefore = lstatSync(runtimeRoot, { bigint: true });
    if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
      return { ok: false };
    }
    const rootReal = realpathSync(runtimeRoot);
    if (!isUnderRoot(runRootReal, rootReal)) return { ok: false };

    let expectedByPath = null;
    if (expected !== null) {
      if (
        !isPlainObject(expected) ||
        expected.rootRealPath !== rootReal ||
        !Array.isArray(expected.entries) ||
        expected.entries.length > MAX_RUNTIME_TREE_ENTRIES
      ) {
        return { ok: false };
      }
      expectedByPath = new Map();
      for (const entry of expected.entries) {
        if (
          !isPlainObject(entry) ||
          typeof entry.path !== 'string' ||
          expectedByPath.has(entry.path)
        ) {
          return { ok: false };
        }
        expectedByPath.set(entry.path, entry);
      }
    }

    const entries = [];
    const directoriesToRevalidate = [];
    const discovered = new Set(['.']);
    const stack = [{ absolutePath: rootReal, path: '.', depth: 0 }];
    let totalFileBytes = 0n;
    let totalPathBytes = Buffer.byteLength('.');

    while (stack.length > 0) {
      const current = stack.pop();
      const before = lstatSync(current.absolutePath, { bigint: true });

      if (before.isSymbolicLink()) {
        const realPath = realpathSync(current.absolutePath);
        const resolvedPath = relativeRuntimePath(rootReal, realPath);
        if (resolvedPath === null) return { ok: false };
        const linkTarget = readlinkSync(current.absolutePath);
        const linkBytes = Buffer.byteLength(linkTarget);
        const resolvedBytes = Buffer.byteLength(resolvedPath);
        if (
          linkBytes > MAX_RUNTIME_TREE_PATH_BYTES ||
          resolvedBytes > MAX_RUNTIME_TREE_PATH_BYTES ||
          totalPathBytes + linkBytes + resolvedBytes > MAX_RUNTIME_TREE_TOTAL_PATH_BYTES
        ) {
          return { ok: false };
        }
        totalPathBytes += linkBytes + resolvedBytes;
        const after = lstatSync(current.absolutePath, { bigint: true });
        if (
          !after.isSymbolicLink() ||
          !sameRuntimeNodeStat(before, after) ||
          readlinkSync(current.absolutePath) !== linkTarget ||
          realpathSync(current.absolutePath) !== realPath
        ) {
          return { ok: false };
        }
        const observed = runtimeNodeRecord('symbolic-link', current.path, after, {
          linkTarget,
          resolvedPath,
        });
        if (!expectedRuntimeHash(expectedByPath, observed).ok) {
          return { ok: false };
        }
        entries.push(observed);
        continue;
      }

      if (before.isDirectory()) {
        if (current.depth > MAX_RUNTIME_TREE_DEPTH) return { ok: false };
        const realPath = realpathSync(current.absolutePath);
        const resolvedPath = relativeRuntimePath(rootReal, realPath);
        if (resolvedPath !== current.path) return { ok: false };
        const directory = opendirSync(current.absolutePath);
        try {
          for (let dirent = directory.readSync(); dirent !== null;) {
            const childPath = join(current.absolutePath, dirent.name);
            const childRelative = relativeRuntimePath(rootReal, childPath);
            const childPathBytes =
              childRelative === null
                ? MAX_RUNTIME_TREE_PATH_BYTES + 1
                : Buffer.byteLength(childRelative);
            if (
              childRelative === null ||
              childRelative === '.' ||
              discovered.has(childRelative) ||
              childPathBytes > MAX_RUNTIME_TREE_PATH_BYTES ||
              discovered.size >= MAX_RUNTIME_TREE_ENTRIES ||
              totalPathBytes + childPathBytes > MAX_RUNTIME_TREE_TOTAL_PATH_BYTES
            ) {
              return { ok: false };
            }
            discovered.add(childRelative);
            totalPathBytes += childPathBytes;
            stack.push({
              absolutePath: childPath,
              path: childRelative,
              depth: current.depth + 1,
            });
            dirent = directory.readSync();
          }
        } finally {
          directory.closeSync();
        }
        const after = lstatSync(current.absolutePath, { bigint: true });
        if (
          !after.isDirectory() ||
          after.isSymbolicLink() ||
          !sameRuntimeNodeStat(before, after) ||
          realpathSync(current.absolutePath) !== realPath
        ) {
          return { ok: false };
        }
        const observed = runtimeNodeRecord('directory', current.path, after, {
          resolvedPath,
        });
        if (!expectedRuntimeHash(expectedByPath, observed).ok) {
          return { ok: false };
        }
        directoriesToRevalidate.push({
          absolutePath: current.absolutePath,
          identity: after,
          realPath,
        });
        entries.push(observed);
        continue;
      }

      if (!before.isFile()) return { ok: false };
      // Every ancestor directory was realpathed inside the runtime root and is
      // revalidated after all descendants. A regular leaf therefore has the
      // same resolved relative path as its lexical inventory path without an
      // additional realpath syscall per file.
      const resolvedPath = current.path;
      const observedBefore = runtimeNodeRecord('regular-file', current.path, before, {
        resolvedPath,
      });
      const expectedFile = expectedRuntimeHash(expectedByPath, observedBefore);
      if (!expectedFile.ok) return { ok: false };

      // The initial capture must open and hash every regular file. Later
      // boundary checks retain that content digest only when the complete
      // filesystem identity still matches. A persistent same-user rewrite,
      // replacement, chmod/chown, or relink changes at least one retained
      // inode/owner/mode/link/size/ctime/mtime field, so reopening thousands of
      // unchanged files adds no evidence and makes every journey O(tree I/O).
      if (expectedFile.sha256 !== null) {
        if (
          before.size > BigInt(MAX_RUNTIME_TREE_FILE_BYTES) ||
          totalFileBytes + before.size > MAX_RUNTIME_TREE_TOTAL_BYTES
        ) {
          return { ok: false };
        }
        const after = lstatSync(current.absolutePath, { bigint: true });
        if (!after.isFile() || after.isSymbolicLink() || !sameRuntimeNodeStat(before, after)) {
          return { ok: false };
        }
        entries.push(
          runtimeNodeRecord('regular-file', current.path, after, {
            resolvedPath,
            sha256: expectedFile.sha256,
          }),
        );
        totalFileBytes += after.size;
        continue;
      }

      let descriptor;
      try {
        const noFollow =
          process.platform === 'win32' || typeof fsConstants.O_NOFOLLOW !== 'number'
            ? 0
            : fsConstants.O_NOFOLLOW;
        const nonBlock =
          process.platform === 'win32' || typeof fsConstants.O_NONBLOCK !== 'number'
            ? 0
            : fsConstants.O_NONBLOCK;
        descriptor = openSync(current.absolutePath, fsConstants.O_RDONLY | noFollow | nonBlock);
        const opened = fstatSync(descriptor, { bigint: true });
        if (
          !opened.isFile() ||
          !sameRuntimeNodeStat(before, opened) ||
          opened.size > BigInt(MAX_RUNTIME_TREE_FILE_BYTES) ||
          totalFileBytes + opened.size > MAX_RUNTIME_TREE_TOTAL_BYTES
        ) {
          return { ok: false };
        }
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(RUNTIME_TREE_HASH_BUFFER_BYTES);
        let bytesReadTotal = 0n;
        for (;;) {
          const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) break;
          bytesReadTotal += BigInt(bytesRead);
          if (bytesReadTotal > opened.size) return { ok: false };
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (bytesReadTotal !== opened.size) return { ok: false };
        const sha256 = hash.digest('hex');

        const completed = fstatSync(descriptor, { bigint: true });
        const after = lstatSync(current.absolutePath, { bigint: true });
        if (
          !completed.isFile() ||
          !after.isFile() ||
          after.isSymbolicLink() ||
          !sameRuntimeNodeStat(opened, completed) ||
          !sameRuntimeNodeStat(completed, after)
        ) {
          return { ok: false };
        }
        entries.push(
          runtimeNodeRecord('regular-file', current.path, after, {
            resolvedPath,
            sha256,
          }),
        );
        totalFileBytes += after.size;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }

    // Directory checks happen again after every descendant has been observed.
    // This closes the interval introduced by the iterative traversal and makes
    // a persistent parent replacement/retargeting fail without realpathing each
    // regular leaf.
    for (const directory of directoriesToRevalidate) {
      const final = lstatSync(directory.absolutePath, { bigint: true });
      if (
        !final.isDirectory() ||
        final.isSymbolicLink() ||
        !sameRuntimeNodeStat(directory.identity, final) ||
        realpathSync(directory.absolutePath) !== directory.realPath
      ) {
        return { ok: false };
      }
    }

    if (
      expectedByPath !== null &&
      (expectedByPath.size !== discovered.size || expected.entryCount !== discovered.size)
    ) {
      return { ok: false };
    }
    entries.sort(compareRuntimeNodePaths);
    const rootAfter = lstatSync(runtimeRoot, { bigint: true });
    if (
      !rootAfter.isDirectory() ||
      rootAfter.isSymbolicLink() ||
      !sameRuntimeNodeStat(rootBefore, rootAfter) ||
      realpathSync(runtimeRoot) !== rootReal
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      identity: Object.freeze({
        rootRealPath: rootReal,
        entryCount: entries.length,
        totalFileBytes: totalFileBytes.toString(),
        totalPathBytes,
        entries: Object.freeze(entries),
      }),
    };
  } catch {
    return { ok: false };
  }
}

function installedIntegritySnapshot(installed, runRoot, platform, expected = null) {
  const descriptors = resolveInstalledDescriptors({
    runRoot,
    packageDir: installed.packageDir,
    binDir: installed.binDir,
    platform,
  });
  if (
    !descriptors.ok ||
    descriptors.installedBin.bin !== installed.installedBin.bin ||
    descriptors.jsEntrypoint.script !== installed.jsEntrypoint.script
  ) {
    return { ok: false };
  }
  const entrypoint = regularFileIdentity(
    descriptors.jsEntrypoint.script,
    MAX_INSTALLED_ENTRYPOINT_BYTES,
    'installed-entrypoint',
  );
  if (!entrypoint.ok) return { ok: false };
  const packageJson = regularFileIdentity(
    installed.packageJsonPath,
    MAX_INSTALLED_PACKAGE_JSON_BYTES,
    'installed-package-json',
  );
  if (
    !packageJson.ok ||
    installed.jsEntrypoint.entrypointSha256 !== `sha256:${entrypoint.identity.sha256}` ||
    installed.jsEntrypoint.packageJsonSha256 !== `sha256:${packageJson.identity.sha256}`
  ) {
    return { ok: false };
  }
  const customerBin =
    platform === 'win32'
      ? regularFileIdentity(
          descriptors.installedBin.bin,
          MAX_INSTALLED_SHIM_BYTES,
          'installed-customer-bin',
        )
      : symlinkIdentity(descriptors.installedBin.bin, descriptors.jsEntrypoint.script);
  if (!customerBin.ok) return { ok: false };
  let runtimeRoot = null;
  if (installed.mode === 'packed-release' && typeof installed.consumerCwd === 'string') {
    runtimeRoot = join(installed.consumerCwd, 'node_modules');
  } else if (installed.mode === 'published-version' && typeof installed.globalPrefix === 'string') {
    runtimeRoot = installed.globalPrefix;
  }
  if (runtimeRoot === null) return { ok: false };
  const runtimeTree = runtimeTreeIdentity(runtimeRoot, runRoot, expected?.runtimeTree ?? null);
  if (!runtimeTree.ok) return { ok: false };
  return {
    ok: true,
    identity: Object.freeze({
      entrypoint: entrypoint.identity,
      packageJson: packageJson.identity,
      customerBin: customerBin.identity,
      runtimeTree: runtimeTree.identity,
    }),
  };
}

function sameInstalledIntegrity(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/** A typed lifecycle error for invalid API usage (a programmer bug, not a run condition). */
class LifecycleError extends Error {
  constructor(reasonCode, message) {
    super(`${reasonCode}: ${message}`);
    this.name = 'LifecycleError';
    this.reasonCode = reasonCode;
  }
}

function safeHomedir() {
  try {
    return homedir();
  } catch {
    return '';
  }
}

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

/** True when `target` is a strict descendant of `root`. */
function isUnderRoot(root, target) {
  const rel = relative(root, target);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The deterministic base of ambient env keys a hermetic install may inherit:
 * toolchain discovery (PATH), locale/terminal, and Windows system essentials.
 * This is an ALLOWLIST, not a denylist — only these names are copied, so no
 * ambient secret (npm config, auth tokens, npmrc credentials, proxies, cloud
 * keys, …) can ever reach a child. Run-owned HOME/temp/npm overrides are layered
 * on top in `#buildEnv`. Matched case-insensitively for Windows (`Path`).
 */
const ENV_ALLOWLIST = new Set([
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  // Windows system essentials npm/node need (APPDATA/LOCALAPPDATA/TEMP/TMP are
  // overridden to run-owned paths in #buildEnv, so they are deliberately absent).
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SYSTEMDRIVE',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'ALLUSERSPROFILE',
]);

export class CandidateLifecycle {
  #runRoot;
  #runRootReal;
  #platform;
  #npmInvocation;
  #env;
  #owned = new Set();
  #homeDir;
  #tmpDir;
  #npmCacheDir;
  #npmPrefixDir;
  #configDir;
  #userNpmrc;
  #globalNpmrc;

  #state = S.EMPTY;
  #events = [];
  #onEvent;
  #invocations = [];
  #runChildImpl;
  #runSignal;
  #parentSignalCoordinator;
  #processBounds;

  #installTimeoutMs;
  #commandTimeoutMs;
  #diagnosticTailBytes;
  #redactPaths;

  #mode;
  #consumerCwd = null;
  #globalPrefix = null;
  #packageDir;
  #binDir;
  #npmVersionCache;
  #installed = null;
  #installedIntegrity = null;
  #project = null;
  #cleanupResult = null;
  #currentSteps = [];
  #snapshotNumber = 0;
  #registryInventory = null;
  #canonicalInstaller = null;

  /**
   * @param {object} options
   * @param {string} options.runRoot absolute, existing, run-owned root directory.
   * @param {string} [options.platform] defaults to `process.platform`.
   * @param {string} [options.npmCliPath] explicit npm JS entrypoint seam for Windows tests/embedding.
   * @param {object|null} [options.registryInventory] normalized published-release inventory.
   * @param {{ scriptPath: string, shellPath?: string, targetCandidateDigest: string }} [options.canonicalInstaller]
   *   Runner-owned canonical installer binding for one exact published target.
   * @param {(event: object) => void} [options.onEvent] observe each lifecycle event.
   * @param {(command: string, args: string[], opts: object) => object|Promise<object>} [options.runChild]
   *   test seam: replace the real child runner (returns `{ status, stdout, stderr, signal, error }`).
   * @param {{ installTimeoutMs?: number, commandTimeoutMs?: number, maxDiagnosticTailBytes?: number }} [options.bounds]
   */
  constructor(options) {
    if (typeof options?.runRoot !== 'string' || !isAbsolute(options.runRoot)) {
      throw new LifecycleError(
        LIFECYCLE_REASON_CODES.INVALID_TRANSITION,
        'runRoot must be an absolute path',
      );
    }
    if (!existsSync(options.runRoot)) {
      throw new LifecycleError(LIFECYCLE_REASON_CODES.INVALID_TRANSITION, 'runRoot must exist');
    }
    this.#runRoot = options.runRoot;
    this.#runRootReal = realpathSync(options.runRoot);
    this.#platform = options.platform ?? process.platform;
    this.#registryInventory = options.registryInventory ?? null;
    this.#npmInvocation = resolveNpmInvocation({
      platform: this.#platform,
      npmCliPath: options.npmCliPath,
    });
    this.#onEvent = typeof options.onEvent === 'function' ? options.onEvent : undefined;
    this.#runChildImpl =
      typeof options.runChild === 'function'
        ? options.runChild
        : (command, args, opts) => this.#defaultRunChild(command, args, opts);
    this.#runSignal = options.signal;
    this.#parentSignalCoordinator = options.parentSignalCoordinator;

    const bounds = options.bounds ?? {};
    this.#installTimeoutMs = bounds.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    this.#commandTimeoutMs = bounds.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#diagnosticTailBytes = bounds.maxDiagnosticTailBytes ?? DEFAULT_DIAGNOSTIC_TAIL_BYTES;
    this.#processBounds = Object.freeze({
      maxStdoutBytes: bounds.maxStdoutBytes,
      maxStderrBytes: bounds.maxStderrBytes,
      maxDiagnosticTailBytes: this.#diagnosticTailBytes,
      rssSampleIntervalMs: bounds.rssSampleIntervalMs,
    });

    // Run-owned paths (all strict descendants of the run root).
    this.#homeDir = join(this.#runRoot, 'home');
    this.#tmpDir = join(this.#runRoot, 'tmp');
    this.#npmCacheDir = join(this.#runRoot, 'npm-cache');
    this.#npmPrefixDir = join(this.#runRoot, 'npm-prefix');
    this.#configDir = join(this.#runRoot, 'npm-config');
    this.#userNpmrc = join(this.#configDir, 'user-npmrc');
    this.#globalNpmrc = join(this.#configDir, 'global-npmrc');

    for (const dir of [
      this.#homeDir,
      join(this.#homeDir, 'AppData', 'Roaming'),
      join(this.#homeDir, 'AppData', 'Local'),
      this.#tmpDir,
      this.#npmCacheDir,
      this.#npmPrefixDir,
      this.#configDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    // Empty run-owned npmrc files pin npm off the real user/global config.
    writeFileSync(this.#userNpmrc, '');
    writeFileSync(this.#globalNpmrc, '');
    for (const owned of [
      this.#homeDir,
      this.#tmpDir,
      this.#npmCacheDir,
      this.#npmPrefixDir,
      this.#configDir,
    ]) {
      this.#owned.add(owned);
    }

    this.#redactPaths = [this.#runRootReal, this.#runRoot, safeHomedir()].filter(Boolean);
    this.#env = this.#buildEnv();

    if (options.canonicalInstaller !== undefined) {
      const canonical = options.canonicalInstaller;
      const scriptPath = canonical?.scriptPath;
      const shellPath = canonical?.shellPath ?? '/bin/sh';
      const targetCandidateDigest = canonical?.targetCandidateDigest;
      let scriptStat;
      try {
        scriptStat = typeof scriptPath === 'string' ? lstatSync(scriptPath) : null;
      } catch {
        scriptStat = null;
      }
      const scriptIdentity =
        typeof scriptPath === 'string' &&
        isAbsolute(scriptPath) &&
        scriptStat?.isFile() === true &&
        scriptStat.isSymbolicLink() === false
          ? regularFileIdentity(
              scriptPath,
              MAX_CANONICAL_INSTALLER_BYTES,
              'canonical-installer-script',
            )
          : { ok: false };
      if (
        this.#platform === 'win32' ||
        !scriptIdentity.ok ||
        typeof shellPath !== 'string' ||
        !isAbsolute(shellPath) ||
        typeof targetCandidateDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(targetCandidateDigest)
      ) {
        throw new LifecycleError(
          L.INVALID_TRANSITION,
          'canonicalInstaller must bind a regular POSIX script to one exact candidate digest',
        );
      }

      const toolBin = join(this.#runRoot, 'canonical-installer-toolchain');
      const npmShim = join(toolBin, 'npm');
      mkdirSync(toolBin, { recursive: true });
      writeFileSync(
        npmShim,
        `#!/bin/sh\nexec ${[this.#npmInvocation.command, ...this.#npmInvocation.prefixArgs]
          .map((token) => shellQuote(token))
          .join(' ')} "$@"\n`,
        { mode: 0o700 },
      );
      chmodSync(npmShim, 0o700);
      const npmShimIdentity = regularFileIdentity(
        npmShim,
        MAX_INSTALLED_SHIM_BYTES,
        'canonical-installer-npm-shim',
      );
      if (!npmShimIdentity.ok) {
        throw new LifecycleError(
          L.INVALID_TRANSITION,
          'canonicalInstaller npm shim could not be identity-pinned',
        );
      }
      this.#owned.add(toolBin);
      this.#canonicalInstaller = Object.freeze({
        scriptPath,
        scriptIdentity: scriptIdentity.identity,
        shellPath,
        targetCandidateDigest,
        toolBin,
        npmShim,
        npmShimIdentity: npmShimIdentity.identity,
      });
    }
  }

  /** Current lifecycle state. */
  get state() {
    return this.#state;
  }

  /** Ordered, frozen lifecycle events emitted so far. */
  get events() {
    return Object.freeze([...this.#events]);
  }

  /** The immutable installed-candidate descriptor, or `null` before a successful install. */
  get installed() {
    return this.#installed;
  }

  /**
   * Re-resolve and hash both installed invocation descriptors. This is called
   * at every journey boundary so same-path replacement, in-place mutation, and
   * shim retargeting cannot silently change the candidate under qualification.
   */
  verifyInstalledIntegrity() {
    if (this.#installed === null || this.#installedIntegrity === null) {
      return Object.freeze({
        ok: false,
        reasonCode: 'installed-candidate-unavailable',
      });
    }
    const observed = installedIntegritySnapshot(
      this.#installed,
      this.#runRoot,
      this.#platform,
      this.#installedIntegrity,
    );
    if (!observed.ok || !sameInstalledIntegrity(observed.identity, this.#installedIntegrity)) {
      return Object.freeze({
        ok: false,
        reasonCode: 'installed-candidate-changed',
      });
    }
    return Object.freeze({ ok: true, reasonCode: null });
  }

  /** A copy of the deterministic child environment (for a runner that reuses it). */
  childEnv() {
    return { ...this.#env };
  }

  /** The exact shell-free npm toolchain descriptor used by this lifecycle. */
  npmInvocation() {
    return Object.freeze({
      argv: Object.freeze([this.#npmInvocation.command, ...this.#npmInvocation.prefixArgs]),
    });
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * Install a resolved candidate into fresh run-owned state. `empty → installed`.
   * @param {{ ok: true, identity: CandidateIdentity, install: object }} resolved
   */
  async install(resolved) {
    this.#requireState('install', [S.EMPTY]);
    this.#beginSteps();
    if (resolved?.ok !== true || !isPlainObject(resolved.install)) {
      return this.#failure(
        'install',
        CANDIDATE_REASON_CODES.INVALID_INPUT,
        null,
        'install requires a resolved candidate source',
      );
    }
    const { install } = resolved;
    this.#setupTargets(install.kind);

    const prepared = this.#prepareInstall(install);
    if (!prepared.ok) {
      return this.#failure('install', prepared.reasonCode, null, prepared.message);
    }
    const preinstallSnapshot = this.#verifySnapshotInventory(prepared.install);
    if (!preinstallSnapshot.ok) {
      return this.#failure(
        'install',
        preinstallSnapshot.reasonCode,
        null,
        preinstallSnapshot.message,
      );
    }
    const installation = await this.#installCandidate(
      resolved.identity,
      prepared.install,
      'candidate-install',
    );
    if (!installation.ok) {
      return this.#failure(
        'install',
        installation.reasonCode,
        installation.child,
        installation.message,
      );
    }
    const { child, installChannel } = installation;
    if (!isCleanChildResult(child)) {
      return this.#failure('install', this.#classifyInstallFailure(child), child);
    }
    if (prepared.install.kind === 'packed-release') {
      const postinstallSnapshot = this.#verifySnapshotInventory(prepared.install);
      if (!postinstallSnapshot.ok) {
        return this.#failure(
          'install',
          postinstallSnapshot.reasonCode,
          null,
          postinstallSnapshot.message,
        );
      }
      const provenance = this.#verifyPackedLockfile(prepared.install);
      if (!provenance.ok) {
        return this.#failure('install', provenance.reasonCode, null, provenance.message);
      }
    }
    let transitionRss = child.rss;
    let registryBinding = null;
    if (
      prepared.install.kind === 'published-version' &&
      resolved.identity.registryIntegrityDigest !== undefined
    ) {
      const provenance = await this.#verifyPublishedRegistryBinding(resolved.identity);
      if (!provenance.ok) {
        return this.#failure(
          'install',
          CANDIDATE_REASON_CODES.PUBLISHED_PROVENANCE_MISMATCH,
          provenance.child,
          provenance.message,
        );
      }
      transitionRss = mergeRss(transitionRss, ...provenance.children.map((entry) => entry.rss));
      registryBinding = provenance.evidence;
    }
    const captured = await this.#captureInstalled(resolved.identity, install.kind, installChannel);
    if (!captured.ok) {
      return this.#failure('install', captured.reasonCode, child, captured.message);
    }
    this.#installed = captured.installed;
    this.#installedIntegrity = captured.integrity;
    this.#state = S.INSTALLED;
    return this.#success(
      'install',
      {
        resolvedVersion: this.#installed.resolvedVersion,
        requestedVersion: resolved.identity.version,
        npmVersion: this.#installed.npmVersion,
        lockfilePresent: this.#installed.lockfilePresent,
        installChannel,
        registryBinding,
      },
      transitionRss,
    );
  }

  /**
   * Create representative CLI state (an initialized project + seeded datastore)
   * so an upgrade can prove state migration and `opensip uninstall` has a
   * documented boundary to act on. Does not change the lifecycle state.
   */
  async createRepresentativeState() {
    this.#requireState('createRepresentativeState', [S.INSTALLED, S.UPGRADED]);
    this.#beginSteps();
    if (this.#project) {
      return this.#success('representative-state', { reused: true });
    }
    const created = await this.#createProject();
    if (!created.ok) {
      return this.#failure(
        'representative-state',
        created.reasonCode,
        created.child,
        created.message,
      );
    }
    return this.#success(
      'representative-state',
      {
        configCreated: this.#project.configCreated,
        runtimeSeeded: this.#project.runtimeSeeded,
      },
      created.rss,
    );
  }

  /**
   * Upgrade in place to a new resolved candidate and prove version (and, when
   * representative state exists, state) migration. `installed → upgraded`.
   * @param {{ ok: true, identity: CandidateIdentity, install: object }} resolved
   */
  async upgrade(resolved) {
    this.#requireState('upgrade', [S.INSTALLED]);
    this.#beginSteps();
    if (resolved?.ok !== true || !isPlainObject(resolved.install)) {
      return this.#failure(
        'upgrade',
        CANDIDATE_REASON_CODES.INVALID_INPUT,
        null,
        'upgrade requires a resolved candidate source',
      );
    }
    if (resolved.install.kind !== this.#mode) {
      return this.#failure(
        'upgrade',
        CANDIDATE_REASON_CODES.INVALID_INPUT,
        null,
        'upgrade candidate must match the installed mode',
      );
    }
    const previousVersion = this.#installed.resolvedVersion;
    const runtimeExpected = this.#project ? this.#project.runtimeSeeded : false;

    const prepared = this.#prepareInstall(resolved.install);
    if (!prepared.ok) {
      return this.#failure('upgrade', prepared.reasonCode, null, prepared.message);
    }
    const preinstallSnapshot = this.#verifySnapshotInventory(prepared.install);
    if (!preinstallSnapshot.ok) {
      return this.#failure(
        'upgrade',
        preinstallSnapshot.reasonCode,
        null,
        preinstallSnapshot.message,
      );
    }
    const installation = await this.#installCandidate(
      resolved.identity,
      prepared.install,
      'candidate-upgrade',
    );
    if (!installation.ok) {
      return this.#failure(
        'upgrade',
        installation.reasonCode,
        installation.child,
        installation.message,
      );
    }
    const { child, installChannel } = installation;
    if (!isCleanChildResult(child)) {
      return this.#failure('upgrade', this.#classifyInstallFailure(child), child);
    }
    if (prepared.install.kind === 'packed-release') {
      const postinstallSnapshot = this.#verifySnapshotInventory(prepared.install);
      if (!postinstallSnapshot.ok) {
        return this.#failure(
          'upgrade',
          postinstallSnapshot.reasonCode,
          null,
          postinstallSnapshot.message,
        );
      }
      const provenance = this.#verifyPackedLockfile(prepared.install);
      if (!provenance.ok) {
        return this.#failure('upgrade', provenance.reasonCode, null, provenance.message);
      }
    }
    let transitionRss = child.rss;
    let registryBinding = null;
    if (
      prepared.install.kind === 'published-version' &&
      resolved.identity.registryIntegrityDigest !== undefined
    ) {
      const provenance = await this.#verifyPublishedRegistryBinding(resolved.identity);
      if (!provenance.ok) {
        return this.#failure(
          'upgrade',
          CANDIDATE_REASON_CODES.PUBLISHED_PROVENANCE_MISMATCH,
          provenance.child,
          provenance.message,
        );
      }
      transitionRss = mergeRss(transitionRss, ...provenance.children.map((entry) => entry.rss));
      registryBinding = provenance.evidence;
    }
    const captured = await this.#captureInstalled(
      resolved.identity,
      resolved.install.kind,
      installChannel,
    );
    if (!captured.ok) {
      return this.#failure('upgrade', captured.reasonCode, child, captured.message);
    }
    this.#installed = captured.installed;
    this.#installedIntegrity = captured.integrity;
    const newVersion = this.#installed.resolvedVersion;

    // State migration proof: the representative project survives the reinstall
    // and the NEW binary reads it without error.
    let stateMigrated = null;
    if (this.#project) {
      const markersPresent =
        existsSync(this.#project.configFile) &&
        (!runtimeExpected || existsSync(this.#project.runtimeDir));
      const readBack = await this.#runBin(
        ['sessions', 'list', '--json'],
        this.#project.projectDir,
        'upgrade-state-read',
      );
      transitionRss = mergeRss(transitionRss, readBack.rss);
      const history = readSessionHistory(readBack);
      const preserved =
        history.ok &&
        history.sessions.some((record) => sameSessionSnapshot(record, this.#project.session));
      stateMigrated = markersPresent && preserved;
      if (!stateMigrated) {
        return this.#failure(
          'upgrade',
          L.STATE_MIGRATION_FAILED,
          isCleanChildResult(readBack) ? null : readBack,
          history.ok
            ? 'representative session record did not survive the upgrade'
            : history.message,
        );
      }
    }

    this.#state = S.UPGRADED;
    return this.#success(
      'upgrade',
      {
        previousVersion,
        newVersion,
        versionMigrated: newVersion !== previousVersion,
        stateMigrated,
        installChannel,
        registryBinding,
      },
      transitionRss,
    );
  }

  /**
   * Remove OpenSIP CLI state via `opensip uninstall` — and assert it removed ONLY
   * its documented boundary (runtime state) while leaving the npm package + bin
   * and authored config intact. `installed|upgraded → cli-state-removed`.
   */
  async removeCliState() {
    this.#requireState('removeCliState', [S.INSTALLED, S.UPGRADED]);
    this.#beginSteps();
    if (!this.#project) {
      const created = await this.#createProject();
      if (!created.ok) {
        return this.#failure(
          'cli-state-removed',
          created.reasonCode,
          created.child,
          created.message,
        );
      }
    }
    const runtimeBefore = existsSync(this.#project.runtimeDir);
    const configBefore = existsSync(this.#project.configFile);

    const child = await this.#runBin(
      ['uninstall', '--project', this.#project.projectDir, '--yes', '--json'],
      this.#runRoot,
      'cli-state-remove',
    );

    const runtimeAfter = existsSync(this.#project.runtimeDir);
    const configAfter = existsSync(this.#project.configFile);
    const packageIntact =
      existsSync(this.#packageDir) && existsSync(this.#installed.installedBin.bin);

    // Documented boundary: uninstall removes runtime state, preserves authored
    // config (no --purge), and never touches the npm package/bin.
    const boundaryOk =
      isCleanChildResult(child) &&
      (!runtimeBefore || !runtimeAfter) &&
      (!configBefore || configAfter) &&
      packageIntact;
    if (!boundaryOk) {
      return this.#failure('cli-state-removed', L.CLI_STATE_REMOVAL_INCOMPLETE, child);
    }
    this.#state = S.CLI_STATE_REMOVED;
    return this.#success(
      'cli-state-removed',
      {
        runtimeRemoved: runtimeBefore && !runtimeAfter,
        configPreserved: configAfter,
        packageIntact,
      },
      child.rss,
    );
  }

  /**
   * Remove the npm package (`npm uninstall [-g] opensip-cli`) — separate from CLI
   * state — and prove the run-owned customer shim AND JS entrypoint are gone and
   * ambient `opensip` was never invoked. `installed|upgraded|cli-state-removed →
   * package-removed`.
   */
  async removePackage() {
    this.#requireState('removePackage', [S.INSTALLED, S.UPGRADED, S.CLI_STATE_REMOVED]);
    this.#beginSteps();
    const binPath = this.#installed.installedBin.bin;
    const jsPath = this.#installed.jsEntrypoint.script;

    const child =
      this.#mode === 'packed-release'
        ? await this.#runNpm(
            ['uninstall', 'opensip-cli', '--no-audit', '--no-fund', '--loglevel', 'error'],
            {
              cwd: this.#consumerCwd,
              timeoutMs: this.#installTimeoutMs,
              evidenceLabel: 'package-remove',
            },
          )
        : await this.#runNpm(['uninstall', '-g', 'opensip-cli', '--loglevel', 'error'], {
            cwd: this.#runRoot,
            timeoutMs: this.#installTimeoutMs,
            evidenceLabel: 'package-remove',
          });

    const shimAbsent = !existsSync(binPath);
    const entrypointAbsent = !existsSync(jsPath);
    const ambientInvocations = this.#invocations.filter((command) => command === 'opensip').length;

    if (
      !isCleanChildResult(child) ||
      !shimAbsent ||
      !entrypointAbsent ||
      ambientInvocations !== 0
    ) {
      return this.#failure('package-removed', L.PACKAGE_REMOVAL_INCOMPLETE, child, {
        shimAbsent,
        entrypointAbsent,
        ambientInvocations,
      });
    }
    this.#state = S.PACKAGE_REMOVED;
    return this.#success(
      'package-removed',
      {
        shimAbsent,
        entrypointAbsent,
        ambientInvocations,
      },
      child.rss,
    );
  }

  /**
   * Idempotently remove every run-owned path this lifecycle created. Realpaths
   * each target and requires ancestry under the run root; returns a CleanupResult
   * even after a journey failure. `any → cleaned`.
   * @returns {CleanupResult}
   */
  cleanup() {
    if (this.#state === S.CLEANED && this.#cleanupResult) {
      return this.#cleanupResult;
    }
    // Child completion includes descendant cleanup, so there is nothing to close
    // before removing run-owned paths.
    let removedRoots = 0;
    let escape = false;
    for (const target of this.#owned) {
      if (!existsSync(target)) continue;
      let real;
      try {
        real = realpathSync(target);
      } catch {
        continue;
      }
      if (real === this.#runRootReal || !isUnderRoot(this.#runRootReal, real)) {
        escape = true;
        continue;
      }
      try {
        rmSync(target, { recursive: true, force: true });
        removedRoots += 1;
      } catch {
        /* counted as residual below */
      }
    }
    let residual = 0;
    for (const target of this.#owned) {
      if (existsSync(target)) residual += 1;
    }
    const status = escape || residual > 0 ? 'incomplete' : 'clean';
    let reasonCode = null;
    if (escape) reasonCode = L.CLEANUP_ESCAPE;
    else if (residual > 0) reasonCode = L.CLEANUP_RESIDUAL;
    this.#state = S.CLEANED;
    this.#cleanupResult = Object.freeze({
      status,
      reasonCode,
      removedRoots,
      residualDescendants: residual,
    });
    this.#pushEvent(
      Object.freeze({
        type: 'cleanup',
        ok: status === 'clean',
        state: S.CLEANED,
        reasonCode,
        diagnostics: Object.freeze([]),
      }),
    );
    return this.#cleanupResult;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #requireState(action, allowed) {
    if (!allowed.includes(this.#state)) {
      throw new LifecycleError(
        L.INVALID_TRANSITION,
        `${action} is not valid from state '${this.#state}' (expected one of ${allowed.join(', ')})`,
      );
    }
  }

  #setupTargets(mode) {
    this.#mode = mode;
    if (mode === 'packed-release') {
      this.#consumerCwd = join(this.#runRoot, 'consumer');
      mkdirSync(this.#consumerCwd, { recursive: true });
      this.#owned.add(this.#consumerCwd);
      this.#packageDir = join(this.#consumerCwd, 'node_modules', 'opensip-cli');
      this.#binDir = join(this.#consumerCwd, 'node_modules', '.bin');
    } else {
      this.#globalPrefix = this.#npmPrefixDir;
      if (this.#platform === 'win32') {
        this.#packageDir = join(this.#globalPrefix, 'node_modules', 'opensip-cli');
        this.#binDir = this.#globalPrefix;
      } else {
        this.#packageDir = join(this.#globalPrefix, 'lib', 'node_modules', 'opensip-cli');
        this.#binDir = join(this.#globalPrefix, 'bin');
      }
    }
  }

  async #npmInstall(install, evidenceLabel) {
    if (install.kind === 'packed-release') {
      this.#writeConsumerManifest(install);
      return await this.#runNpm(['install', '--no-audit', '--no-fund', '--loglevel', 'error'], {
        cwd: this.#consumerCwd,
        timeoutMs: this.#installTimeoutMs,
        evidenceLabel,
      });
    }
    return await this.#runNpm(
      [
        'install',
        '-g',
        install.spec,
        '--no-audit',
        '--no-fund',
        '--loglevel',
        'error',
        '--registry',
        install.registry ?? NPMJS_REGISTRY,
      ],
      { cwd: this.#runRoot, timeoutMs: this.#installTimeoutMs, evidenceLabel },
    );
  }

  async #installCandidate(identity, install, evidenceLabel) {
    if (
      this.#canonicalInstaller !== null &&
      identity?.digest === this.#canonicalInstaller.targetCandidateDigest
    ) {
      if (install.kind !== 'published-version') {
        return {
          ok: false,
          reasonCode: CANDIDATE_REASON_CODES.INVALID_INPUT,
          child: null,
          message: 'the canonical installer target must be a published-version candidate',
        };
      }
      const before = regularFileIdentity(
        this.#canonicalInstaller.scriptPath,
        MAX_CANONICAL_INSTALLER_BYTES,
        'canonical-installer-script',
      );
      const npmShimBefore = regularFileIdentity(
        this.#canonicalInstaller.npmShim,
        MAX_INSTALLED_SHIM_BYTES,
        'canonical-installer-npm-shim',
      );
      if (
        !before.ok ||
        !npmShimBefore.ok ||
        canonicalJson(before.identity) !== canonicalJson(this.#canonicalInstaller.scriptIdentity) ||
        canonicalJson(npmShimBefore.identity) !==
          canonicalJson(this.#canonicalInstaller.npmShimIdentity)
      ) {
        return {
          ok: false,
          reasonCode: L.CANONICAL_INSTALLER_CHANGED,
          child: null,
          message: 'the canonical installer changed before execution',
        };
      }
      const registry = install.registry ?? NPMJS_REGISTRY;
      const env = {
        ...this.#env,
        OPENSIP_CLI_PACKAGE: 'opensip-cli',
        OPENSIP_CLI_VERSION: identity.version,
        NPM_CONFIG_PREFIX: this.#npmPrefixDir,
        NPM_CONFIG_CACHE: this.#npmCacheDir,
        NPM_CONFIG_USERCONFIG: this.#userNpmrc,
        NPM_CONFIG_GLOBALCONFIG: this.#globalNpmrc,
        NPM_CONFIG_REGISTRY: registry,
        npm_config_registry: registry,
        PATH: `${this.#canonicalInstaller.toolBin}:${dirname(
          process.execPath,
        )}:${this.#binDir}:/usr/bin:/bin`,
      };
      const child = await this.#runChild(
        this.#canonicalInstaller.shellPath,
        [this.#canonicalInstaller.scriptPath],
        {
          cwd: this.#runRoot,
          timeoutMs: this.#installTimeoutMs,
          evidenceLabel: `${evidenceLabel}-canonical-installer`,
          env,
        },
      );
      const after = regularFileIdentity(
        this.#canonicalInstaller.scriptPath,
        MAX_CANONICAL_INSTALLER_BYTES,
        'canonical-installer-script',
      );
      const npmShimAfter = regularFileIdentity(
        this.#canonicalInstaller.npmShim,
        MAX_INSTALLED_SHIM_BYTES,
        'canonical-installer-npm-shim',
      );
      if (
        !after.ok ||
        !npmShimAfter.ok ||
        canonicalJson(after.identity) !== canonicalJson(this.#canonicalInstaller.scriptIdentity) ||
        canonicalJson(npmShimAfter.identity) !==
          canonicalJson(this.#canonicalInstaller.npmShimIdentity)
      ) {
        return {
          ok: false,
          reasonCode: L.CANONICAL_INSTALLER_CHANGED,
          child,
          message: 'the canonical installer changed during execution',
        };
      }
      return { ok: true, child, installChannel: 'canonical-installer' };
    }

    return {
      ok: true,
      child: await this.#npmInstall(install, evidenceLabel),
      installChannel: install.kind === 'packed-release' ? 'packed-consumer' : 'npm-direct',
    };
  }

  #prepareInstall(install) {
    if (install.kind !== 'packed-release') return { ok: true, install };
    if (!Array.isArray(install.verifiedTarballs) || install.verifiedTarballs.length === 0) {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.CHECKSUM_MISMATCH,
        message: 'packed candidate omitted its verified tarball inventory',
      };
    }
    this.#snapshotNumber += 1;
    const snapshotRoot = join(this.#runRoot, 'candidate-snapshots', String(this.#snapshotNumber));
    mkdirSync(snapshotRoot, { recursive: true });
    this.#owned.add(join(this.#runRoot, 'candidate-snapshots'));
    const tarballs = [];
    const packageNames = new Set();
    const destinationNames = new Set();
    try {
      for (const artifact of install.verifiedTarballs) {
        if (
          !isPlainObject(artifact) ||
          typeof artifact.packageName !== 'string' ||
          typeof artifact.sourcePath !== 'string' ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.sizeBytes) ||
          artifact.sizeBytes <= 0 ||
          artifact.sizeBytes > MAX_PACKED_TARBALL_BYTES
        ) {
          throw new Error('invalid verified tarball inventory');
        }
        const destinationName = basename(artifact.sourcePath);
        if (packageNames.has(artifact.packageName) || destinationNames.has(destinationName)) {
          throw new Error('duplicate packed snapshot identity');
        }
        packageNames.add(artifact.packageName);
        destinationNames.add(destinationName);
        const target = join(snapshotRoot, destinationName);
        const source = readBoundedFileBytes({
          path: artifact.sourcePath,
          maxBytes: artifact.sizeBytes,
          reasonPrefix: 'packed-snapshot-source',
          requireNonEmpty: true,
        });
        if (
          !source.ok ||
          source.byteLength !== artifact.sizeBytes ||
          createHash('sha256').update(source.buffer).digest('hex') !== artifact.sha256
        ) {
          throw new Error('verified tarball changed before installation');
        }
        writeFileSync(target, source.buffer, { flag: 'wx', mode: 0o400 });
        tarballs.push(
          Object.freeze({
            packageName: artifact.packageName,
            path: realpathSync(target),
            sha256: artifact.sha256,
            sizeBytes: artifact.sizeBytes,
          }),
        );
      }
    } catch {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.CHECKSUM_MISMATCH,
        message: 'packed candidate changed before a run-owned snapshot could be verified',
      };
    }
    const byName = new Map(tarballs.map((artifact) => [artifact.packageName, artifact.path]));
    const cliTarball = byName.get('opensip-cli');
    if (cliTarball === undefined || byName.size !== tarballs.length) {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.INCOMPLETE_PACKAGE_SET,
        message: 'packed snapshot has duplicate package names or no CLI tarball',
      };
    }
    const overrides = {};
    for (const [packageName, path] of byName) {
      if (packageName !== 'opensip-cli') overrides[packageName] = `file:${path}`;
    }
    return {
      ok: true,
      install: Object.freeze({
        ...install,
        cliTarball,
        overrides: Object.freeze(overrides),
        snapshotTarballs: Object.freeze(tarballs),
      }),
    };
  }

  #verifySnapshotInventory(install) {
    if (install.kind !== 'packed-release') return { ok: true };
    try {
      for (const artifact of install.snapshotTarballs) {
        const read = readBoundedFileBytes({
          path: artifact.path,
          maxBytes: artifact.sizeBytes,
          reasonPrefix: 'packed-snapshot',
          requireNonEmpty: true,
        });
        if (
          !read.ok ||
          read.byteLength !== artifact.sizeBytes ||
          createHash('sha256').update(read.buffer).digest('hex') !== artifact.sha256
        ) {
          throw new Error('snapshot mismatch');
        }
      }
    } catch {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.CHECKSUM_MISMATCH,
        message: 'run-owned packed snapshot failed its immediate integrity check',
      };
    }
    return { ok: true };
  }

  #verifyPackedLockfile(install) {
    let lock;
    try {
      lock = JSON.parse(readFileSync(join(this.#consumerCwd, 'package-lock.json'), 'utf8'));
    } catch {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.PACKED_PROVENANCE_MISMATCH,
        message: 'packed install did not produce a readable package lock',
      };
    }
    if (!isPlainObject(lock?.packages)) {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.PACKED_PROVENANCE_MISMATCH,
        message: 'packed install lock omitted its package-resolution map',
      };
    }
    const expected = new Map(
      install.snapshotTarballs.map((artifact) => [artifact.packageName, artifact.path]),
    );
    const seen = new Set();
    for (const [lockPath, record] of Object.entries(lock.packages)) {
      const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(lockPath);
      if (match === null || !isPlainObject(record)) continue;
      const packageName = match[1];
      if (packageName !== 'opensip-cli' && !packageName.startsWith('@opensip-cli/')) continue;
      const expectedPath = expected.get(packageName);
      if (expectedPath === undefined || typeof record.resolved !== 'string') {
        return {
          ok: false,
          reasonCode: CANDIDATE_REASON_CODES.PACKED_PROVENANCE_MISMATCH,
          message: 'lockfile contains an unverified first-party package resolution',
        };
      }
      const spec = record.resolved.startsWith('file:') ? record.resolved.slice(5) : null;
      if (spec === null) {
        return {
          ok: false,
          reasonCode: CANDIDATE_REASON_CODES.PACKED_PROVENANCE_MISMATCH,
          message: 'lockfile resolved a first-party package through the registry',
        };
      }
      let resolvedPath;
      try {
        resolvedPath = realpathSync(isAbsolute(spec) ? spec : resolve(this.#consumerCwd, spec));
      } catch {
        resolvedPath = null;
      }
      if (resolvedPath !== expectedPath) {
        return {
          ok: false,
          reasonCode: CANDIDATE_REASON_CODES.PACKED_PROVENANCE_MISMATCH,
          message: 'lockfile first-party resolution does not match the verified snapshot',
        };
      }
      seen.add(packageName);
    }
    if (!seen.has('opensip-cli')) {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.PACKED_PROVENANCE_MISMATCH,
        message: 'lockfile did not bind the installed CLI to the verified snapshot',
      };
    }
    return { ok: true };
  }

  async #verifyPublishedRegistryBinding(identity) {
    if (this.#registryInventory === null) {
      return {
        ok: false,
        child: null,
        message: 'published candidate omitted its validated registry inventory',
      };
    }
    if (
      this.#registryInventory.releaseVersion !== identity.version ||
      this.#registryInventory.registry !== identity.registry ||
      registryIntegrityDigest(this.#registryInventory) !== identity.registryIntegrityDigest ||
      (identity.manifestDigest !== undefined &&
        this.#registryInventory.manifestDigest !== identity.manifestDigest)
    ) {
      return {
        ok: false,
        child: null,
        message: 'published candidate identity did not match its validated registry inventory',
      };
    }
    const workRoot = join(this.#runRoot, 'registry-binding');
    this.#owned.add(workRoot);
    return await verifyInstalledRegistryBinding({
      inventory: this.#registryInventory,
      workRoot,
      runNpm: (args, evidenceLabel) =>
        this.#runNpm(args, {
          cwd: this.#runRoot,
          timeoutMs: this.#installTimeoutMs,
          evidenceLabel,
        }),
    });
  }

  #writeConsumerManifest(install) {
    const manifest = {
      name: 'opensip-cli-acceptance-consumer',
      version: '0.0.0',
      private: true,
      dependencies: { 'opensip-cli': `file:${install.cliTarball}` },
      overrides: install.overrides,
    };
    writeFileSync(
      join(this.#consumerCwd, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  async #captureInstalled(identity, mode, installChannel) {
    const descriptors = resolveInstalledDescriptors({
      runRoot: this.#runRoot,
      packageDir: this.#packageDir,
      binDir: this.#binDir,
      platform: this.#platform,
    });
    if (!descriptors.ok) {
      return {
        ok: false,
        reasonCode: descriptors.reasonCode,
        message: descriptors.message,
      };
    }
    const packageJsonPath = join(this.#packageDir, 'package.json');
    const packageJsonFile = regularFileIdentity(
      packageJsonPath,
      MAX_INSTALLED_PACKAGE_JSON_BYTES,
      'installed-package-json',
    );
    const entrypointFile = regularFileIdentity(
      descriptors.jsEntrypoint.script,
      MAX_INSTALLED_ENTRYPOINT_BYTES,
      'installed-entrypoint',
    );
    if (!packageJsonFile.ok || !entrypointFile.ok) {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.INVALID_ENTRYPOINT,
        message: 'installed package identity files could not be pinned',
      };
    }
    let packageMetadata = { name: null, version: null };
    try {
      const pkg = JSON.parse(packageJsonFile.buffer.toString('utf8'));
      packageMetadata = {
        name: typeof pkg.name === 'string' ? pkg.name : null,
        version: typeof pkg.version === 'string' ? pkg.version : null,
      };
    } catch {
      /* resolvedVersion stays null; the descriptor already proved the package */
    }
    if (packageMetadata.name !== 'opensip-cli') {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.INVALID_PACKAGE_JSON,
        message: 'installed package manifest did not identify opensip-cli',
      };
    }
    if (packageMetadata.version !== identity.version) {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.CANDIDATE_VERSION_MISMATCH,
        message: `installed package version ${JSON.stringify(packageMetadata.version)} does not match requested ${JSON.stringify(identity.version)}`,
      };
    }
    const lockfilePresent =
      mode === 'packed-release' && this.#consumerCwd
        ? existsSync(join(this.#consumerCwd, 'package-lock.json'))
        : false;

    const installed = Object.freeze({
      mode,
      installChannel,
      requestedSource: identity,
      npmVersion: await this.#npmVersion(),
      resolvedVersion: packageMetadata.version,
      packageMetadata: Object.freeze(packageMetadata),
      installedBin: descriptors.installedBin,
      jsEntrypoint: Object.freeze({
        ...descriptors.jsEntrypoint,
        entrypointSha256: `sha256:${entrypointFile.identity.sha256}`,
        packageJsonSha256: `sha256:${packageJsonFile.identity.sha256}`,
      }),
      packageJsonPath,
      packageDir: this.#packageDir,
      binDir: this.#binDir,
      consumerCwd: this.#consumerCwd,
      globalPrefix: this.#globalPrefix,
      lockfilePresent,
    });
    const integrity = installedIntegritySnapshot(installed, this.#runRoot, this.#platform);
    if (!integrity.ok) {
      return {
        ok: false,
        reasonCode: CANDIDATE_REASON_CODES.INVALID_ENTRYPOINT,
        message: 'installed invocation descriptors could not be identity-pinned',
      };
    }
    return { ok: true, installed, integrity: integrity.identity };
  }

  async #createProject() {
    const projectDir = join(this.#runRoot, 'project');
    mkdirSync(projectDir, { recursive: true });
    this.#owned.add(projectDir);
    const initChild = await this.#runBin(
      ['init', '--cwd', projectDir, '--language', 'typescript', '--json'],
      projectDir,
      'project-init',
    );
    if (!isCleanChildResult(initChild)) {
      return {
        ok: false,
        reasonCode: L.REPRESENTATIVE_STATE_FAILED,
        child: initChild,
      };
    }
    try {
      const sourceDir = join(projectDir, 'src');
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, 'index.ts'), 'export const representative = 1;\n');
      writeFileSync(
        join(projectDir, 'tsconfig.json'),
        `${JSON.stringify(
          { compilerOptions: { module: 'NodeNext', target: 'ES2022' } },
          null,
          2,
        )}\n`,
      );
    } catch {
      return {
        ok: false,
        reasonCode: L.REPRESENTATIVE_STATE_FAILED,
        child: null,
        message: 'representative source fixture could not be created',
      };
    }
    // Persist a real analysis session. Merely opening an empty store proves
    // schema readability, not that an upgrade preserves customer history.
    // Machine-output graph runs intentionally do not create generic sessions;
    // use the ordinary customer command so representative state contains a
    // real, publicly replayable record for the upgrade proof.
    const seedChild = await this.#runBin(['graph'], projectDir, 'project-session-seed');
    if (!isCleanChildResult(seedChild)) {
      return {
        ok: false,
        reasonCode: L.REPRESENTATIVE_STATE_FAILED,
        child: seedChild,
        message: 'representative analysis session could not be persisted',
      };
    }
    const listChild = await this.#runBin(
      ['sessions', 'list', '--json'],
      projectDir,
      'project-session-list',
    );
    const history = readSessionHistory(listChild);
    const representativeRecord = history.ok
      ? history.sessions.find(
          (record) => isPlainObject(record) && record.tool === 'graph' && record.cwd === projectDir,
        )
      : undefined;
    const session =
      representativeRecord === undefined ? null : snapshotSession(representativeRecord);
    const configFile = join(projectDir, 'opensip-cli.config.yml');
    const runtimeDir = join(projectDir, 'opensip-cli', '.runtime');
    const configCreated = existsSync(configFile);
    const runtimeSeeded = existsSync(runtimeDir);
    if (!history.ok || session === null || !configCreated || !runtimeSeeded) {
      return {
        ok: false,
        reasonCode: L.REPRESENTATIVE_STATE_FAILED,
        child: isCleanChildResult(listChild) ? null : listChild,
        message:
          history.ok && session === null
            ? 'representative analysis produced no stored session'
            : history.message,
      };
    }
    this.#project = Object.freeze({
      projectDir,
      configFile,
      runtimeDir,
      configCreated,
      runtimeSeeded,
      session,
    });
    return {
      ok: true,
      rss: mergeRss(initChild.rss, seedChild.rss, listChild.rss),
    };
  }

  #runBin(args, cwd, evidenceLabel) {
    const invocation = resolveInstalledCliInvocation(this.#installed);
    return this.#runChild(invocation.command, [...invocation.prefixArgs, ...args], {
      cwd,
      timeoutMs: this.#commandTimeoutMs,
      evidenceLabel,
    });
  }

  #runNpm(args, opts) {
    return this.#runChild(
      this.#npmInvocation.command,
      [...this.#npmInvocation.prefixArgs, ...args],
      opts,
    );
  }

  async #runChild(command, args, opts) {
    this.#invocations.push(command);
    const result = await this.#runChildImpl(command, args, opts);
    const child = {
      status: typeof result?.status === 'number' ? result.status : null,
      signal: result?.signal ?? null,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
      error: result?.error,
      timedOut: result?.timedOut === true,
      cancelled: result?.cancelled === true,
      outputTruncated: result?.outputTruncated === true,
      durationMs:
        typeof result?.durationMs === 'number' && Number.isFinite(result.durationMs)
          ? Math.max(0, Math.round(result.durationMs))
          : 0,
      cleanup: {
        residualDescendants: Number.isSafeInteger(result?.cleanup?.residualDescendants)
          ? result.cleanup.residualDescendants
          : 1,
      },
      rss: normalizeChildRss(result?.rss),
    };
    this.#recordStep(opts.evidenceLabel, child);
    return child;
  }

  async #defaultRunChild(command, args, opts) {
    const result = await runMeasuredProcess(
      {
        argv: [command, ...args],
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        stdoutBytes: this.#processBounds.maxStdoutBytes ?? MAX_CHILD_BUFFER,
        stderrBytes: this.#processBounds.maxStderrBytes ?? MAX_CHILD_BUFFER,
        env: opts.env,
      },
      {
        baseEnv: this.#env,
        bounds: this.#processBounds,
        platform: this.#platform,
        runSignal: this.#runSignal,
        parentSignalCoordinator: this.#parentSignalCoordinator,
      },
    );
    return {
      ...result,
      stdout: result.stdoutCapture ?? result.stdoutTail ?? '',
      stderr: result.stderrTail ?? '',
    };
  }

  async #npmVersion() {
    if (this.#npmVersionCache !== undefined) return this.#npmVersionCache;
    const child = await this.#runNpm(['--version'], {
      cwd: this.#runRoot,
      timeoutMs: this.#commandTimeoutMs,
      evidenceLabel: 'npm-version',
    });
    const out = child.stdout.trim();
    this.#npmVersionCache = isCleanChildResult(child) && /^\d+\.\d+\.\d+/.test(out) ? out : null;
    return this.#npmVersionCache;
  }

  #classifyInstallFailure(child) {
    const text = `${child.stderr}\n${child.stdout}`;
    if (REGISTRY_FAILURE.test(text)) return CANDIDATE_REASON_CODES.REGISTRY_UNAVAILABLE;
    return CANDIDATE_REASON_CODES.INSTALL_FAILED;
  }

  #buildEnv() {
    const env = {};
    let ambientPath;
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      const normalizedKey = key.toUpperCase();
      if (normalizedKey === 'PATH') {
        ambientPath ??= value;
        continue;
      }
      if (ENV_ALLOWLIST.has(normalizedKey)) env[key] = value;
    }
    const pathDelimiter = this.#platform === 'win32' ? ';' : delimiter;
    env.PATH = [dirname(process.execPath), ambientPath]
      .filter((entry) => typeof entry === 'string' && entry.length > 0)
      .join(pathDelimiter);
    Object.assign(env, {
      HOME: this.#homeDir,
      USERPROFILE: this.#homeDir,
      APPDATA: join(this.#homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(this.#homeDir, 'AppData', 'Local'),
      TMPDIR: this.#tmpDir,
      TEMP: this.#tmpDir,
      TMP: this.#tmpDir,
      npm_config_cache: this.#npmCacheDir,
      npm_config_prefix: this.#npmPrefixDir,
      npm_config_userconfig: this.#userNpmrc,
      npm_config_globalconfig: this.#globalNpmrc,
      npm_config_registry: NPMJS_REGISTRY,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_progress: 'false',
      NO_COLOR: '1',
      CI: '1',
    });
    return env;
  }

  #redact(text) {
    let out = String(text ?? '');
    for (const p of this.#redactPaths) {
      if (p) out = out.split(p).join('<path>');
    }
    out = redactSensitiveText(out);
    const buf = Buffer.from(out, 'utf8');
    if (buf.byteLength > this.#diagnosticTailBytes) {
      return `…${buf.subarray(buf.byteLength - this.#diagnosticTailBytes).toString('utf8')}`;
    }
    return out;
  }

  #failure(type, reasonCode, child, facts) {
    const diagnostics = [];
    if (child) {
      const tail = this.#redact(child.stderr || child.stdout || '');
      if (tail.length > 0) diagnostics.push(tail);
    }
    if (diagnostics.length === 0 && typeof facts === 'string') {
      diagnostics.push(this.#redact(facts));
    }
    const event = Object.freeze({
      type,
      ok: false,
      state: this.#state,
      reasonCode,
      diagnostics: Object.freeze(diagnostics),
      facts: Object.freeze(isPlainObject(facts) ? facts : {}),
      rss: normalizeChildRss(child?.rss),
      steps: this.#takeSteps(),
    });
    this.#pushEvent(event);
    return event;
  }

  #success(type, facts, rss) {
    const event = Object.freeze({
      type,
      ok: true,
      state: this.#state,
      reasonCode: null,
      diagnostics: Object.freeze([]),
      facts: Object.freeze(facts ?? {}),
      rss: normalizeChildRss(rss),
      steps: this.#takeSteps(),
    });
    this.#pushEvent(event);
    return event;
  }

  #pushEvent(event) {
    this.#events.push(event);
    this.#onEvent?.(event);
  }

  #beginSteps() {
    this.#currentSteps = [];
  }

  #takeSteps() {
    const steps = Object.freeze([...this.#currentSteps]);
    this.#currentSteps = [];
    return steps;
  }

  #recordStep(label, child) {
    if (this.#currentSteps.length >= MAX_LIFECYCLE_STEPS) return;
    const reasonCode = childReasonCode(child);
    const diagnostics = [];
    if (reasonCode !== null) {
      const tail = this.#redact(child.stderr || child.stdout || '');
      if (tail.length > 0) diagnostics.push(tail);
    }
    this.#currentSteps.push(
      Object.freeze({
        label:
          typeof label === 'string' && label.length > 0
            ? label
            : `lifecycle-child-${this.#currentSteps.length + 1}`,
        stage: 'lifecycle',
        exitCode: child.signal === null ? child.status : null,
        signal: child.signal,
        timedOut: child.timedOut,
        cancelled: child.cancelled,
        outputTruncated: child.outputTruncated,
        durationMs: child.durationMs,
        rss: child.rss,
        residualDescendants: child.cleanup.residualDescendants,
        reasonCode,
        diagnostics: Object.freeze(diagnostics),
      }),
    );
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeChildRss(rss) {
  if (rss?.status === 'available' && Number.isFinite(rss.peakBytes) && rss.peakBytes > 0) {
    return Object.freeze({
      status: 'available',
      peakBytes: Math.round(rss.peakBytes),
    });
  }
  return Object.freeze({
    status: 'unavailable',
    reasonCode:
      typeof rss?.reasonCode === 'string' && rss.reasonCode.length > 0
        ? rss.reasonCode
        : 'rss-not-sampled',
  });
}

function mergeRss(...measurements) {
  let peak = 0;
  let reasonCode = 'rss-not-sampled';
  for (const measurement of measurements) {
    const normalized = normalizeChildRss(measurement);
    if (normalized.status === 'available') peak = Math.max(peak, normalized.peakBytes);
    else reasonCode = normalized.reasonCode;
  }
  return peak > 0
    ? Object.freeze({ status: 'available', peakBytes: peak })
    : Object.freeze({ status: 'unavailable', reasonCode });
}

function isCleanChildResult(child) {
  return (
    child?.status === 0 &&
    child.signal == null &&
    child.timedOut !== true &&
    child.cancelled !== true &&
    child.outputTruncated !== true &&
    (child.cleanup?.residualDescendants ?? 1) === 0
  );
}

function childReasonCode(child) {
  if (child.timedOut) return 'timed-out';
  if (child.cancelled) return 'cancelled';
  if (child.status === null && child.signal === null) return 'spawn-unavailable';
  if (child.cleanup.residualDescendants > 0) return 'cleanup-failed';
  if (child.outputTruncated) return 'output-overflow';
  if (child.status !== 0 || child.signal !== null) return 'command-failed';
  return null;
}
