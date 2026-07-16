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
  lstatSync as realLstatSync,
  mkdirSync as realMkdirSync,
  mkdtempSync as realMkdtempSync,
  readFileSync as realReadFileSync,
  realpathSync as realRealpathSync,
  rmSync as realRmSync,
  statSync as realStatSync,
  symlinkSync as realSymlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { boundedDiagnostic, checkScenario, expectEnvelope } from '../cli-acceptance-core.mjs';
import { classifyMeasuredOutcome, createMeasuredProcessPort } from '../lib/measured-process.mjs';
import {
  AgentReportWriteError,
  AGENT_REPORT_WRITE_REASONS,
  writeSanitizedInstalledAgentReport,
} from './agent-report-writer.mjs';
import { CandidateLifecycle } from './candidate-lifecycle.mjs';
import {
  CandidatePeerBridgeError,
  createCandidatePeerBridge,
  removeCandidatePeerBridge,
  verifyCandidatePeerBridge,
  verifyCandidatePeerResolution,
} from './candidate-peer-bridge.mjs';
import {
  composeProfile,
  computeSummary,
  computeVerdict,
  isJourneyApplicable,
  isJourneyRequired,
  parseAcceptanceProfile,
  PLATFORM_ACCEPTANCE_SCHEMA_VERSION,
  profileDigest,
} from './contract.mjs';
import { collectHostProfile as realCollectHostProfile } from './host-profile.mjs';
import { packFixtures as realPackFixtures } from './fixture-packages.mjs';
import { JOURNEY_REGISTRY, resolveProfileJourneys } from './journey-catalog.mjs';
import { createDefaultMcpConnector } from './mcp-connector.mjs';
import { resolveCandidateSource as realResolveCandidateSource } from './candidate-source.mjs';
import { readBoundedFileBytes } from './bounded-owned-file.mjs';
import {
  MAX_REGISTRY_INVENTORY_BYTES,
  resolveRegistryInventoryBinding,
} from './registry-install-binding.mjs';
import { redactSensitiveText } from './sensitive-text.mjs';

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
  REGISTRY_INVENTORY_INVALID: 'registry-inventory-invalid',
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
  CANDIDATE_KIND_NOT_APPLICABLE: 'candidate-kind-not-applicable',
  PREVIOUS_CANDIDATE_NOT_SUPPLIED: 'previous-candidate-not-supplied',
});

const JOURNEY_STATUSES = new Set(['pass', 'fail', 'skipped', 'unavailable']);
const KEBAB_REASON = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// Contract-safe bounds mirrored locally so a runner-built row never trips the
// evidence parser.
const MAX_DIAGNOSTICS_PER_JOURNEY = 64;
const MAX_DIAGNOSTICS_PER_STEP = 8;
const MAX_DIAGNOSTIC_LENGTH = 4096;
const MAX_STEPS_PER_JOURNEY = 64;
const PER_RESULT_EVIDENCE_OVERHEAD = 256;
const STEP_STAGES = new Set(['process', 'lifecycle', 'mcp']);

const R = RUNNER_REASON_CODES;
const S = ACCEPTANCE_STAGES;

/** Lifecycle-driven ids → their stage + transition. */
const LIFECYCLE_STAGE_BY_ID = Object.freeze({
  'lifecycle.install': S.INSTALL,
  'lifecycle.upgrade': S.UPGRADE,
  'lifecycle.cli-state-uninstall': S.STATE_REMOVE,
  'lifecycle.package-uninstall': S.PACKAGE_REMOVE,
});

const CANDIDATE_PEER_BRIDGE_FIXTURES = new Map([
  ['extensions.fit-pack', { domain: 'fit', packageName: '@opensip-cli-fixture/fit-pack-demo' }],
  ['extensions.sim-pack', { domain: 'sim', packageName: '@opensip-cli-fixture/sim-pack-demo' }],
]);

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
    lstatSync: realLstatSync,
    readFileSync: realReadFileSync,
    realpathSync: realRealpathSync,
    rmSync: realRmSync,
    statSync: realStatSync,
    symlinkSync: realSymlinkSync,
  };
}

/** True when `target` is `root` itself or a strict descendant of `root`. */
function isUnderOrEqual(root, target) {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Capture the no-follow identity of the concrete directory created for this run. */
function captureDirectoryIdentity(fs, path) {
  const real = fs.realpathSync(path);
  if (real !== path) throw new Error('directory must already have a canonical path');
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink?.() === true || stat.isDirectory?.() !== true) {
    throw new Error('path must be a concrete directory');
  }
  if (
    (typeof stat.dev !== 'number' && typeof stat.dev !== 'bigint') ||
    (typeof stat.ino !== 'number' && typeof stat.ino !== 'bigint')
  ) {
    throw new TypeError('directory identity is unavailable');
  }
  return Object.freeze({ realpath: real, dev: stat.dev, ino: stat.ino });
}

/** Revalidate both the root path and its inode before any recursive deletion. */
function matchesDirectoryIdentity(fs, path, expected) {
  try {
    if (fs.realpathSync(path) !== expected.realpath) return false;
    const stat = fs.lstatSync(path);
    return (
      stat.isSymbolicLink?.() !== true &&
      stat.isDirectory?.() === true &&
      stat.dev === expected.dev &&
      stat.ino === expected.ino
    );
  } catch {
    return false;
  }
}

/** Redact run-owned/host paths and common credential forms before evidence sealing. */
function redactDiagnosticText(text, state) {
  let redacted = String(text ?? '');
  const paths = [state?.runRoot, state?.options?.repoRoot, homedir()].filter(
    (entry) => typeof entry === 'string' && entry.length > 1,
  );
  for (const path of paths) redacted = redacted.split(path).join('<path>');
  return redactSensitiveText(redacted);
}

/** Redact, bound, and control-strip a diagnostics array to the contract limits. */
function boundDiagnostics(diagnostics, state) {
  const out = [];
  for (const entry of diagnostics ?? []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const bounded = boundedDiagnostic(
      redactDiagnosticText(entry, state),
      Math.min(state.bounds.maxDiagnosticTailBytes, MAX_DIAGNOSTIC_LENGTH),
    );
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
 * @param {string} [options.agentReportOutPath] optional sanitized agent-report destination.
 * @param {AbortSignal} [options.signal]       runner-level cancellation signal.
 * @param {object} [options.parentSignalCoordinator] shared process-signal cleanup coordinator.
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
  const writeAgentReport = deps.writeAgentReport ?? writeSanitizedInstalledAgentReport;
  const readProfile = deps.readProfile ?? realReadProfile;
  const platform = deps.platform ?? process.platform;
  const readRegistryInventory = deps.readRegistryInventory ?? readBoundedFileBytes;
  const resolveRegistryInventory = deps.resolveRegistryInventory ?? resolveRegistryInventoryBinding;

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
  const profileResult = loadProfile(readProfile, options.profilePath, options.repoRoot);
  if (!profileResult.ok) {
    emit(S.PREFLIGHT, { reasonCode: profileResult.reasonCode });
    return invalidInvocation(profileResult.reasonCode, profileResult.message, progress);
  }
  const profile = profileResult.profile;
  let journeys;
  try {
    journeys = resolveProfileJourneys(
      profile.journeys.map((selection) => selection.id),
      registry,
    );
  } catch (error) {
    emit(S.PREFLIGHT, { reasonCode: R.PROFILE_INVALID });
    return invalidInvocation(R.PROFILE_INVALID, redactError(error), progress);
  }

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
  let registryInventory = null;
  if (primary.identity.kind === 'published-version') {
    const inventoryRead = readRegistryInventory({
      path: options.registryInventoryPath,
      maxBytes: MAX_REGISTRY_INVENTORY_BYTES,
      reasonPrefix: 'registry-inventory',
      requireNonEmpty: true,
    });
    if (!inventoryRead?.ok || !Buffer.isBuffer(inventoryRead.buffer)) {
      emit(S.CANDIDATE_RESOLVE, { reasonCode: R.REGISTRY_INVENTORY_INVALID });
      return invalidInvocation(
        R.REGISTRY_INVENTORY_INVALID,
        'published candidate registry inventory could not be read safely',
        progress,
      );
    }
    try {
      registryInventory = resolveRegistryInventory({
        inventoryBytes: inventoryRead.buffer,
        expectedDigest: primary.identity.registryIntegrityDigest,
        expectedVersion: primary.identity.version,
        expectedRegistry: primary.identity.registry,
        expectedManifestDigest: primary.identity.manifestDigest,
      }).inventory;
    } catch (error) {
      emit(S.CANDIDATE_RESOLVE, { reasonCode: R.REGISTRY_INVENTORY_INVALID });
      return invalidInvocation(
        R.REGISTRY_INVENTORY_INVALID,
        redactMessage(`published candidate registry inventory: ${redactError(error)}`),
        progress,
      );
    }
  }
  let previous = null;
  if (options.candidate?.previous !== undefined) {
    previous = await resolveCandidateSource(options.candidate.previous, {
      // The release inventory binds the target bytes. The upgrade source is a
      // separately recorded exact registry/version identity and must never
      // inherit the target release's integrity digest.
      allowUnboundRegistryIntegrity: true,
    });
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
  // otherwise install the primary. The upgrade row is an explicit no-effect skip
  // when no exact previous candidate was supplied.
  const installResolved = previous ?? primary;
  const upgradeResolved = primary;
  emit(S.CANDIDATE_RESOLVE, { durationMs: clock.now() - candidateStart });

  // --- preflight: run root + host ---------------------------------------
  let runRoot;
  let runRootIdentity;
  try {
    runRoot = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'opensip-acceptance-')));
    runRootIdentity = captureDirectoryIdentity(fs, runRoot);
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
    runRootIdentity,
    createProcessPort,
    createMcpConnector,
    writeAgentReport,
    registry,
    emit,
    bounds: profile.bounds,
    requiredCapabilities: profile.requiredCapabilities,
    results: [],
    seenIds: new Set(),
    stopped: null,
    infraReason: null,
    evidenceBytes: 0,
    processResidualDescendants: 0,
    lifecycle: null,
    lifecycleAttempted: new Set(),
    lifecycleEvidence: {
      installedVersion: null,
      upgradedVersion: null,
      versionMigrated: null,
      stateMigrated: null,
      cliStateRemoved: null,
      packageRemoved: null,
      targetInstallChannel: null,
      integrityChecks: {
        count: 0,
        durationMs: 0,
      },
    },
    registryBindings: {
      candidateLifecycle: null,
      canonicalInstaller: null,
    },
    installedView: null,
    candidatePeerBridge: null,
    fixturesView: null,
    mcpConnector: null,
    representativeCreated: false,
    representativeEvent: null,
    journeysRoot: join(runRoot, 'journeys'),
    journeysRootIdentity: null,
    sharedWorkRoot: null,
    sharedWorkRootIdentity: null,
    removalBoundaryIntegrityChecked: false,
    candidate: primary.identity,
    previousCandidate: previous?.identity ?? null,
    registryInventory,
  };

  let host;
  try {
    const hostStart = clock.now();
    host = collectHostProfile(runRoot, [...profile.requiredCapabilities]);
    emit(S.PREFLIGHT, { durationMs: clock.now() - hostStart });
  } catch (error) {
    emit(S.PREFLIGHT, { reasonCode: R.HOST_COLLECTION_FAILED });
    bestEffortRemove(fs, runRoot, runRoot, runRootIdentity);
    return infrastructureFault(
      R.HOST_COLLECTION_FAILED,
      redactError(error),
      null,
      progress,
      profile.bounds.maxEvidenceBytes,
    );
  }
  state.host = host;
  for (const capability of profile.requiredCapabilities) {
    if (host.capabilities?.[capability] !== true) {
      state.stopped = {
        reasonCode: `capability-${capability.replace(/[^a-z0-9]+/g, '-')}-unavailable`,
      };
      break;
    }
  }

  // --- install the candidate + pack fixtures ----------------------------
  // The lifecycle constructor requires its run root to already exist.
  const candidateRoot = join(runRoot, 'candidate');
  ensureDir(fs, candidateRoot);
  const installerSelection = profile.journeys.find(
    (selection) => selection.id === 'macos.installer-sh',
  );
  const canonicalInstaller =
    primary.identity.kind === 'published-version' &&
    installerSelection !== undefined &&
    isJourneyApplicable(installerSelection, primary.identity.kind)
      ? Object.freeze({
          scriptPath: join(options.repoRoot, 'scripts', 'install.sh'),
          shellPath: '/bin/sh',
          targetCandidateDigest: primary.identity.digest,
        })
      : undefined;
  let lifecycle;
  try {
    lifecycle = createLifecycle({
      runRoot: candidateRoot,
      platform,
      bounds: profile.bounds,
      signal: options.signal,
      parentSignalCoordinator: options.parentSignalCoordinator,
      registryInventory,
      ...(canonicalInstaller === undefined ? {} : { canonicalInstaller }),
    });
  } catch (error) {
    emit(S.INSTALL, { reasonCode: R.CANDIDATE_INSTALL_FAILED });
    bestEffortRemove(fs, runRoot, runRoot, runRootIdentity);
    return infrastructureFault(
      R.CANDIDATE_INSTALL_FAILED,
      redactError(error),
      null,
      progress,
      profile.bounds.maxEvidenceBytes,
    );
  }
  state.lifecycle = lifecycle;

  const skipReasonById = new Map(
    profile.journeys.map((selection) => {
      if (!isJourneyApplicable(selection, primary.identity.kind)) {
        return [selection.id, R.CANDIDATE_KIND_NOT_APPLICABLE];
      }
      if (selection.id === 'lifecycle.upgrade' && previous === null) {
        return [selection.id, R.PREVIOUS_CANDIDATE_NOT_SUPPLIED];
      }
      return [selection.id, null];
    }),
  );
  const requiredById = new Map(
    profile.journeys.map((selection) => [
      selection.id,
      isJourneyApplicable(selection, primary.identity.kind) &&
        isJourneyRequired(selection, previous?.identity ?? null),
    ]),
  );
  const capabilitiesById = new Map(
    profile.journeys.map((selection) => [selection.id, selection.capabilities ?? []]),
  );

  let cleanup;
  try {
    state.fixturesView = tryPackFixtures(packFixtures, {
      repoRoot: options.repoRoot,
      runRoot,
      fs,
      env: lifecycle.childEnv(),
      platform,
    });

    // --- execute journeys in profile order ------------------------------
    for (const journey of journeys) {
      const required = requiredById.get(journey.id) === true;
      const declaredCapabilities = capabilitiesById.get(journey.id) ?? [];
      const result = await runOneJourney(state, journey, {
        required,
        skipReason: skipReasonById.get(journey.id) ?? null,
        declaredCapabilities,
        installResolved,
        upgradeResolved,
      });
      appendResult(state, result);
    }
  } catch (error) {
    // Any harness exception after the run root exists is an infrastructure
    // fault, but it still produces one explicit row per selected journey and
    // proceeds through the same deterministic cleanup/finalization path.
    state.infraReason ??= R.JOURNEY_THREW;
    state.stopped = { reasonCode: state.infraReason };
    for (const journey of journeys) {
      if (state.seenIds.has(journey.id)) continue;
      const skipReason = skipReasonById.get(journey.id) ?? null;
      appendResult(
        state,
        skipReason === null
          ? makeResult(state, journey, requiredById.get(journey.id) === true, {
              status: 'unavailable',
              reasonCode: state.infraReason,
              diagnostics: [redactError(error)],
              durationMs: 0,
              rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
            })
          : makeSemanticSkipResult(
              state,
              journey,
              skipReason,
              requiredById.get(journey.id) === true,
            ),
      );
    }
  } finally {
    // Profiles normally end with package removal, whose preflight is the final
    // candidate observation. Custom/short profiles and early stops still need
    // one explicit terminal observation before cleanup can erase the evidence.
    try {
      ensureTerminalCandidateIntegrity(state);
    } catch {
      state.infraReason ??= R.CANDIDATE_LOST;
      state.stopped = { reasonCode: state.infraReason };
    }
    // --- cleanup ---------------------------------------------------------
    const cleanupStart = clock.now();
    try {
      cleanup = await finalizeCleanup(state);
    } catch {
      cleanup = Object.freeze({
        status: 'incomplete',
        reasonCode: R.CLEANUP_INTEGRITY_FAILED,
        removedRoots: 0,
        residualDescendants: 1,
      });
    }
    if (cleanup.status !== 'clean') {
      state.infraReason ??= cleanup.reasonCode ?? R.CLEANUP_INTEGRITY_FAILED;
    }
    emit(S.CLEANUP, {
      durationMs: clock.now() - cleanupStart,
      reasonCode: cleanup.reasonCode ?? undefined,
    });
  }

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
    previousCandidate: previous?.identity ?? null,
    execution: normalizeExecutionIdentity(options.execution, platform),
    lifecycle: Object.freeze({
      ...state.lifecycleEvidence,
      integrityChecks: Object.freeze({
        ...state.lifecycleEvidence.integrityChecks,
      }),
    }),
    registryBindings: Object.freeze({ ...state.registryBindings }),
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

  // Applicability and the no-previous upgrade case are semantic no-effect
  // skips. Preserve their rows even after an earlier stop and resolve them
  // before integrity checks, capability probes, lifecycle calls, or executors.
  if (params.skipReason !== null) {
    const result = makeSemanticSkipResult(state, journey, params.skipReason, params.required);
    emit(stage, {
      id: journey.id,
      reasonCode: params.skipReason,
      durationMs: 0,
      rss: result.rss,
    });
    return result;
  }

  // A stopped run marks every remaining journey unavailable with the causal reason.
  if (state.stopped) {
    const result = makeResult(state, journey, params.required, {
      status: 'unavailable',
      reasonCode: state.stopped.reasonCode,
      diagnostics: [`run stopped: ${state.stopped.reasonCode}`],
      durationMs: 0,
    });
    emit(stage, {
      id: journey.id,
      reasonCode: state.stopped.reasonCode,
      durationMs: 0,
    });
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

  // Profile-level prerequisites gate the entire host. Journey-selection and
  // registry prerequisites gate the individual row. Apply all three before
  // integrity I/O, lifecycle effects, and ordinary executors so a missing
  // native capability produces a truthful no-effect row.
  const requiredCapabilities = [
    ...state.requiredCapabilities,
    ...params.declaredCapabilities,
    ...journey.capabilities,
  ];
  const unavailableCapability = requiredCapabilities.find(
    (capability) => state.host?.capabilities?.[capability] !== true,
  );
  if (unavailableCapability !== undefined) {
    const result = makeResult(state, journey, params.required, {
      status: 'unavailable',
      reasonCode: `capability-${unavailableCapability}-unavailable`,
      diagnostics: [`host lacks required capability ${unavailableCapability}`],
      durationMs: clock.now() - start,
      rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    });
    emit(stage, {
      id: journey.id,
      reasonCode: result.reasonCode,
      durationMs: clock.now() - start,
      rss: result.rss,
    });
    return result;
  }

  // Once installed, every executable journey begins from the exact descriptor
  // identities pinned by CandidateLifecycle. This pre-journey observation also
  // closes the preceding journey: a mutation made by that journey stops the run
  // before any later candidate execution. The package-removal preflight is the
  // terminal observation after CLI-state removal, so a second full-tree
  // postflight per journey is unnecessary.
  if (journey.id !== 'lifecycle.install' && state.installedView !== null) {
    const integrity = verifyCandidateIntegrity(state);
    if (journey.id === 'lifecycle.package-uninstall') {
      state.removalBoundaryIntegrityChecked = true;
    }
    if (!integrity.ok) {
      state.infraReason = R.CANDIDATE_LOST;
      state.stopped = { reasonCode: R.CANDIDATE_LOST };
      const result = makeResult(state, journey, params.required, {
        status: 'unavailable',
        reasonCode: R.CANDIDATE_LOST,
        diagnostics: [integrity.reasonCode],
        durationMs: clock.now() - start,
        rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
      });
      emit(stage, {
        id: journey.id,
        reasonCode: R.CANDIDATE_LOST,
        durationMs: clock.now() - start,
        rss: result.rss,
      });
      return result;
    }
  }

  let result;
  if (LIFECYCLE_STAGE_BY_ID[journey.id] === undefined) {
    result = await runExecutorJourney(state, journey, params);
  } else {
    result = await runLifecycleJourney(state, journey, params);
  }

  emit(stage, {
    id: journey.id,
    reasonCode: result.reasonCode ?? undefined,
    durationMs: clock.now() - start,
    rss: result.rss,
  });

  postJourneyStopChecks(state);
  return result;
}

/**
 * Source a lifecycle journey's result from the CandidateLifecycle orchestration
 * (install / upgrade / cli-state removal / package removal) — never from a spawn.
 */
async function runLifecycleJourney(state, journey, params) {
  const { lifecycle, clock } = state;
  const start = clock.now();
  state.lifecycleAttempted.add(journey.id);

  if (journey.id === 'lifecycle.install') {
    const event = await lifecycle.install(params.installResolved);
    if (!event.ok) {
      // Candidate loss ⇒ nothing downstream can run.
      state.infraReason = R.CANDIDATE_INSTALL_FAILED;
      state.stopped = { reasonCode: R.CANDIDATE_UNAVAILABLE };
      return lifecycleResult(state, journey, params, event, 'fail', clock.now() - start);
    }
    state.installedView = toInstalledView(lifecycle.installed);
    state.lifecycleEvidence.installedVersion = event.facts?.resolvedVersion ?? null;
    if (params.installResolved?.identity?.digest === state.candidate.digest) {
      recordTargetInstallEvidence(state, event);
    }
    state.mcpConnector = state.createMcpConnector({
      jsEntrypoint: lifecycle.installed.jsEntrypoint,
      baseEnv: lifecycle.childEnv(),
      bounds: state.bounds,
      platform: state.platform,
      repoRoot: state.options.repoRoot,
      parentSignalCoordinator: state.options.parentSignalCoordinator,
    });
    return lifecycleResult(state, journey, params, event, 'pass', clock.now() - start);
  }

  if (journey.id === 'lifecycle.upgrade') {
    try {
      clearCandidatePeerBridge(state);
    } catch (error) {
      state.infraReason = R.ROOT_ESCAPE;
      state.stopped = { reasonCode: R.ROOT_ESCAPE };
      return lifecycleResult(
        state,
        journey,
        params,
        {
          ok: false,
          reasonCode: R.ROOT_ESCAPE,
          diagnostics: [redactError(error)],
        },
        'fail',
        clock.now() - start,
      );
    }
    const representative = await ensureRepresentativeState(state);
    if (!representative.ok) {
      return lifecycleResult(state, journey, params, representative, 'fail', clock.now() - start);
    }
    const event = await lifecycle.upgrade(params.upgradeResolved);
    const upgradeEvent = {
      ...event,
      steps: [...(representative.steps ?? []), ...(event.steps ?? [])],
    };
    if (!event.ok) {
      // A failed upgrade does not lose the primary candidate that is already
      // installed and qualified; continue with the removal journeys.
      return lifecycleResult(
        state,
        journey,
        params,
        {
          ...upgradeEvent,
          rss: mergeRssMeasurements(representative.rss, event.rss),
        },
        'fail',
        clock.now() - start,
      );
    }
    if (state.previousCandidate !== null && event.facts?.versionMigrated !== true) {
      return lifecycleResult(
        state,
        journey,
        params,
        {
          ...upgradeEvent,
          ok: false,
          reasonCode: 'upgrade-version-not-migrated',
          diagnostics: ['the exact previous candidate did not migrate to a different version'],
        },
        'fail',
        clock.now() - start,
      );
    }
    state.installedView = toInstalledView(lifecycle.installed);
    state.lifecycleEvidence.upgradedVersion = event.facts?.newVersion ?? null;
    state.lifecycleEvidence.versionMigrated = event.facts?.versionMigrated ?? null;
    state.lifecycleEvidence.stateMigrated = event.facts?.stateMigrated ?? null;
    recordTargetInstallEvidence(state, event);
    return lifecycleResult(
      state,
      journey,
      params,
      {
        ...upgradeEvent,
        rss: mergeRssMeasurements(representative.rss, event.rss),
      },
      'pass',
      clock.now() - start,
    );
  }

  if (journey.id === 'lifecycle.cli-state-uninstall') {
    const event = await lifecycle.removeCliState();
    if (event.ok) state.lifecycleEvidence.cliStateRemoved = event.facts?.runtimeRemoved === true;
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
  try {
    clearCandidatePeerBridge(state);
  } catch (error) {
    state.infraReason = R.ROOT_ESCAPE;
    state.stopped = { reasonCode: R.ROOT_ESCAPE };
    return lifecycleResult(
      state,
      journey,
      params,
      {
        ok: false,
        reasonCode: R.ROOT_ESCAPE,
        diagnostics: [redactError(error)],
      },
      'fail',
      clock.now() - start,
    );
  }
  const event = await lifecycle.removePackage();
  if (event.ok) {
    state.lifecycleEvidence.packageRemoved =
      event.facts?.shimAbsent === true && event.facts?.entrypointAbsent === true;
  }
  return lifecycleResult(
    state,
    journey,
    params,
    event,
    event.ok ? 'pass' : 'fail',
    clock.now() - start,
  );
}

async function ensureRepresentativeState(state) {
  if (state.representativeEvent) return state.representativeEvent;
  state.representativeCreated = true;
  try {
    state.representativeEvent = await state.lifecycle.createRepresentativeState();
  } catch (error) {
    state.representativeEvent = {
      ok: false,
      reasonCode: R.JOURNEY_THREW,
      diagnostics: [redactError(error)],
      rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    };
  }
  return state.representativeEvent;
}

function lifecycleResult(state, journey, params, event, status, durationMs) {
  const diagnostics = status === 'pass' ? [] : [...(event.diagnostics ?? [])];
  const steps = event.steps ?? [];
  return makeResult(state, journey, params.required, {
    status,
    reasonCode: status === 'pass' ? null : event.reasonCode,
    diagnostics,
    durationMs,
    // Lifecycle events may expose the final child measurement as `rss` while
    // retaining every child in `steps`. The journey aggregate must dominate
    // all of those step peaks or an rssRequired profile will produce a
    // contradictory all-pass result with a failing overall verdict.
    rss: mergeRssMeasurements(event.rss, ...steps.map((step) => step.rss)),
    steps,
  });
}

/** Build the executor context, run the executor, and fold its outcome into a result. */
async function runExecutorJourney(state, journey, params) {
  const { clock } = state;
  const start = clock.now();

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

  let workRoot;
  try {
    workRoot = assignWorkRoot(state, journey);
  } catch (error) {
    state.infraReason = R.ROOT_ESCAPE;
    state.stopped = { reasonCode: R.ROOT_ESCAPE };
    return makeResult(state, journey, params.required, {
      status: 'unavailable',
      reasonCode: R.ROOT_ESCAPE,
      diagnostics: [redactError(error)],
      durationMs: clock.now() - start,
      rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    });
  }
  const bridgeFixture = CANDIDATE_PEER_BRIDGE_FIXTURES.get(journey.id);
  const bridgeResolutionAnchor =
    bridgeFixture === undefined ? null : candidatePeerResolutionAnchor(workRoot, bridgeFixture);
  let bridgeIntegrityError = null;
  const verifyBridgeResolution = () => {
    try {
      verifyCandidatePeerResolution(state.candidatePeerBridge, {
        anchor: bridgeResolutionAnchor,
        fs: state.fs,
      });
    } catch (error) {
      bridgeIntegrityError ??= error;
      throw error;
    }
  };
  if (bridgeResolutionAnchor !== null) {
    try {
      state.candidatePeerBridge =
        state.candidatePeerBridge === null
          ? createCandidatePeerBridge({
              installed: state.lifecycle.installed,
              runRoot: state.runRoot,
              platform: state.platform,
              fs: state.fs,
            })
          : verifyCandidatePeerBridge(state.candidatePeerBridge, {
              fs: state.fs,
            });
      verifyBridgeResolution();
    } catch (error) {
      const reasonCode =
        error instanceof CandidatePeerBridgeError && error.kind === 'root-escape'
          ? R.ROOT_ESCAPE
          : R.CANDIDATE_LOST;
      state.infraReason = reasonCode;
      state.stopped = { reasonCode };
      return makeResult(state, journey, params.required, {
        status: 'unavailable',
        reasonCode,
        diagnostics: [redactError(error)],
        durationMs: clock.now() - start,
        rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
      });
    }
  }
  const rawPort = state.createProcessPort({
    baseEnv: state.lifecycle.childEnv(),
    bounds: state.bounds,
    platform: state.platform,
    runSignal: state.options.signal,
    deps: { parentSignalCoordinator: state.options.parentSignalCoordinator },
  });
  const processFaults = [];
  const stepEvidence = [];
  const port = trackProcessIntegrity(
    rawPort,
    state,
    processFaults,
    stepEvidence,
    bridgeResolutionAnchor === null ? null : verifyBridgeResolution,
  );
  const artifactTracker = createAgentArtifactTracker(state, journey);
  const context = buildContext(state, journey, workRoot, port, artifactTracker?.surface);
  // A connector is shared across MCP journeys. Discarding previously-consumed
  // observations here keeps every terminal server observation owned by the
  // journey that opened it.
  if (journey.category === 'mcp') takeMcpStepEvidence(state, processFaults);

  let fields;
  let outcome;
  try {
    outcome = await journey.executor(context);
  } catch (error) {
    fields = {
      status: 'unavailable',
      reasonCode: R.JOURNEY_THREW,
      diagnostics: [redactError(error)],
    };
  }

  const validated = fields === undefined ? coerceOutcome(outcome) : null;
  if (fields === undefined && validated === null) {
    fields = {
      status: 'unavailable',
      reasonCode: R.EXECUTOR_INVALID_RESULT,
      diagnostics: ['executor did not return a valid single JourneyOutcome'],
    };
  }

  // When the caller requested the installed-agent auxiliary artifact, a passing
  // journey must have completed its one closed writer capability. This catches
  // accidental executor drift that otherwise reports pass while cleanup deletes
  // the only full report.
  if (
    fields === undefined &&
    validated.status === 'pass' &&
    artifactTracker !== null &&
    !artifactTracker.succeeded
  ) {
    fields = {
      status: 'fail',
      reasonCode: 'installed-smoke-report-not-preserved',
      diagnostics: ['the installed agent report was not preserved'],
    };
  }

  stepEvidence.push(...takeMcpStepEvidence(state, processFaults));
  const integrityFault = enforceProcessFaults(state, processFaults);
  if (integrityFault !== null) {
    fields = {
      status: 'fail',
      reasonCode: integrityFault.reasonCode,
      diagnostics: [integrityFault.diagnostic],
    };
  }

  // The candidate process can create a nearer node_modules during the journey.
  // Re-resolve after execution so a shadowed peer can never support a passing
  // extension result or be silently erased during cleanup.
  if (bridgeResolutionAnchor !== null && state.candidatePeerBridge !== null) {
    try {
      if (bridgeIntegrityError !== null) throw bridgeIntegrityError;
      verifyBridgeResolution();
    } catch (error) {
      const reasonCode =
        error instanceof CandidatePeerBridgeError && error.kind === 'root-escape'
          ? R.ROOT_ESCAPE
          : R.CANDIDATE_LOST;
      state.infraReason = reasonCode;
      state.stopped = { reasonCode };
      fields = {
        status: 'unavailable',
        reasonCode,
        diagnostics: [redactError(error)],
      };
    }
  }

  fields ??= {
    status: validated.status,
    reasonCode: validated.status === 'pass' ? null : validated.reasonCode,
    diagnostics: validated.diagnostics,
  };
  return makeResult(state, journey, params.required, {
    ...fields,
    durationMs: clock.now() - start,
    rss: journeyRss(state, journey, port),
    steps: stepEvidence,
  });
}

function assignWorkRoot(state, journey) {
  const { runRoot } = state;
  if (state.journeysRootIdentity === null) {
    state.journeysRootIdentity = ensureConcreteRunDirectory(state, state.journeysRoot, {
      requireAbsentLeaf: true,
    });
  } else if (!matchesDirectoryIdentity(state.fs, state.journeysRoot, state.journeysRootIdentity)) {
    throw new Error('journeys working-directory root identity changed');
  }
  if (journey.isolated) {
    const dir = join(runRoot, 'journeys', journeyDirName(journey.id));
    ensureConcreteRunDirectory(state, dir, { requireAbsentLeaf: true });
    return dir;
  }
  if (state.sharedWorkRoot === null) {
    state.sharedWorkRoot = join(runRoot, 'journeys', 'shared');
  }
  if (state.sharedWorkRootIdentity === null) {
    state.sharedWorkRootIdentity = ensureConcreteRunDirectory(state, state.sharedWorkRoot, {
      requireAbsentLeaf: true,
    });
  } else {
    if (!matchesDirectoryIdentity(state.fs, state.sharedWorkRoot, state.sharedWorkRootIdentity)) {
      throw new Error('shared journey working directory identity changed');
    }
    ensureConcreteRunDirectory(state, state.sharedWorkRoot);
  }
  if (!matchesDirectoryIdentity(state.fs, state.sharedWorkRoot, state.sharedWorkRootIdentity)) {
    throw new Error('shared journey working directory identity changed');
  }
  return state.sharedWorkRoot;
}

function ensureConcreteRunDirectory(state, path, { requireAbsentLeaf = false } = {}) {
  const { fs, runRoot, runRootIdentity } = state;
  const relativePath = relative(runRootIdentity.realpath, path);
  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('journey working directory escaped the run root');
  }

  let parentPath = runRootIdentity.realpath;
  let parentIdentity = runRootIdentity;
  const components = relativePath.split(sep);
  for (const [index, component] of components.entries()) {
    if (component.length === 0 || component === '.' || component === '..') {
      throw new Error('journey working directory contained an invalid path component');
    }
    if (
      !matchesDirectoryIdentity(fs, runRoot, runRootIdentity) ||
      !matchesDirectoryIdentity(fs, parentPath, parentIdentity)
    ) {
      throw new Error('journey working directory ancestor identity changed');
    }

    const childPath = join(parentPath, component);
    let childIdentity = captureOptionalDirectoryIdentity(fs, childPath);
    if (requireAbsentLeaf && index === components.length - 1 && childIdentity !== null) {
      throw new Error('journey working directory leaf already existed');
    }
    if (childIdentity === null) {
      // Deliberately avoid recursive mkdir: it follows a substituted ancestor
      // before that ancestor can be validated. Pin the parent on both sides of
      // the single-component create instead.
      if (!matchesDirectoryIdentity(fs, parentPath, parentIdentity)) {
        throw new Error('journey working directory ancestor identity changed');
      }
      fs.mkdirSync(childPath);
      if (!matchesDirectoryIdentity(fs, parentPath, parentIdentity)) {
        throw new Error('journey working directory ancestor identity changed');
      }
      childIdentity = captureDirectoryIdentity(fs, childPath);
    }
    if (!isUnderOrEqual(runRootIdentity.realpath, childIdentity.realpath)) {
      throw new Error('journey working directory was not a concrete descendant of the run root');
    }
    if (
      state.journeysRootIdentity !== null &&
      childPath === state.journeysRoot &&
      !matchesDirectoryIdentity(fs, childPath, state.journeysRootIdentity)
    ) {
      throw new Error('journeys working-directory root identity changed');
    }
    parentPath = childPath;
    parentIdentity = childIdentity;
  }
  return parentIdentity;
}

function captureOptionalDirectoryIdentity(fs, path) {
  try {
    return captureDirectoryIdentity(fs, path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
}

function candidatePeerResolutionAnchor(workRoot, fixture) {
  return join(
    workRoot,
    'opensip-cli',
    '.runtime',
    'plugins',
    fixture.domain,
    'node_modules',
    fixture.packageName,
    'index.js',
  );
}

function clearCandidatePeerBridge(state) {
  if (state.candidatePeerBridge === null) return;
  removeCandidatePeerBridge(state.candidatePeerBridge, {
    runRoot: state.runRoot,
    fs: state.fs,
  });
  state.candidatePeerBridge = null;
}

function buildContext(state, journey, workRoot, port, artifacts) {
  const context = {
    installed: state.installedView,
    paths: Object.freeze({ workRoot }),
    fixtures: state.fixturesView,
    process: port,
    assert: makeAssertHelpers(state),
  };
  if (typeof state.lifecycle.npmInvocation === 'function') {
    context.toolchain = Object.freeze({
      node: Object.freeze({ argv: Object.freeze([process.execPath]) }),
      npm: state.lifecycle.npmInvocation(),
    });
  }
  if (state.registryInventory !== null) {
    context.registryInventory = state.registryInventory;
  }
  if (journey.category === 'mcp' && state.mcpConnector !== null) {
    context.mcp = state.mcpConnector;
  }
  if (artifacts !== undefined) context.artifacts = artifacts;
  return Object.freeze(context);
}

function copyRegistryBindingEvidence(proof) {
  if (proof === null || typeof proof !== 'object' || !Array.isArray(proof.packageNames)) {
    throw new TypeError('registry binding proof was malformed');
  }
  return Object.freeze({
    inventoryDigest: proof.inventoryDigest,
    packageNames: Object.freeze([...proof.packageNames]),
    packageCount: proof.packageCount,
    packageSetDigest: proof.packageSetDigest,
    offlineReplayComplete: proof.offlineReplayComplete,
  });
}

function recordTargetInstallEvidence(state, event) {
  const channel = event.facts?.installChannel;
  if (
    channel === 'canonical-installer' ||
    channel === 'npm-direct' ||
    channel === 'packed-consumer'
  ) {
    state.lifecycleEvidence.targetInstallChannel = channel;
  }
  const proof = event.facts?.registryBinding;
  if (proof == null) return;
  state.registryBindings.candidateLifecycle = copyRegistryBindingEvidence(proof);
  if (channel === 'canonical-installer') {
    state.registryBindings.canonicalInstaller = copyRegistryBindingEvidence(proof);
  }
}

/** Build the one-shot agent-only auxiliary writer + completion tracker. */
function createAgentArtifactTracker(state, journey) {
  const outPath = state.options.agentReportOutPath;
  if (journey.id !== 'agent.installed-smoke' || typeof outPath !== 'string') return null;

  let attempted = false;
  let succeeded = false;
  const surface = Object.freeze({
    writeInstalledAgentReport(report) {
      if (attempted) {
        throw new AgentReportWriteError(
          AGENT_REPORT_WRITE_REASONS.ALREADY_ATTEMPTED,
          'the installed agent report writer is one-shot',
        );
      }
      attempted = true;
      const result = state.writeAgentReport({
        report,
        outPath,
        runRoot: state.runRoot,
        repoRoot: state.options.repoRoot,
        maxBytes: state.bounds.maxEvidenceBytes,
      });
      succeeded = true;
      return result;
    },
  });
  return {
    get succeeded() {
      return succeeded;
    },
    surface,
  };
}

/** The bounded, side-effect-free assertion helpers a journey reads. */
function makeAssertHelpers(state) {
  const toAssertable = (result) => ({
    stdout: result.stdoutCapture ?? '',
    stderr: result.stderrTail ?? '',
    exitCode: Number.isSafeInteger(result?.status) ? result.status : null,
  });
  const terminalFailures = (result) => {
    const failures = [];
    if (result?.timedOut === true) failures.push('process timed out');
    if (result?.cancelled === true) failures.push('process was cancelled');
    if (typeof result?.signal === 'string' && result.signal.length > 0) {
      failures.push(`process terminated by ${result.signal}`);
    }
    if (!Number.isSafeInteger(result?.status) && result?.signal == null) {
      failures.push('process had no terminal exit status');
    }
    return failures;
  };
  return Object.freeze({
    toAssertable,
    check: (result, expect) => [
      ...terminalFailures(result),
      ...checkScenario(toAssertable(result), expect),
    ],
    envelope: (opts) => expectEnvelope(opts ?? {}),
    diagnostic: (text) =>
      boundedDiagnostic(redactDiagnosticText(text, state), state.bounds.maxDiagnosticTailBytes),
  });
}

function readPortRss(port) {
  if (typeof port.rssMeasurement === 'function') return port.rssMeasurement();
  return { status: 'unavailable', reasonCode: 'rss-not-sampled' };
}

function journeyRss(state, journey, port) {
  const processRss = readPortRss(port);
  if (journey.category !== 'mcp' || typeof state.mcpConnector?.rssMeasurement !== 'function') {
    return processRss;
  }
  return mergeRssMeasurements(processRss, state.mcpConnector.rssMeasurement());
}

function trackProcessIntegrity(port, state, faults, steps, afterMeasuredRun = null) {
  if (!port || typeof port.run !== 'function') {
    throw new TypeError('measured process port must expose run(spec)');
  }
  let invocation = 0;
  const tracked = {
    async run(spec) {
      invocation += 1;
      const label = `process-${invocation}`;
      const startedAt = state.clock.now();
      let result;
      try {
        result = await port.run(spec);
      } catch (error) {
        const step = normalizeStepEvidence(
          {
            label,
            stage: 'process',
            exitCode: null,
            signal: null,
            timedOut: false,
            cancelled: false,
            outputTruncated: false,
            durationMs: state.clock.now() - startedAt,
            rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
            residualDescendants: 0,
            reasonCode: 'spawn-unavailable',
            diagnostics: [redactError(error)],
          },
          state,
        );
        appendStepEvidence(steps, step, faults);
        faults.push({
          reasonCode: 'spawn-unavailable',
          diagnostic: 'a measured child failed before returning a terminal result',
        });
        throw error;
      }
      const step = measuredProcessStep(result, label, state);
      appendStepEvidence(steps, step, faults);
      if (result?.outputTruncated === true) {
        faults.push({
          reasonCode: 'output-overflow',
          diagnostic: 'a measured child exceeded its bounded stdout or stderr capture',
        });
      }
      const reportedResidual = result?.cleanup?.residualDescendants;
      const residual =
        Number.isSafeInteger(reportedResidual) && reportedResidual >= 0 ? reportedResidual : 1;
      if (residual > 0) {
        state.processResidualDescendants += residual;
        faults.push({
          reasonCode: 'cleanup-failed',
          diagnostic: `a measured child left ${residual} residual descendant(s)`,
        });
      }
      if (afterMeasuredRun !== null) afterMeasuredRun();
      return result;
    },
  };
  if (typeof port.rssMeasurement === 'function') {
    tracked.rssMeasurement = () => port.rssMeasurement();
  }
  return Object.freeze(tracked);
}

function measuredProcessStep(result, label, state) {
  const normalized = {
    status: Number.isSafeInteger(result?.status) && result.status >= 0 ? result.status : null,
    signal: typeof result?.signal === 'string' && result.signal.length > 0 ? result.signal : null,
    deliveredSignal:
      typeof result?.deliveredSignal === 'string' && result.deliveredSignal.length > 0
        ? result.deliveredSignal
        : null,
    timedOut: result?.timedOut === true,
    cancelled: result?.cancelled === true,
    outputTruncated: result?.outputTruncated === true,
    durationMs:
      typeof result?.durationMs === 'number' && Number.isFinite(result.durationMs)
        ? result.durationMs
        : 0,
    rss: normalizeRss(result?.rss),
    cleanup: {
      residualDescendants:
        Number.isSafeInteger(result?.cleanup?.residualDescendants) &&
        result.cleanup.residualDescendants >= 0
          ? result.cleanup.residualDescendants
          : 1,
    },
  };
  const reasonCode = classifyMeasuredOutcome(normalized);
  return normalizeStepEvidence(
    {
      label,
      stage: 'process',
      exitCode: normalized.status,
      signal: normalized.signal,
      deliveredSignal: normalized.deliveredSignal,
      timedOut: normalized.timedOut,
      cancelled: normalized.cancelled,
      outputTruncated: normalized.outputTruncated,
      durationMs: normalized.durationMs,
      rss: normalized.rss,
      residualDescendants: normalized.cleanup.residualDescendants,
      reasonCode,
      diagnostics:
        reasonCode === null || typeof result?.stderrTail !== 'string' ? [] : [result.stderrTail],
    },
    state,
  );
}

function normalizeStepEvidence(raw, state) {
  const signal =
    typeof raw?.signal === 'string' && /^SIG[A-Z0-9]+$/.test(raw.signal) ? raw.signal : null;
  const hasDeliveredSignal = Object.hasOwn(raw ?? {}, 'deliveredSignal');
  const deliveredSignal =
    typeof raw?.deliveredSignal === 'string' && /^SIG[A-Z0-9]+$/.test(raw.deliveredSignal)
      ? raw.deliveredSignal
      : null;
  // A platform wrapper can synthesize 128+signal while still preserving the
  // actual POSIX terminal signal. The contract is exclusive, so the real
  // signal wins over that derived numeric status.
  const exitCode =
    signal === null && Number.isSafeInteger(raw?.exitCode) && raw.exitCode >= 0
      ? raw.exitCode
      : null;
  const timedOut = raw?.timedOut === true;
  const cancelled = !timedOut && raw?.cancelled === true;
  const outputTruncated = raw?.outputTruncated === true;
  const residualDescendants =
    Number.isSafeInteger(raw?.residualDescendants) && raw.residualDescendants >= 0
      ? raw.residualDescendants
      : 1;
  const abnormal =
    exitCode === null ||
    exitCode !== 0 ||
    signal !== null ||
    timedOut ||
    cancelled ||
    outputTruncated ||
    residualDescendants > 0;
  return Object.freeze({
    label: safeReason(raw?.label) ?? 'step-unknown',
    stage: STEP_STAGES.has(raw?.stage) ? raw.stage : 'process',
    exitCode,
    signal,
    ...(hasDeliveredSignal ? { deliveredSignal } : {}),
    timedOut,
    cancelled,
    outputTruncated,
    durationMs:
      typeof raw?.durationMs === 'number' && Number.isFinite(raw.durationMs)
        ? Math.max(0, Math.round(raw.durationMs))
        : 0,
    rss: normalizeRss(raw?.rss),
    residualDescendants,
    reasonCode: abnormal ? (safeReason(raw?.reasonCode) ?? 'command-failed') : null,
    diagnostics: Object.freeze(
      boundDiagnostics(raw?.diagnostics, state).slice(0, MAX_DIAGNOSTICS_PER_STEP),
    ),
  });
}

function appendStepEvidence(steps, step, faults) {
  if (steps.length < MAX_STEPS_PER_JOURNEY) {
    steps.push(step);
    return;
  }
  if (!faults.some((fault) => fault.reasonCode === 'step-evidence-overflow')) {
    faults.push({
      reasonCode: 'step-evidence-overflow',
      diagnostic: `journey exceeded the ${MAX_STEPS_PER_JOURNEY}-step evidence bound`,
    });
  }
}

function takeMcpStepEvidence(state, faults) {
  const connector = state.mcpConnector;
  if (typeof connector?.takeStepEvidence !== 'function') return [];
  let rawSteps;
  try {
    rawSteps = connector.takeStepEvidence();
  } catch {
    faults.push({
      reasonCode: 'mcp-evidence-unavailable',
      diagnostic: 'the MCP connector failed to return terminal step evidence',
    });
    return [];
  }
  if (!Array.isArray(rawSteps)) {
    faults.push({
      reasonCode: 'mcp-evidence-unavailable',
      diagnostic: 'the MCP connector returned invalid terminal step evidence',
    });
    return [];
  }
  const steps = [];
  for (const raw of rawSteps) {
    const step = normalizeStepEvidence(raw, state);
    appendStepEvidence(steps, step, faults);
    if (step.outputTruncated) {
      faults.push({
        reasonCode: 'output-overflow',
        diagnostic: 'an MCP child exceeded its bounded stderr capture',
      });
    }
    if (step.residualDescendants > 0) {
      state.processResidualDescendants += step.residualDescendants;
      faults.push({
        reasonCode: 'cleanup-failed',
        diagnostic: `an MCP child left ${step.residualDescendants} residual descendant(s)`,
      });
    }
    if (step.reasonCode !== null && !step.outputTruncated && step.residualDescendants === 0) {
      faults.push({
        reasonCode: 'mcp-process-integrity-failed',
        diagnostic: `an MCP child ended with ${step.reasonCode}`,
      });
    }
  }
  return steps;
}

function enforceProcessFaults(state, faults) {
  if (faults.length === 0) return null;
  const selected = faults.find((fault) => fault.reasonCode === 'cleanup-failed') ?? faults[0];
  state.infraReason ??=
    selected.reasonCode === 'cleanup-failed' ? R.CLEANUP_INTEGRITY_FAILED : selected.reasonCode;
  state.stopped = { reasonCode: state.infraReason };
  return selected;
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

function makeSemanticSkipResult(state, journey, reasonCode, required = false) {
  const diagnostic =
    reasonCode === R.CANDIDATE_KIND_NOT_APPLICABLE
      ? `journey does not apply to the ${state.candidate.kind} candidate kind`
      : 'no exact previous candidate was supplied';
  return makeResult(state, journey, required, {
    status: 'skipped',
    reasonCode,
    diagnostics: [diagnostic],
    durationMs: 0,
    rss: { status: 'unavailable', reasonCode: 'rss-not-sampled' },
    steps: [],
  });
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
    diagnostics: boundDiagnostics(fields.diagnostics, state),
    steps: Object.freeze(
      (fields.steps ?? [])
        .slice(0, MAX_STEPS_PER_JOURNEY)
        .map((step) => normalizeStepEvidence(step, state)),
    ),
  });
}

function normalizeRss(rss) {
  if (rss && rss.status === 'available' && Number.isFinite(rss.peakBytes) && rss.peakBytes >= 0) {
    return Object.freeze({
      status: 'available',
      peakBytes: Math.round(rss.peakBytes),
    });
  }
  const reasonCode = safeReason(rss?.reasonCode) ?? 'rss-not-sampled';
  return Object.freeze({ status: 'unavailable', reasonCode });
}

function mergeRssMeasurements(...measurements) {
  let peak = 0;
  let reasonCode = 'rss-not-sampled';
  for (const measurement of measurements) {
    const normalized = normalizeRss(measurement);
    if (normalized.status === 'available') peak = Math.max(peak, normalized.peakBytes);
    else reasonCode = normalized.reasonCode;
  }
  return peak > 0
    ? Object.freeze({ status: 'available', peakBytes: peak })
    : Object.freeze({ status: 'unavailable', reasonCode });
}

// Reason codes that indicate a HARNESS prerequisite gap (e.g. the private
// agent-eval build is missing), not a candidate defect. A journey that reports
// one of these is an infrastructure fault: the harness could not produce
// trustworthy evidence, so the whole run's verdict is `infrastructure-fault`
// (exit 3) rather than a candidate `fail` (exit 1). See ADR-0164 / Plan 04.2.6.
const HARNESS_INFRA_REASONS = new Set([
  'agent-eval-harness-missing',
  'agent-eval-harness-unloadable',
  R.FIXTURES_UNAVAILABLE,
  'core-support-policy-unavailable',
  'mcp-port-missing',
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
  for (const step of result.steps ?? []) {
    bytes += PER_RESULT_EVIDENCE_OVERHEAD;
    for (const diagnostic of step.diagnostics) bytes += Buffer.byteLength(diagnostic, 'utf8');
  }
  state.evidenceBytes += bytes;
  if (state.evidenceBytes > state.bounds.maxEvidenceBytes && !state.stopped) {
    state.infraReason = R.EVIDENCE_BOUND_EXHAUSTED;
    state.stopped = { reasonCode: R.EVIDENCE_BOUND_EXHAUSTED };
  }
}

function verifyCandidateIntegrity(state) {
  const startedAt = state.clock.now();
  try {
    if (typeof state.lifecycle?.verifyInstalledIntegrity === 'function') {
      const result = state.lifecycle.verifyInstalledIntegrity();
      return result?.ok === true
        ? { ok: true, reasonCode: null }
        : {
            ok: false,
            reasonCode:
              typeof result?.reasonCode === 'string'
                ? result.reasonCode
                : 'installed-candidate-changed',
          };
    }
    // Compatibility for injected test doubles: production CandidateLifecycle
    // always exposes the identity verifier.
    const bin = state.installedView?.installedBin?.bin;
    return typeof bin === 'string' && state.fs.existsSync(bin)
      ? { ok: true, reasonCode: null }
      : { ok: false, reasonCode: 'installed-candidate-unavailable' };
  } finally {
    const elapsedMs = Math.max(0, Math.round(state.clock.now() - startedAt));
    state.lifecycleEvidence.integrityChecks.count += 1;
    state.lifecycleEvidence.integrityChecks.durationMs += elapsedMs;
  }
}

function ensureTerminalCandidateIntegrity(state) {
  if (
    state.installedView === null ||
    state.removalBoundaryIntegrityChecked ||
    state.lifecycleEvidence.packageRemoved === true ||
    state.infraReason === R.CANDIDATE_LOST
  ) {
    return;
  }
  state.removalBoundaryIntegrityChecked = true;
  const integrity = verifyCandidateIntegrity(state);
  if (!integrity.ok) {
    state.infraReason = R.CANDIDATE_LOST;
    state.stopped = { reasonCode: R.CANDIDATE_LOST };
  }
}

/** Propagate cancellation observed while a journey was executing. */
function postJourneyStopChecks(state) {
  if (state.stopped) return;
  if (state.options.signal?.aborted) {
    state.infraReason = R.RUN_CANCELLED;
    state.stopped = { reasonCode: R.RUN_CANCELLED };
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function finalizeCleanup(state) {
  const { fs, runRoot, runRootIdentity, lifecycle } = state;
  let removedRoots = 0;
  let residual = state.processResidualDescendants;
  let escape = false;
  let reasonCode = null;

  // Candidate code ran below this path. If it renamed/replaced the root, no
  // recursive cleanup target is trustworthy anymore—not even one that now
  // resolves beneath a different directory with the same child names.
  if (!matchesDirectoryIdentity(fs, runRoot, runRootIdentity)) {
    return Object.freeze({
      status: 'incomplete',
      reasonCode: R.ROOT_ESCAPE,
      removedRoots: 0,
      residualDescendants: Math.max(1, residual),
    });
  }

  try {
    clearCandidatePeerBridge(state);
  } catch {
    reasonCode = R.ROOT_ESCAPE;
  }

  // 1. The lifecycle removes its own hermetic install/home/npm state.
  let lifecycleCleanup = {
    status: 'clean',
    reasonCode: null,
    removedRoots: 0,
    residualDescendants: 0,
  };
  try {
    const removableStates = new Set(['installed', 'upgraded', 'cli-state-removed']);
    if (
      !state.lifecycleAttempted.has('lifecycle.package-uninstall') &&
      removableStates.has(lifecycle.state)
    ) {
      const removal = await lifecycle.removePackage();
      state.lifecycleAttempted.add('lifecycle.package-uninstall');
      attachLifecycleCleanupSteps(state, 'lifecycle.package-uninstall', removal.steps ?? []);
      if (removal.ok) {
        state.lifecycleEvidence.packageRemoved =
          removal.facts?.shimAbsent === true && removal.facts?.entrypointAbsent === true;
      }
      if (!removal.ok) reasonCode = removal.reasonCode ?? R.CLEANUP_INTEGRITY_FAILED;
    }
    lifecycleCleanup = await lifecycle.cleanup();
  } catch {
    reasonCode = R.CLEANUP_INTEGRITY_FAILED;
  }
  removedRoots += lifecycleCleanup.removedRoots ?? 0;
  residual +=
    Number.isSafeInteger(lifecycleCleanup.residualDescendants) &&
    lifecycleCleanup.residualDescendants >= 0
      ? lifecycleCleanup.residualDescendants
      : 1;
  if (lifecycleCleanup.status !== 'clean') {
    reasonCode ??= lifecycleCleanup.reasonCode ?? R.CLEANUP_INTEGRITY_FAILED;
  }

  // npm uninstall scripts and lifecycle cleanup are effectful. Revalidate the
  // runner root before touching its sibling journey/fixture directories.
  if (!matchesDirectoryIdentity(fs, runRoot, runRootIdentity)) {
    return Object.freeze({
      status: 'incomplete',
      reasonCode: R.ROOT_ESCAPE,
      removedRoots,
      residualDescendants: Math.max(1, residual),
    });
  }

  // 2. The runner removes its own roots (journeys/fixtures), realpath-guarded.
  const runRootReal = runRootIdentity.realpath;
  for (const child of ['journeys', 'fixtures', 'candidate']) {
    if (!matchesDirectoryIdentity(fs, runRoot, runRootIdentity)) {
      escape = true;
      break;
    }
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
  if (matchesDirectoryIdentity(fs, runRoot, runRootIdentity)) {
    try {
      fs.rmSync(runRoot, { recursive: true, force: true });
      removedRoots += 1;
    } catch {
      residual += 1;
    }
  } else {
    escape = true;
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

function attachLifecycleCleanupSteps(state, journeyId, rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return;
  const index = state.results.findIndex((result) => result.id === journeyId);
  if (index < 0) return;
  const existing = state.results[index];
  const steps = [...(existing.steps ?? [])];
  for (const raw of rawSteps) {
    if (steps.length >= MAX_STEPS_PER_JOURNEY) break;
    steps.push(normalizeStepEvidence(raw, state));
  }
  state.results[index] = Object.freeze({
    ...existing,
    steps: Object.freeze(steps),
  });
}

function bestEffortRemove(fs, runRoot, target, runRootIdentity) {
  try {
    if (!matchesDirectoryIdentity(fs, runRoot, runRootIdentity)) return;
    const real = fs.realpathSync(target);
    if (isUnderOrEqual(runRootIdentity.realpath, real))
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
    installChannel: installed.installChannel,
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

function loadProfile(readProfile, profilePath, repoRoot) {
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
    return {
      ok: false,
      reasonCode: R.PROFILE_NOT_FOUND,
      message: redactError(error),
    };
  }
  try {
    let profile = parseAcceptanceProfile(raw);
    if (profile.base) {
      if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
        throw new Error('repo root is required to resolve a derived profile base');
      }
      const basePath = join(repoRoot, '.config', 'platform-acceptance', `${profile.base.id}.json`);
      const base = parseAcceptanceProfile(readProfile(basePath));
      profile = composeProfile(base, raw);
    }
    return { ok: true, profile, digest: profileDigest(profile) };
  } catch (error) {
    return {
      ok: false,
      reasonCode: R.PROFILE_INVALID,
      message: redactError(error),
    };
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

function normalizeExecutionIdentity(execution, platform) {
  const runId =
    typeof execution?.runId === 'string' && execution.runId.length > 0 ? execution.runId : 'local';
  const runAttempt =
    Number.isSafeInteger(execution?.runAttempt) && execution.runAttempt > 0
      ? execution.runAttempt
      : 1;
  const runnerLabel =
    typeof execution?.runnerLabel === 'string' && execution.runnerLabel.length > 0
      ? execution.runnerLabel
      : `local-${platform}`;
  return Object.freeze({ runId, runAttempt, runnerLabel });
}

function redactError(error) {
  return redactMessage(error instanceof Error ? error.message : String(error));
}

function redactMessage(message) {
  return boundedDiagnostic(String(message ?? ''), 1024);
}
