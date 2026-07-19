import { describe, expect, expectTypeOf, it } from 'vitest';

import * as api from './index.js';

import type {
  InventoryLimits,
  LanguageEvidenceSupport,
  PackageManifestFacts,
  ProjectInventory,
  ProjectInventoryInput,
} from './index.js';

const RUNTIME_EXPORTS = [
  'DEFAULT_INVENTORY_LIMITS',
  'MAX_COMMAND_ARGV',
  'MAX_COMMAND_ARG_LENGTH',
  'MAX_FACT_TEXT',
  'MAX_FILE_LANGUAGES',
  'MAX_FILE_TARGETS',
  'MAX_INVENTORY_FILES',
  'MAX_INVENTORY_PACKAGES',
  'MAX_INVENTORY_SERIALIZED_BYTES',
  'MAX_INVENTORY_TARGETS',
  'MAX_MANIFEST_BINS',
  'MAX_MANIFEST_BYTES',
  'MAX_MANIFEST_DEPTH',
  'MAX_MANIFEST_EXPORTS',
  'MAX_PACKAGE_SCRIPTS',
  'MAX_PROJECT_LANGUAGES',
  'MAX_SCRIPT_NAME',
  'MAX_TARGET_CONVENTION_PATH_LENGTH',
  'MAX_TARGET_CONVENTION_PATHS',
  'MAX_TARGET_METADATA_TEXT',
  'MAX_TARGET_METADATA_VALUES',
  'MAX_TARGET_NAME',
  'MAX_TARGET_RESOLVED_PATH_LENGTH',
  'MAX_WORKSPACE_PATTERNS',
  'buildProjectInventory',
  'classifyFileRoles',
  'findOwningPackage',
  'projectConfigIdentity',
  'readPackageManifestFacts',
] as const;

describe('@opensip-cli/codebase public surface', () => {
  it('keeps the runtime barrel explicit and bounded', () => {
    expect(Object.keys(api).sort()).toEqual([...RUNTIME_EXPORTS].sort());
  });

  it('exports the stable inventory types without runtime values', () => {
    expectTypeOf<ProjectInventoryInput>().toBeObject();
    expectTypeOf<ProjectInventory>().toBeObject();
    expectTypeOf<InventoryLimits>().toBeObject();
    expectTypeOf<LanguageEvidenceSupport>().toBeObject();
    expectTypeOf<PackageManifestFacts>().toBeObject();
    expect(api).not.toHaveProperty('ProjectInventory');
    expect(api).not.toHaveProperty('PackageManifestFacts');
  });
});
