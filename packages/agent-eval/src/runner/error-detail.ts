import { tmpdir } from 'node:os';

import { boundedUtf8Prefix } from '../model/value-helpers.js';

const MAX_ERROR_DETAIL_BYTES = 512;
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

/**
 * Render one bounded error detail while removing workspace, HOME, and host-temp
 * path prefixes before the value can enter a durable step record.
 */
export function safeErrorDetail(error: unknown, sensitivePaths: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitivePaths(message, sensitivePaths);
  const singleLine = redacted.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
  return boundedUtf8Prefix(singleLine, MAX_ERROR_DETAIL_BYTES);
}
