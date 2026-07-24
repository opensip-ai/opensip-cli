/**
 * Tool-facing error catalog contribution helpers (Plan 00 Phase 2).
 *
 * Catalogs attach via {@link ToolExtensionPoints.errorCatalog}. Aggregation
 * lives on the per-invocation {@link ToolRegistry} — never a process-global map.
 */

import {
  ERROR_CATALOG_SCHEMA_VERSION,
  type ErrorCatalog,
  type ErrorDefinition,
  ErrorDefinitionError,
  defineErrorCatalog,
  type ErrorCatalogOwner,
} from '../lib/error-definition.js';
import { coreSystemErrorCatalog } from '../lib/error-definition.js';

/** Wire shape for optional tool catalog contribution. */
export interface ToolErrorCatalogContribution {
  readonly schemaVersion: typeof ERROR_CATALOG_SCHEMA_VERSION;
  readonly catalog: ErrorCatalog;
}

/**
 * Validate an optional tool catalog contribution (hostile plugin input).
 * @throws {ErrorDefinitionError} When the value is missing/not a plain object, the schemaVersion is unsupported, the owner id mismatches, or neither a catalog nor definitions are present.
 */
export function validateToolErrorCatalogContribution(
  raw: unknown,
  owner: ErrorCatalogOwner,
): ToolErrorCatalogContribution {
  if (raw === undefined || raw === null) {
    throw new ErrorDefinitionError('errorCatalog contribution is required when provided');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ErrorDefinitionError('errorCatalog must be a plain object');
  }
  const value = raw as Record<string, unknown>;
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== ERROR_CATALOG_SCHEMA_VERSION) {
    throw new ErrorDefinitionError(
      `unsupported errorCatalog schemaVersion (expected ${ERROR_CATALOG_SCHEMA_VERSION})`,
    );
  }
  // Accept either a full catalog or a definitions bag to normalize.
  if (
    value.catalog &&
    typeof value.catalog === 'object' &&
    value.catalog !== null &&
    'definitions' in value.catalog &&
    'list' in value.catalog
  ) {
    const catalog = value.catalog as ErrorCatalog;
    if (catalog.owner?.id !== owner.id) {
      throw new ErrorDefinitionError(
        `errorCatalog owner id '${catalog.owner?.id ?? '<missing>'}' does not match tool owner '${owner.id}'`,
      );
    }
    return { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION, catalog };
  }
  // Bare ErrorCatalog shape (matches ToolExtensionPoints.errorCatalog).
  if ('definitions' in value && 'list' in value && 'owner' in value) {
    const catalog = value as unknown as ErrorCatalog;
    if (catalog.owner?.id !== owner.id) {
      throw new ErrorDefinitionError(
        `errorCatalog owner id '${catalog.owner?.id ?? '<missing>'}' does not match tool owner '${owner.id}'`,
      );
    }
    return { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION, catalog };
  }
  if (value.definitions && typeof value.definitions === 'object') {
    const catalog = defineErrorCatalog(
      owner,
      value.definitions as Parameters<typeof defineErrorCatalog>[1],
      { allowLegacyCodes: true },
    );
    return { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION, catalog };
  }
  throw new ErrorDefinitionError('errorCatalog requires catalog or definitions');
}

/**
 * Merge core system catalog with loaded tool catalogs; fail on code collisions
 * across tools (same code, different owner).
 */
export function aggregateErrorCatalogs(
  toolCatalogs: readonly { toolName: string; toolId: string; catalog: ErrorCatalog }[],
): {
  readonly byCode: ReadonlyMap<string, ErrorDefinition & { readonly toolName?: string }>;
  readonly collisions: readonly { code: string; owners: readonly string[] }[];
} {
  const byCode = new Map<string, ErrorDefinition & { toolName?: string }>();
  const collisions: { code: string; owners: string[] }[] = [];

  for (const def of coreSystemErrorCatalog.list) {
    byCode.set(def.code, def);
  }

  for (const entry of toolCatalogs) {
    for (const def of entry.catalog.list) {
      const existing = byCode.get(def.code);
      if (existing && existing.owner.id !== def.owner.id) {
        collisions.push({
          code: def.code,
          owners: [existing.owner.id, def.owner.id],
        });
        continue;
      }
      byCode.set(def.code, { ...def, toolName: entry.toolName });
    }
  }

  return { byCode, collisions };
}

export { coreSystemErrorCatalog, ERROR_CATALOG_SCHEMA_VERSION } from '../lib/error-definition.js';
