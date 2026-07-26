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
  // No `allowLegacyCodes` here, deliberately: a third-party tool's catalog is held to the same
  // grammar and one-head-per-owner rule as a first-party one. Exempting the tools we do NOT
  // control, while binding the ones we do, would invert the point of the guardrail.
  const catalog = defineErrorCatalog(
    effectiveOwner,
    definitions as Parameters<typeof defineErrorCatalog>[1],
  );
  return { schemaVersion: ERROR_CATALOG_SCHEMA_VERSION, catalog };
}

/**
 * A catalog owned by a non-Tool package (Plan 01 ruling D1).
 *
 * Before this existed the only registration path was `ToolExtensionPoints.errorCatalog`,
 * so a substrate such as config, datastore, session-store, output, codebase or targeting
 * had no way to own a code: its failures either normalized at the CLI composition root —
 * making the host the recorded owner of failures it never raised — or fell back to a
 * legacy family, which erases the axes that make a code useful. `DataStoreVersionError`
 * is the worked example: its message IS the user's upgrade instruction, yet a
 * `SYSTEM_ERROR` fallback carries `exposure: 'redacted'` and hides it.
 *
 * Ownership is keyed on the package name, so attribution stays honest and the generated
 * code index stays complete.
 */
export interface SubstrateErrorCatalogContribution {
  /** npm package name; must equal every contributed definition's `owner.id`. */
  readonly packageName: string;
  readonly catalog: ErrorCatalog;
}

/**
 * Merge the core system catalog with loaded tool catalogs and substrate catalogs; fail on
 * code collisions across owners (same code, different owner).
 *
 * Substrates are folded in BEFORE tools so that a tool contributing a code a substrate
 * already owns is reported as a collision rather than silently taking ownership.
 */
export function aggregateErrorCatalogs(
  toolCatalogs: readonly { toolName: string; toolId: string; catalog: ErrorCatalog }[],
  substrateCatalogs: readonly SubstrateErrorCatalogContribution[] = [],
): {
  readonly byCode: ReadonlyMap<string, ErrorDefinition & { readonly toolName?: string }>;
  readonly collisions: readonly { code: string; owners: readonly string[] }[];
} {
  const fold = new CatalogFold();

  for (const def of coreSystemErrorCatalog.list) fold.seedCore(def);
  // Substrates before tools: see the doc comment above.
  for (const entry of substrateCatalogs) fold.admit(entry.catalog, entry.packageName);
  for (const entry of toolCatalogs) fold.admit(entry.catalog, entry.toolId, entry.toolName);

  return fold.result();
}

/**
 * One pass of catalog admission, extracted so substrates and tools share it rather than
 * running two near-identical loops whose only real difference is the `toolName` stamp.
 */
class CatalogFold {
  private readonly byCode = new Map<string, ErrorDefinition & { toolName?: string }>();
  private readonly collisions: { code: string; owners: string[] }[] = [];

  /**
   * head → the owner that claimed it.
   *
   * `defineErrorCatalog` already guarantees one head PER catalog; this is the other half of
   * the same invariant — one owner per head ACROSS catalogs. Together they are what makes a
   * code globally unique without a central allocator: an owner cannot mint outside its head,
   * and no two owners share one. Without this half, two packages could each be internally
   * consistent under `X.` and still collide on `X.CONFIG.INVALID`.
   */
  private readonly headClaims = new Map<string, string>();

  seedCore(def: ErrorDefinition): void {
    this.byCode.set(def.code, def);
  }

  /** Fold one catalog in, recording every collision it causes rather than throwing. */
  admit(catalog: ErrorCatalog, ownerId: string, toolName?: string): void {
    this.claimHead(catalog, ownerId);
    for (const def of catalog.list) {
      const existing = this.byCode.get(def.code);
      if (def.owner.id !== ownerId || this.isTaken(existing, def, toolName)) {
        this.collisions.push({
          code: def.code,
          owners: [existing?.owner.id ?? ownerId, def.owner.id],
        });
        continue;
      }
      this.byCode.set(
        def.code,
        Object.freeze({ ...def, ...(toolName === undefined ? {} : { toolName }) }),
      );
    }
  }

  result(): {
    readonly byCode: ReadonlyMap<string, ErrorDefinition & { readonly toolName?: string }>;
    readonly collisions: readonly { code: string; owners: readonly string[] }[];
  } {
    return { byCode: this.byCode, collisions: this.collisions };
  }

  /**
   * A substrate may not overwrite ANY code already present. A tool may re-register its own
   * code under its own name — one owner is allowed more than one catalog — but not a code
   * another owner holds.
   */
  private isTaken(
    existing: (ErrorDefinition & { toolName?: string }) | undefined,
    def: ErrorDefinition,
    toolName: string | undefined,
  ): boolean {
    if (existing === undefined) return false;
    if (toolName === undefined) return true;
    return existing.owner.id !== def.owner.id || existing.toolName !== toolName;
  }

  /** Record a head conflict WITHOUT skipping the catalog, so per-code clashes still surface. */
  private claimHead(catalog: ErrorCatalog, ownerId: string): void {
    const head = catalog.codeHead;
    // `undefined` head = the legacy class-default catalog, whose codes are un-dotted and
    // therefore cannot collide with an owner-scoped one.
    if (head === undefined) return;
    const claimed = this.headClaims.get(head);
    if (claimed !== undefined && claimed !== ownerId) {
      this.collisions.push({ code: `${head}.*`, owners: [claimed, ownerId] });
      return;
    }
    this.headClaims.set(head, ownerId);
  }
}

export { coreSystemErrorCatalog, ERROR_CATALOG_SCHEMA_VERSION } from '../lib/error-definition.js';
