/**
 * @fileoverview Atomic, sealed evidence writer + bounded summary renderers.
 *
 * Release and CI consumers need ONE stable artifact file that either verifies
 * completely or not at all. This module:
 *   - seals an evidence body by appending the terminal `completion` record
 *     ({ state, evidenceDigest }) — only after the runner's cleanup finished;
 *   - re-validates the full artifact through the contract parser (which
 *     recomputes the sealed-body digest, so a partially written or tampered file
 *     can never verify);
 *   - enforces the profile's total evidence byte bound;
 *   - refuses a symlink destination and any path inside the run root; and
 *   - writes via a same-directory temp file → fsync → close → atomic rename.
 *
 * It also renders the two bounded human/JSON summaries. Child process output
 * NEVER leaves the artifact: the summaries carry only counts + required-failure
 * ids/reasons, never stdout/stderr tails.
 *
 * Dependency-free apart from Node built-ins + the sibling contract module.
 *
 * @typedef {import('./contract.d.mts').AcceptanceEvidence} AcceptanceEvidence
 */

import { closeSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { evidenceDigest, parseAcceptanceEvidence } from './contract.mjs';

/** Closed, kebab-case reason codes for a write failure. */
export const WRITER_REASON_CODES = Object.freeze({
  OUT_INSIDE_RUN_ROOT: 'out-inside-run-root',
  OUT_IS_SYMLINK: 'out-is-symlink',
  OUT_INVALID: 'out-invalid',
  EVIDENCE_TOO_LARGE: 'evidence-too-large',
  EVIDENCE_INVALID: 'evidence-invalid',
  WRITE_FAILED: 'write-failed',
});

const W = WRITER_REASON_CODES;

/** A typed, reason-coded writer failure. */
export class EvidenceWriteError extends Error {
  constructor(reasonCode, message) {
    super(`${reasonCode}: ${message}`);
    this.name = 'EvidenceWriteError';
    this.reasonCode = reasonCode;
  }
}

/** True when `target` is `root` itself or a strict descendant of `root`. */
function isUnderOrEqual(root, target) {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Seal + atomically write one acceptance evidence artifact.
 *
 * @param {object} input
 * @param {object} input.evidence         the evidence body WITHOUT `completion`.
 * @param {'completed'|'infrastructure-fault'} input.completionState
 * @param {string} input.outPath          absolute output path (already grammar-validated).
 * @param {number} input.maxEvidenceBytes total serialized byte bound.
 * @param {string|null} [input.runRoot]   the run root; `outPath` must be outside it.
 * @param {object} [deps]                 fs seam overrides for tests.
 * @returns {{ ok: true, path: string, bytes: number, digest: string }}
 */
export function writeAcceptanceEvidence(input, deps = {}) {
  const fs = {
    openSync: deps.openSync ?? openSync,
    writeSync: deps.writeSync ?? writeSync,
    fsyncSync: deps.fsyncSync ?? fsyncSync,
    closeSync: deps.closeSync ?? closeSync,
    renameSync: deps.renameSync ?? renameSync,
    rmSync: deps.rmSync ?? rmSync,
    lstatSync: deps.lstatSync ?? lstatSync,
  };
  if (
    input === null ||
    typeof input !== 'object' ||
    input.evidence === null ||
    typeof input.evidence !== 'object'
  ) {
    throw new EvidenceWriteError(W.EVIDENCE_INVALID, 'no evidence body was supplied');
  }
  const outPath = requireOutPath(input.outPath);

  // The output must live OUTSIDE the run root (which contains candidate + project roots).
  if (typeof input.runRoot === 'string' && input.runRoot.length > 0) {
    const runRootResolved = resolve(input.runRoot);
    if (isUnderOrEqual(runRootResolved, outPath)) {
      throw new EvidenceWriteError(W.OUT_INSIDE_RUN_ROOT, 'output path is inside the run root');
    }
  }

  // Refuse a symlink destination (never follow one).
  let existing;
  try {
    existing = fs.lstatSync(outPath);
  } catch {
    existing = undefined;
  }
  if (existing?.isSymbolicLink()) {
    throw new EvidenceWriteError(W.OUT_IS_SYMLINK, 'output path is a symlink');
  }

  // Seal: append the terminal completion record over the sealed body digest.
  const body = stripCompletion(input.evidence);
  const digest = evidenceDigest(body);
  const sealed = { ...body, completion: { state: input.completionState, evidenceDigest: digest } };

  // Re-validate the FULL artifact — this recomputes the sealed-body digest and
  // the summary, so a hand-edited or partial file cannot verify.
  try {
    parseAcceptanceEvidence(sealed);
  } catch (error) {
    throw new EvidenceWriteError(
      W.EVIDENCE_INVALID,
      `sealed evidence failed contract validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const serialized = `${JSON.stringify(sealed, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > input.maxEvidenceBytes) {
    throw new EvidenceWriteError(
      W.EVIDENCE_TOO_LARGE,
      `serialized evidence is ${bytes} bytes, exceeding the ${input.maxEvidenceBytes} byte bound`,
    );
  }

  atomicWrite(fs, outPath, serialized);
  return { ok: true, path: outPath, bytes, digest };
}

function requireOutPath(outPath) {
  if (typeof outPath !== 'string' || outPath.length === 0 || !isAbsolute(outPath)) {
    throw new EvidenceWriteError(W.OUT_INVALID, 'output path must be an absolute path');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(outPath)) {
    throw new EvidenceWriteError(W.OUT_INVALID, 'output path contains control characters');
  }
  return resolve(outPath);
}

function stripCompletion(evidence) {
  const body = { ...evidence };
  delete body.completion;
  return body;
}

/** Same-directory temp file → write → fsync → close → atomic rename. */
function atomicWrite(fs, outPath, serialized) {
  const dir = dirname(outPath);
  const tmp = join(dir, `.${basename(outPath)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    // `wx` fails if the temp path already exists — never clobber an unexpected file.
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, serialized);
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already failing */
      }
    }
    tryRemove(fs, tmp);
    throw new EvidenceWriteError(
      W.WRITE_FAILED,
      `could not write temp evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    tryRemove(fs, tmp);
    throw new EvidenceWriteError(
      W.WRITE_FAILED,
      `could not close temp evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.renameSync(tmp, outPath);
  } catch (error) {
    tryRemove(fs, tmp);
    throw new EvidenceWriteError(
      W.WRITE_FAILED,
      `could not atomically rename evidence into place: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function tryRemove(fs, target) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Bounded summary renderers (counts + required-failure ids only; never child output)
// ---------------------------------------------------------------------------

/** The list of required journeys that did not pass, for both renderers. */
function requiredFailures(evidence) {
  const out = [];
  for (const result of evidence.results) {
    if (result.required && result.status !== 'pass') {
      out.push({ id: result.id, status: result.status, reasonCode: result.reasonCode });
    }
  }
  return out;
}

/**
 * A single JSON summary object for `--json-summary` mode. Carries only counts,
 * identity, and required-failure ids/reasons — never stdout/stderr tails.
 */
export function renderJsonSummary(result, outPath) {
  const evidence = result.evidence;
  const base = {
    outcome: result.outcome,
    verdict: result.verdict,
    reasonCode: result.reasonCode ?? null,
    evidencePath: outPath ?? null,
  };
  if (evidence === null || evidence === undefined) {
    return { ...base, profile: null, candidate: null, summary: null, requiredFailures: [] };
  }
  return {
    ...base,
    completion: result.completionState,
    profile: { id: evidence.profile.id, version: evidence.profile.version },
    candidate: {
      kind: evidence.candidate.kind,
      version: evidence.candidate.version,
      source: evidence.candidate.source,
    },
    summary: evidence.summary,
    requiredFailures: requiredFailures(evidence),
  };
}

/** Lines for the human pass/fail table (stdout). */
export function renderHumanSummaryLines(result) {
  const evidence = result.evidence;
  const lines = [`platform-acceptance: ${result.verdict ?? result.outcome}`];
  if (result.reasonCode) lines.push(`  reason: ${result.reasonCode}`);
  if (evidence === null || evidence === undefined) return lines;
  const s = evidence.summary;
  lines.push(
    `  profile: ${evidence.profile.id} v${evidence.profile.version}`,
    `  candidate: ${evidence.candidate.source}`,
    `  passed ${s.passed}  failed ${s.failed}  skipped ${s.skipped}  unavailable ${s.unavailable}`,
    `  required: ${s.requiredPassed}/${s.requiredTotal}`,
  );
  return lines;
}

/** Bounded failure-detail lines for stderr (required non-pass rows). */
export function renderFailureDetailLines(result) {
  const evidence = result.evidence;
  if (evidence === null || evidence === undefined) return [];
  const lines = [];
  for (const failure of requiredFailures(evidence)) {
    lines.push(
      `  ${failure.status.toUpperCase()} ${failure.id} (${failure.reasonCode ?? 'unspecified'})`,
    );
  }
  return lines;
}
