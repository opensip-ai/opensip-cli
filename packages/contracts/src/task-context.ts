export {
  MAX_TASK_CONTEXT_FILES,
  MAX_TASK_CONTEXT_MANIFEST_BYTES,
  MAX_TASK_CONTEXT_PLANES,
  PROJECT_INVENTORY_SCHEMA_VERSION,
  TASK_CONTEXT_MANIFEST_SCHEMA_VERSION,
  TEST_SELECTION_SCHEMA_VERSION,
  buildProjectInventorySnapshotIdentities,
  buildTestSelectionSnapshotIdentity,
  projectInventorySnapshotIdentityMatches,
  testSelectionSnapshotIdentityMatches,
} from './task-context-model.js';
export {
  projectInventorySnapshotSchema,
  testSelectionSnapshotSchema,
} from './task-context-inventory-schema.js';
export {
  parseTaskContextManifest,
  taskContextFileScopeSchema,
  taskContextManifestSchema,
  taskContextPlaneSchema,
} from './task-context-manifest-schema.js';
export {
  buildTaskContextFileScope,
  buildTaskContextProjectIdentity,
  contextCoverageSchema,
} from './task-context-schema-shared.js';

export type {
  ContextCoverage,
  EvidenceReadSupportStatus,
  FactProvenance,
  FactProvenanceSource,
  FileEvidenceSupport,
  FileFact,
  FileRole,
  PackageFact,
  ProjectFact,
  ProjectInventorySnapshot,
  SelectedTest,
  TaskContextFileScope,
  TaskContextManifest,
  TaskContextPlane,
  TaskContextPlaneKind,
  TaskContextPlaneStatus,
  TaskContextReadiness,
  TaskContextSnapshotPointer,
  TaskContextSourceIdentity,
  TestSelectionBasis,
  TestSelectionSnapshot,
  TestSelectionTrust,
  VerificationCommand,
} from './task-context-model.js';
