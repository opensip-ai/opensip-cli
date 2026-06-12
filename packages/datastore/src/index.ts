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
export type { BaselineEntry, BaselineRow } from './baseline-repo.js';
