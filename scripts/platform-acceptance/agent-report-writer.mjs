/**
 * @fileoverview Bounded, sanitized auxiliary writer for the installed
 * agent-eval smoke report.
 *
 * The sealed platform-acceptance evidence remains the qualification authority.
 * This file preserves the detailed private-harness report only as a debugging
 * aid: every string is path/credential sanitized, the complete JSON artifact is
 * byte-bounded, and the destination must be outside the disposable run root.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { isSensitiveKey, redactSensitiveText } from './sensitive-text.mjs';
import { writeAllSync } from './write-all-sync.mjs';

/** The fixed upper bound for both source and sanitized installed-smoke reports. */
export const MAX_INSTALLED_AGENT_REPORT_BYTES = 4 * 1024 * 1024;

/** Closed reason codes surfaced to the agent journey without leaking paths. */
export const AGENT_REPORT_WRITE_REASONS = Object.freeze({
  ALREADY_ATTEMPTED: 'agent-report-write-already-attempted',
  INVALID_REPORT: 'agent-report-invalid',
  OUT_EXISTS: 'agent-report-out-exists',
  OUT_INSIDE_RUN_ROOT: 'agent-report-out-inside-run-root',
  OUT_INVALID: 'agent-report-out-invalid',
  OUT_IS_SYMLINK: 'agent-report-out-is-symlink',
  REPORT_TOO_LARGE: 'agent-report-too-large',
  WRITE_FAILED: 'agent-report-write-failed',
});

const A = AGENT_REPORT_WRITE_REASONS;
const REDACTED = '<redacted>';
const REDACTED_PATH = '<path>';
export class AgentReportWriteError extends Error {
  constructor(reasonCode, message) {
    super(`${reasonCode}: ${message}`);
    this.name = 'AgentReportWriteError';
    this.reasonCode = reasonCode;
  }
}

function isUnderOrEqual(root, target) {
  if (root === target) return true;
  const rel = relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

function sanitizeString(value, redactRoots) {
  let sanitized = value;
  for (const root of redactRoots) {
    if (root.length > 1) sanitized = sanitized.split(root).join(REDACTED_PATH);
  }
  sanitized = redactSensitiveText(sanitized)
    .replace(/\bfile:(?:\/+)?[^\s"'<>]+/gi, REDACTED_PATH)
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/gi,
      REDACTED,
    )
    .replace(/(^|[\s"'=(])(?:\\{2}|\/{2})[^\s"'<>]*/g, `$1${REDACTED_PATH}`)
    .replace(/(^|[\s"'=:(])(?:~\/|[A-Za-z]:[\\/]|\/(?!\/))[^\s"'<>]*/g, `$1${REDACTED_PATH}`)
    // Auxiliary JSON should not retain terminal/control payloads either.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
  return sanitized;
}

function sanitizeValue(value, redactRoots, seen) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeString(value, redactRoots);
  if (typeof value !== 'object') {
    throw new AgentReportWriteError(A.INVALID_REPORT, 'report contains a non-JSON value');
  }
  if (seen.has(value)) {
    throw new AgentReportWriteError(A.INVALID_REPORT, 'report contains a reference cycle');
  }
  seen.add(value);
  let sanitized;
  if (Array.isArray(value)) {
    sanitized = value.map((entry) => sanitizeValue(entry, redactRoots, seen));
  } else {
    // JSON permits keys such as `__proto__`, `constructor`, and `prototype`.
    // A null-prototype accumulator keeps every own key as inert data instead of
    // invoking Object.prototype setters or shadowing inherited object machinery
    // while the report is copied.
    sanitized = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      const sanitizedKey = sanitizeString(key, redactRoots);
      if (Object.hasOwn(sanitized, sanitizedKey)) {
        throw new AgentReportWriteError(A.INVALID_REPORT, 'report keys collide after sanitization');
      }
      sanitized[sanitizedKey] = isSensitiveKey(key)
        ? REDACTED
        : sanitizeValue(entry, redactRoots, seen);
    }
  }
  seen.delete(value);
  return sanitized;
}

/** Return a deep JSON-safe copy with credentials and absolute paths removed. */
export function sanitizeInstalledAgentReport(report, extraRedactRoots = []) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new AgentReportWriteError(A.INVALID_REPORT, 'report must be a JSON object');
  }
  const roots = [homedir(), ...extraRedactRoots]
    .filter((entry) => typeof entry === 'string' && entry.length > 1)
    .map((entry) => resolve(entry));
  return sanitizeValue(report, roots, new WeakSet());
}

function requireOutputPath(outPath, runRoot, fs) {
  if (
    typeof outPath !== 'string' ||
    outPath.length === 0 ||
    !isAbsolute(outPath) ||
    extname(outPath).toLowerCase() !== '.json'
  ) {
    throw new AgentReportWriteError(A.OUT_INVALID, 'output must be an absolute .json path');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(outPath)) {
    throw new AgentReportWriteError(A.OUT_INVALID, 'output path contains control characters');
  }
  if (typeof runRoot !== 'string' || runRoot.length === 0 || !isAbsolute(runRoot)) {
    throw new AgentReportWriteError(A.OUT_INVALID, 'run root must be an absolute path');
  }

  const requested = resolve(outPath);
  let parentReal;
  try {
    parentReal = fs.realpathSync(dirname(requested));
  } catch {
    throw new AgentReportWriteError(A.OUT_INVALID, 'output parent must already exist');
  }
  const target = join(parentReal, basename(requested));
  const rootReal = fs.realpathSync(runRoot);
  if (isUnderOrEqual(rootReal, target)) {
    throw new AgentReportWriteError(A.OUT_INSIDE_RUN_ROOT, 'output is inside the run root');
  }

  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink()) {
      throw new AgentReportWriteError(A.OUT_IS_SYMLINK, 'output is a symlink');
    }
    throw new AgentReportWriteError(A.OUT_EXISTS, 'output already exists');
  } catch (error) {
    if (error instanceof AgentReportWriteError) throw error;
    if (error?.code !== 'ENOENT') {
      throw new AgentReportWriteError(A.OUT_INVALID, 'output could not be inspected safely');
    }
  }
  return { requested, target };
}

function tryRemove(fs, target) {
  try {
    fs.rmSync(target, { force: true });
  } catch {
    /* best effort cleanup/rollback; the caller retains the authoritative result */
  }
}

/**
 * Write through a same-directory private temp and atomically hard-link it into
 * the final, must-not-exist target. `linkSync` keeps the no-clobber guarantee
 * even if another process creates the target after the initial lstat.
 */
function syncParentDirectory(fs, target, platform) {
  // Node cannot portably open directory handles on Windows. The target remains
  // an exclusive, fully-synced file there; POSIX additionally persists the
  // namespace link before reporting success.
  if (platform === 'win32') return;
  let descriptor;
  try {
    descriptor = fs.openSync(dirname(target), 'r');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicExclusiveWrite(fs, target, serialized, platform) {
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let descriptor;
  let linked = false;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    writeAllSync(fs, descriptor, serialized);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temp, target);
    linked = true;
    syncParentDirectory(fs, target, platform);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* already reporting the original failure */
      }
    }
    if (linked) tryRemove(fs, target);
    tryRemove(fs, temp);
    throw new AgentReportWriteError(
      A.WRITE_FAILED,
      `could not atomically preserve report (${error instanceof Error ? error.name : 'error'})`,
    );
  }
  // The hard link is the commit point. Failure to unlink its private sibling
  // must not turn a successful, durable final artifact into a false failure.
  tryRemove(fs, temp);
}

/**
 * Sanitize and preserve one installed-agent report outside the disposable run
 * root. The serialized byte bound is checked both before and after sanitizing.
 */
export function writeSanitizedInstalledAgentReport(input, deps = {}) {
  const fs = {
    closeSync: deps.closeSync ?? closeSync,
    fsyncSync: deps.fsyncSync ?? fsyncSync,
    linkSync: deps.linkSync ?? linkSync,
    lstatSync: deps.lstatSync ?? lstatSync,
    openSync: deps.openSync ?? openSync,
    realpathSync: deps.realpathSync ?? realpathSync,
    rmSync: deps.rmSync ?? rmSync,
    writeSync: deps.writeSync ?? writeSync,
  };
  const maximum = Math.min(
    Number.isSafeInteger(input?.maxBytes) && input.maxBytes > 0
      ? input.maxBytes
      : MAX_INSTALLED_AGENT_REPORT_BYTES,
    MAX_INSTALLED_AGENT_REPORT_BYTES,
  );
  let source;
  try {
    source = JSON.stringify(input?.report);
  } catch {
    throw new AgentReportWriteError(A.INVALID_REPORT, 'report is not JSON serializable');
  }
  if (typeof source !== 'string') {
    throw new AgentReportWriteError(A.INVALID_REPORT, 'report is not JSON serializable');
  }
  if (Buffer.byteLength(source, 'utf8') > maximum) {
    throw new AgentReportWriteError(A.REPORT_TOO_LARGE, 'source report exceeds its byte bound');
  }

  const { requested, target } = requireOutputPath(input?.outPath, input?.runRoot, fs);
  const sanitized = sanitizeInstalledAgentReport(input.report, [input.runRoot, input.repoRoot]);
  const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maximum) {
    throw new AgentReportWriteError(A.REPORT_TOO_LARGE, 'sanitized report exceeds its byte bound');
  }
  atomicExclusiveWrite(fs, target, serialized, deps.platform ?? process.platform);
  return Object.freeze({
    bytes,
    digest: createHash('sha256').update(serialized).digest('hex'),
    path: requested,
  });
}
