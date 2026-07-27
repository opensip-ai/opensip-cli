/** Bounded validation for persisted catalog identities before key derivation. */

import { err, ok, type Result } from '@opensip-cli/core';

import { catalogGenerationKey } from './catalog-generation-model.js';
import { fromGraphReadError, readError, type McpReadError } from './mcp-error.js';

import type { Catalog, CatalogIdentity, GraphReadReason } from '@opensip-cli/graph/read';

const MAX_IDENTITY_LANGUAGE = 64;
const MAX_IDENTITY_CACHE_KEY = 8192;
const MAX_IDENTITY_FINGERPRINT = 64 * 1024 * 1024;
const ADAPTER_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/;
const LEGACY_FINGERPRINT = /^[A-Za-z0-9._:-]+$/;

export function catalogMatchesIdentity(catalog: Catalog, identity: CatalogIdentity): boolean {
  return (
    catalog.language === identity.language &&
    catalog.cacheKey === identity.cacheKey &&
    (catalog.filesFingerprint ?? '') === identity.filesFingerprint &&
    catalog.builtAt === identity.builtAt
  );
}

function isSafeCatalogIdentity(value: unknown): value is CatalogIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.language === 'string' &&
    identity.language.length <= MAX_IDENTITY_LANGUAGE &&
    ADAPTER_ID.test(identity.language) &&
    typeof identity.cacheKey === 'string' &&
    isControlFreeBounded(identity.cacheKey, MAX_IDENTITY_CACHE_KEY) &&
    typeof identity.filesFingerprint === 'string' &&
    isSafeFilesFingerprint(identity.filesFingerprint) &&
    typeof identity.builtAt === 'string' &&
    isCanonicalTimestamp(identity.builtAt)
  );
}

function isControlFreeBounded(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
}

function isSafeFilesFingerprint(value: string): boolean {
  if (value.length > MAX_IDENTITY_FINGERPRINT) return false;
  if (value === '' || LEGACY_FINGERPRINT.test(value)) return true;
  if (hasNonLineFeedControl(value)) return false;
  const lines = value.split('\n');
  if (!/^\d+$/u.test(lines[0] ?? '')) return false;
  return lines.slice(1).every((line) => line === '' || line.indexOf('|') > 0);
}

function hasNonLineFeedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 10) || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function isCanonicalTimestamp(value: string): boolean {
  if (value.length > 32 || /\p{Cc}/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function safeCatalogGenerationKey(identity: CatalogIdentity): Result<string, McpReadError> {
  if (!isSafeCatalogIdentity(identity)) {
    return err(
      readError(
        'catalog-identity-invalid',
        'Persisted graph catalog identity is malformed or oversized.',
      ),
    );
  }
  return ok(catalogGenerationKey(identity));
}

export function mapCatalogIdentityError(error: {
  code: GraphReadReason;
  message: string;
}): McpReadError {
  return fromGraphReadError({
    code: error.code,
    operation: 'catalog-identity',
    message: error.message,
  });
}
