export { buildProjectInventory } from './inventory.js';
export { readPackageManifestFacts } from './manifest-facts.js';
export { classifyFileRoles } from './file-roles.js';
export { projectConfigIdentity } from './identity.js';
export {
  DEFAULT_INVENTORY_LIMITS,
  MAX_COMMAND_ARGV,
  MAX_COMMAND_ARG_LENGTH,
  MAX_FACT_TEXT,
  MAX_FILE_TARGETS,
  MAX_FILE_LANGUAGES,
  MAX_INVENTORY_SERIALIZED_BYTES,
  MAX_INVENTORY_FILES,
  MAX_INVENTORY_PACKAGES,
  MAX_INVENTORY_TARGETS,
  MAX_MANIFEST_BINS,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_DEPTH,
  MAX_MANIFEST_EXPORTS,
  MAX_PACKAGE_SCRIPTS,
  MAX_PROJECT_LANGUAGES,
  MAX_SCRIPT_NAME,
  MAX_TARGET_CONVENTION_PATH_LENGTH,
  MAX_TARGET_CONVENTION_PATHS,
  MAX_TARGET_METADATA_TEXT,
  MAX_TARGET_METADATA_VALUES,
  MAX_TARGET_NAME,
  MAX_TARGET_RESOLVED_PATH_LENGTH,
  MAX_WORKSPACE_PATTERNS,
} from './types.js';

export type { FileRoleClassification } from './file-roles.js';
export type {
  InventoryLimits,
  LanguageEvidenceSupport,
  PackageManifestFacts,
  PackageManifestFactsResult,
  PackageManifestFailureReason,
  PackageManifestReadInput,
  ProjectInventory,
  ProjectInventoryInput,
} from './types.js';
