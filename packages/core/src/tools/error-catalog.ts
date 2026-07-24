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
import { isPlainDataObject } from '../lib/plain-data-object.js';

/** Wire shape for optional tool catalog contribution. */
export interface ToolErrorCatalogContribution {
  readonly schemaVersion: typeof ERROR_CATALOG_SCHEMA_VERSION;
  readonly catalog: ErrorCatalog;
}

/** @throws {ErrorDefinitionError} When a contribution field cannot be safely inspected. */
function ownData(value: object, key: string): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new ErrorDefinitionError(`errorCatalog.${key} could not be inspected`);
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new ErrorDefinitionError(`errorCatalog.${key} must be a data property`);
  }
  return descriptor.value;
}

/**
 * Validate an optional tool catalog contribution (hostile plugin input).
 * @throws {ErrorDefinitionError} When the value is missing/not a plain object, the schemaVersion is unsupported, the owner id mismatches, or neither a catalog nor definitions are present.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Hostile plugin admission validates each independent schema/owner/plain-data invariant before copying.
export function validateToolErrorCatalogContribution(
  raw: unknown,
  owner: ErrorCatalogOwner,
): ToolErrorCatalogContribution {
  if (raw === undefined || raw === null) {
    throw new ErrorDefinitionError('errorCatalog contribution is required when provided');
  }
  if (!isPlainDataObject(raw)) {
    throw new ErrorDefinitionError('errorCatalog must be a plain object');
  }
  const value = raw;
  const schemaVersion = ownData(value, 'schemaVersion');
  if (schemaVersion !== ERROR_CATALOG_SCHEMA_VERSION) {
    throw new ErrorDefinitionError(
      `unsupported errorCatalog schemaVersion (expected ${ERROR_CATALOG_SCHEMA_VERSION})`,
    );
  }
  // Accept either `{ schemaVersion, catalog }`, a bare ErrorCatalog, or a
  // definitions contribution. Every accepted form is copied through
  // defineErrorCatalog; a plugin-provided get/require/list implementation is
  // never retained by the host.
  const nestedCatalog = ownData(value, 'catalog');
  const candidate = nestedCatalog ?? value;
  if (!isPlainDataObject(candidate)) {
    throw new ErrorDefinitionError('errorCatalog.catalog must be a plain object');
  }
  if (ownData(candidate, 'schemaVersion') !== ERROR_CATALOG_SCHEMA_VERSION) {
    throw new ErrorDefinitionError(
      `unsupported nested errorCatalog schemaVersion (expected ${ERROR_CATALOG_SCHEMA_VERSION})`,
    );
  }

  const declaredOwner = ownData(candidate, 'owner');
  let declaredPackageName: string | undefined;
  if (declaredOwner !== undefined) {
    if (!isPlainDataObject(declaredOwner)) {
      throw new ErrorDefinitionError('errorCatalog owner must be a plain object');
    }
    const declaredId = ownData(declaredOwner, 'id');
    if (declaredId !== owner.id) {
      throw new ErrorDefinitionError(
        `errorCatalog owner id '${typeof declaredId === 'string' ? declaredId : '<missing>'}' does not match tool owner '${owner.id}'`,
      );
    }
    const packageName = ownData(declaredOwner, 'packageName');
    if (typeof packageName === 'string') declaredPackageName = packageName;
  }

  const definitions = ownData(candidate, 'definitions');
  if (!isPlainDataObject(definitions)) {
    throw new ErrorDefinitionError('errorCatalog requires catalog or definitions');
  }
  const effectiveOwner: ErrorCatalogOwner = {
    id: owner.id,
    displayName: owner.displayName,
    ...(owner.packageName === undefined && declaredPackageName === undefined
      ? {}
      : { packageName: owner.packageName ?? declaredPackageName }),
  };
  const catalog = defineErrorCatalog(
    effectiveOwner,
    definitions as Parameters<typeof defineErrorCatalog>[1],
    { allowLegacyCodes: true },
  );
  return { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION, catalog };
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
      if (
        def.owner.id !== entry.toolId ||
        (existing !== undefined &&
          (existing.owner.id !== def.owner.id || existing.toolName !== entry.toolName))
      ) {
        collisions.push({
          code: def.code,
          owners: [existing?.owner.id ?? entry.toolId, def.owner.id],
        });
        continue;
      }
      byCode.set(def.code, Object.freeze({ ...def, toolName: entry.toolName }));
    }
  }

  return { byCode, collisions };
}

export { coreSystemErrorCatalog, ERROR_CATALOG_SCHEMA_VERSION } from '../lib/error-definition.js';
