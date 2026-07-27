import { tmpdir } from 'node:os';

import { boundedUtf8Prefix } from '../model/value-helpers.js';

const MAX_ERROR_DETAIL_BYTES = 512;
const CREDENTIAL_ENV_KEY =
  /(?:^|_)(?:api_?key|authorization|cookie|credential|password|private_?key|secret|token)(?:_|$)/iu;
const CREDENTIAL_ASSIGNMENT =
  /(\b(?:api[_-]?key|authorization|cookie|credential|password|secret|token)\s*[:=]\s*)[^\s,;&'"}]+/giu;
const MIN_AMBIENT_CREDENTIAL_LENGTH = 8;
const REDACTED_CREDENTIAL = '[redacted-credential]';
const REDACTED_PATH = '[redacted-path]';

function pathVariants(value: string): readonly string[] {
  const trimmed = value.replace(/[\\/]+$/u, '');
  if (trimmed.length <= 1) return [];
  return [...new Set([trimmed, trimmed.replaceAll('\\', '/'), trimmed.replaceAll('/', '\\')])];
}

function redactSensitivePaths(message: string, sensitivePaths: readonly string[]): string {
  const variants = [...sensitivePaths, tmpdir()]
    .flatMap(pathVariants)
    .sort((left, right) => right.length - left.length);
  return variants.reduce((redacted, path) => redacted.replaceAll(path, REDACTED_PATH), message);
}

function redactCredentials(message: string): string {
  let redacted = message.replace(
    CREDENTIAL_ASSIGNMENT,
    (_match, prefix: string) => `${prefix}${REDACTED_CREDENTIAL}`,
  );
  const ambientValues = Object.entries(process.env)
    .flatMap(([key, value]) =>
      CREDENTIAL_ENV_KEY.test(key) &&
      value !== undefined &&
      value.length >= MIN_AMBIENT_CREDENTIAL_LENGTH
        ? [value]
        : [],
    )
    .sort((left, right) => right.length - left.length);
  for (const value of ambientValues) redacted = redacted.replaceAll(value, REDACTED_CREDENTIAL);
  return redacted;
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'failure detail unavailable';
  }
}

/**
 * Render one bounded error detail while removing workspace, HOME, and host-temp
 * path prefixes before the value can enter a durable step record.
 */
export function safeErrorDetail(error: unknown, sensitivePaths: readonly string[] = []): string {
  const message = errorMessage(error);
  const redacted = redactCredentials(redactSensitivePaths(message, sensitivePaths));
  const singleLine = redacted.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return boundedUtf8Prefix(singleLine, MAX_ERROR_DETAIL_BYTES);
}
