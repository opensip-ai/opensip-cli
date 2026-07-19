/**
 * @fileoverview Public facade for closed SQLite checkpointing and bounded,
 * read-only integrity inspection.
 */

export {
  checkpointSqliteFile,
  checkpointSqliteFileWithDependencies,
  sqliteCheckpointFailureResult,
} from './sqlite-checkpoint.js';
export type { SqliteCheckpointDependencies, SqliteCheckpointOptions } from './sqlite-checkpoint.js';
export {
  SQLITE_FOREIGN_KEY_MAX_SAMPLES,
  SQLITE_QUICK_CHECK_MAX_ISSUES,
} from './sqlite-integrity-contract.js';
export type {
  SqliteForeignKeyCheckResult,
  SqliteForeignKeyRowId,
  SqliteForeignKeyViolation,
  SqliteIntegrityFacts,
  SqliteIntegrityResult,
  SqliteQuickCheckResult,
  SqliteSidecarPresence,
  SqliteSidecarState,
} from './sqlite-integrity-contract.js';
export { inspectSqliteFile, inspectSqliteFileWithDependencies } from './sqlite-inspection.js';
export type { SqliteInspectionDependencies, SqliteInspectionOptions } from './sqlite-inspection.js';
