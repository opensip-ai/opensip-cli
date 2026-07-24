/**
 * Safe diagnostic data policy (Plan 00 Phase 3.4).
 *
 * Semantic redaction/bounding on top of ADR-0175 toJsonValue. Terminal ANSI
 * and HTML encoding stay at final sinks — not here.
 */

import { toJsonRecord, toJsonValue, type JsonRecord, type JsonValue } from './json-value.js';
import { sanitizeErrorMetadata } from './errors.js';

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu;
const CREDENTIAL_IN_URL = /:\/\/([^/@\s]+):([^@/\s]+)@/gu;

/**
 * Bound and scrub a value for structured logs / public diagnostics.
 * Deny-by-default for Error/cause objects — use failure envelope instead.
 */
export function toSafeDiagnosticData(value: unknown): JsonValue {
  if (value instanceof Error) {
    return toJsonRecord({
      name: value.name,
      message: scrubText(value.message),
      note: 'error-object-redacted',
    });
  }
  if (typeof value === 'object' && value !== null) {
    return toJsonRecord(sanitizeErrorMetadata(value));
  }
  if (typeof value === 'string') {
    return scrubText(value);
  }
  return toJsonValue(value);
}

/** Nested record form for log `data` bags. */
export function toSafeDiagnosticRecord(value: unknown): JsonRecord {
  const v = toSafeDiagnosticData(value);
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as JsonRecord;
  }
  return toJsonRecord({ value: v });
}

/** Strip controls and credential URL userinfo; keep ordinary text. */
export function scrubText(text: string, max = 2000): string {
  let out = text.replace(CONTROL_CHARS, '').replace(CREDENTIAL_IN_URL, '://***:***@');
  if (out.length > max) out = `${out.slice(0, max - 1)}…`;
  return out;
}

/** Terminal sink: neutralize ANSI first, then other controls. */
export function neutralizeTerminalText(text: string): string {
  // Strip CSI sequences before control-char scrubbing (ESC is a control code).
  return scrubText(text.replace(ANSI, ''));
}

/** Project absolute paths to project-relative when under root; else mark operator-only. */
export function projectRelativePath(filePath: string, projectRoot?: string): string {
  if (!projectRoot) return scrubText(filePath, 512);
  const root = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot;
  if (filePath === root) return '.';
  if (filePath.startsWith(`${root}/`)) return scrubText(filePath.slice(root.length + 1), 512);
  return '[absolute-path]';
}
