/**
 * @fileoverview Bounded, secret-free native host-fact collector for platform
 * acceptance.
 *
 * Collects only an allowlisted set of facts about the native host: platform,
 * architecture, OS release/version, Node version + module ABI, npm/package
 * manager, CPU model/count, total memory, run-root filesystem type + case
 * behavior, shell identity, and availability of declared native probes.
 *
 * Hard rules (enforced by tests):
 *   - No usernames, absolute home paths, hostnames, IPs, npm tokens, registry
 *     credentials, or full environment variables ever enter the result.
 *   - Child calls use argv arrays with short timeouts; never `shell: true`, and
 *     never serialize the full child environment.
 *   - An uncollectable fact is `{ status: 'unavailable', reasonCode }`, never an
 *     empty string or a guessed value.
 *   - Capability/case probes mutate only run-owned paths under `root`.
 *   - Pure: this module returns a value. It never writes evidence, exits, or
 *     logs.
 *
 * Types are in `contract.d.mts` (`HostProfile`). This runtime is dependency-free
 * apart from Node built-ins so a release script can import it with no build.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  openSync,
  closeSync,
  writeFileSync,
  writeSync,
  symlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { cpus, totalmem, release, version as osVersionString } from 'node:os';
import { basename, join } from 'node:path';

const CHILD_TIMEOUT_MS = 5000;
const KNOWN_CAPABILITIES = ['pty', 'symlink', 'permissions', 'process-tree-rss'];

/** Run a bounded, shell-free child and return trimmed stdout, or null on any failure. */
function runProbe(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      timeout: CHILD_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return typeof stdout === 'string' ? stdout.trim() : null;
  } catch {
    return null;
  }
}

function unavailable(reasonCode) {
  return { status: 'unavailable', reasonCode };
}

function collectOsVersion() {
  try {
    const value = osVersionString();
    return typeof value === 'string' && value.length > 0 ? value : unavailable('os-version-empty');
  } catch {
    return unavailable('os-version-error');
  }
}

function collectNpmVersion(platform) {
  // npm ships as `npm.cmd` on Windows, which execFile cannot run directly; try
  // the platform-appropriate name and treat any failure as unavailable.
  const candidates = platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  for (const candidate of candidates) {
    const out = runProbe(candidate, ['--version']);
    if (out && /^\d+\.\d+\.\d+/.test(out)) return out;
  }
  return unavailable('npm-unavailable');
}

function collectPackageManager() {
  // Derive from the running invocation's user agent (e.g. "pnpm/11.10.0 ...");
  // never serialize other environment variables.
  const agent = process.env.npm_config_user_agent;
  if (typeof agent === 'string' && agent.length > 0) {
    const token = agent.split(/\s+/)[0];
    const name = token.split('/')[0];
    if (/^[a-z][a-z0-9-]*$/i.test(name)) return name;
  }
  return unavailable('package-manager-undetermined');
}

function collectCpuModel() {
  try {
    const list = cpus();
    const model = list[0]?.model;
    return typeof model === 'string' && model.length > 0 ? model : unavailable('cpu-model-empty');
  } catch {
    return unavailable('cpu-model-error');
  }
}

function collectShell(platform) {
  // Report only the basename (e.g. "zsh"), never the absolute shell path.
  const raw = platform === 'win32' ? process.env.ComSpec : process.env.SHELL;
  if (typeof raw === 'string' && raw.length > 0) {
    const name = basename(raw).replace(/\.exe$/i, '');
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return name;
  }
  return unavailable('shell-undetermined');
}

/**
 * Resolve the filesystem type of the run root by parsing `mount` and selecting
 * the entry whose mount point is the longest prefix of `root`. Handles the
 * darwin form (`… on /path (apfs, …)`) and the linux form
 * (`… on /path type ext4 (…)`). Falls back to linux `stat -f`.
 */
function collectFilesystemType(platform, root) {
  if (platform !== 'darwin' && platform !== 'linux') {
    return unavailable('fs-type-unsupported-probe');
  }
  const mountOut = runProbe('mount', []);
  if (mountOut) {
    let best = null;
    for (const line of mountOut.split('\n')) {
      const match = line.match(/ on (.+?) (?:type (\S+)|\(([A-Za-z0-9._-]+)[,)])/);
      if (!match) continue;
      const mountPoint = match[1];
      const type = match[2] ?? match[3];
      if (!type || !isPrefixPath(mountPoint, root)) continue;
      if (!best || mountPoint.length > best.mountPoint.length) best = { mountPoint, type };
    }
    if (best) return best.type;
  }
  if (platform === 'linux') {
    const out = runProbe('stat', ['-f', '-c', '%T', root]);
    if (out && /^[A-Za-z0-9._-]+$/.test(out)) return out;
  }
  return unavailable('fs-type-undetermined');
}

/** True when `mountPoint` is `root` itself or an ancestor directory of `root`. */
function isPrefixPath(mountPoint, root) {
  if (mountPoint === '/') return root.startsWith('/');
  return root === mountPoint || root.startsWith(`${mountPoint}/`);
}

/**
 * Detect run-root case sensitivity by creating a mixed-case file and checking
 * whether the lower-cased name resolves. Mutates only run-owned paths.
 */
function detectCaseSensitivity(root) {
  let dir;
  try {
    dir = mkdtempSync(join(root, 'host-case-'));
    const upper = join(dir, 'CaseProbe');
    const lower = join(dir, 'caseprobe');
    writeFileSync(upper, 'x');
    // Case-INsensitive filesystem: the lower-cased path resolves to the same file.
    return !existsSync(lower);
  } catch {
    return unavailable('case-probe-failed');
  } finally {
    if (dir) safeRemove(dir);
  }
}

function safeRemove(target) {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort — a residual run-owned temp dir is cleaned by the runner root */
  }
}

function probePty(platform) {
  if (platform === 'win32') return false;
  return (
    existsSync('/usr/bin/script') ||
    existsSync('/bin/script') ||
    runProbe('sh', ['-c', 'command -v script']) !== null
  );
}

function probeSymlink(root) {
  let dir;
  try {
    dir = mkdtempSync(join(root, 'host-symlink-'));
    const target = join(dir, 'target');
    const link = join(dir, 'link');
    writeFileSync(target, 'x');
    symlinkSync(target, link);
    return existsSync(link);
  } catch {
    return false;
  } finally {
    if (dir) safeRemove(dir);
  }
}

function probePermissions(platform, root) {
  if (platform === 'win32') return false;
  let dir;
  try {
    dir = mkdtempSync(join(root, 'host-perm-'));
    const file = join(dir, 'readonly');
    writeFileSync(file, 'x');
    chmodSync(file, 0o444);
    let denied = false;
    try {
      const fd = openSync(file, 'a');
      try {
        writeSync(fd, 'y');
      } finally {
        closeSync(fd);
      }
    } catch {
      denied = true;
    }
    chmodSync(file, 0o644);
    return denied;
  } catch {
    return false;
  } finally {
    if (dir) safeRemove(dir);
  }
}

function probeProcessTreeRss(platform) {
  if (platform === 'win32') return false;
  return runProbe('ps', ['-o', 'pid=', '-p', String(process.pid)]) !== null;
}

function probeCapability(id, platform, root) {
  switch (id) {
    case 'pty': {
      return probePty(platform);
    }
    case 'symlink': {
      return probeSymlink(root);
    }
    case 'permissions': {
      return probePermissions(platform, root);
    }
    case 'process-tree-rss': {
      return probeProcessTreeRss(platform);
    }
    default: {
      return false;
    }
  }
}

/**
 * Collect the bounded native host profile for a run rooted at `root`. Any
 * capability ids in `requiredCapabilities` are probed in addition to the known
 * default set, so the runner can decide per-journey whether a missing prereq
 * makes a required journey fail.
 */
export function collectHostProfile(root, requiredCapabilities = []) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('collectHostProfile requires a run-owned root path');
  }
  const platform = process.platform;

  const capabilityIds = [...new Set([...KNOWN_CAPABILITIES, ...requiredCapabilities])];
  const capabilities = {};
  for (const id of capabilityIds) {
    capabilities[id] = probeCapability(id, platform, root);
  }

  const osReleaseRaw = release();
  const cpuList = safeCpuList();

  return {
    platform,
    arch: process.arch,
    osRelease:
      osReleaseRaw && osReleaseRaw.length > 0 ? osReleaseRaw : unavailable('os-release-empty'),
    osVersion: collectOsVersion(),
    nodeVersion: process.version,
    nodeModuleAbi: String(process.versions.modules),
    npmVersion: collectNpmVersion(platform),
    packageManager: collectPackageManager(),
    cpuModel: collectCpuModel(),
    cpuCount: cpuList.length > 0 ? cpuList.length : 1,
    totalMemoryBytes: safeTotalMem(),
    filesystem: {
      type: collectFilesystemType(platform, root),
      caseSensitive: detectCaseSensitivity(root),
    },
    shell: collectShell(platform),
    capabilities,
  };
}

function safeCpuList() {
  try {
    return cpus();
  } catch {
    return [];
  }
}

function safeTotalMem() {
  try {
    const total = totalmem();
    return Number.isFinite(total) && total >= 0 ? Math.floor(total) : 0;
  } catch {
    return 0;
  }
}
