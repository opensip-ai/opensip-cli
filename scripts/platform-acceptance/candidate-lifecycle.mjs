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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import {
  CANDIDATE_REASON_CODES,
  NPMJS_REGISTRY,
  resolveInstalledDescriptors,
} from './candidate-source.mjs';

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
});

const S = CANDIDATE_LIFECYCLE_STATES;
const L = LIFECYCLE_REASON_CODES;

const DEFAULT_INSTALL_TIMEOUT_MS = 180_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_DIAGNOSTIC_TAIL_BYTES = 4096;
const MAX_CHILD_BUFFER = 16 * 1024 * 1024;

// Network-ish npm failures map to `registry-unavailable`; everything else to
// `install-failed`. Kept deliberately broad — a false "unavailable" is a
// truthful "we could not prove the candidate", never a green-wash.
const REGISTRY_FAILURE =
  /enotfound|etimedout|econnrefused|econnreset|eai_again|getaddrinfo|network|socket hang up|etarget|e404|403 forbidden|401 unauthorized|registry/i;

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

/** True when `target` is a strict descendant of `root`. */
function isUnderRoot(root, target) {
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
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
  #npm;
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
  #project = null;
  #cleanupResult = null;

  /**
   * @param {object} options
   * @param {string} options.runRoot absolute, existing, run-owned root directory.
   * @param {string} [options.platform] defaults to `process.platform`.
   * @param {(event: object) => void} [options.onEvent] observe each lifecycle event.
   * @param {(command: string, args: string[], opts: object) => object} [options.runChild]
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
    this.#npm = this.#platform === 'win32' ? 'npm.cmd' : 'npm';
    this.#onEvent = typeof options.onEvent === 'function' ? options.onEvent : undefined;
    this.#runChildImpl =
      typeof options.runChild === 'function'
        ? options.runChild
        : (command, args, opts) => this.#defaultRunChild(command, args, opts);

    const bounds = options.bounds ?? {};
    this.#installTimeoutMs = bounds.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    this.#commandTimeoutMs = bounds.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#diagnosticTailBytes = bounds.maxDiagnosticTailBytes ?? DEFAULT_DIAGNOSTIC_TAIL_BYTES;

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

  /** A copy of the deterministic child environment (for a runner that reuses it). */
  childEnv() {
    return { ...this.#env };
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * Install a resolved candidate into fresh run-owned state. `empty → installed`.
   * @param {{ ok: true, identity: CandidateIdentity, install: object }} resolved
   */
  install(resolved) {
    this.#requireState('install', [S.EMPTY]);
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

    const child = this.#npmInstall(install);
    if (child.status !== 0) {
      return this.#failure('install', this.#classifyInstallFailure(child), child);
    }
    const captured = this.#captureInstalled(resolved.identity, install.kind);
    if (!captured.ok) {
      return this.#failure('install', captured.reasonCode, null, captured.message);
    }
    this.#installed = captured.installed;
    this.#state = S.INSTALLED;
    return this.#success('install', {
      resolvedVersion: this.#installed.resolvedVersion,
      requestedVersion: resolved.identity.version,
      npmVersion: this.#installed.npmVersion,
      lockfilePresent: this.#installed.lockfilePresent,
    });
  }

  /**
   * Create representative CLI state (an initialized project + seeded datastore)
   * so an upgrade can prove state migration and `opensip uninstall` has a
   * documented boundary to act on. Does not change the lifecycle state.
   */
  createRepresentativeState() {
    this.#requireState('createRepresentativeState', [S.INSTALLED, S.UPGRADED]);
    if (this.#project) {
      return this.#success('representative-state', { reused: true });
    }
    const created = this.#createProject();
    if (!created.ok) {
      return this.#failure('representative-state', created.reasonCode, created.child);
    }
    return this.#success('representative-state', {
      configCreated: this.#project.configCreated,
      runtimeSeeded: this.#project.runtimeSeeded,
    });
  }

  /**
   * Upgrade in place to a new resolved candidate and prove version (and, when
   * representative state exists, state) migration. `installed → upgraded`.
   * @param {{ ok: true, identity: CandidateIdentity, install: object }} resolved
   */
  upgrade(resolved) {
    this.#requireState('upgrade', [S.INSTALLED]);
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

    const child = this.#npmInstall(resolved.install);
    if (child.status !== 0) {
      return this.#failure('upgrade', this.#classifyInstallFailure(child), child);
    }
    const captured = this.#captureInstalled(resolved.identity, resolved.install.kind);
    if (!captured.ok) {
      return this.#failure('upgrade', captured.reasonCode, null, captured.message);
    }
    this.#installed = captured.installed;
    const newVersion = this.#installed.resolvedVersion;

    // State migration proof: the representative project survives the reinstall
    // and the NEW binary reads it without error.
    let stateMigrated = null;
    if (this.#project) {
      const markersPresent =
        existsSync(this.#project.configFile) &&
        (!runtimeExpected || existsSync(this.#project.runtimeDir));
      const readBack = this.#runBin(['sessions', 'list', '--json'], this.#project.projectDir);
      stateMigrated = markersPresent && readBack.status === 0;
      if (!stateMigrated) {
        return this.#failure(
          'upgrade',
          L.STATE_MIGRATION_FAILED,
          readBack.status === 0 ? null : readBack,
          'representative state did not survive the upgrade',
        );
      }
    }

    this.#state = S.UPGRADED;
    return this.#success('upgrade', {
      previousVersion,
      newVersion,
      versionMigrated: newVersion !== previousVersion,
      stateMigrated,
    });
  }

  /**
   * Remove OpenSIP CLI state via `opensip uninstall` — and assert it removed ONLY
   * its documented boundary (runtime state) while leaving the npm package + bin
   * and authored config intact. `installed|upgraded → cli-state-removed`.
   */
  removeCliState() {
    this.#requireState('removeCliState', [S.INSTALLED, S.UPGRADED]);
    if (!this.#project) {
      const created = this.#createProject();
      if (!created.ok) {
        return this.#failure('cli-state-removed', created.reasonCode, created.child);
      }
    }
    const runtimeBefore = existsSync(this.#project.runtimeDir);
    const configBefore = existsSync(this.#project.configFile);

    const child = this.#runBin(
      ['uninstall', '--project', this.#project.projectDir, '--yes', '--json'],
      this.#runRoot,
    );

    const runtimeAfter = existsSync(this.#project.runtimeDir);
    const configAfter = existsSync(this.#project.configFile);
    const packageIntact =
      existsSync(this.#packageDir) && existsSync(this.#installed.installedBin.bin);

    // Documented boundary: uninstall removes runtime state, preserves authored
    // config (no --purge), and never touches the npm package/bin.
    const boundaryOk =
      child.status === 0 &&
      (!runtimeBefore || !runtimeAfter) &&
      (!configBefore || configAfter) &&
      packageIntact;
    if (!boundaryOk) {
      return this.#failure('cli-state-removed', L.CLI_STATE_REMOVAL_INCOMPLETE, child);
    }
    this.#state = S.CLI_STATE_REMOVED;
    return this.#success('cli-state-removed', {
      runtimeRemoved: runtimeBefore && !runtimeAfter,
      configPreserved: configAfter,
      packageIntact,
    });
  }

  /**
   * Remove the npm package (`npm uninstall [-g] opensip-cli`) — separate from CLI
   * state — and prove the run-owned customer shim AND JS entrypoint are gone and
   * ambient `opensip` was never invoked. `installed|upgraded|cli-state-removed →
   * package-removed`.
   */
  removePackage() {
    this.#requireState('removePackage', [S.INSTALLED, S.UPGRADED, S.CLI_STATE_REMOVED]);
    const binPath = this.#installed.installedBin.bin;
    const jsPath = this.#installed.jsEntrypoint.script;

    const child =
      this.#mode === 'packed-release'
        ? this.#runChild(
            this.#npm,
            ['uninstall', 'opensip-cli', '--no-audit', '--no-fund', '--loglevel', 'error'],
            { cwd: this.#consumerCwd, timeoutMs: this.#installTimeoutMs },
          )
        : this.#runChild(this.#npm, ['uninstall', '-g', 'opensip-cli', '--loglevel', 'error'], {
            cwd: this.#runRoot,
            timeoutMs: this.#installTimeoutMs,
          });

    const shimAbsent = !existsSync(binPath);
    const entrypointAbsent = !existsSync(jsPath);
    const ambientInvocations = this.#invocations.filter((command) => command === 'opensip').length;

    if (child.status !== 0 || !shimAbsent || !entrypointAbsent || ambientInvocations !== 0) {
      return this.#failure('package-removed', L.PACKAGE_REMOVAL_INCOMPLETE, child, {
        shimAbsent,
        entrypointAbsent,
        ambientInvocations,
      });
    }
    this.#state = S.PACKAGE_REMOVED;
    return this.#success('package-removed', {
      shimAbsent,
      entrypointAbsent,
      ambientInvocations,
    });
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
    // Children are spawned synchronously (spawnSync) and already reaped, so there
    // is nothing to close first; the guard stays explicit for future async use.
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
    this.#pushEvent({
      type: 'cleanup',
      ok: status === 'clean',
      state: S.CLEANED,
      reasonCode,
      diagnostics: Object.freeze([]),
    });
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

  #npmInstall(install) {
    if (install.kind === 'packed-release') {
      this.#writeConsumerManifest(install);
      return this.#runChild(
        this.#npm,
        ['install', '--no-audit', '--no-fund', '--loglevel', 'error'],
        { cwd: this.#consumerCwd, timeoutMs: this.#installTimeoutMs },
      );
    }
    return this.#runChild(
      this.#npm,
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
      { cwd: this.#runRoot, timeoutMs: this.#installTimeoutMs },
    );
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

  #captureInstalled(identity, mode) {
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
    let packageMetadata = { name: null, version: null };
    try {
      const pkg = JSON.parse(readFileSync(join(this.#packageDir, 'package.json'), 'utf8'));
      packageMetadata = {
        name: typeof pkg.name === 'string' ? pkg.name : null,
        version: typeof pkg.version === 'string' ? pkg.version : null,
      };
    } catch {
      /* resolvedVersion stays null; the descriptor already proved the package */
    }
    const lockfilePresent =
      mode === 'packed-release' && this.#consumerCwd
        ? existsSync(join(this.#consumerCwd, 'package-lock.json'))
        : false;

    const installed = Object.freeze({
      mode,
      requestedSource: identity,
      npmVersion: this.#npmVersion(),
      resolvedVersion: packageMetadata.version,
      packageMetadata: Object.freeze(packageMetadata),
      installedBin: descriptors.installedBin,
      jsEntrypoint: descriptors.jsEntrypoint,
      packageDir: this.#packageDir,
      binDir: this.#binDir,
      consumerCwd: this.#consumerCwd,
      globalPrefix: this.#globalPrefix,
      lockfilePresent,
    });
    return { ok: true, installed };
  }

  #createProject() {
    const projectDir = join(this.#runRoot, 'project');
    mkdirSync(projectDir, { recursive: true });
    this.#owned.add(projectDir);
    const initChild = this.#runBin(
      ['init', '--cwd', projectDir, '--language', 'typescript', '--json'],
      projectDir,
    );
    if (initChild.status !== 0) {
      return {
        ok: false,
        reasonCode: L.REPRESENTATIVE_STATE_FAILED,
        child: initChild,
      };
    }
    // Best-effort: touch the datastore so representative runtime state exists.
    this.#runBin(['sessions', 'list', '--json'], projectDir);
    const configFile = join(projectDir, 'opensip-cli.config.yml');
    const runtimeDir = join(projectDir, 'opensip-cli', '.runtime');
    this.#project = Object.freeze({
      projectDir,
      configFile,
      runtimeDir,
      configCreated: existsSync(configFile),
      runtimeSeeded: existsSync(runtimeDir),
    });
    return { ok: true };
  }

  #runBin(args, cwd) {
    return this.#runChild(this.#installed.installedBin.bin, args, {
      cwd,
      timeoutMs: this.#commandTimeoutMs,
    });
  }

  #runChild(command, args, opts) {
    this.#invocations.push(command);
    const result = this.#runChildImpl(command, args, opts);
    return {
      status: typeof result?.status === 'number' ? result.status : null,
      signal: result?.signal ?? null,
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
      error: result?.error,
    };
  }

  #defaultRunChild(command, args, opts) {
    const result = spawnSync(command, args, {
      cwd: opts.cwd,
      env: this.#env,
      shell: false,
      encoding: 'utf8',
      timeout: opts.timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_CHILD_BUFFER,
    });
    return {
      status: typeof result.status === 'number' ? result.status : null,
      signal: result.signal ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  }

  #npmVersion() {
    if (this.#npmVersionCache !== undefined) return this.#npmVersionCache;
    const child = this.#runChild(this.#npm, ['--version'], {
      cwd: this.#runRoot,
      timeoutMs: this.#commandTimeoutMs,
    });
    const out = child.stdout.trim();
    this.#npmVersionCache = child.status === 0 && /^\d+\.\d+\.\d+/.test(out) ? out : null;
    return this.#npmVersionCache;
  }

  #classifyInstallFailure(child) {
    const text = `${child.stderr}\n${child.stdout}`;
    if (REGISTRY_FAILURE.test(text)) return CANDIDATE_REASON_CODES.REGISTRY_UNAVAILABLE;
    return CANDIDATE_REASON_CODES.INSTALL_FAILED;
  }

  #buildEnv() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (ENV_ALLOWLIST.has(key.toUpperCase())) env[key] = value;
    }
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
    out = out.replace(
      /(authorization|bearer|_authtoken|_auth|_password|npm_token|node_auth_token|token)(\s*[=:]\s*)\S+/gi,
      '$1$2<redacted>',
    );
    out = out.replace(/\/\/[^\s/]+\/:_authtoken=\S+/gi, '//<redacted>');
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
    } else if (typeof facts === 'string') {
      diagnostics.push(this.#redact(facts));
    }
    const event = Object.freeze({
      type,
      ok: false,
      state: this.#state,
      reasonCode,
      diagnostics: Object.freeze(diagnostics),
      facts: Object.freeze(isPlainObject(facts) ? facts : {}),
    });
    this.#pushEvent(event);
    return event;
  }

  #success(type, facts) {
    const event = Object.freeze({
      type,
      ok: true,
      state: this.#state,
      reasonCode: null,
      diagnostics: Object.freeze([]),
      facts: Object.freeze(facts ?? {}),
    });
    this.#pushEvent(event);
    return event;
  }

  #pushEvent(event) {
    this.#events.push(event);
    this.#onEvent?.(event);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
