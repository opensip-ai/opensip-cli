/**
 * @fileoverview macOS-specific native journeys (Plan 02 — macOS GA qualification).
 *
 * These journeys close the gap between the common installed-artifact profile and
 * the exact macOS 26 / Apple-Silicon / Node 24 (ABI 137) / npm 11 / APFS support
 * tuple. They add Apple-native probes (sw_vers/uname cross-check, APFS + case
 * behavior, the POSIX `install.sh` path, `/bin/zsh` invocation, npm-shim realpath
 * containment, `/usr/bin/script` PTY, `/usr/bin/open` interception, native
 * SQLite provenance, signal + contention behavior).
 *
 * Hard invariants (mirroring the sibling domain modules):
 *   - An executor reads ONLY its injected `JourneyExecutorContext` (installed
 *     descriptors, run-owned paths, the measured-process port, assert helpers).
 *     Every child runs through `ctx.process.run` / `runCli` as an argv array —
 *     never `shell: true`, never a discovered binary. Fixed absolute system
 *     utility paths (`/usr/bin/sw_vers`, `/bin/sh`, …) are journey-authored, not
 *     profile-injected.
 *   - On a non-darwin host every macOS journey returns `unavailable` WITHOUT
 *     spawning anything — it never throws and never false-passes, so
 *     `pnpm test:scripts` stays green on any host. The executors are REAL: on a
 *     matching Mac (Phase 6) they run against the installed candidate.
 *   - Outcomes are bounded and redacted: diagnostics carry booleans, counts, and
 *     closed reason phrases, never absolute host paths or child output dumps.
 *   - The support-row classification is delegated to the built core policy
 *     (`assessHostSupport`) via a LAZY dynamic import, so the acceptance harness
 *     stays dependency-free at module load and the registry never needs a build
 *     just to enumerate journeys. A missing/unbuilt core is a fail-closed
 *     `unavailable`, never a silent pass.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectEnvelope } from '../../cli-acceptance-core.mjs';
import {
  assertCommand,
  assertUniqueJourneyIds,
  defineJourney,
  fail,
  pass,
  readJson,
  runCli,
  unavailable,
} from '../journey-kit.mjs';

// ---------------------------------------------------------------------------
// Constants + tiny pure helpers
// ---------------------------------------------------------------------------

/** The stable support-row id the macOS acceptance profile binds (spec §4). */
export const MACOS_PREVIEW_ROW_ID = 'macos-26-arm64-node24-npm11-v1';

const HERE = fileURLToPath(import.meta.url);
// journeys → platform-acceptance → scripts → repo root.
const REPO_ROOT = dirname(dirname(dirname(dirname(HERE))));
const INSTALL_SH = join(REPO_ROOT, 'scripts', 'install.sh');
/** The built core lib is loaded lazily so module load stays build-free. */
const CORE_LIB_URL = new URL('../../../packages/core/dist/index-lib.js', import.meta.url);

const SW_VERS = '/usr/bin/sw_vers';
const UNAME = '/usr/bin/uname';
const DISKUTIL = '/usr/sbin/diskutil';
const OPEN_BIN = '/usr/bin/open';
const SH = '/bin/sh';
const ZSH = '/bin/zsh';

const ANSI_ESCAPE = '\u001B';
/** The finding the analysis `fit` journey seeds; exit 1 under either mode. */
const FIT_FINDING_ARGS = Object.freeze(['fit', '--check', 'no-console-log']);
const FIT_ENVELOPE_EXPECT = { exitCode: 1, json: expectEnvelope({ tool: 'fit' }) };

/** A short, safe error string (never a stack, never absolute paths guaranteed). */
function errText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Escape a single argv token for a `sh -c` / `zsh -c` command body. */
function singleQuote(token) {
  return `'${String(token).replace(/'/g, "'\\''")}'`;
}

/** True when `target` is `root` itself or a strict descendant of `root`. */
function isUnder(root, target) {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Normalize a `uname -m` machine string to a Node `process.arch` token. */
export function normalizeUnameArch(machine) {
  const value = String(machine ?? '')
    .trim()
    .toLowerCase();
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (value === 'x86_64' || value === 'amd64') return 'x64';
  if (value === 'i386' || value === 'i686') return 'ia32';
  return value;
}

/** Map cross-checked macOS tuple facts to a core `ObservedHost` (absent = unobserved). */
export function buildTupleObservedHost(facts) {
  const observed = { osPlatform: 'darwin', kernelName: 'Darwin' };
  if (facts.swVers != null) observed.osVersion = facts.swVers;
  if (facts.kernelRelease != null) observed.kernelRelease = facts.kernelRelease;
  if (facts.nodeArch != null) observed.arch = facts.nodeArch;
  if (facts.nodeVersion != null) observed.nodeVersion = facts.nodeVersion;
  if (facts.nodeAbi != null) observed.nodeAbi = facts.nodeAbi;
  if (facts.npmVersion != null) observed.npmVersion = facts.npmVersion;
  return observed;
}

/**
 * Pure cross-check of the independent macOS tuple sources against the core
 * support policy. Contradictory sources fail EVEN IF one alone would match. A
 * required source that is unobservable is a failure, never a silent pass.
 *
 * @param {object} facts       normalized sources (or null when unavailable).
 * @param {(observed: object) => { row?: {id: string}, status: string, reasonCodes: readonly string[] }} assessHostSupport
 * @returns {{ ok: boolean, reasonCode: string | null, lines: string[] }}
 */
export function evaluateTupleCrosscheck(facts, assessHostSupport) {
  const lines = [];
  const record = (source, value) =>
    lines.push(`${source}=${value == null ? 'unavailable' : String(value)}`);
  record('sw_vers.productVersion', facts.swVers);
  record('uname.kernelRelease', facts.kernelRelease);
  record('uname.machine', facts.unameMachine);
  record('process.arch', facts.nodeArch);
  record('process.version', facts.nodeVersion);
  record('process.versions.modules', facts.nodeAbi);
  record('npm.version', facts.npmVersion);

  const missing = [];
  if (facts.swVers == null) missing.push('sw_vers');
  if (facts.kernelRelease == null) missing.push('uname-r');
  if (facts.unameMachine == null) missing.push('uname-m');
  if (facts.npmVersion == null) missing.push('npm');
  if (missing.length > 0) {
    return {
      ok: false,
      reasonCode: 'tuple-source-unavailable',
      lines: [...lines, `missing sources: ${missing.join(', ')}`],
    };
  }

  // Two independent architecture sources must AGREE, regardless of the tuple.
  const unameArchNorm = normalizeUnameArch(facts.unameMachine);
  if (facts.nodeArch != null && unameArchNorm !== facts.nodeArch) {
    return {
      ok: false,
      reasonCode: 'arch-source-mismatch',
      lines: [...lines, `arch sources disagree: uname=${unameArchNorm} node=${facts.nodeArch}`],
    };
  }

  const assessment = assessHostSupport(buildTupleObservedHost(facts));
  if (assessment.reasonCodes.length > 0) {
    return {
      ok: false,
      reasonCode: 'tuple-not-supported-row',
      lines: [...lines, `contradictions: ${assessment.reasonCodes.join(', ')}`],
    };
  }
  if (assessment.row == null || assessment.row.id !== MACOS_PREVIEW_ROW_ID) {
    return {
      ok: false,
      reasonCode: 'tuple-row-unselected',
      lines: [...lines, `selected row: ${assessment.row?.id ?? 'none'}`],
    };
  }
  if (assessment.status !== 'preview' && assessment.status !== 'supported') {
    return {
      ok: false,
      reasonCode: 'tuple-status-unsupported',
      lines: [...lines, `row status: ${assessment.status}`],
    };
  }
  return {
    ok: true,
    reasonCode: null,
    lines: [...lines, `selected row: ${assessment.row.id} (${assessment.status})`],
  };
}

// ---------------------------------------------------------------------------
// Effect helpers (consume ONLY the injected context)
// ---------------------------------------------------------------------------

/** Non-darwin guard: every macOS journey short-circuits here on any other host. */
function requireDarwin(context) {
  if (process.platform === 'darwin') return null;
  return unavailable('non-darwin-host', [
    context.assert.diagnostic(`macOS journey is not applicable on ${process.platform}`),
  ]);
}

let assessHostSupportPromise;
/** Lazily load the built core `assessHostSupport`; null (never throw) if unbuilt. */
function loadAssessHostSupport() {
  assessHostSupportPromise ??= import(CORE_LIB_URL.href)
    .then((module) =>
      typeof module.assessHostSupport === 'function' ? module.assessHostSupport : null,
    )
    .catch(() => null);
  return assessHostSupportPromise;
}

/** Run one fixed argv through the port; return trimmed stdout, or null on any failure. */
async function probeValue(context, argv) {
  let result;
  try {
    result = await context.process.run({ argv, cwd: context.paths.workRoot });
  } catch {
    return null;
  }
  if (result.timedOut || (result.status ?? 1) !== 0) return null;
  const out = (result.stdoutCapture ?? '').trim();
  return out.length > 0 ? out : null;
}

/** Run one fixed argv through the port with optional cwd/env/pty overrides. */
function runProcess(context, argv, options = {}) {
  const spec = { argv, cwd: options.cwd ?? context.paths.workRoot };
  if (options.env !== undefined) spec.env = options.env;
  if (options.timeoutMs !== undefined) spec.timeoutMs = options.timeoutMs;
  if (options.pty !== undefined) spec.pty = options.pty;
  return context.process.run(spec);
}

/** Seed a minimal TS project (a console.log fit flags) under `dir`. */
function seedProject(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'bad.ts'), "console.log('debug');\n");
  writeFileSync(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2)}\n`,
  );
}

/** True when the run root reports case-INsensitive behavior (mutates only run-owned paths). */
function probeCaseInsensitive(root) {
  const dir = mkdtempSync(join(root, 'macos-fs-'));
  try {
    const upper = join(dir, 'CaseProbe');
    const lower = join(dir, 'caseprobe');
    writeFileSync(upper, 'x');
    // Case-insensitive volume: the lower-cased path resolves to the same file.
    return existsSync(lower);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the run-owned root cleanup removes any residue */
    }
  }
}

// ---------------------------------------------------------------------------
// Task 1.1 — tuple + filesystem host preflight
// ---------------------------------------------------------------------------

const tupleCrosscheckExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  const assessHostSupport = await loadAssessHostSupport();
  if (assessHostSupport == null) {
    return unavailable('core-support-policy-unavailable', [
      context.assert.diagnostic('could not load assessHostSupport from packages/core/dist'),
    ]);
  }
  const facts = {
    swVers: await probeValue(context, [SW_VERS, '-productVersion']),
    kernelRelease: await probeValue(context, [UNAME, '-r']),
    unameMachine: await probeValue(context, [UNAME, '-m']),
    npmVersion: await probeValue(context, ['npm', '--version']),
    nodeArch: process.arch,
    nodeVersion: process.version,
    nodeAbi: String(process.versions.modules),
  };
  const verdict = evaluateTupleCrosscheck(facts, assessHostSupport);
  const diagnostics = verdict.lines.map((line) => context.assert.diagnostic(line));
  return verdict.ok ? pass(diagnostics) : fail(verdict.reasonCode, diagnostics);
};

const filesystemExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  const lines = [];

  let caseInsensitive;
  try {
    caseInsensitive = probeCaseInsensitive(context.paths.workRoot);
  } catch (error) {
    return fail('filesystem-case-probe-failed', [context.assert.diagnostic(errText(error))]);
  }
  lines.push(context.assert.diagnostic(`case-insensitive=${caseInsensitive}`));
  if (caseInsensitive !== true) {
    return fail('filesystem-case-sensitive', [
      ...lines,
      context.assert.diagnostic('the run root is case-sensitive (outside the supported tuple)'),
    ]);
  }

  // APFS on the ACTUAL run root — never inferred from the system volume or a label.
  const info = await probeValue(context, [DISKUTIL, 'info', context.paths.workRoot]);
  if (info == null) {
    return unavailable('diskutil-unavailable', [
      ...lines,
      context.assert.diagnostic('diskutil info could not describe the run root'),
    ]);
  }
  const isApfs = /apfs/i.test(info);
  lines.push(context.assert.diagnostic(`apfs=${isApfs}`));
  if (!isApfs) {
    return fail('filesystem-not-apfs', [
      ...lines,
      context.assert.diagnostic('the run root is not an APFS volume'),
    ]);
  }
  return pass(lines);
};

// ---------------------------------------------------------------------------
// Task 1.2 — installer / npm shim / shell / filesystem semantics
// ---------------------------------------------------------------------------

const installerShExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  const version = context.installed?.resolvedVersion;
  if (typeof version !== 'string' || version.length === 0) {
    return fail('installer-version-unknown', [
      context.assert.diagnostic('the installed candidate did not report a resolved version'),
    ]);
  }
  const home = join(context.paths.workRoot, 'installer-home');
  const prefix = join(context.paths.workRoot, 'installer-prefix');
  const cache = join(context.paths.workRoot, 'installer-cache');
  const tmp = join(context.paths.workRoot, 'installer-tmp');
  try {
    for (const dir of [home, prefix, cache, tmp]) mkdirSync(dir, { recursive: true });
  } catch (error) {
    return fail('installer-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  const nodeBinDir = dirname(process.execPath);
  const env = {
    OPENSIP_CLI_PACKAGE: 'opensip-cli',
    OPENSIP_CLI_VERSION: version,
    NPM_CONFIG_PREFIX: prefix,
    NPM_CONFIG_CACHE: cache,
    HOME: home,
    TMPDIR: tmp,
    // A minimal PATH that excludes any ambient/candidate `opensip`, so the
    // installer can only resolve the run-owned prefix bin — never ambient.
    PATH: `${join(prefix, 'bin')}:${nodeBinDir}:/usr/bin:/bin`,
  };

  const install = await runProcess(context, [SH, INSTALL_SH], { env });
  if (install.timedOut)
    return fail('timed-out', [context.assert.diagnostic('install.sh timed out')]);
  if ((install.status ?? 1) !== 0) {
    return fail('installer-failed', [
      context.assert.diagnostic(`install.sh exited ${install.status}`),
      context.assert.diagnostic(install.stderrTail),
    ]);
  }

  const ownedBin = join(prefix, 'bin', 'opensip');
  if (!existsSync(ownedBin)) {
    return fail('installer-bin-missing', [
      context.assert.diagnostic('opensip was not linked under the run-owned prefix'),
    ]);
  }
  let realBin;
  try {
    realBin = realpathSync(ownedBin);
  } catch (error) {
    return fail('installer-bin-unreadable', [context.assert.diagnostic(errText(error))]);
  }
  let realPrefix;
  try {
    realPrefix = realpathSync(prefix);
  } catch {
    realPrefix = prefix;
  }
  if (!isUnder(realPrefix, realBin)) {
    return fail('installer-escaped-prefix', [
      context.assert.diagnostic('installed opensip resolved outside the run-owned prefix'),
    ]);
  }
  const versionRun = await runProcess(context, [ownedBin, '--version'], { env });
  if ((versionRun.status ?? 1) !== 0 || !versionRun.stdoutCapture.includes(version)) {
    return fail('installed-cli-unusable', [
      context.assert.diagnostic(`run-owned opensip --version exited ${versionRun.status}`),
    ]);
  }
  return pass([context.assert.diagnostic(`installed ${version} under a run-owned prefix`)]);
};

const zshInvocationExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  if (!existsSync(ZSH)) {
    return unavailable('zsh-unavailable', [context.assert.diagnostic('/bin/zsh is not present')]);
  }
  const bin = context.installed?.installedBin?.bin;
  if (typeof bin !== 'string' || bin.length === 0) {
    return fail('installed-bin-unknown', [
      context.assert.diagnostic('the installed candidate did not expose an installed bin'),
    ]);
  }
  const version = context.installed?.resolvedVersion ?? '';
  const result = await runProcess(context, [ZSH, '-c', `exec ${singleQuote(bin)} --version`]);
  if (result.timedOut)
    return fail('timed-out', [context.assert.diagnostic('zsh invocation timed out')]);
  if ((result.status ?? 1) !== 0) {
    return fail('zsh-invocation-failed', [
      context.assert.diagnostic(`zsh -> opensip --version exited ${result.status}`),
      context.assert.diagnostic(result.stderrTail),
    ]);
  }
  if (version.length > 0 && !result.stdoutCapture.includes(version)) {
    return fail('zsh-version-mismatch', [
      context.assert.diagnostic('zsh-invoked opensip did not report the resolved version'),
    ]);
  }
  return pass();
};

const npmShimContainmentExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  const bin = context.installed?.installedBin?.bin;
  const script = context.installed?.jsEntrypoint?.script;
  if (typeof bin !== 'string' || bin.length === 0) {
    return fail('installed-bin-unknown', [
      context.assert.diagnostic('the installed candidate did not expose an installed bin'),
    ]);
  }
  if (typeof script !== 'string' || script.length === 0) {
    return fail('installed-entrypoint-unknown', [
      context.assert.diagnostic('the installed candidate did not expose a JS entrypoint'),
    ]);
  }
  let realBin;
  try {
    realBin = realpathSync(bin);
  } catch (error) {
    return fail('npm-shim-missing', [context.assert.diagnostic(errText(error))]);
  }
  let realScript;
  try {
    realScript = realpathSync(script);
  } catch (error) {
    return fail('npm-entrypoint-missing', [context.assert.diagnostic(errText(error))]);
  }
  // <prefix>/bin/opensip → prefix is two directories up from the shim.
  const prefix = dirname(dirname(bin));
  let realPrefix;
  try {
    realPrefix = realpathSync(prefix);
  } catch {
    realPrefix = prefix;
  }
  const binUnder = isUnder(realPrefix, realBin);
  const scriptUnder = isUnder(realPrefix, realScript);
  const lines = [
    context.assert.diagnostic(`bin-under-prefix=${binUnder}`),
    context.assert.diagnostic(`entrypoint-under-prefix=${scriptUnder}`),
  ];
  if (!binUnder || !scriptUnder) {
    return fail('npm-shim-escapes-prefix', [
      ...lines,
      context.assert.diagnostic('the npm shim resolved outside the isolated install prefix'),
    ]);
  }
  return pass(lines);
};

const pathSemanticsExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  const roots = [];
  let physicalRoot;
  try {
    physicalRoot = realpathSync(context.paths.workRoot);
    const spaces = join(context.paths.workRoot, 'wörk späce ✓');
    const nfc = join(context.paths.workRoot, 'café-project'.normalize('NFC'));
    const nfd = join(context.paths.workRoot, 'café-project'.normalize('NFD') + '-nfd');
    for (const dir of [spaces, nfc, nfd]) {
      seedProject(dir);
      roots.push({ label: 'literal', dir });
    }
    const real = join(context.paths.workRoot, 'symlink-real');
    seedProject(real);
    const link = join(context.paths.workRoot, 'symlink-link');
    symlinkSync(real, link, 'dir');
    roots.push({ label: 'symlink', dir: link });
  } catch (error) {
    return fail('path-semantics-setup-failed', [context.assert.diagnostic(errText(error))]);
  }

  for (const root of roots) {
    const result = await runCli(context, {
      args: ['fit', '--json', '--check', 'no-console-log'],
      cwd: root.dir,
    });
    const outcome = assertCommand(context, result, FIT_ENVELOPE_EXPECT, 'path-discovery-failed');
    if (outcome.status !== 'pass') return outcome;
    // Any resolved project + generated state must stay under the PHYSICAL run root.
    let resolved;
    try {
      resolved = realpathSync(root.dir);
    } catch (error) {
      return fail('path-resolution-failed', [context.assert.diagnostic(errText(error))]);
    }
    if (!isUnder(physicalRoot, resolved)) {
      return fail('path-escaped-run-root', [
        context.assert.diagnostic(`${root.label} project resolved outside the physical run root`),
      ]);
    }
  }
  return pass([
    context.assert.diagnostic(`discovered ${roots.length} odd-path projects under the run root`),
  ]);
};

const permissionsExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  const readOnly = join(context.paths.workRoot, 'read-only');
  try {
    mkdirSync(readOnly, { recursive: true });
    chmodSync(readOnly, 0o500);
  } catch (error) {
    return fail('permissions-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  try {
    const result = await runCli(context, {
      args: ['init', '--language', 'typescript', '--json'],
      cwd: readOnly,
    });
    if (result.timedOut) {
      return fail('timed-out', [context.assert.diagnostic('init in a read-only dir timed out')]);
    }
    if ((result.status ?? 0) === 0) {
      return fail('permission-denied-silently-succeeded', [
        context.assert.diagnostic('init reported success writing into a read-only directory'),
      ]);
    }
    // No out-of-root fallback: the denied target must not have gained project state.
    if (existsSync(join(readOnly, 'opensip-cli'))) {
      return fail('permission-out-of-root-fallback', [
        context.assert.diagnostic('init left partial project state in the read-only target'),
      ]);
    }
    return pass();
  } finally {
    try {
      chmodSync(readOnly, 0o700);
    } catch {
      /* best-effort restore so the run-owned cleanup can remove the tree */
    }
  }
};

// ---------------------------------------------------------------------------
// Task 1.3 — PTY / browser / signals / native SQLite / cleanup
// ---------------------------------------------------------------------------

const ptyHumanViewExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  // 1. Human render under a real PTY (/usr/bin/script) completes with the finding.
  const human = await runCli(context, { args: FIT_FINDING_ARGS, pty: true });
  if (human.timedOut) return fail('timed-out', [context.assert.diagnostic('PTY run timed out')]);
  if ((human.status ?? 1) !== 1) {
    return fail('pty-unexpected-exit', [
      context.assert.diagnostic(`expected exit 1 under a PTY, got ${human.status}`),
    ]);
  }
  if (human.stdoutCapture.trim().length === 0) {
    return fail('pty-empty-output', [
      context.assert.diagnostic('the PTY run produced empty stdout'),
    ]);
  }
  // 2. NO_COLOR suppresses escape sequences even under a TTY.
  const noColor = await runCli(context, {
    args: FIT_FINDING_ARGS,
    pty: true,
    env: { NO_COLOR: '1' },
  });
  if (noColor.stdoutCapture.includes(ANSI_ESCAPE)) {
    return fail('pty-ansi-under-no-color', [
      context.assert.diagnostic('stdout carried an ANSI escape under a PTY while NO_COLOR was set'),
    ]);
  }
  // 3. --json stays pure + non-interactive under a TTY.
  const json = await runCli(context, {
    args: ['fit', '--json', '--check', 'no-console-log'],
    pty: true,
  });
  const parsed = readJson(json);
  if (!parsed.ok) {
    return fail('pty-json-not-pure', [context.assert.diagnostic(parsed.message)]);
  }
  return pass();
};

const signalsExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  // Abort mid-run — the port drives a bounded SIGTERM→SIGKILL tree termination.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  let aborted;
  try {
    aborted = await runCli(context, { args: ['graph', '--json'], signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const failures = [];
  if (aborted.cancelled !== true) failures.push('run was not reported cancelled after abort');
  if (aborted.cleanup.residualDescendants > 0) {
    failures.push(`cancellation left ${aborted.cleanup.residualDescendants} descendant(s)`);
  }
  if (failures.length > 0) {
    return fail(
      'signal-shutdown-failed',
      failures.map((message) => context.assert.diagnostic(message)),
    );
  }
  // Reusable state: a fresh datastore read after cancellation still succeeds.
  const rerun = await runCli(context, { args: ['sessions', 'list', '--json'] });
  if (rerun.timedOut || (rerun.status ?? 1) !== 0 || !readJson(rerun).ok) {
    return fail('state-not-reusable', [
      context.assert.diagnostic(`post-cancel sessions list exited ${rerun.status}`),
    ]);
  }
  return pass();
};

const browserOpenExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  if (!existsSync(OPEN_BIN)) {
    return unavailable('open-utility-unavailable', [
      context.assert.diagnostic('/usr/bin/open is not present'),
    ]);
  }
  // Seed a project + a run so `report` has data to render.
  try {
    seedProject(context.paths.workRoot);
  } catch (error) {
    return fail('browser-open-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  const seedRun = await runCli(context, { args: ['graph', '--json'] });
  if (seedRun.timedOut) {
    return fail('timed-out', [context.assert.diagnostic('seed graph run timed out')]);
  }

  // Availability probe of a REGISTERED browser without launching a GUI. A missing
  // browser is only recorded; it never fails the interception proof below.
  const browserProbe = await runProcess(context, [OPEN_BIN, '-Ra', 'Safari']);
  const browserRegistered = (browserProbe.status ?? 1) === 0;

  // Interception: a run-owned `open` shim on PATH captures the target and never
  // launches a real application (the `open` npm package spawns `open` via PATH).
  const shimBin = join(context.paths.workRoot, 'shim-bin');
  const capture = join(context.paths.workRoot, 'open-capture.log');
  try {
    mkdirSync(shimBin, { recursive: true });
    writeFileSync(
      join(shimBin, 'open'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${singleQuote(capture)}\nexit 0\n`,
      { mode: 0o755 },
    );
  } catch (error) {
    return fail('open-shim-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  const nodeBinDir = dirname(process.execPath);
  const result = await runCli(context, {
    args: ['report', '--open'],
    pty: true,
    // Prepend the shim; unset CI (empty is falsy) only for this child so the
    // launcher actually attempts to open under the PTY.
    env: { PATH: `${shimBin}:${nodeBinDir}:/usr/bin:/bin`, CI: '' },
  });
  if (result.timedOut) {
    return fail('timed-out', [context.assert.diagnostic('report --open timed out')]);
  }

  let captured;
  try {
    captured = existsSync(capture)
      ? readFileSync(capture, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  } catch (error) {
    return fail('open-capture-unreadable', [context.assert.diagnostic(errText(error))]);
  }
  if (captured.length === 0) {
    return fail('open-shim-not-invoked', [
      context.assert.diagnostic('report --open did not resolve the run-owned open shim'),
    ]);
  }
  if (captured.length !== 1) {
    return fail('open-multiple-targets', [
      context.assert.diagnostic(`expected exactly one open target, got ${captured.length}`),
    ]);
  }
  let safeTarget;
  try {
    safeTarget =
      existsSync(captured[0]) &&
      isUnder(realpathSync(context.paths.workRoot), realpathSync(captured[0]));
  } catch {
    safeTarget = false;
  }
  if (safeTarget !== true) {
    return fail('open-unsafe-target', [
      context.assert.diagnostic('the open target was not a safe generated file under the run root'),
    ]);
  }
  return pass([
    context.assert.diagnostic(`browser-registered=${browserRegistered}`),
    context.assert.diagnostic(
      'report --open resolved exactly one safe generated file via the shim',
    ),
  ]);
};

const nativeSqliteExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  // The native better-sqlite3 binding (Node ABI 137) must load from a clean install.
  const list = await runCli(context, { args: ['sessions', 'list', '--json'] });
  if (list.timedOut) {
    return fail('timed-out', [context.assert.diagnostic('sessions list --json timed out')]);
  }
  if ((list.status ?? 1) !== 0 || !readJson(list).ok) {
    return fail('native-sqlite-load-failed', [
      context.assert.diagnostic(`sessions list --json exited ${list.status}`),
      context.assert.diagnostic(list.stderrTail),
    ]);
  }
  // Provenance: the installed entrypoint must resolve under the isolated install
  // prefix, NEVER a workspace dist/node_modules fallback.
  const script = context.installed?.jsEntrypoint?.script;
  if (typeof script !== 'string' || script.length === 0) {
    return fail('installed-entrypoint-unknown', [
      context.assert.diagnostic('the installed candidate did not expose a JS entrypoint'),
    ]);
  }
  let realScript;
  try {
    realScript = realpathSync(script);
  } catch (error) {
    return fail('native-entrypoint-missing', [context.assert.diagnostic(errText(error))]);
  }
  if (isUnder(REPO_ROOT, realScript)) {
    return fail('native-binding-from-workspace', [
      context.assert.diagnostic('the installed entrypoint resolved inside the workspace checkout'),
    ]);
  }
  return pass([context.assert.diagnostic('native SQLite loaded from the isolated install prefix')]);
};

const contentionRecoveryExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  try {
    seedProject(context.paths.workRoot);
  } catch (error) {
    return fail('contention-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  // Bounded contention: concurrent datastore readers/writers all succeed on APFS.
  const concurrent = await Promise.all([
    runCli(context, { args: ['sessions', 'list', '--json'] }),
    runCli(context, { args: ['sessions', 'list', '--json'] }),
    runCli(context, { args: ['graph', '--json'] }),
  ]);
  for (const run of concurrent) {
    if (run.timedOut || (run.status ?? 1) !== 0) {
      return fail('contention-failed', [
        context.assert.diagnostic(`a concurrent datastore command exited ${run.status}`),
        context.assert.diagnostic(run.stderrTail),
      ]);
    }
  }
  // Interrupted-child recovery: abort mid-write, then prove a clean replay.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    await runCli(context, { args: ['graph', '--json'], signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  const replay = await runCli(context, { args: ['sessions', 'list', '--json'] });
  if (replay.timedOut || (replay.status ?? 1) !== 0 || !readJson(replay).ok) {
    return fail('interrupted-recovery-failed', [
      context.assert.diagnostic(`post-interrupt sessions list exited ${replay.status}`),
      context.assert.diagnostic(replay.stderrTail),
    ]);
  }
  return pass();
};

// ---------------------------------------------------------------------------
// Registry contribution
// ---------------------------------------------------------------------------

export const macosJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'macos.tuple-crosscheck',
    category: 'macos',
    value: {
      human: 'Runs on the exact supported Mac',
      agent: 'sw_vers/uname/Node/npm sources agree on the macOS 26 arm64 support tuple',
    },
    isolated: true,
    steps: [
      { label: 'probe sw_vers, uname -r, uname -m, and npm' },
      { label: 'cross-check against process.arch/version/ABI' },
      { label: 'assess the support-row selection (contradictions fail)' },
    ],
    executor: tupleCrosscheckExecutor,
  }),
  defineJourney({
    id: 'macos.filesystem',
    category: 'macos',
    value: {
      human: 'Works on an APFS, case-insensitive volume',
      agent: 'the actual run root is APFS with case-insensitive behavior',
    },
    isolated: true,
    steps: [
      { label: 'probe case behavior with run-owned names' },
      { label: 'confirm the run root is APFS via diskutil' },
    ],
    executor: filesystemExecutor,
  }),
  defineJourney({
    id: 'macos.installer-sh',
    category: 'macos',
    value: {
      human: 'Installs via the canonical installer',
      agent: 'scripts/install.sh installs the exact version into a run-owned prefix under /bin/sh',
    },
    isolated: true,
    steps: [
      { label: 'run install.sh with an exact version + run-owned prefix/HOME/cache/temp' },
      { label: 'assert the bin is linked under the prefix (no ambient escape)' },
      { label: 'assert the run-owned bin reports the exact version' },
    ],
    executor: installerShExecutor,
  }),
  defineJourney({
    id: 'macos.zsh-invocation',
    category: 'macos',
    value: {
      human: 'Runs from the Apple zsh shell',
      agent: 'the installed bin executes under /bin/zsh and reports its version',
    },
    isolated: true,
    steps: [
      { label: 'invoke the installed bin through /bin/zsh -c' },
      { label: 'assert exit 0 + the resolved version' },
    ],
    executor: zshInvocationExecutor,
  }),
  defineJourney({
    id: 'macos.npm-shim-containment',
    category: 'macos',
    value: {
      human: 'The command resolves to the installed package',
      agent: 'the npm shim + JS entrypoint realpath resolve within the isolated prefix',
    },
    isolated: true,
    steps: [
      { label: 'realpath the installed bin and entrypoint' },
      { label: 'assert both stay under the isolated install prefix' },
    ],
    executor: npmShimContainmentExecutor,
  }),
  defineJourney({
    id: 'macos.path-semantics',
    category: 'macos',
    value: {
      human: 'Works from spaces, Unicode, and symlinked paths',
      agent: 'discovery works from spaces/NFC/NFD/symlink roots contained under the run root',
    },
    capabilities: ['symlink'],
    isolated: true,
    steps: [
      { label: 'seed spaces + precomposed + decomposed + symlinked project roots' },
      { label: 'run fit --json from each and prove containment under the physical run root' },
    ],
    executor: pathSemanticsExecutor,
  }),
  defineJourney({
    id: 'macos.permissions',
    category: 'macos',
    value: {
      human: 'Fails cleanly on permission denied',
      agent: 'init into a read-only dir fails with no out-of-root fallback',
    },
    capabilities: ['permissions'],
    isolated: true,
    steps: [
      { label: 'create a read-only directory' },
      { label: 'attempt init and assert a graceful non-zero exit' },
      { label: 'assert no partial state escaped the denied target' },
    ],
    executor: permissionsExecutor,
  }),
  defineJourney({
    id: 'macos.pty-human-view',
    category: 'macos',
    value: {
      human: 'Live view renders in a real terminal',
      agent: 'fit renders under /usr/bin/script; NO_COLOR suppresses escapes; --json stays pure',
    },
    capabilities: ['pty'],
    isolated: true,
    steps: [
      { label: 'run fit under a PTY and assert a non-empty exit-1 render' },
      { label: 'assert NO_COLOR removes escapes and --json stays pure JSON' },
    ],
    executor: ptyHumanViewExecutor,
  }),
  defineJourney({
    id: 'macos.signals',
    category: 'macos',
    value: {
      human: 'Cancels cleanly and stays reusable',
      agent: 'an aborted run is cancelled, leaves no descendants, and state replays next run',
    },
    isolated: true,
    steps: [
      { label: 'abort a run mid-flight' },
      { label: 'assert cancelled + zero residual descendants' },
      { label: 'assert a fresh datastore read still succeeds' },
    ],
    executor: signalsExecutor,
  }),
  defineJourney({
    id: 'macos.browser-open',
    category: 'macos',
    value: {
      human: 'Never opens a stray browser',
      agent: 'report --open resolves exactly one safe generated file through a capture shim',
    },
    capabilities: ['pty'],
    isolated: true,
    steps: [
      { label: 'probe /usr/bin/open availability without launching a GUI' },
      { label: 'intercept report --open with a run-owned open shim under a PTY' },
      { label: 'assert exactly one safe generated file target' },
    ],
    executor: browserOpenExecutor,
  }),
  defineJourney({
    id: 'macos.native-sqlite',
    category: 'macos',
    value: {
      human: 'The data store opens on Apple Silicon',
      agent: 'the native better-sqlite3 binding loads from the isolated install, not the workspace',
    },
    isolated: true,
    steps: [
      { label: 'open the store via sessions list --json' },
      { label: 'assert the entrypoint resolves outside the workspace checkout' },
    ],
    executor: nativeSqliteExecutor,
  }),
  defineJourney({
    id: 'macos.contention-recovery',
    category: 'macos',
    value: {
      human: 'Survives concurrent use and interruption',
      agent:
        'concurrent datastore access succeeds and an interrupted child replays cleanly on APFS',
    },
    isolated: true,
    steps: [
      { label: 'run concurrent datastore commands' },
      { label: 'interrupt a child mid-write and prove a clean replay' },
    ],
    executor: contentionRecoveryExecutor,
  }),
]);
