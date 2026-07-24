/**
 * Safe diagnostic data policy (Plan 00 Phase 3.4).
 *
 * Semantic redaction/bounding on top of ADR-0175 toJsonValue. Terminal ANSI
 * and HTML encoding stay at final sinks — not here.
 */

import { redactCredentialText, sanitizeErrorMetadata } from './errors.js';
import { toJsonRecord, toJsonValue, type JsonRecord, type JsonValue } from './json-value.js';

// Control-character ranges are intentional for diagnostic scrubbing.
// eslint-disable-next-line no-control-regex -- strip C0 controls from operator text
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
// eslint-disable-next-line no-control-regex -- strip CSI ANSI sequences (ESC is a control)
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/gu;

/**
 * Bound and scrub a value for structured logs / public diagnostics.
 * Deny-by-default for Error/cause objects — use failure envelope instead.
 */
// JsonValue is a union of scalar/object/array arms — each branch is a valid arm.
// eslint-disable-next-line sonarjs/function-return-type -- intentionally multi-arm JsonValue
export function toSafeDiagnosticData(value: unknown): JsonValue {
  try {
    if (value instanceof Error) {
      return toJsonRecord({
        name: scrubText(value.name, 128),
        message: scrubText(value.message),
        note: 'error-object-redacted',
      });
    }
  } catch {
    // @swallow-ok probe/optional capability: hostile instanceof failure falls
    // through to descriptor-based metadata sanitization.
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

/** Strip controls and known credential values; keep ordinary text. */
export function scrubText(text: string, max = 2000): string {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 2000;
  let out = redactCredentialText(text).replace(CONTROL_CHARS, '');
  if (out.length > limit) {
    out = limit === 0 ? '' : `${out.slice(0, Math.max(0, limit - 1))}…`;
  }
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
