export type {
  DataStore,
  DataStoreOpenOptions,
  DataStoreVersionMismatch,
  DrizzleDataStore,
  DrizzleHandle,
  SqliteBackendHandle,
} from './data-store.js';
export {
  DataStoreMigrationError,
  DataStoreVersionError,
  isDrizzleDataStore,
  requireDrizzleDataStore,
} from './data-store.js';
export { DataStoreFactory } from './factory.js';
export { isDbNewerThanCli, readSupportedDbVersion } from './schema-version.js';
// Generic host-owned baseline/ratchet plane (ADR-0036): the shared table pair
// + the per-tool repo over them.
export { toolBaselineEntries, toolBaselineMeta } from './schema/baseline.js';
export { BaselineRepo } from './baseline-repo.js';
// ADR-0042: the generic keyed tool-state table + repo (the cli.toolState seams).
export { toolState } from './schema/tool-state.js';
export { ToolStateRepo, TOOL_STATE_MAX_PAYLOAD_BYTES } from './tool-state-repo.js';
export type { BaselineEntry, BaselineIdentityMetadata, BaselineRow } from './baseline-repo.js';
export { DEFAULT_TEST_BASELINE_IDENTITY } from './baseline-repo.js';
export type { DataStoreLockContext } from './data-store.js';
