/**
 * @fileoverview Atomic, sealed evidence writer + bounded summary renderers.
 *
 * Release and CI consumers need ONE stable artifact file that either verifies
 * completely or not at all. This module:
 *   - seals an evidence body by appending the terminal `completion` record
 *     ({ state, evidenceDigest }) — only after the runner's cleanup finished;
 *   - re-validates the full artifact through the contract parser (which
 *     recomputes the sealed-body digest, so a partial write, accidental
 *     corruption, or internally inconsistent file cannot verify);
 *   - enforces the profile's total evidence byte bound;
 *   - refuses a symlink destination and any path inside the run root; and
 *   - writes via a same-directory temp file → fsync → close → atomic rename
 *     → parent-directory fsync on POSIX.
 *
 * It also renders the two bounded human/JSON summaries. Child process output
 * NEVER leaves the artifact: the summaries carry only counts + required-failure
 * ids/reasons, never stdout/stderr tails.
 *
 * The digest is an unkeyed internal-integrity check, not an authenticity
 * signature. Qualification consumers must also trust the workflow/artifact or
 * release provenance through which the file was retained.
 *
 * Dependency-free apart from Node built-ins + the sibling contract module.
 *
 * @typedef {import('./contract.d.mts').AcceptanceEvidence} AcceptanceEvidence
 */

import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { evidenceDigest, parseAcceptanceEvidence } from './contract.mjs';
import { writeAllSync } from './write-all-sync.mjs';

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
    realpathSync: deps.realpathSync ?? realpathSync,
  };
  if (
    input === null ||
    typeof input !== 'object' ||
    input.evidence === null ||
    typeof input.evidence !== 'object'
  ) {
    throw new EvidenceWriteError(W.EVIDENCE_INVALID, 'no evidence body was supplied');
  }
  if (!Number.isSafeInteger(input.maxEvidenceBytes) || input.maxEvidenceBytes <= 0) {
    throw new EvidenceWriteError(
      W.EVIDENCE_INVALID,
      'maxEvidenceBytes must be a positive safe integer',
    );
  }
  const requestedPath = requireOutPath(input.outPath);
  const hasRunRoot = typeof input.runRoot === 'string' && input.runRoot.length > 0;
  const runRootResolved = hasRunRoot ? resolve(input.runRoot) : undefined;
  if (runRootResolved !== undefined && isUnderOrEqual(runRootResolved, requestedPath)) {
    throw new EvidenceWriteError(W.OUT_INSIDE_RUN_ROOT, 'output path is inside the run root');
  }
  let parentReal;
  try {
    parentReal = fs.realpathSync(dirname(requestedPath));
  } catch {
    throw new EvidenceWriteError(W.OUT_INVALID, 'output parent must already exist');
  }
  const outPath = join(parentReal, basename(requestedPath));

  // Compare the REAL output parent with the run root. This rejects a lexical
  // outside path whose existing parent is a symlink into the disposable root.
  if (runRootResolved !== undefined) {
    let runRootReal = runRootResolved;
    try {
      runRootReal = fs.realpathSync(runRootResolved);
    } catch {
      // The runner normally removes its root before evidence is sealed. Its
      // already-realpathed absolute identity remains safe for lexical fallback.
    }
    if (isUnderOrEqual(runRootReal, outPath)) {
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
  const sealed = {
    ...body,
    completion: { state: input.completionState, evidenceDigest: digest },
  };

  // Re-validate the FULL artifact — this recomputes the sealed-body digest and
  // the summary, so an inconsistent, accidentally corrupted, or partial file
  // cannot verify. An actor can rewrite and reseal an unkeyed digest; trusted
  // workflow/artifact provenance supplies authenticity outside this module.
  let validated;
  try {
    validated = parseAcceptanceEvidence(sealed);
  } catch (error) {
    throw new EvidenceWriteError(
      W.EVIDENCE_INVALID,
      `sealed evidence failed contract validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Serialize the normalized contract value, not the caller-owned object. A
  // nested object may carry a non-enumerable `toJSON` hook (or a getter) that
  // changes what JSON.stringify emits after validation; using the parser's
  // plain frozen projection ensures the durable bytes are exactly the value
  // whose schema and digest were checked above.
  const serialized = `${JSON.stringify(validated, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > input.maxEvidenceBytes) {
    throw new EvidenceWriteError(
      W.EVIDENCE_TOO_LARGE,
      `serialized evidence is ${bytes} bytes, exceeding the ${input.maxEvidenceBytes} byte bound`,
    );
  }

  atomicWrite(fs, outPath, serialized, deps.platform ?? process.platform);
  return { ok: true, path: requestedPath, bytes, digest };
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

/** Persist the rename's directory entry on POSIX; Node cannot portably do this on Windows. */
function syncParentDirectory(fs, outPath, platform) {
  if (platform === 'win32') return;
  let descriptor;
  try {
    descriptor = fs.openSync(dirname(outPath), 'r');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Same-directory temp → write/fsync/close → rename → parent fsync. */
function atomicWrite(fs, outPath, serialized, platform) {
  const dir = dirname(outPath);
  const tmp = join(dir, `.${basename(outPath)}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    // `wx` fails if the temp path already exists — never clobber an unexpected file.
    fd = fs.openSync(tmp, 'wx', 0o600);
    writeAllSync(fs, fd, serialized);
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
  try {
    syncParentDirectory(fs, outPath, platform);
  } catch (error) {
    // The caller must never receive success for a namespace update whose
    // durability could not be confirmed. Remove the renamed artifact and make
    // a best-effort directory sync of that rollback before reporting failure.
    tryRemove(fs, outPath);
    try {
      syncParentDirectory(fs, outPath, platform);
    } catch {
      /* already reporting the original durability failure */
    }
    throw new EvidenceWriteError(
      W.WRITE_FAILED,
      `could not persist the evidence rename: ${error instanceof Error ? error.message : String(error)}`,
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
      out.push({
        id: result.id,
        status: result.status,
        reasonCode: result.reasonCode,
      });
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
    return {
      ...base,
      profile: null,
      candidate: null,
      summary: null,
      requiredFailures: [],
    };
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
