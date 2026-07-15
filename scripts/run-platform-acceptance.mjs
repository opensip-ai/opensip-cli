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
 *     ( --packed-release <dir> [--expected-version <semver>]
 *     | --published-version <semver> [--previous-version <semver>] [--registry <https-url>] )
 *     --out <path>
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
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  --packed-release <dir> [--expected-version <semver>]
      Qualify freshly-packed release tarballs in <dir>.
  --published-version <semver> [--previous-version <semver>] [--registry <https-url>]
      Qualify an exact published version (optionally upgrading FROM --previous-version).

Required:
  --profile <path>   data-only acceptance profile JSON
  --out <path>       absolute evidence artifact path (must be outside the run root)

Options:
  --json-summary     print exactly one JSON summary object to stdout
  -h, --help         print this help and exit 0

Exit codes: 0 pass · 1 required journey unsatisfied · 2 invalid invocation · 3 infrastructure fault`;

const VALUE_FLAGS = new Set([
  '--profile',
  '--out',
  '--packed-release',
  '--expected-version',
  '--published-version',
  '--previous-version',
  '--registry',
]);
const BOOLEAN_FLAGS = new Set(['--json-summary']);

/** True when a value contains a C0/C1 control character. */
function hasControlChars(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  const seen = new Map();
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
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
  if (!hasPublished && flags['--previous-version'] !== undefined) {
    return invalid('--previous-version is only valid with --published-version');
  }
  if (!hasPublished && flags['--registry'] !== undefined) {
    return invalid('--registry is only valid with --published-version');
  }

  let candidate;
  if (hasPacked) {
    const primary = { kind: 'packed-release', directory: flags['--packed-release'] };
    if (flags['--expected-version'] !== undefined)
      primary.expectedVersion = flags['--expected-version'];
    candidate = { primary };
  } else {
    const primary = { kind: 'published-version', version: flags['--published-version'] };
    if (flags['--registry'] !== undefined) primary.registry = flags['--registry'];
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
    jsonSummary: flags['--json-summary'] === true,
    candidate,
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
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : 'unknown';
  } catch {
    return 'unknown';
  }
}

function humanStage(event) {
  const reason = event.reasonCode ? ` ${event.reasonCode}` : '';
  const id = event.id ? ` ${event.id}` : '';
  process.stderr.write(`[acceptance] ${event.stage}${id}${reason} (${event.durationMs}ms)\n`);
}

/** Map a completed/infra result to an exit code (never for invalid-invocation). */
function exitCodeForVerdict(result) {
  if (result.outcome === RUN_OUTCOMES.INFRASTRUCTURE_FAULT) return 3;
  return result.verdict === 'pass' ? 0 : 1;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!parsed.ok) {
    process.stderr.write(`platform-acceptance: ${parsed.message}\n`);
    return 2;
  }

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let result;
  try {
    result = await runPlatformAcceptance(
      {
        profilePath: parsed.profilePath,
        candidate: parsed.candidate,
        repoRoot: REPO_ROOT,
        harnessGitSha: resolveHarnessGitSha(),
        signal: controller.signal,
      },
      { onProgress: parsed.jsonSummary ? undefined : humanStage },
    );
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  // Invalid invocation (bad profile / candidate) — exit 2, no artifact.
  if (result.outcome === RUN_OUTCOMES.INVALID_INVOCATION) {
    process.stderr.write(
      `platform-acceptance: invalid invocation (${result.reasonCode}): ${result.message ?? ''}\n`,
    );
    return 2;
  }

  // Completed or infrastructure fault — attempt a valid, sealed, atomic artifact.
  let written;
  try {
    written = writeAcceptanceEvidence({
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
    process.stderr.write(`platform-acceptance: could not write evidence (${reason})\n`);
    return 3;
  }

  emitSummary(parsed, result, written.path);
  return exitCodeForVerdict(result);
}

function emitSummary(parsed, result, outPath) {
  if (parsed.jsonSummary) {
    // EXACTLY one JSON object on stdout; nothing else.
    process.stdout.write(`${JSON.stringify(renderJsonSummary(result, outPath))}\n`);
    return;
  }
  process.stdout.write(`${renderHumanSummaryLines(result).join('\n')}\n`);
  process.stdout.write(`evidence: ${outPath}\n`);
  const failures = renderFailureDetailLines(result);
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
  }
}

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
