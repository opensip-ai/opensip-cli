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
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
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
import {
  initProject,
  runInterruptedSqliteProbe,
  runSqliteContentionProbe,
} from './persistence.mjs';

// ---------------------------------------------------------------------------
// Constants + tiny pure helpers
// ---------------------------------------------------------------------------

/** The stable support-row id the macOS acceptance profile binds (spec §4). */
export const MACOS_PREVIEW_ROW_ID = 'macos-26-arm64-node24-npm11-v1';

const HERE = fileURLToPath(import.meta.url);
// journeys → platform-acceptance → scripts → repo root.
const REPO_ROOT = dirname(dirname(dirname(dirname(HERE))));
/** The built core lib is loaded lazily so module load stays build-free. */
const CORE_LIB_URL = new URL('../../../packages/core/dist/index-lib.js', import.meta.url);

const SW_VERS = '/usr/bin/sw_vers';
const UNAME = '/usr/bin/uname';
const DISKUTIL = '/usr/sbin/diskutil';
const DF = '/bin/df';
const OPEN_BIN = '/usr/bin/open';
const ZSH = '/bin/zsh';

const ANSI_ESCAPE = '\u001B';
/** The finding the analysis `fit` journey seeds; exit 1 under either mode. */
const FIT_FINDING_ARGS = Object.freeze(['fit', '--check', 'no-console-log']);
const FIT_ENVELOPE_EXPECT = {
  exitCode: 1,
  json: expectEnvelope({ tool: 'fit' }),
};
const NATIVE_SIGNAL_TIMEOUT_MS = 10_000;
const NATIVE_SIGNAL_AFTER_MS = 100;

/** Run in a separate Node process so the installed native addon is really loaded. */
const NATIVE_SQLITE_PROBE_SOURCE = String.raw`
const { createRequire } = require('node:module');
try {
  const fromCli = createRequire(process.argv[1]);
  const datastoreEntrypoint = fromCli.resolve('@opensip-cli/datastore');
  const fromDatastore = createRequire(datastoreEntrypoint);
  const sqliteEntrypoint = fromDatastore.resolve('better-sqlite3');
  const Database = fromDatastore('better-sqlite3');
  const database = new Database(':memory:');
  let queryOk = false;
  try {
    queryOk = database.prepare('SELECT 1 AS ok').get()?.ok === 1;
  } finally {
    database.close();
  }
  const nativeAddon = Object.keys(require.cache).find(
    (path) => path.endsWith('.node') && /better[_-]sqlite3/i.test(path),
  );
  if (!nativeAddon) throw new Error('native addon was not loaded');
  process.stdout.write(JSON.stringify({
    ok: queryOk,
    datastoreEntrypoint,
    sqliteEntrypoint,
    nativeAddon,
  }));
} catch {
  process.stdout.write(JSON.stringify({ ok: false }));
  process.exitCode = 1;
}
`;

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

/** Parse the containing device from POSIX `df -P <path>` output. */
export function parseDfDevice(output) {
  if (typeof output !== 'string') return null;
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const [device] = lines.at(-1).split(/\s+/u);
  return /^\/dev\/[A-Za-z0-9._-]+$/u.test(device ?? '') ? device : null;
}

/** Classify the two commands whose success is required by `macos.browser-open`. */
export function evaluateBrowserCommandResult(result, phase) {
  if (result?.timedOut === true) return { ok: false, reasonCode: 'timed-out' };
  if ((result?.status ?? 1) !== 0) {
    return {
      ok: false,
      reasonCode: phase === 'seed' ? 'browser-open-seed-failed' : 'report-open-failed',
    };
  }
  return { ok: true, reasonCode: null };
}

function containingNodeModules(path) {
  let current = dirname(path);
  while (true) {
    if (basename(current) === 'node_modules') return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Verify a successful native probe stayed inside the installed dependency tree. */
export function evaluateNativeSqliteProvenance(probe) {
  if (probe?.queryOk !== true) return { ok: false, reasonCode: 'native-sqlite-query-failed' };
  const paths = [
    probe.installedEntrypoint,
    probe.datastoreEntrypoint,
    probe.sqliteEntrypoint,
    probe.nativeAddon,
  ];
  if (paths.some((path) => typeof path !== 'string' || !isAbsolute(path))) {
    return { ok: false, reasonCode: 'native-sqlite-provenance-invalid' };
  }
  if (!probe.nativeAddon.endsWith('.node')) {
    return { ok: false, reasonCode: 'native-sqlite-provenance-invalid' };
  }
  const installNodeModules = containingNodeModules(probe.installedEntrypoint);
  if (installNodeModules === null) {
    return { ok: false, reasonCode: 'installed-dependency-tree-unknown' };
  }
  if (paths.slice(1).some((path) => !isUnder(installNodeModules, path))) {
    return { ok: false, reasonCode: 'native-sqlite-outside-install' };
  }
  return { ok: true, reasonCode: null };
}

/** Validate one PTY fitness probe before accepting its terminal/output semantics. */
export function evaluatePtyFindingResult(result, mode) {
  const failures = [];
  if (result?.timedOut === true) failures.push('run timed out');
  if ((result?.status ?? 0) !== 1) failures.push(`expected exit 1, got ${String(result?.status)}`);
  if ((result?.cleanup?.residualDescendants ?? 1) !== 0) {
    failures.push('run left residual descendants');
  }
  if (result?.outputTruncated === true) failures.push('stdout was truncated');
  const stdout = typeof result?.stdoutCapture === 'string' ? result.stdoutCapture : '';
  if (stdout.trim().length === 0) failures.push('stdout was empty');
  if (mode === 'no-color' && stdout.includes(ANSI_ESCAPE)) {
    failures.push('stdout contained ANSI under NO_COLOR');
  }
  if (mode === 'json') {
    try {
      const payload = JSON.parse(stdout);
      if (
        payload?.kind !== 'fit.run' ||
        payload?.status !== 'ok' ||
        payload?.exitCode !== 1 ||
        payload?.envelope?.schemaVersion !== 2 ||
        payload?.envelope?.tool !== 'fit' ||
        payload?.envelope?.verdict?.passed !== false
      ) {
        failures.push('stdout did not contain the expected fit envelope shape');
      }
    } catch {
      failures.push('stdout was not pure JSON');
    }
  }
  return failures;
}

/** Validate explicit signal identity, bounded exit, and descendant cleanup. */
export function evaluateNativeSignalResult(result, expectedSignal, timeoutMs) {
  const failures = [];
  if (result?.deliveredSignal !== expectedSignal) {
    failures.push(`${expectedSignal} was not delivered`);
  }
  if (result?.timedOut === true) failures.push(`${expectedSignal} fell through to timeout`);
  if (result?.cancelled === true)
    failures.push(`${expectedSignal} was reported as generic cancellation`);
  if (
    !Number.isFinite(result?.durationMs) ||
    result.durationMs < 0 ||
    result.durationMs >= timeoutMs
  ) {
    failures.push(`${expectedSignal} did not terminate within the bound`);
  }
  if ((result?.cleanup?.residualDescendants ?? 1) !== 0) {
    failures.push(`${expectedSignal} left residual descendants`);
  }
  if (result?.signal === 'SIGKILL') failures.push(`${expectedSignal} required SIGKILL escalation`);
  if (result?.signal === null && (result?.status ?? 0) === 0) {
    failures.push(`${expectedSignal} produced a clean exit instead of interruption`);
  }
  return failures;
}

/** Require an interrupted live child with zero observed residual descendants. */
export function evaluateInterruptedRecoveryResult(result) {
  if (result?.cancelled !== true) return 'interruption-not-observed';
  if (result?.timedOut === true) return 'interruption-fell-through-to-timeout';
  if ((result?.cleanup?.residualDescendants ?? 1) !== 0) {
    return 'interruption-left-descendants';
  }
  return null;
}

/** Require a structured, actionable permission error for one exact state target. */
export function evaluatePermissionFailure(result, targetMarker) {
  if (result?.timedOut === true) return { ok: false, reasonCode: 'permission-check-timed-out' };
  if (!Number.isInteger(result?.status) || result.status <= 0) {
    return { ok: false, reasonCode: 'permission-denied-silently-succeeded' };
  }
  let payload;
  try {
    payload = JSON.parse(result.stdoutCapture);
  } catch {
    return { ok: false, reasonCode: 'permission-error-not-json' };
  }
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const text = errors
    .flatMap((error) => [error?.message, error?.suggestion])
    .filter((entry) => typeof entry === 'string')
    .join(' ');
  if (
    payload?.kind !== 'command.error' ||
    payload?.status !== 'error' ||
    payload?.exitCode !== result.status ||
    errors.length === 0
  ) {
    return { ok: false, reasonCode: 'permission-error-shape-invalid' };
  }
  if (!text.includes(targetMarker)) {
    return { ok: false, reasonCode: 'permission-error-target-missing' };
  }
  if (!/(?:EACCES|permission|non-writable|writable directory)/iu.test(text)) {
    return { ok: false, reasonCode: 'permission-error-not-actionable' };
  }
  return { ok: true, reasonCode: null };
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
  const observed = { osPlatform: 'darwin' };
  if (facts.swVers != null) observed.osVersion = facts.swVers;
  if (facts.kernelName != null) observed.kernelName = facts.kernelName;
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
  record('uname.kernelName', facts.kernelName);
  record('uname.kernelRelease', facts.kernelRelease);
  record('uname.machine', facts.unameMachine);
  record('process.arch', facts.nodeArch);
  record('process.version', facts.nodeVersion);
  record('process.versions.modules', facts.nodeAbi);
  record('npm.version', facts.npmVersion);

  const missing = [];
  if (facts.swVers == null) missing.push('sw_vers');
  if (facts.kernelName == null) missing.push('uname-s');
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

function seedIdentifiedProject(dir) {
  seedProject(dir);
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'opensip-macos-acceptance', private: true, type: 'module' }, null, 2)}\n`,
  );
}

function seedSignalProject(dir) {
  seedIdentifiedProject(dir);
  for (let index = 0; index < 192; index += 1) {
    writeFileSync(
      join(dir, 'src', `signal-${String(index).padStart(3, '0')}.ts`),
      `export const signalValue${String(index)} = ${String(index)};\n`,
    );
  }
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
  const npmArgv = context.toolchain?.npm?.argv;
  if (!Array.isArray(npmArgv) || npmArgv.length === 0) {
    return unavailable('npm-toolchain-unavailable', [
      context.assert.diagnostic('the runner did not provide a resolved npm executable descriptor'),
    ]);
  }
  const assessHostSupport = await loadAssessHostSupport();
  if (assessHostSupport == null) {
    return unavailable('core-support-policy-unavailable', [
      context.assert.diagnostic('could not load assessHostSupport from packages/core/dist'),
    ]);
  }
  const facts = {
    swVers: await probeValue(context, [SW_VERS, '-productVersion']),
    kernelName: await probeValue(context, [UNAME, '-s']),
    kernelRelease: await probeValue(context, [UNAME, '-r']),
    unameMachine: await probeValue(context, [UNAME, '-m']),
    npmVersion: await probeValue(context, [...npmArgv, '--version']),
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

  // Resolve the ACTUAL containing device first. `diskutil info <directory>` is
  // not a supported macOS invocation; POSIX df gives us the device without shell
  // parsing, then diskutil proves that device is APFS.
  const dfOutput = await probeValue(context, [DF, '-P', context.paths.workRoot]);
  const device = parseDfDevice(dfOutput);
  if (device === null) {
    return unavailable('filesystem-device-unavailable', [
      ...lines,
      context.assert.diagnostic('df could not identify the run-root device'),
    ]);
  }
  const info = await probeValue(context, [DISKUTIL, 'info', device]);
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
  if (context.installed?.mode !== 'published-version') {
    return fail('installer-published-candidate-required', [
      context.assert.diagnostic('the canonical installer assertion requires a published candidate'),
    ]);
  }
  if (context.installed?.installChannel !== 'canonical-installer') {
    return fail('installer-channel-unproven', [
      context.assert.diagnostic(
        'the lifecycle target was not installed through scripts/install.sh',
      ),
    ]);
  }
  const version = context.installed?.resolvedVersion;
  if (typeof version !== 'string' || version.length === 0) {
    return fail('installer-version-unknown', [
      context.assert.diagnostic('the installed candidate did not report a resolved version'),
    ]);
  }
  const versionRun = await runCli(context, { args: ['--version'] });
  if (
    versionRun.timedOut ||
    (versionRun.status ?? 1) !== 0 ||
    !versionRun.stdoutCapture.includes(version)
  ) {
    return fail('installed-cli-unusable', [
      context.assert.diagnostic(
        'the lifecycle-owned canonical target did not report its exact version',
      ),
    ]);
  }
  return pass([
    context.assert.diagnostic(`canonical lifecycle target ${version} passed its measured smoke`),
  ]);
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
  // This journey otherwise performs only filesystem inspection, which would
  // make the macOS profile's required process-tree RSS claim impossible. Run
  // the validated customer shim once and bind its output to the candidate
  // version after proving both realpaths are contained.
  const version = context.installed?.resolvedVersion ?? '';
  const invoked = await runCli(context, { args: ['--version'] });
  if (
    invoked.timedOut ||
    (invoked.status ?? 1) !== 0 ||
    invoked.cleanup.residualDescendants !== 0 ||
    version.length === 0 ||
    !invoked.stdoutCapture.includes(version)
  ) {
    return fail('npm-shim-invocation-failed', [
      context.assert.diagnostic('the contained npm shim did not report the candidate version'),
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
  const configDenied = join(context.paths.workRoot, 'config-denied');
  const runtimeDenied = join(context.paths.workRoot, 'runtime-denied');
  let runtimeStateRoot;
  try {
    seedIdentifiedProject(configDenied);
    chmodSync(configDenied, 0o500);
  } catch (error) {
    return fail('permissions-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  try {
    const configResult = await runCli(context, {
      args: ['init', '--cwd', configDenied, '--language', 'typescript', '--json'],
      cwd: configDenied,
    });
    const configFailure = evaluatePermissionFailure(configResult, 'opensip-cli.config.yml');
    if (!configFailure.ok) {
      return fail(configFailure.reasonCode, [
        context.assert.diagnostic('read-only config target lacked an actionable structured error'),
      ]);
    }
    if (
      existsSync(join(configDenied, 'opensip-cli.config.yml')) ||
      existsSync(join(configDenied, 'opensip-cli', '.runtime'))
    ) {
      return fail('permission-config-partial-state', [
        context.assert.diagnostic('config denial left partial config/runtime state'),
      ]);
    }

    chmodSync(configDenied, 0o700);
    seedIdentifiedProject(runtimeDenied);
    const init = await runCli(context, {
      args: ['init', '--cwd', runtimeDenied, '--language', 'typescript', '--json'],
      cwd: runtimeDenied,
    });
    const initPayload = readJson(init);
    if (
      init.timedOut ||
      (init.status ?? 1) !== 0 ||
      !initPayload.ok ||
      initPayload.value?.kind !== 'init' ||
      initPayload.value?.status !== 'ok'
    ) {
      return fail('permission-runtime-setup-failed', [
        context.assert.diagnostic('could not initialize the runtime-permission fixture'),
      ]);
    }
    runtimeStateRoot = join(runtimeDenied, 'opensip-cli');
    const runtimeDir = join(runtimeStateRoot, '.runtime');
    rmSync(runtimeDir, { recursive: true, force: true });
    chmodSync(runtimeStateRoot, 0o500);

    const runtimeResult = await runCli(context, {
      args: ['graph', '--json'],
      cwd: runtimeDenied,
    });
    const runtimeFailure = evaluatePermissionFailure(runtimeResult, '.runtime/datastore.sqlite');
    if (!runtimeFailure.ok) {
      return fail(runtimeFailure.reasonCode, [
        context.assert.diagnostic('read-only runtime target lacked an actionable structured error'),
      ]);
    }
    if (!existsSync(join(runtimeDenied, 'opensip-cli.config.yml')) || existsSync(runtimeDir)) {
      return fail('permission-runtime-partial-state', [
        context.assert.diagnostic('runtime denial changed config or left partial runtime state'),
      ]);
    }
    return pass();
  } finally {
    try {
      chmodSync(configDenied, 0o700);
    } catch {
      /* best-effort restore so the run-owned cleanup can remove the tree */
    }
    if (runtimeStateRoot !== undefined) {
      try {
        chmodSync(runtimeStateRoot, 0o700);
      } catch {
        /* best-effort restore so the run-owned cleanup can remove the tree */
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Task 1.3 — PTY / browser / signals / native SQLite / cleanup
// ---------------------------------------------------------------------------

const ptyHumanViewExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  // Isolated journeys start from an empty directory. Seed a recognizable source
  // project so the CLI enters its zero-init cache mode and the check has the
  // finding this journey promises to render.
  try {
    seedProject(context.paths.workRoot);
  } catch (error) {
    return fail('pty-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  // 1. Human render under a real PTY (/usr/bin/script) completes with the finding.
  const human = await runCli(context, { args: FIT_FINDING_ARGS, pty: true });
  const humanFailures = evaluatePtyFindingResult(human, 'human');
  if (humanFailures.length > 0) {
    return fail(
      'pty-human-view-invalid',
      humanFailures.map((failure) => context.assert.diagnostic(failure)),
    );
  }
  // 2. NO_COLOR suppresses escape sequences even under a TTY.
  const noColor = await runCli(context, {
    args: FIT_FINDING_ARGS,
    pty: true,
    env: { NO_COLOR: '1' },
  });
  const noColorFailures = evaluatePtyFindingResult(noColor, 'no-color');
  if (noColorFailures.length > 0) {
    return fail(
      'pty-no-color-invalid',
      noColorFailures.map((failure) => context.assert.diagnostic(failure)),
    );
  }
  // 3. --json stays pure + non-interactive under a TTY.
  const json = await runCli(context, {
    args: ['fit', '--json', '--check', 'no-console-log'],
    pty: true,
  });
  const jsonFailures = evaluatePtyFindingResult(json, 'json');
  if (jsonFailures.length > 0) {
    return fail(
      'pty-json-invalid',
      jsonFailures.map((failure) => context.assert.diagnostic(failure)),
    );
  }
  const canonical = assertCommand(context, json, FIT_ENVELOPE_EXPECT, 'pty-json-invalid');
  if (canonical.status !== 'pass') return canonical;
  return pass();
};

const signalsExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  try {
    seedSignalProject(context.paths.workRoot);
  } catch (error) {
    return fail('signal-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  const init = await runCli(context, {
    args: ['init', '--language', 'typescript', '--json'],
  });
  const initPayload = readJson(init);
  if (
    init.timedOut ||
    (init.status ?? 1) !== 0 ||
    !initPayload.ok ||
    initPayload.value?.kind !== 'init' ||
    initPayload.value?.status !== 'ok'
  ) {
    return fail('signal-setup-failed', [
      context.assert.diagnostic('could not initialize the signal fixture'),
    ]);
  }

  for (const probe of [
    { signal: 'SIGINT', pty: true },
    { signal: 'SIGTERM', pty: false },
  ]) {
    const result = await runCli(context, {
      args: ['graph', '--json'],
      timeoutMs: NATIVE_SIGNAL_TIMEOUT_MS,
      nativeSignal: { signal: probe.signal, afterMs: NATIVE_SIGNAL_AFTER_MS },
      pty: probe.pty,
    });
    const failures = evaluateNativeSignalResult(result, probe.signal, NATIVE_SIGNAL_TIMEOUT_MS);
    if (failures.length > 0) {
      return fail(
        'native-signal-shutdown-failed',
        failures.map((message) => context.assert.diagnostic(message)),
      );
    }
  }

  // Reusable state: a fresh datastore read after both signals still succeeds.
  const rerun = await runCli(context, { args: ['sessions', 'list', '--json'] });
  const replay = readJson(rerun);
  if (
    rerun.timedOut ||
    (rerun.status ?? 1) !== 0 ||
    rerun.cleanup.residualDescendants !== 0 ||
    !replay.ok ||
    replay.value?.kind !== 'history' ||
    replay.value?.status !== 'ok' ||
    !Array.isArray(replay.value?.data?.sessions)
  ) {
    return fail('state-not-reusable', [
      context.assert.diagnostic(`post-signal sessions list exited ${rerun.status}`),
    ]);
  }

  // Reusable terminal: a fresh PTY can still launch, render, and close cleanly.
  const terminal = await runCli(context, { args: ['--version'], pty: true });
  const version = context.installed?.resolvedVersion ?? '';
  if (
    terminal.timedOut ||
    (terminal.status ?? 1) !== 0 ||
    terminal.cleanup.residualDescendants !== 0 ||
    terminal.stdoutCapture.trim().length === 0 ||
    (version.length > 0 && !terminal.stdoutCapture.includes(version))
  ) {
    return fail('terminal-not-reusable', [
      context.assert.diagnostic(`post-signal PTY version exited ${terminal.status}`),
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
  const initialized = await runCli(context, {
    args: ['init', '--language', 'typescript', '--json'],
  });
  if (initialized.timedOut || (initialized.status ?? 1) !== 0) {
    return fail('browser-open-init-failed', [
      context.assert.diagnostic('could not initialize the browser-open fixture'),
      context.assert.diagnostic(initialized.stderrTail),
    ]);
  }
  const seedRun = await runCli(context, { args: ['graph', '--json'] });
  const seedResult = evaluateBrowserCommandResult(seedRun, 'seed');
  if (!seedResult.ok) {
    const message = seedRun.timedOut
      ? 'seed graph run timed out'
      : `seed graph run exited ${seedRun.status}`;
    return fail(seedResult.reasonCode, [context.assert.diagnostic(message)]);
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
    // `report` opens by default. The public opt-out is `--no-open`; there is no
    // positive `--open` flag.
    args: ['report'],
    pty: true,
    // Prepend the shim; unset CI (empty is falsy) only for this child so the
    // launcher actually attempts to open under the PTY.
    env: { PATH: `${shimBin}:${nodeBinDir}:/usr/bin:/bin`, CI: '' },
  });
  const reportResult = evaluateBrowserCommandResult(result, 'report');
  if (!reportResult.ok) {
    const message = result.timedOut ? 'report timed out' : `report exited ${result.status}`;
    return fail(reportResult.reasonCode, [context.assert.diagnostic(message)]);
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
      context.assert.diagnostic('report did not resolve the run-owned open shim'),
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
    context.assert.diagnostic('report resolved exactly one safe generated file via the shim'),
  ]);
};

const nativeSqliteExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  // A completely empty directory is intentionally not treated as a project.
  // Seed a recognizable source tree so this clean-install probe exercises the
  // customer-facing zero-init cache path before loading the native binding.
  try {
    seedIdentifiedProject(context.paths.workRoot);
  } catch (error) {
    return fail('native-sqlite-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
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

  const probeRun = await runProcess(context, [
    process.execPath,
    '-e',
    NATIVE_SQLITE_PROBE_SOURCE,
    realScript,
  ]);
  if (probeRun.timedOut) {
    return fail('timed-out', [context.assert.diagnostic('native SQLite probe timed out')]);
  }
  if ((probeRun.status ?? 1) !== 0) {
    return fail('native-sqlite-probe-failed', [
      context.assert.diagnostic(`native SQLite probe exited ${probeRun.status}`),
    ]);
  }
  const parsed = readJson(probeRun);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
    return fail('native-sqlite-probe-invalid', [
      context.assert.diagnostic('native SQLite probe did not return valid JSON'),
    ]);
  }

  const probe = parsed.value;
  const resolved = {
    installedEntrypoint: realScript,
    queryOk: probe.ok === true,
  };
  for (const field of ['datastoreEntrypoint', 'sqliteEntrypoint', 'nativeAddon']) {
    if (typeof probe[field] !== 'string') {
      return fail('native-sqlite-probe-invalid', [
        context.assert.diagnostic(`native SQLite probe omitted ${field}`),
      ]);
    }
    try {
      resolved[field] = realpathSync(probe[field]);
    } catch {
      return fail('native-sqlite-provenance-invalid', [
        context.assert.diagnostic(`native SQLite probe returned an unreadable ${field}`),
      ]);
    }
  }
  const provenance = evaluateNativeSqliteProvenance(resolved);
  if (!provenance.ok) {
    return fail(provenance.reasonCode, [
      context.assert.diagnostic('native SQLite resolved outside the isolated install tree'),
    ]);
  }
  return pass([
    context.assert.diagnostic(
      'better-sqlite3 loaded its native addon from the isolated install dependency tree',
    ),
  ]);
};

const contentionRecoveryExecutor = async (context) => {
  const gate = requireDarwin(context);
  if (gate) return gate;
  try {
    seedProject(context.paths.workRoot);
  } catch (error) {
    return fail('contention-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  const initialized = await initProject(context, context.paths.workRoot);
  if (!initialized.ok) return initialized.outcome;
  const contention = await runSqliteContentionProbe(context, context.paths.workRoot);
  if (contention.status !== 'pass') return contention;
  const interrupted = await runInterruptedSqliteProbe(context, context.paths.workRoot);
  if (interrupted.status !== 'pass') return interrupted;
  return pass([...contention.diagnostics, ...interrupted.diagnostics]);
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
      {
        label: 'assert the lifecycle target was installed through scripts/install.sh',
      },
      {
        label: 'invoke the lifecycle-owned installed descriptor',
      },
      {
        label: 'assert the exact candidate version under measured execution',
      },
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
      { label: 'run the contained shim and assert the candidate version' },
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
      {
        label: 'seed spaces + precomposed + decomposed + symlinked project roots',
      },
      {
        label: 'run fit --json from each and prove containment under the physical run root',
      },
    ],
    executor: pathSemanticsExecutor,
  }),
  defineJourney({
    id: 'macos.permissions',
    category: 'macos',
    value: {
      human: 'Fails cleanly on permission denied',
      agent:
        'denied config and runtime targets return structured actionable errors without partial state',
    },
    capabilities: ['permissions'],
    isolated: true,
    steps: [
      {
        label: 'deny the project config target and require an actionable JSON error',
      },
      {
        label: 'deny the initialized runtime target and require an actionable JSON error',
      },
      { label: 'assert neither denial leaves partial config/runtime state' },
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
      {
        label: 'run fit under a PTY and require exit 1, output, and zero descendants',
      },
      { label: 'require NO_COLOR exit 1 with no escapes' },
      { label: 'require --json exit 1 with the canonical pure fit envelope' },
    ],
    executor: ptyHumanViewExecutor,
  }),
  defineJourney({
    id: 'macos.signals',
    category: 'macos',
    value: {
      human: 'Handles terminal interrupts cleanly and stays reusable',
      agent:
        'exact SIGINT (PTY) and SIGTERM forwarding exit boundedly with no descendants; state and terminal reuse succeed',
    },
    isolated: true,
    steps: [
      { label: 'forward SIGINT through a PTY and SIGTERM without a PTY' },
      {
        label: 'require exact signal identity, bounded exit, and zero descendants',
      },
      { label: 'require fresh datastore and PTY version commands to succeed' },
    ],
    executor: signalsExecutor,
  }),
  defineJourney({
    id: 'macos.browser-open',
    category: 'macos',
    value: {
      human: 'Never opens a stray browser',
      agent: 'report resolves exactly one safe generated file through a capture shim',
    },
    capabilities: ['pty'],
    isolated: true,
    steps: [
      { label: 'probe /usr/bin/open availability without launching a GUI' },
      {
        label: 'intercept the default report open with a run-owned shim under a PTY',
      },
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
      {
        label: 'seed a recognizable zero-init project and open its cached store',
      },
      {
        label: 'assert the entrypoint resolves outside the workspace checkout',
      },
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
