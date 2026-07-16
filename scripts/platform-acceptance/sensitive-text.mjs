/**
 * @fileoverview Shared credential redaction for acceptance diagnostics.
 *
 * Child output can reach both the sealed evidence and the auxiliary agent
 * report. Keep one grammar for object keys, plain key/value assignments,
 * headers, query parameters, registry auth lines, bearer tokens, and URL
 * userinfo so those artifacts cannot drift into different disclosure postures.
 */

const SENSITIVE_KEY_PARTS = new Set([
  'apikey',
  'auth',
  'authorization',
  'authtoken',
  'cookie',
  'credential',
  'passwd',
  'password',
  'secret',
  'sig',
  'signature',
  'token',
]);

const QUOTED_OR_TOKEN_VALUE = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;]+)`;
const AUTHORIZATION_PATTERN = new RegExp(
  String.raw`\b(authorization\s*[=:]\s*)(?:bearer\s+)?${QUOTED_OR_TOKEN_VALUE}`,
  'giu',
);
const BEARER_PATTERN = new RegExp(String.raw`\b(bearer\s+)${QUOTED_OR_TOKEN_VALUE}`, 'giu');
const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(^|[^A-Za-z0-9_])(["']?)([A-Za-z_][A-Za-z0-9_-]{0,63})\2(\s*[=:]\s*)(?!\/{2})(${QUOTED_OR_TOKEN_VALUE})`,
  'gmu',
);
const FLAG_PATTERN = new RegExp(
  String.raw`(^|[\s,;])(-{1,2})([A-Za-z_][A-Za-z0-9_-]{0,63})(\s+)(${QUOTED_OR_TOKEN_VALUE})`,
  'gmu',
);

function normalizeKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toLowerCase();
}

/** True when an object/assignment key conventionally carries a credential. */
export function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  const parts = normalized.split('_').filter(Boolean);
  return (
    parts.some((part) => SENSITIVE_KEY_PARTS.has(part)) ||
    normalized === 'api_key' ||
    normalized.endsWith('_api_key') ||
    /(?:^|_)(?:access|private|session|signing|ssh)_key(?:_id)?$/u.test(normalized)
  );
}

/** Redact credential-bearing fragments inside one bounded diagnostic string. */
export function redactSensitiveText(value) {
  return String(value ?? '')
    .replace(/\b(https?:\/\/)[^\s/@]+@/giu, '$1<redacted>@')
    .replace(AUTHORIZATION_PATTERN, '$1<redacted>')
    .replace(BEARER_PATTERN, '$1<redacted>')
    .replace(ASSIGNMENT_PATTERN, (match, prefix, quote, key, separator) =>
      isSensitiveKey(key) || normalizeKey(key) === 'key'
        ? `${prefix}${quote}${key}${quote}${separator}<redacted>`
        : match,
    )
    .replace(FLAG_PATTERN, (match, prefix, hyphens, key, separator) =>
      isSensitiveKey(key) || normalizeKey(key) === 'key'
        ? `${prefix}${hyphens}${key}${separator}<redacted>`
        : match,
    );
}
