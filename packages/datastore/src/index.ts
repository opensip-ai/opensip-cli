export type {
  DataStore,
  DataStoreOpenOptions,
  DataStoreVersionMismatch,
  DatastoreMaintenance,
} from './data-store.js';
export { DataStoreMigrationError, DataStoreVersionError } from './data-store.js';
export { DataStoreFactory } from './factory.js';
export { isDbNewerThanCli, readSupportedDbVersion } from './schema-version.js';
// Generic host-owned baseline/ratchet plane (ADR-0036): repository only —
// table objects stay package-internal (ADR-0009 / ADR-0107).
export { BaselineRepo } from './baseline-repo.js';
// ADR-0042: the generic keyed state repo (cli toolState seams).
export { ToolStateRepo, TOOL_STATE_MAX_PAYLOAD_BYTES } from './tool-state-repo.js';
export {
  PolicyAuditRepo,
  POLICY_AUDIT_DEFAULT_LIMIT,
  POLICY_AUDIT_MAX_JSON_BYTES,
  POLICY_AUDIT_MAX_LIMIT,
  POLICY_AUDIT_MAX_ROWS,
  POLICY_AUDIT_MAX_STRING_BYTES,
} from './policy-audit-repo.js';
export type { BaselineEntry, BaselineIdentityMetadata, BaselineRow } from './baseline-repo.js';
export type {
  PolicyAuditAppendEvent,
  PolicyAuditListOptions,
  PolicyAuditStoredEvent,
} from './policy-audit-repo.js';
export type { DataStoreLockContext } from './data-store.js';
