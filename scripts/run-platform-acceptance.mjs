#!/usr/bin/env node
/**
 * @fileoverview Repository-internal entry point for the installed-artifact
 * platform-acceptance harness.
 *
 * It parses a CLOSED CLI grammar, drives `runPlatformAcceptance`, seals + writes
 * ONE atomic evidence artifact, and renders a bounded summary. It is called only
 * by package scripts / release workflows; it does NOT mount through Commander or
 * the Tool registry and never appears in `agent-catalog`.
 *
 * Grammar:
 *   node scripts/run-platform-acceptance.mjs
 *     --profile <path>
 *     ( --packed-release <dir> --expected-version <semver>
 *     | --published-version <semver> --expected-registry-integrity-digest <sha256>
 *       --registry-integrity-inventory <path>
 *       [--previous-version <semver>] [--registry <https-url>] )
 *     --out <path>
 *     [--agent-report-out <path>]
 *     [--expected-manifest-digest <sha256>]
 *     [--expected-registry-integrity-digest <sha256>]
 *     [--run-id <id>] [--run-attempt <n>] [--runner-label <label>]
 *     [--json-summary]
 *
 * Exit codes (Phase 0 contract):
 *   0  pass
 *   1  a completed profile with an unsatisfied required journey
 *   2  invalid invocation / profile / candidate
 *   3  infrastructure fault before trustworthy evidence
 *
 * `process.exitCode` is set ONLY at this top-level boundary.
 */

import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parentSignalCoordinator } from './lib/measured-process.mjs';
import {
  renderFailureDetailLines,
  renderHumanSummaryLines,
  renderJsonSummary,
  writeAcceptanceEvidence,
} from './platform-acceptance/evidence-writer.mjs';
import { RUN_OUTCOMES, runPlatformAcceptance } from './platform-acceptance/runner.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const HELP = `platform-acceptance — installed-artifact qualification harness

Usage:
  node scripts/run-platform-acceptance.mjs --profile <path> <candidate> --out <path> [--json-summary]

Candidate (exactly one form):
  --packed-release <dir> --expected-version <semver>
      Qualify freshly-packed release tarballs in <dir>.
  --published-version <semver> --expected-registry-integrity-digest <sha256>
      --registry-integrity-inventory <path>
      [--previous-version <semver>] [--registry <https-url>]
      Qualify an exact published version (optionally upgrading FROM --previous-version).

Required:
  --profile <path>   data-only acceptance profile JSON
  --out <path>       absolute evidence artifact path (must be outside the run root)

Options:
  --agent-report-out <path>
                     preserve a bounded sanitized installed-agent report outside the run root
  --expected-manifest-digest <sha256>
                     bind the candidate to an exact release manifest
  --expected-registry-integrity-digest <sha256>
                     bind a published candidate to the complete npm integrity inventory
  --registry-integrity-inventory <path>
                     canonical inventory file whose exact registry bytes must be installed
  --run-id <id>      workflow run identity (defaults to GITHUB_RUN_ID or local)
  --run-attempt <n>  positive workflow attempt (defaults to GITHUB_RUN_ATTEMPT or 1)
  --runner-label <label>
                     pinned runner/image label (defaults to ImageOS/RUNNER_OS/platform)
  --json-summary     print exactly one JSON summary object to stdout
  -h, --help         print this help and exit 0

Exit codes: 0 pass · 1 required journey unsatisfied · 2 invalid invocation · 3 infrastructure fault`;

const VALUE_FLAGS = new Set([
  '--profile',
  '--out',
  '--agent-report-out',
  '--packed-release',
  '--expected-version',
  '--published-version',
  '--previous-version',
  '--registry',
  '--expected-manifest-digest',
  '--expected-registry-integrity-digest',
  '--registry-integrity-inventory',
  '--run-id',
  '--run-attempt',
  '--runner-label',
]);
const BOOLEAN_FLAGS = new Set(['--json-summary']);
const MAX_EXECUTION_ID_LENGTH = 128;
const GIT_SHA = /^[a-f0-9]{7,64}$/;

/** True when a value contains a C0/C1 control character. */
function hasControlChars(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function executionString(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_EXECUTION_ID_LENGTH ||
    hasControlChars(value)
  ) {
    return invalid(`${label} must be 1-${MAX_EXECUTION_ID_LENGTH} characters without controls`);
  }
  return { ok: true, value };
}

function executionAttempt(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return invalid(`${label} must be a positive safe integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return invalid(`${label} must be a positive safe integer`);
  }
  return { ok: true, value: parsed };
}

function firstExecutionSource(sources, fallback) {
  for (const source of sources) {
    if (source.value === undefined) continue;
    return source;
  }
  return fallback;
}

function executionIdentity(flags, env) {
  const runIdSource = firstExecutionSource(
    [
      { label: '--run-id', value: flags['--run-id'] },
      { label: 'GITHUB_RUN_ID', value: env.GITHUB_RUN_ID },
    ],
    { label: 'run identity', value: 'local' },
  );
  const attemptSource = firstExecutionSource(
    [
      { label: '--run-attempt', value: flags['--run-attempt'] },
      { label: 'GITHUB_RUN_ATTEMPT', value: env.GITHUB_RUN_ATTEMPT },
    ],
    { label: 'run attempt', value: '1' },
  );
  const runnerSource = firstExecutionSource(
    [
      { label: '--runner-label', value: flags['--runner-label'] },
      { label: 'ImageOS', value: env.ImageOS },
      { label: 'RUNNER_OS', value: env.RUNNER_OS },
    ],
    { label: 'runner label', value: `local-${process.platform}` },
  );

  const runId = executionString(runIdSource.value, runIdSource.label);
  if (!runId.ok) return runId;
  const runAttempt = executionAttempt(attemptSource.value, attemptSource.label);
  if (!runAttempt.ok) return runAttempt;
  const runnerLabel = executionString(runnerSource.value, runnerSource.label);
  if (!runnerLabel.ok) return runnerLabel;
  return {
    ok: true,
    value: {
      runId: runId.value,
      runAttempt: runAttempt.value,
      runnerLabel: runnerLabel.value,
    },
  };
}

function parseArgs(argv, env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const seen = new Map();
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    // pnpm 11 (and some npm versions) forward the bare `--` script separator
    // as argv (`pnpm platform:acceptance -- --profile …` → `["--", "--profile", …]`).
    // Ignore end-of-options markers so package-script and direct-node invocations match.
    if (token === '--') continue;
    if (typeof token !== 'string' || !token.startsWith('--')) {
      return invalid(`unexpected argument ${JSON.stringify(token)}`);
    }
    if (seen.has(token)) return invalid(`duplicate flag ${token}`);
    seen.set(token, true);
    if (BOOLEAN_FLAGS.has(token)) {
      flags[token] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(token)) return invalid(`unknown flag ${token}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return invalid(`flag ${token} requires a value`);
    }
    if (value.length === 0 || hasControlChars(value)) {
      return invalid(`flag ${token} has an invalid value`);
    }
    flags[token] = value;
    i += 1;
  }

  if (flags['--profile'] === undefined) return invalid('--profile is required');
  if (flags['--out'] === undefined) return invalid('--out is required');
  if (!isAbsolute(flags['--out'])) return invalid('--out must be an absolute path');
  if (flags['--agent-report-out'] !== undefined && !isAbsolute(flags['--agent-report-out'])) {
    return invalid('--agent-report-out must be an absolute path');
  }
  if (
    flags['--registry-integrity-inventory'] !== undefined &&
    !isAbsolute(flags['--registry-integrity-inventory'])
  ) {
    return invalid('--registry-integrity-inventory must be an absolute path');
  }
  if (
    flags['--agent-report-out'] !== undefined &&
    resolve(flags['--agent-report-out']) === resolve(flags['--out'])
  ) {
    return invalid('--agent-report-out must differ from --out');
  }

  const hasPacked = flags['--packed-release'] !== undefined;
  const hasPublished = flags['--published-version'] !== undefined;
  if (hasPacked && hasPublished) {
    return invalid('--packed-release and --published-version are mutually exclusive');
  }
  if (!hasPacked && !hasPublished) {
    return invalid('one candidate form (--packed-release or --published-version) is required');
  }
  if (!hasPacked && flags['--expected-version'] !== undefined) {
    return invalid('--expected-version is only valid with --packed-release');
  }
  if (hasPacked && flags['--expected-version'] === undefined) {
    return invalid('--expected-version is required with --packed-release');
  }
  if (!hasPublished && flags['--previous-version'] !== undefined) {
    return invalid('--previous-version is only valid with --published-version');
  }
  if (!hasPublished && flags['--registry'] !== undefined) {
    return invalid('--registry is only valid with --published-version');
  }
  if (
    flags['--expected-manifest-digest'] !== undefined &&
    !/^[a-f0-9]{64}$/.test(flags['--expected-manifest-digest'])
  ) {
    return invalid('--expected-manifest-digest must be a 64-character lowercase SHA-256 digest');
  }
  if (
    flags['--expected-registry-integrity-digest'] !== undefined &&
    !/^[a-f0-9]{64}$/.test(flags['--expected-registry-integrity-digest'])
  ) {
    return invalid(
      '--expected-registry-integrity-digest must be a 64-character lowercase SHA-256 digest',
    );
  }
  if (hasPacked && flags['--expected-registry-integrity-digest'] !== undefined) {
    return invalid('--expected-registry-integrity-digest is only valid with --published-version');
  }
  if (hasPacked && flags['--registry-integrity-inventory'] !== undefined) {
    return invalid('--registry-integrity-inventory is only valid with --published-version');
  }
  if (hasPublished && flags['--expected-registry-integrity-digest'] === undefined) {
    return invalid('--expected-registry-integrity-digest is required with --published-version');
  }
  if (hasPublished && flags['--registry-integrity-inventory'] === undefined) {
    return invalid('--registry-integrity-inventory is required with --published-version');
  }
  const execution = executionIdentity(flags, env);
  if (!execution.ok) return execution;

  let candidate;
  if (hasPacked) {
    const primary = { kind: 'packed-release', directory: flags['--packed-release'] };
    if (flags['--expected-version'] !== undefined)
      primary.expectedVersion = flags['--expected-version'];
    if (flags['--expected-manifest-digest'] !== undefined)
      primary.manifestDigest = flags['--expected-manifest-digest'];
    candidate = { primary };
  } else {
    const primary = { kind: 'published-version', version: flags['--published-version'] };
    if (flags['--registry'] !== undefined) primary.registry = flags['--registry'];
    if (flags['--expected-manifest-digest'] !== undefined)
      primary.manifestDigest = flags['--expected-manifest-digest'];
    primary.registryIntegrityDigest = flags['--expected-registry-integrity-digest'];
    candidate = { primary };
    if (flags['--previous-version'] !== undefined) {
      const previous = { kind: 'published-version', version: flags['--previous-version'] };
      if (flags['--registry'] !== undefined) previous.registry = flags['--registry'];
      candidate.previous = previous;
    }
  }

  return {
    ok: true,
    profilePath: flags['--profile'],
    outPath: flags['--out'],
    agentReportOutPath: flags['--agent-report-out'],
    registryInventoryPath: flags['--registry-integrity-inventory'],
    jsonSummary: flags['--json-summary'] === true,
    candidate,
    execution: execution.value,
  };
}

function invalid(message) {
  return { ok: false, message };
}

function resolveHarnessGitSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return GIT_SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function humanStage(event, stderr = process.stderr) {
  const reason = event.reasonCode ? ` ${event.reasonCode}` : '';
  const id = event.id ? ` ${event.id}` : '';
  stderr.write(`[acceptance] ${event.stage}${id}${reason} (${event.durationMs}ms)\n`);
}

/** Map a completed/infra result to an exit code (never for invalid-invocation). */
function exitCodeForVerdict(result) {
  if (result.outcome === RUN_OUTCOMES.INFRASTRUCTURE_FAULT) return 3;
  return result.verdict === 'pass' ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const coordinator = runtime.parentSignalCoordinator ?? parentSignalCoordinator;
  const runAcceptance = runtime.runPlatformAcceptance ?? runPlatformAcceptance;
  const writeEvidence = runtime.writeAcceptanceEvidence ?? writeAcceptanceEvidence;
  const emitResultSummary = runtime.emitSummary ?? emitSummary;
  const parsed = parseArgs(argv, runtime.env ?? process.env);
  if (parsed.help) {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!parsed.ok) {
    stderr.write(`platform-acceptance: ${parsed.message}\n`);
    return 2;
  }

  const harnessGitSha = runtime.harnessGitSha ?? resolveHarnessGitSha();
  if (typeof harnessGitSha !== 'string' || !GIT_SHA.test(harnessGitSha)) {
    stderr.write('platform-acceptance: infrastructure fault (harness-git-sha-unavailable)\n');
    return 3;
  }

  const controller = new AbortController();
  let resolveFinalization;
  const finalization = new Promise((resolveFinalized) => {
    resolveFinalization = resolveFinalized;
  });
  // One coordinator owns the original parent signal across the entire harness.
  // Its cleanup callback aborts the runner immediately but does not settle until
  // cleanup, evidence sealing, and summary output have all finished. Only then
  // may the coordinator restore the native SIGINT/SIGTERM termination semantics.
  const unregisterFinalization = coordinator.register(() => {
    controller.abort();
    return finalization;
  });

  try {
    const result = await runAcceptance(
      {
        profilePath: parsed.profilePath,
        candidate: parsed.candidate,
        repoRoot: REPO_ROOT,
        harnessGitSha,
        agentReportOutPath: parsed.agentReportOutPath,
        registryInventoryPath: parsed.registryInventoryPath,
        execution: parsed.execution,
        signal: controller.signal,
        parentSignalCoordinator: coordinator,
      },
      { onProgress: parsed.jsonSummary ? undefined : (event) => humanStage(event, stderr) },
    );

    // Invalid invocation (bad profile / candidate) — exit 2, no artifact.
    if (result.outcome === RUN_OUTCOMES.INVALID_INVOCATION) {
      stderr.write(
        `platform-acceptance: invalid invocation (${result.reasonCode}): ${result.message ?? ''}\n`,
      );
      return 2;
    }

    // Completed or infrastructure fault — attempt a valid, sealed, atomic artifact.
    let written;
    try {
      written = writeEvidence({
        evidence: result.evidence,
        completionState: result.completionState,
        outPath: parsed.outPath,
        maxEvidenceBytes: result.maxEvidenceBytes ?? undefined,
        runRoot: result.runRoot,
      });
    } catch (error) {
      // The write itself failed (or there was no trustworthy evidence to seal):
      // print ONE redacted, bounded error and treat as an infrastructure fault.
      const reason =
        error && typeof error === 'object' && 'reasonCode' in error
          ? error.reasonCode
          : 'write-failed';
      stderr.write(`platform-acceptance: could not write evidence (${reason})\n`);
      return 3;
    }

    emitResultSummary(parsed, result, written.path, { stdout, stderr });
    return exitCodeForVerdict(result);
  } finally {
    unregisterFinalization();
    resolveFinalization();
  }
}

function emitSummary(parsed, result, outPath, streams = {}) {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  if (parsed.jsonSummary) {
    // EXACTLY one JSON object on stdout; nothing else.
    stdout.write(`${JSON.stringify(renderJsonSummary(result, outPath))}\n`);
    return;
  }
  stdout.write(`${renderHumanSummaryLines(result).join('\n')}\n`);
  stdout.write(`evidence: ${outPath}\n`);
  const failures = renderFailureDetailLines(result);
  if (failures.length > 0) {
    stderr.write(`${failures.join('\n')}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(
        `platform-acceptance: unexpected error (${error instanceof Error ? error.name : 'error'})\n`,
      );
      process.exitCode = 3;
    },
  );
}
