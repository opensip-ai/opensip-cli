/**
 * @fileoverview Linux-specific native journeys (Plan 12 — Linux qualification).
 *
 * These journeys close the gap between the common installed-artifact profile and
 * the exact Ubuntu 24.04 / x86_64 / Node 24 (ABI 137) / npm 11 / ext4 support
 * tuple. They add Linux-native probes the common journeys cannot express:
 *   - `linux.tuple-crosscheck` — /etc/os-release + uname + Node/npm sources agree
 *     on the ubuntu support tuple (via the generalized `assessHostSupport`).
 *   - `linux.native-sqlite` — the glibc-linked `better-sqlite3` x64 prebuild
 *     loads from the isolated install tree, not the workspace (the DART ask).
 *   - `linux.case-sensitivity` — the run root is case-SENSITIVE, inverting the
 *     macOS APFS case-insensitive expectation.
 *
 * Hard invariants (mirroring the sibling domain modules):
 *   - An executor reads ONLY its injected context. Every child runs through
 *     `ctx.process.run` / `runCli` as an argv array — never `shell: true`, never
 *     a discovered binary. Fixed absolute system utility paths are journey-authored.
 *   - On a non-Linux host every Linux journey returns `unavailable` WITHOUT
 *     spawning anything — it never throws and never false-passes, so
 *     `pnpm test:scripts` stays green on any host. The executors are REAL: on a
 *     matching Linux host they run against the installed candidate.
 *   - Outcomes are bounded and redacted: diagnostics carry booleans, counts, and
 *     closed reason phrases, never absolute host paths or child output dumps.
 *   - The support-row classification is delegated to the built core policy
 *     (`assessHostSupport`) via a LAZY dynamic import, so the acceptance harness
 *     stays dependency-free at module load. A missing/unbuilt core is a
 *     fail-closed `unavailable`, never a silent pass.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  loadAssessHostSupport,
  pass,
  probeValue,
  readJson,
  runCli,
  unavailable,
} from '../journey-kit.mjs';
import { seedProject } from '../seed-fit-project.mjs';

import { evaluateNativeSqliteProvenance, normalizeUnameArch } from './macos.mjs';

// ---------------------------------------------------------------------------
// Constants + tiny pure helpers
// ---------------------------------------------------------------------------

/** The stable support-row id the ubuntu acceptance profile binds. */
export const UBUNTU_PREVIEW_ROW_ID = 'ubuntu-2404-x64-node24-npm11-v1';

const HERE = fileURLToPath(import.meta.url);
// journeys → platform-acceptance → scripts → repo root.
const REPO_ROOT = dirname(dirname(dirname(dirname(HERE))));

const UNAME = '/usr/bin/uname';
const OS_RELEASE = '/etc/os-release';

/** A fit run that flags exactly the seeded `no-console-log` finding (error → exit 1). */
const FIT_ENVELOPE_EXPECT = { exitCode: 1, json: expectEnvelope({ tool: 'fit' }) };

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

/** True when `target` is `root` itself or a strict descendant of `root`. */
function isUnder(root, target) {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Read `VERSION_ID` from `/etc/os-release` (bounded, secret-free), or null. */
function readOsReleaseVersionId() {
  try {
    const raw = readFileSync(OS_RELEASE, 'utf8');
    if (raw.length > 8192) return null;
    for (const line of raw.split('\n')) {
      const match = line.match(/^VERSION_ID="?(\d+(?:\.\d+)*)"?$/u);
      if (match) return match[1];
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/** Map cross-checked Linux tuple facts to a core `ObservedHost` (absent = unobserved). */
export function buildLinuxObservedHost(facts) {
  const observed = { osPlatform: 'linux' };
  if (facts.osVersion != null) observed.osVersion = facts.osVersion;
  if (facts.kernelName != null) observed.kernelName = facts.kernelName;
  if (facts.kernelRelease != null) observed.kernelRelease = facts.kernelRelease;
  if (facts.nodeArch != null) observed.arch = facts.nodeArch;
  if (facts.nodeVersion != null) observed.nodeVersion = facts.nodeVersion;
  if (facts.nodeAbi != null) observed.nodeAbi = facts.nodeAbi;
  if (facts.npmVersion != null) observed.npmVersion = facts.npmVersion;
  return observed;
}

/**
 * Pure cross-check of the independent Linux tuple sources against the core
 * support policy. Contradictory sources fail EVEN IF one alone would match. A
 * required source that is unobservable is a failure, never a silent pass.
 *
 * @param {object} facts       normalized sources (or null when unavailable).
 * @param {(observed: object) => { row?: {id: string}, status: string, reasonCodes: readonly string[] }} assessHostSupport
 * @returns {{ ok: boolean, reasonCode: string | null, lines: string[] }}
 */
export function evaluateLinuxTupleCrosscheck(facts, assessHostSupport) {
  const lines = [];
  const record = (source, value) =>
    lines.push(`${source}=${value == null ? 'unavailable' : String(value)}`);
  record('os-release.VERSION_ID', facts.osVersion);
  record('uname.kernelName', facts.kernelName);
  record('uname.kernelRelease', facts.kernelRelease);
  record('uname.machine', facts.unameMachine);
  record('process.arch', facts.nodeArch);
  record('process.version', facts.nodeVersion);
  record('process.versions.modules', facts.nodeAbi);
  record('npm.version', facts.npmVersion);

  const missing = [];
  if (facts.osVersion == null) missing.push('os-release');
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

  const assessment = assessHostSupport(buildLinuxObservedHost(facts));
  if (assessment.reasonCodes.length > 0) {
    return {
      ok: false,
      reasonCode: 'tuple-not-supported-row',
      lines: [...lines, `contradictions: ${assessment.reasonCodes.join(', ')}`],
    };
  }
  if (assessment.row == null || assessment.row.id !== UBUNTU_PREVIEW_ROW_ID) {
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

/** Non-Linux guard: every Linux journey short-circuits here on any other host. */
function requireLinux(context) {
  if (process.platform === 'linux') return null;
  return unavailable('non-linux-host', [
    context.assert.diagnostic(`Linux journey is not applicable on ${process.platform}`),
  ]);
}

/** Run one fixed argv through the port with optional cwd override. */
function runProcess(context, argv, options = {}) {
  return context.process.run({ argv, cwd: options.cwd ?? context.paths.workRoot });
}

function seedIdentifiedProject(dir) {
  seedProject(dir);
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'opensip-linux-acceptance', private: true, type: 'module' }, null, 2)}\n`,
  );
}

/** True when the run root reports case-SENSITIVE behavior (mutates only run-owned paths). */
function probeCaseSensitive(root) {
  const dir = mkdtempSync(join(root, 'linux-fs-'));
  try {
    const upper = join(dir, 'CaseProbe');
    const lower = join(dir, 'caseprobe');
    writeFileSync(upper, 'x');
    // Case-sensitive filesystem: the lower-cased path does NOT resolve.
    return !existsSync(lower);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the run-owned root cleanup removes any residue */
    }
  }
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

const tupleCrosscheckExecutor = async (context) => {
  const gate = requireLinux(context);
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
    osVersion: readOsReleaseVersionId(),
    kernelName: await probeValue(context, [UNAME, '-s']),
    kernelRelease: await probeValue(context, [UNAME, '-r']),
    unameMachine: await probeValue(context, [UNAME, '-m']),
    npmVersion: await probeValue(context, [...npmArgv, '--version']),
    nodeArch: process.arch,
    nodeVersion: process.version,
    nodeAbi: String(process.versions.modules),
  };
  const verdict = evaluateLinuxTupleCrosscheck(facts, assessHostSupport);
  const diagnostics = verdict.lines.map((line) => context.assert.diagnostic(line));
  return verdict.ok ? pass(diagnostics) : fail(verdict.reasonCode, diagnostics);
};

const nativeSqliteExecutor = async (context) => {
  const gate = requireLinux(context);
  if (gate) return gate;
  // Seed a recognizable source tree so this clean-install probe exercises the
  // customer-facing zero-init cache path before loading the native binding.
  try {
    seedIdentifiedProject(context.paths.workRoot);
  } catch (error) {
    return fail('native-sqlite-setup-failed', [context.assert.diagnostic(errText(error))]);
  }
  // The native better-sqlite3 binding (Node ABI 137, glibc x64) must load from a clean install.
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
  const resolved = { installedEntrypoint: realScript, queryOk: probe.ok === true };
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
      'better-sqlite3 loaded its glibc x64 native addon from the isolated install dependency tree',
    ),
  ]);
};

const caseSensitivityExecutor = async (context) => {
  const gate = requireLinux(context);
  if (gate) return gate;
  let caseSensitive;
  try {
    caseSensitive = probeCaseSensitive(context.paths.workRoot);
  } catch (error) {
    return fail('filesystem-case-probe-failed', [context.assert.diagnostic(errText(error))]);
  }
  const line = context.assert.diagnostic(`case-sensitive=${caseSensitive}`);
  if (caseSensitive !== true) {
    return fail('filesystem-case-insensitive', [
      line,
      context.assert.diagnostic('the run root is case-insensitive (outside the supported tuple)'),
    ]);
  }
  // Two projects differing only by case must resolve as distinct roots.
  const lower = join(context.paths.workRoot, 'case-project');
  const upper = join(context.paths.workRoot, 'Case-Project');
  try {
    seedProject(lower);
    seedProject(upper);
  } catch (error) {
    return fail('filesystem-case-setup-failed', [line, context.assert.diagnostic(errText(error))]);
  }
  for (const dir of [lower, upper]) {
    const result = await runCli(context, {
      args: ['fit', '--json', '--check', 'no-console-log'],
      cwd: dir,
    });
    const outcome = assertCommand(
      context,
      result,
      FIT_ENVELOPE_EXPECT,
      'case-distinct-project-failed',
    );
    if (outcome.status !== 'pass') return outcome;
  }
  return pass([
    line,
    context.assert.diagnostic('case-only-distinct project roots resolved cleanly'),
  ]);
};

// ---------------------------------------------------------------------------
// Registry contribution
// ---------------------------------------------------------------------------

export const linuxJourneys = assertUniqueJourneyIds([
  defineJourney({
    id: 'linux.tuple-crosscheck',
    category: 'linux',
    value: {
      human: 'Runs on the exact supported Ubuntu host',
      agent: 'os-release/uname/Node/npm sources agree on the Ubuntu 24.04 x64 support tuple',
    },
    isolated: true,
    steps: [
      { label: 'probe /etc/os-release VERSION_ID, uname -s/-r/-m, and npm' },
      { label: 'cross-check against process.arch/version/ABI' },
      { label: 'assess the support-row selection (contradictions fail)' },
    ],
    executor: tupleCrosscheckExecutor,
  }),
  defineJourney({
    id: 'linux.native-sqlite',
    category: 'linux',
    value: {
      human: 'The data store opens on x86_64 Linux',
      agent: 'the glibc-linked better-sqlite3 x64 binding loads from the isolated install',
    },
    isolated: true,
    steps: [
      { label: 'seed a recognizable zero-init project and open its cached store' },
      { label: 'assert the entrypoint resolves outside the workspace checkout' },
      { label: 'load the native addon in a child and prove install-tree provenance' },
    ],
    executor: nativeSqliteExecutor,
  }),
  defineJourney({
    id: 'linux.case-sensitivity',
    category: 'linux',
    value: {
      human: 'Works on a case-sensitive filesystem',
      agent: 'the run root is case-sensitive and case-only-distinct projects resolve separately',
    },
    isolated: true,
    steps: [
      { label: 'probe case behavior with run-owned names' },
      { label: 'run fit --json from two case-only-distinct project roots' },
    ],
    executor: caseSensitivityExecutor,
  }),
]);
