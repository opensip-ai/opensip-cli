/**
 * @fileoverview The platform-acceptance journey orchestrator — an explicit state
 * machine over the closed stage vocabulary that drives the Phase 0–2 modules and
 * returns a complete, contract-shaped evidence model plus an exit classification.
 *
 * Flow (a closed stage machine):
 *   preflight → candidate-resolve → install → journey* → upgrade → state-remove →
 *   package-remove → cleanup → finalize
 *
 * Invariants:
 *   - Journeys run in PROFILE ORDER. Shared-state journeys reuse one primary
 *     project root serially; `isolated` journeys get a fresh, journey-owned root.
 *     (Phase 3 runs serially; distinct roots keep future bounded parallelism open.)
 *   - Every declared journey produces exactly one `JourneyResult`; a missing
 *     capability, a stopped run, or an invalid executor result is an explicit
 *     `unavailable`/`fail` row, never a dropped one.
 *   - An ordinary journey `fail` does NOT stop the run; candidate loss, root
 *     escape, evidence-bound exhaustion, cleanup-integrity failure, and caller
 *     cancellation DO — remaining journeys become `unavailable` with a causal reason.
 *   - Every effect seam is injectable (clock, fs, host collector, candidate
 *     lifecycle, process port, mcp connector, journey registry, fixture packer).
 *   - The stage stream is the ONLY observability plane — no OTel, no OpenSIP
 *     logger, no generic sessions.
 *
 * The evidence model returned here is the sealed body WITHOUT the terminal
 * `completion` record; `evidence-writer.mjs` seals + writes it atomically.
 *
 * @typedef {import('./contract.d.mts').AcceptanceProfile} AcceptanceProfile
 * @typedef {import('./contract.d.mts').JourneyResult} JourneyResult
 * @typedef {import('./contract.d.mts').CleanupResult} CleanupResult
 * @typedef {import('./journey-catalog.d.mts').JourneyExecutorContext} JourneyExecutorContext
 * @typedef {import('./journey-catalog.d.mts').InstalledCandidateView} InstalledCandidateView
 */

import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  mkdtempSync as realMkdtempSync,
  readFileSync as realReadFileSync,
  realpathSync as realRealpathSync,
  rmSync as realRmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { boundedDiagnostic, checkScenario, expectEnvelope } from '../cli-acceptance-core.mjs';
import { createMeasuredProcessPort } from '../lib/measured-process.mjs';
import { CandidateLifecycle } from './candidate-lifecycle.mjs';
import {
  computeSummary,
  computeVerdict,
  parseAcceptanceProfile,
  PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
  profileDigest,
} from './contract.mjs';
import { collectHostProfile as realCollectHostProfile } from './host-profile.mjs';
import { packFixtures as realPackFixtures } from './fixture-packages.mjs';
import { JOURNEY_REGISTRY, resolveProfileJourneys } from './journey-catalog.mjs';
import { createDefaultMcpConnector } from './mcp-connector.mjs';
import { resolveCandidateSource as realResolveCandidateSource } from './candidate-source.mjs';

/** The closed stage vocabulary for the harness observability plane. */
export const ACCEPTANCE_STAGES = Object.freeze({
  PREFLIGHT: 'preflight',
  CANDIDATE_RESOLVE: 'candidate-resolve',
  INSTALL: 'install',
  JOURNEY: 'journey',
  UPGRADE: 'upgrade',
  STATE_REMOVE: 'state-remove',
  PACKAGE_REMOVE: 'package-remove',
  CLEANUP: 'cleanup',
  FINALIZE: 'finalize',
});

/** The terminal outcome kinds the entry point maps to exit codes. */
export const RUN_OUTCOMES = Object.freeze({
  COMPLETED: 'completed',
  INFRASTRUCTURE_FAULT: 'infrastructure-fault',
  INVALID_INVOCATION: 'invalid-invocation',
});

/** Closed runner-level reason codes (kebab-case; distinct from journey/candidate codes). */
export const RUNNER_REASON_CODES = Object.freeze({
  PROFILE_NOT_FOUND: 'profile-not-found',
  PROFILE_INVALID: 'profile-invalid',
  CANDIDATE_INVALID: 'candidate-invalid',
  RUN_ROOT_FAILED: 'run-root-failed',
  HOST_COLLECTION_FAILED: 'host-collection-failed',
  CANDIDATE_INSTALL_FAILED: 'candidate-install-failed',
  CANDIDATE_UNAVAILABLE: 'candidate-unavailable',
  CANDIDATE_LOST: 'candidate-lost',
  ROOT_ESCAPE: 'root-escape',
  EVIDENCE_BOUND_EXHAUSTED: 'evidence-bound-exhausted',
  CLEANUP_INTEGRITY_FAILED: 'cleanup-integrity-failed',
  RUN_CANCELLED: 'run-cancelled',
  FIXTURES_UNAVAILABLE: 'fixtures-unavailable',
  EXECUTOR_INVALID_RESULT: 'executor-invalid-result',
  JOURNEY_THREW: 'journey-threw',
});

const JOURNEY_STATUSES = new Set(['pass', 'fail', 'skipped', 'unavailable']);
const KEBAB_REASON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// Contract-safe bounds mirrored locally so a runner-built row never trips the
// evidence parser.
const MAX_DIAGNOSTICS_PER_JOURNEY = 64;
const MAX_DIAGNOSTIC_LENGTH = 4096;
const PER_RESULT_EVIDENCE_OVERHEAD = 256;

const R = RUNNER_REASON_CODES;
const S = ACCEPTANCE_STAGES;

/** Lifecycle-driven ids → their stage + transition. */
const LIFECYCLE_STAGE_BY_ID = Object.freeze({
  'lifecycle.install': S.INSTALL,
  'lifecycle.upgrade': S.UPGRADE,
  'lifecycle.cli-state-uninstall': S.STATE_REMOVE,
  'lifecycle.package-uninstall': S.PACKAGE_REMOVE,
});

function defaultClock() {
  const origin = Date.now();
  const originHr = process.hrtime.bigint();
  return {
    now() {
      return Number(process.hrtime.bigint() - originHr) / 1e6;
    },
    wallIso() {
      return new Date().toISOString();
    },
    // Only used for the artifact's ISO timestamps; monotonic `now()` drives durations.
    wallOrigin() {
      return origin;
    },
  };
}

function defaultFs() {
  return {
    mkdtempSync: realMkdtempSync,
    mkdirSync: realMkdirSync,
    existsSync: realExistsSync,
    realpathSync: realRealpathSync,
    rmSync: realRmSync,
  };
}

/** True when `target` is `root` itself or a strict descendant of `root`. */
function isUnderOrEqual(root, target) {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Bound + control-strip a diagnostics array to the contract limits. */
function boundDiagnostics(diagnostics, maxTailBytes) {
  const out = [];
  for (const entry of diagnostics ?? []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const bounded = boundedDiagnostic(entry, Math.min(maxTailBytes, MAX_DIAGNOSTIC_LENGTH));
    if (bounded.length === 0) continue;
    out.push(bounded);
    if (out.length >= MAX_DIAGNOSTICS_PER_JOURNEY) break;
  }
  return Object.freeze(out);
}

function safeReason(reasonCode) {
  return typeof reasonCode === 'string' && KEBAB_REASON.test(reasonCode) ? reasonCode : null;
}

/** Sanitize a journey id into a filesystem-safe directory segment. */
function journeyDirName(id) {
  return id.replace(/[^a-z0-9]+/gi, '-');
}

/**
 * Orchestrate one platform-acceptance run.
 *
 * @param {object} options
 * @param {string} options.profilePath        path to a data-only acceptance profile JSON.
 * @param {object} options.candidate          `{ primary, previous? }` raw candidate-source inputs.
 * @param {string} options.repoRoot           absolute repository root (for fixtures).
 * @param {string} options.harnessGitSha      the harness commit sha for the evidence.
 * @param {AbortSignal} [options.signal]       runner-level cancellation signal.
 * @param {object} [deps]                      injectable effect seams (see file header).
 * @returns {Promise<object>} `{ outcome, reasonCode, message, evidence, verdict, completionState, runRoot, progress }`
 */
export async function runPlatformAcceptance(options, deps = {}) {
  const clock = deps.clock ?? defaultClock();
  const fs = deps.fs ?? defaultFs();
  const collectHostProfile = deps.collectHostProfile ?? realCollectHostProfile;
  const resolveCandidateSource = deps.resolveCandidateSource ?? realResolveCandidateSource;
  const createLifecycle = deps.createLifecycle ?? ((opts) => new CandidateLifecycle(opts));
  const registry = deps.journeyRegistry ?? JOURNEY_REGISTRY;
  const createProcessPort = deps.createProcessPort ?? createMeasuredProcessPort;
  const createMcpConnector = deps.createMcpConnector ?? createDefaultMcpConnector;
  const packFixtures = deps.packFixtures ?? realPackFixtures;
  const readProfile = deps.readProfile ?? realReadProfile;
  const platform = deps.platform ?? process.platform;

  const progress = [];
  const emit = (stage, detail = {}) => {
    const event = Object.freeze({
      stage,
      reasonCode: safeReason(detail.reasonCode),
      durationMs:
        typeof detail.durationMs === 'number' ? Math.max(0, Math.round(detail.durationMs)) : 0,
      id: typeof detail.id === 'string' ? detail.id : null,
      rss: detail.rss ?? null,
    });
    progress.push(event);
    try {
      deps.onProgress?.(event);
    } catch {
      /* progress observation must never break the run */
    }
    return event;
  };

  const startedAtIso = clock.wallIso();
  const runStart = clock.now();

  // --- preflight: profile ------------------------------------------------
  const profileResult = loadProfile(readProfile, options.profilePath);
  if (!profileResult.ok) {
    emit(S.PREFLIGHT, { reasonCode: profileResult.reasonCode });
    return invalidInvocation(profileResult.reasonCode, profileResult.message, progress);
  }
  const profile = profileResult.profile;

  // --- candidate-resolve -------------------------------------------------
  const candidateStart = clock.now();
  const primary = await resolveCandidateSource(options.candidate?.primary);
  if (!primary || primary.ok !== true) {
    emit(S.CANDIDATE_RESOLVE, { reasonCode: R.CANDIDATE_INVALID });
    return invalidInvocation(
      R.CANDIDATE_INVALID,
      redactMessage(
        `primary candidate: ${primary?.reasonCode ?? 'unknown'}: ${primary?.message ?? ''}`,
      ),
      progress,
    );
  }
  let previous = null;
  if (options.candidate?.previous !== undefined) {
    previous = await resolveCandidateSource(options.candidate.previous);
    if (!previous || previous.ok !== true) {
      emit(S.CANDIDATE_RESOLVE, { reasonCode: R.CANDIDATE_INVALID });
      return invalidInvocation(
        R.CANDIDATE_INVALID,
        redactMessage(
          `previous candidate: ${previous?.reasonCode ?? 'unknown'}: ${previous?.message ?? ''}`,
        ),
        progress,
      );
    }
  }
  // Install the older candidate first (when supplied) and upgrade TO the primary;
  // otherwise install the primary and prove reinstall migration against itself.
  const installResolved = previous ?? primary;
  const upgradeResolved = primary;
  emit(S.CANDIDATE_RESOLVE, { durationMs: clock.now() - candidateStart });

  // --- preflight: run root + host ---------------------------------------
  let runRoot;
  try {
    runRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'opensip-acceptance-')));
  } catch (error) {
    emit(S.PREFLIGHT, { reasonCode: R.RUN_ROOT_FAILED });
    // No run root ⇒ no host profile ⇒ no trustworthy evidence body.
    return infrastructureFault(
      R.RUN_ROOT_FAILED,
      redactError(error),
      null,
      progress,
      profile.bounds.maxEvidenceBytes,
    );
  }

  const state = {
    options,
    profile,
    platform,
    clock,
    fs,
    runRoot,
    createProcessPort,
    createMcpConnector,
    registry,
    emit,
    bounds: profile.bounds,
    results: [],
    seenIds: new Set(),
    stopped: null,
    infraReason: null,
    evidenceBytes: 0,
    lifecycle: null,
    installedView: null,
    fixturesView: null,
    mcpConnector: null,
    representativeCreated: false,
    sharedWorkRoot: null,
    candidate: primary.identity,
  };

  let host;
  try {
    const hostStart = clock.now();
    host = collectHostProfile(runRoot, [...profile.requiredCapabilities]);
    emit(S.PREFLIGHT, { durationMs: clock.now() - hostStart });
  } catch (error) {
    emit(S.PREFLIGHT, { reasonCode: R.HOST_COLLECTION_FAILED });
    bestEffortRemove(fs, runRoot, runRoot);
    return infrastructureFault(
      R.HOST_COLLECTION_FAILED,
      redactError(error),
      null,
      progress,
      profile.bounds.maxEvidenceBytes,
    );
  }
  state.host = host;

  // --- install the candidate + pack fixtures ----------------------------
  // The lifecycle constructor requires its run root to already exist.
  const candidateRoot = join(runRoot, 'candidate');
  ensureDir(fs, candidateRoot);
  let lifecycle;
  try {
    lifecycle = createLifecycle({
      runRoot: candidateRoot,
      platform,
      bounds: {
        maxDiagnosticTailBytes: profile.bounds.maxDiagnosticTailBytes,
      },
    });
  } catch (error) {
    emit(S.INSTALL, { reasonCode: R.CANDIDATE_INSTALL_FAILED });
    bestEffortRemove(fs, runRoot, runRoot);
    return infrastructureFault(
      R.CANDIDATE_INSTALL_FAILED,
      redactError(error),
      null,
      progress,
      profile.bounds.maxEvidenceBytes,
    );
  }
  state.lifecycle = lifecycle;

  const journeys = resolveProfileJourneys(
    profile.journeys.map((selection) => selection.id),
    state.registry,
  );
  const requiredById = new Map(
    profile.journeys.map((selection) => [selection.id, selection.required]),
  );
  const capabilitiesById = new Map(
    profile.journeys.map((selection) => [selection.id, selection.capabilities ?? []]),
  );

  state.fixturesView = tryPackFixtures(packFixtures, {
    repoRoot: options.repoRoot,
    runRoot,
    fs,
    env: lifecycle.childEnv(),
    platform,
  });

  // --- execute journeys in profile order --------------------------------
  for (const journey of journeys) {
    const required = requiredById.get(journey.id) === true;
    const declaredCapabilities = capabilitiesById.get(journey.id) ?? [];
    const result = await runOneJourney(state, journey, {
      required,
      declaredCapabilities,
      installResolved,
      upgradeResolved,
    });
    appendResult(state, result);
  }

  // --- cleanup -----------------------------------------------------------
  const cleanupStart = clock.now();
  const cleanup = finalizeCleanup(state);
  emit(S.CLEANUP, {
    durationMs: clock.now() - cleanupStart,
    reasonCode: cleanup.reasonCode ?? undefined,
  });

  // --- finalize ----------------------------------------------------------
  const finalizeStart = clock.now();
  const completedAtIso = isoAtLeast(clock.wallIso(), startedAtIso);
  const summary = computeSummary(profile, state.results);
  let verdict;
  let completionState;
  let outcome;
  if (state.infraReason) {
    verdict = 'infrastructure-fault';
    completionState = 'infrastructure-fault';
    outcome = RUN_OUTCOMES.INFRASTRUCTURE_FAULT;
  } else {
    verdict = computeVerdict(profile, state.results, cleanup);
    completionState = 'completed';
    outcome = RUN_OUTCOMES.COMPLETED;
  }

  const evidence = Object.freeze({
    schemaVersion: PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
    profile: Object.freeze({
      id: profile.id,
      version: profile.version,
      digest: profileResult.digest,
    }),
    // The candidate under qualification is always the PRIMARY (target) candidate,
    // even on the `--previous-version` upgrade path where a failed upgrade leaves
    // the previous version on disk: the run's purpose is to qualify the primary
    // bytes, and a failed required upgrade already forces a non-pass verdict (and
    // an `--expected-version` mismatch in the verifier). The actually-installed
    // version at each step is evidenced by the lifecycle install/upgrade journeys.
    candidate: primary.identity,
    harnessGitSha: options.harnessGitSha,
    startedAt: startedAtIso,
    completedAt: completedAtIso,
    host,
    results: Object.freeze([...state.results]),
    cleanup,
    summary,
    verdict,
  });
  emit(S.FINALIZE, { durationMs: clock.now() - finalizeStart });
  emit(S.FINALIZE, {
    durationMs: clock.now() - runStart,
    reasonCode: state.infraReason ?? undefined,
  });

  return Object.freeze({
    outcome,
    reasonCode: state.infraReason ?? null,
    message: null,
    evidence,
    verdict,
    completionState,
    runRoot,
    maxEvidenceBytes: profile.bounds.maxEvidenceBytes,
    progress: Object.freeze([...progress]),
  });
}

// ---------------------------------------------------------------------------
// Per-journey execution
// ---------------------------------------------------------------------------

async function runOneJourney(state, journey, params) {
  const { emit, clock } = state;
  const stage = LIFECYCLE_STAGE_BY_ID[journey.id] ?? S.JOURNEY;
  const start = clock.now();

  // A stopped run marks every remaining journey unavailable with the causal reason.
  if (state.stopped) {
    const result = makeResult(state, journey, params.required, {
      status: 'unavailable',
      reasonCode: state.stopped.reasonCode,
      diagnostics: [`run stopped: ${state.stopped.reasonCode}`],
      durationMs: 0,
    });
    emit(stage, { id: journey.id, reasonCode: state.stopped.reasonCode, durationMs: 0 });
    return result;
  }

  // Caller cancellation: propagate as a hard stop.
  if (state.options.signal?.aborted) {
    state.infraReason = R.RUN_CANCELLED;
    state.stopped = { reasonCode: R.RUN_CANCELLED };
    const result = makeResult(state, journey, params.required, {
      status: 'unavailable',
      reasonCode: R.RUN_CANCELLED,
      diagnostics: ['run cancelled before journey started'],
      durationMs: 0,
    });
    emit(stage, { id: journey.id, reasonCode: R.RUN_CANCELLED, durationMs: 0 });
    return result;
  }

  let result;
  if (LIFECYCLE_STAGE_BY_ID[journey.id] === undefined) {
    result = await runExecutorJourney(state, journey, params);
  } else {
    result = runLifecycleJourney(state, journey, params);
  }

  emit(stage, {
    id: journey.id,
    reasonCode: result.reasonCode ?? undefined,
    durationMs: clock.now() - start,
    rss: result.rss,
  });

  postJourneyStopChecks(state, journey);
  return result;
}

/**
 * Source a lifecycle journey's result from the CandidateLifecycle orchestration
 * (install / upgrade / cli-state removal / package removal) — never from a spawn.
 */
function runLifecycleJourney(state, journey, params) {
  const { lifecycle, clock } = state;
  const start = clock.now();

  if (journey.id === 'lifecycle.install') {
    const event = lifecycle.install(params.installResolved);
    if (!event.ok) {
      // Candidate loss ⇒ nothing downstream can run.
      state.infraReason = R.CANDIDATE_INSTALL_FAILED;
      state.stopped = { reasonCode: R.CANDIDATE_UNAVAILABLE };
      return lifecycleResult(state, journey, params, event, 'fail', clock.now() - start);
    }
    state.installedView = toInstalledView(lifecycle.installed);
    state.mcpConnector = state.createMcpConnector({
      jsEntrypoint: lifecycle.installed.jsEntrypoint,
      baseEnv: lifecycle.childEnv(),
      bounds: state.bounds,
      platform: state.platform,
      repoRoot: state.options.repoRoot,
    });
    return lifecycleResult(state, journey, params, event, 'pass', clock.now() - start);
  }

  if (journey.id === 'lifecycle.upgrade') {
    ensureRepresentativeState(state);
    const event = lifecycle.upgrade(params.upgradeResolved);
    if (!event.ok) {
      // A failed upgrade does not lose the primary candidate that is already
      // installed and qualified; continue with the removal journeys.
      return lifecycleResult(state, journey, params, event, 'fail', clock.now() - start);
    }
    state.installedView = toInstalledView(lifecycle.installed);
    return lifecycleResult(state, journey, params, event, 'pass', clock.now() - start);
  }

  if (journey.id === 'lifecycle.cli-state-uninstall') {
    const event = lifecycle.removeCliState();
    return lifecycleResult(
      state,
      journey,
      params,
      event,
      event.ok ? 'pass' : 'fail',
      clock.now() - start,
    );
  }

  // lifecycle.package-uninstall
  const event = lifecycle.removePackage();
  return lifecycleResult(
    state,
    journey,
    params,
    event,
    event.ok ? 'pass' : 'fail',
    clock.now() - start,
  );
}

function ensureRepresentativeState(state) {
  if (state.representativeCreated) return;
  state.representativeCreated = true;
  try {
    state.lifecycle.createRepresentativeState();
  } catch {
    /* a representative-state failure surfaces via the upgrade/removeCliState events */
  }
}

function lifecycleResult(state, journey, params, event, status, durationMs) {
  const diagnostics = status === 'pass' ? [] : [...(event.diagnostics ?? [])];
  return makeResult(state, journey, params.required, {
    status,
    reasonCode: status === 'pass' ? null : event.reasonCode,
    diagnostics,
    durationMs,
    // Lifecycle transitions use synchronous spawns; no per-tree RSS is sampled.
    rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
  });
}

/** Build the executor context, run the executor, and fold its outcome into a result. */
async function runExecutorJourney(state, journey, params) {
  const { clock } = state;
  const start = clock.now();

  // Capability preflight — a declared native prereq the host lacks is an explicit
  // `unavailable` row (never a dropped journey).
  for (const capability of params.declaredCapabilities) {
    if (state.host?.capabilities?.[capability] !== true) {
      return makeResult(state, journey, params.required, {
        status: 'unavailable',
        reasonCode: `capability-${capability}-unavailable`,
        diagnostics: [`host lacks required capability ${capability}`],
        durationMs: clock.now() - start,
        rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
      });
    }
  }
  for (const capability of journey.capabilities) {
    if (state.host?.capabilities?.[capability] !== true) {
      return makeResult(state, journey, params.required, {
        status: 'unavailable',
        reasonCode: `capability-${capability}-unavailable`,
        diagnostics: [`host lacks capability ${capability}`],
        durationMs: clock.now() - start,
        rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
      });
    }
  }

  // Extension journeys need packed fixtures; a packing failure makes them
  // explicitly unavailable rather than dropped.
  if (journey.category === 'extensions' && state.fixturesView === null) {
    return makeResult(state, journey, params.required, {
      status: 'unavailable',
      reasonCode: R.FIXTURES_UNAVAILABLE,
      diagnostics: ['repository fixtures could not be packed for this run'],
      durationMs: clock.now() - start,
      rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    });
  }

  const workRoot = assignWorkRoot(state, journey);
  const port = state.createProcessPort({
    baseEnv: state.lifecycle.childEnv(),
    bounds: state.bounds,
    platform: state.platform,
    runSignal: state.options.signal,
  });
  const context = buildContext(state, journey, workRoot, port);

  let outcome;
  try {
    outcome = await journey.executor(context);
  } catch (error) {
    return makeResult(state, journey, params.required, {
      status: 'unavailable',
      reasonCode: R.JOURNEY_THREW,
      diagnostics: [redactError(error)],
      durationMs: clock.now() - start,
      rss: readPortRss(port),
    });
  }

  const validated = coerceOutcome(outcome);
  if (validated === null) {
    return makeResult(state, journey, params.required, {
      status: 'unavailable',
      reasonCode: R.EXECUTOR_INVALID_RESULT,
      diagnostics: ['executor did not return a valid single JourneyOutcome'],
      durationMs: clock.now() - start,
      rss: readPortRss(port),
    });
  }

  return makeResult(state, journey, params.required, {
    status: validated.status,
    reasonCode: validated.status === 'pass' ? null : validated.reasonCode,
    diagnostics: validated.diagnostics,
    durationMs: clock.now() - start,
    rss: readPortRss(port),
  });
}

function assignWorkRoot(state, journey) {
  const { fs, runRoot } = state;
  if (journey.isolated) {
    const dir = join(runRoot, 'journeys', journeyDirName(journey.id));
    ensureDir(fs, dir);
    return dir;
  }
  if (state.sharedWorkRoot === null) {
    state.sharedWorkRoot = join(runRoot, 'journeys', 'shared');
    ensureDir(fs, state.sharedWorkRoot);
  }
  return state.sharedWorkRoot;
}

function buildContext(state, journey, workRoot, port) {
  const context = {
    installed: state.installedView,
    paths: Object.freeze({ workRoot }),
    fixtures: state.fixturesView,
    process: port,
    assert: makeAssertHelpers(state.bounds),
  };
  if (journey.category === 'mcp' && state.mcpConnector !== null) {
    context.mcp = state.mcpConnector;
  }
  return Object.freeze(context);
}

/** The bounded, side-effect-free assertion helpers a journey reads. */
function makeAssertHelpers(bounds) {
  const toAssertable = (result) => ({
    stdout: result.stdoutCapture ?? '',
    stderr: result.stderrTail ?? '',
    exitCode: result.status ?? 1,
  });
  return Object.freeze({
    toAssertable,
    check: (result, expect) => checkScenario(toAssertable(result), expect),
    envelope: (opts) => expectEnvelope(opts ?? {}),
    diagnostic: (text) => boundedDiagnostic(text, bounds.maxDiagnosticTailBytes),
  });
}

function readPortRss(port) {
  if (typeof port.rssMeasurement === 'function') return port.rssMeasurement();
  return { status: 'unavailable', reasonCode: 'rss-not-sampled' };
}

// ---------------------------------------------------------------------------
// Result assembly + stop conditions
// ---------------------------------------------------------------------------

function coerceOutcome(outcome) {
  if (outcome === null || typeof outcome !== 'object') return null;
  if (!JOURNEY_STATUSES.has(outcome.status)) return null;
  if (!Array.isArray(outcome.diagnostics)) return null;
  return outcome;
}

function makeResult(state, journey, required, fields) {
  const status = JOURNEY_STATUSES.has(fields.status) ? fields.status : 'unavailable';
  let reasonCode = null;
  if (status !== 'pass')
    reasonCode = safeReason(fields.reasonCode) ?? journey.category + '-unspecified';
  const rss = normalizeRss(fields.rss);
  return Object.freeze({
    id: journey.id,
    category: journey.category,
    required,
    status,
    reasonCode,
    durationMs:
      typeof fields.durationMs === 'number' ? Math.max(0, Math.round(fields.durationMs)) : 0,
    rss,
    diagnostics: boundDiagnostics(fields.diagnostics, state.bounds.maxDiagnosticTailBytes),
  });
}

function normalizeRss(rss) {
  if (rss && rss.status === 'available' && Number.isFinite(rss.peakBytes) && rss.peakBytes >= 0) {
    return Object.freeze({ status: 'available', peakBytes: Math.round(rss.peakBytes) });
  }
  const reasonCode = safeReason(rss?.reasonCode) ?? 'rss-not-sampled';
  return Object.freeze({ status: 'unavailable', reasonCode });
}

// Reason codes that indicate a HARNESS prerequisite gap (e.g. the private
// agent-eval build is missing), not a candidate defect. A journey that reports
// one of these is an infrastructure fault: the harness could not produce
// trustworthy evidence, so the whole run's verdict is `infrastructure-fault`
// (exit 3) rather than a candidate `fail` (exit 1). See ADR-0164 / Plan 04.2.6.
const HARNESS_INFRA_REASONS = new Set([
  'agent-eval-harness-missing',
  'agent-eval-harness-unloadable',
]);

function appendResult(state, result) {
  if (state.seenIds.has(result.id)) {
    throw new Error(`runner produced a duplicate result for journey ${JSON.stringify(result.id)}`);
  }
  state.seenIds.add(result.id);
  state.results.push(result);
  // A harness-prerequisite failure escalates to an infrastructure fault so an OS
  // support workflow never reads "you forgot to build agent-eval" as a candidate
  // defect. Remaining journeys still run and record evidence; the verdict is
  // pinned to infrastructure-fault.
  if (
    result.status === 'unavailable' &&
    HARNESS_INFRA_REASONS.has(result.reasonCode) &&
    !state.infraReason
  ) {
    state.infraReason = result.reasonCode;
  }
  // Coarse running estimate of the evidence budget; the writer enforces the hard bound.
  let bytes = PER_RESULT_EVIDENCE_OVERHEAD;
  for (const diagnostic of result.diagnostics) bytes += Buffer.byteLength(diagnostic, 'utf8');
  state.evidenceBytes += bytes;
  if (state.evidenceBytes > state.bounds.maxEvidenceBytes && !state.stopped) {
    state.stopped = { reasonCode: R.EVIDENCE_BOUND_EXHAUSTED };
  }
}

/** Detect candidate loss (installed bin vanished) before the removal phase. */
function postJourneyStopChecks(state, journey) {
  if (state.stopped) return;
  if (state.options.signal?.aborted) {
    state.infraReason = R.RUN_CANCELLED;
    state.stopped = { reasonCode: R.RUN_CANCELLED };
    return;
  }
  // Candidate integrity only matters up to the removal journeys (which are meant
  // to delete the bin).
  const inRemovalPhase =
    journey.id === 'lifecycle.cli-state-uninstall' || journey.id === 'lifecycle.package-uninstall';
  if (inRemovalPhase || state.installedView === null) return;
  const bin = state.installedView.installedBin?.bin;
  if (typeof bin === 'string' && !state.fs.existsSync(bin)) {
    state.infraReason = R.CANDIDATE_LOST;
    state.stopped = { reasonCode: R.CANDIDATE_LOST };
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function finalizeCleanup(state) {
  const { fs, runRoot, lifecycle } = state;
  let removedRoots = 0;
  let residual = 0;
  let escape = false;
  let reasonCode = null;

  // 1. The lifecycle removes its own hermetic install/home/npm state.
  let lifecycleCleanup = {
    status: 'clean',
    reasonCode: null,
    removedRoots: 0,
    residualDescendants: 0,
  };
  try {
    lifecycleCleanup = lifecycle.cleanup();
  } catch {
    reasonCode = R.CLEANUP_INTEGRITY_FAILED;
  }
  removedRoots += lifecycleCleanup.removedRoots ?? 0;
  residual += lifecycleCleanup.residualDescendants ?? 0;
  if (lifecycleCleanup.status !== 'clean') {
    reasonCode ??= lifecycleCleanup.reasonCode ?? R.CLEANUP_INTEGRITY_FAILED;
  }

  // 2. The runner removes its own roots (journeys/fixtures), realpath-guarded.
  let runRootReal;
  try {
    runRootReal = fs.realpathSync(runRoot);
  } catch {
    runRootReal = runRoot;
  }
  for (const child of ['journeys', 'fixtures', 'candidate']) {
    const target = join(runRoot, child);
    if (!fs.existsSync(target)) continue;
    let real;
    try {
      real = fs.realpathSync(target);
    } catch {
      continue;
    }
    if (real === runRootReal || !isUnderOrEqual(runRootReal, real)) {
      escape = true;
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removedRoots += 1;
    } catch {
      residual += 1;
    }
  }

  // 3. Remove the run root itself last.
  try {
    fs.rmSync(runRoot, { recursive: true, force: true });
    removedRoots += 1;
  } catch {
    residual += 1;
  }
  if (fs.existsSync(runRoot)) residual += 1;

  if (escape) reasonCode ??= R.ROOT_ESCAPE;
  else if (residual > 0) reasonCode ??= R.CLEANUP_INTEGRITY_FAILED;

  const status = escape || residual > 0 || reasonCode !== null ? 'incomplete' : 'clean';
  return Object.freeze({
    status,
    reasonCode: status === 'clean' ? null : (reasonCode ?? R.CLEANUP_INTEGRITY_FAILED),
    removedRoots,
    residualDescendants: residual,
  });
}

function bestEffortRemove(fs, runRoot, target) {
  try {
    const real = fs.realpathSync(target);
    if (isUnderOrEqual(fs.realpathSync(runRoot), real))
      fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Fixtures + views + small helpers
// ---------------------------------------------------------------------------

function tryPackFixtures(packFixtures, options) {
  const dest = join(options.runRoot, 'fixtures');
  ensureDir(options.fs, dest);
  try {
    const packed = packFixtures({
      repoRoot: options.repoRoot,
      destDir: dest,
      env: options.env,
      platform: options.platform,
    });
    return Object.freeze({
      toolPluginTarball: packed.toolPluginTarball,
      fitPackTarball: packed.fitPackTarball,
      simPackTarball: packed.simPackTarball,
    });
  } catch {
    return null;
  }
}

function toInstalledView(installed) {
  return Object.freeze({
    mode: installed.mode,
    installedBin: installed.installedBin,
    jsEntrypoint: installed.jsEntrypoint,
    resolvedVersion: installed.resolvedVersion ?? null,
  });
}

function ensureDir(fs, dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* the caller observes a missing dir through a later failure */
  }
}

/** Default profile reader: parse a JSON file into a raw object. */
function realReadProfile(path) {
  return JSON.parse(realReadFileSync(path, 'utf8'));
}

function loadProfile(readProfile, profilePath) {
  if (typeof profilePath !== 'string' || profilePath.length === 0) {
    return {
      ok: false,
      reasonCode: R.PROFILE_NOT_FOUND,
      message: 'no --profile path was supplied',
    };
  }
  let raw;
  try {
    raw = readProfile(profilePath);
  } catch (error) {
    return { ok: false, reasonCode: R.PROFILE_NOT_FOUND, message: redactError(error) };
  }
  try {
    const profile = parseAcceptanceProfile(raw);
    return { ok: true, profile, digest: profileDigest(profile) };
  } catch (error) {
    return { ok: false, reasonCode: R.PROFILE_INVALID, message: redactError(error) };
  }
}

function invalidInvocation(reasonCode, message, progress) {
  return Object.freeze({
    outcome: RUN_OUTCOMES.INVALID_INVOCATION,
    reasonCode,
    message: redactMessage(message),
    evidence: null,
    verdict: null,
    completionState: null,
    runRoot: null,
    maxEvidenceBytes: null,
    progress: Object.freeze([...progress]),
  });
}

function infrastructureFault(reasonCode, message, evidence, progress, maxEvidenceBytes = null) {
  return Object.freeze({
    outcome: RUN_OUTCOMES.INFRASTRUCTURE_FAULT,
    reasonCode,
    message: redactMessage(message),
    evidence,
    verdict: 'infrastructure-fault',
    completionState: 'infrastructure-fault',
    runRoot: null,
    maxEvidenceBytes,
    progress: Object.freeze([...progress]),
  });
}

function isoAtLeast(candidate, floor) {
  return Date.parse(candidate) < Date.parse(floor) ? floor : candidate;
}

function redactError(error) {
  return redactMessage(error instanceof Error ? error.message : String(error));
}

function redactMessage(message) {
  return boundedDiagnostic(String(message ?? ''), 1024);
}
