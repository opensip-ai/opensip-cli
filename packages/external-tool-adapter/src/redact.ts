/**
 * @fileoverview Secret redaction for secret-scanner parsers (ADR-0091 / ADR-0092).
 *
 * A secret scanner (gitleaks) captures the live credential (`Secret`) and the
 * surrounding match region (`Match`). Neither may EVER reach `Signal.message`,
 * `Signal.metadata` in raw form, or any egress payload. A parser stores only a
 * {@link redactSecret} PREVIEW (or {@link secretHash}) so a finding stays
 * identifiable without leaking the value.
 *
 * Pure functions; `redactSecret` provably never returns the raw string.
 */

import { createHash } from 'node:crypto';

/**
 * Mask a secret to a short, non-reversible PREVIEW: the first 4 characters plus
 * an ellipsis (`'AKIA…'`). A value of length `<= 4` collapses to just `'…'`, so
 * the full raw secret is NEVER returned. Empty/undefined → `''`.
 */
export function redactSecret(raw: string | undefined | null): string {
  if (raw === undefined || raw === null) return '';
  const s = String(raw);
  if (s.length === 0) return '';
  if (s.length <= 4) return '…';
  return `${s.slice(0, 4)}…`;
}

/**
 * A stable, non-reversible identity for a secret: the first 12 hex chars of its
 * SHA-256. Useful when two findings must be told apart without storing any part
 * of the value. Empty/undefined → `''`.
 */
export function secretHash(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw.length === 0) return '';
  return createHash('sha256').update(String(raw)).digest('hex').slice(0, 12);
}

// URL userinfo — `scheme://user:password@host`. Networked scanners (pip-audit,
// dependency-check, cargo-deny) echo the failing index/registry URL into stderr
// on an auth error; the password half must never reach a ToolError / log / report.
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^@/\s:]+):([^@/\s]+)@/giu;

// `Authorization: Bearer <token>` / `Basic <token>` — the auth scheme is followed
// by whitespace and the credential (no `:`/`=`). Masked before the key=value pass so
// the token after the scheme cannot leak.
const AUTH_SCHEME_RE = /\b(bearer|basic)\s+([\w.~+/=-]{4,})/giu;

// Inline `key=value` / `key: value` credential assignments a scanner may echo from
// its own argv/config (`token=abc123`, `api-key: xyz`, `password="hunter2"`).
const INLINE_SECRET_RE =
  /\b(password|passwd|pwd|token|api[_-]?key|secret)\b(["']?\s*[:=]\s*["']?)(\S+)/giu;

/**
 * Redact credential material from FREE-TEXT scanner diagnostics (stderr tails,
 * error messages) before it reaches a {@link import('@opensip-cli/core').ToolError},
 * a log, or a report. Masks URL userinfo passwords, `Bearer`/`Basic` tokens, and
 * inline `key=value` secret assignments while leaving the surrounding diagnostic
 * readable. Conservative by design — it targets known credential shapes, not
 * arbitrary high-entropy strings. Returns the input unchanged when there is nothing
 * to mask. Empty/undefined → `''`.
 */
export function redactCredentials(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw.length === 0) return '';
  return String(raw)
    .replace(URL_USERINFO_RE, (_match, scheme: string, user: string) => `${scheme}${user}:***@`)
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} ***`)
    .replace(INLINE_SECRET_RE, (_match, key: string, sep: string) => `${key}${sep}***`);
}
