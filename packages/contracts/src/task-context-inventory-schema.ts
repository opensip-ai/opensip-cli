import { z } from 'zod';

import {
  PROJECT_INVENTORY_SCHEMA_VERSION,
  TEST_SELECTION_SCHEMA_VERSION,
} from './task-context-model.js';
import {
  contextCoverageSchema,
  graphIdentitySchema,
  inventoryIdentitySchema,
  inventoryMetadataIdentitySchema,
  reasonCodeSchema,
  relativePathSchema,
  rootPathSchema,
  safeText,
  testSelectionIdentitySchema,
  verificationCommandSchema,
} from './task-context-schema-shared.js';

const factProvenanceSchema = z
  .object({
    source: z.enum(['target', 'manifest', 'convention', 'filesystem']),
    detail: safeText(256),
  })
  .strict();

export const projectInventorySnapshotSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_INVENTORY_SCHEMA_VERSION),
    snapshotId: inventoryIdentitySchema,
    metadataIdentity: inventoryMetadataIdentitySchema,
    project: z
      .object({
        packageManager: safeText(128).optional(),
        workspacePatterns: z.array(safeText(1024)).max(128),
        languages: z.array(safeText(128)).max(256),
        fileCount: z.number().int().nonnegative().max(20_000),
        packageCount: z.number().int().nonnegative().max(2000),
        configIdentity: safeText(256),
      })
      .strict(),
    packages: z
      .array(
        z
          .object({
            name: safeText(214),
            root: rootPathSchema,
            private: z.boolean(),
            exports: z.array(safeText(1024)).max(256),
            bins: z.array(safeText(1024)).max(128),
            verificationCommands: z.array(verificationCommandSchema).max(100),
            provenance: z.array(factProvenanceSchema).max(32),
          })
          .strict(),
      )
      .max(2000),
    files: z
      .array(
        z
          .object({
            path: relativePathSchema,
            size: z.number().int().nonnegative(),
            modifiedMs: z.number().nonnegative(),
            roles: z
              .array(
                z.enum([
                  'production',
                  'test',
                  'configuration',
                  'documentation',
                  'generated',
                  'build',
                  'unknown',
                ]),
              )
              .max(8),
            targets: z.array(safeText(128)).max(8),
            languages: z.array(safeText(128)).max(32),
            evidenceSupport: z
              .object({
                callable: z.enum(['supported', 'unsupported', 'unknown']),
                declaration: z.enum(['supported', 'unsupported', 'unknown']),
                reference: z.enum(['supported', 'unsupported', 'unknown']),
              })
              .strict(),
            packageName: safeText(214).optional(),
            provenance: z.array(factProvenanceSchema).max(32),
          })
          .strict(),
      )
      .max(20_000),
    coverage: contextCoverageSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const paths = new Set<string>();
    snapshot.files.forEach((file, index) => {
      if (paths.has(file.path)) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: `duplicate inventory file '${file.path}'`,
        });
      }
      paths.add(file.path);
      for (const [field, values] of [
        ['roles', file.roles],
        ['targets', file.targets],
        ['languages', file.languages],
      ] as const) {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: 'custom',
            path: ['files', index, field],
            message: `duplicate ${field.slice(0, -1)}`,
          });
        }
      }
    });
    if (snapshot.project.fileCount !== snapshot.files.length) {
      context.addIssue({
        code: 'custom',
        path: ['project', 'fileCount'],
        message: 'project file count must match retained file facts',
      });
    }
    if (snapshot.project.packageCount !== snapshot.packages.length) {
      context.addIssue({
        code: 'custom',
        path: ['project', 'packageCount'],
        message: 'project package count must match retained package facts',
      });
    }
    const packageNames = snapshot.packages.map((pkg) => pkg.name);
    const packageRoots = snapshot.packages.map((pkg) => pkg.root);
    if (new Set(packageNames).size !== packageNames.length) {
      context.addIssue({
        code: 'custom',
        path: ['packages'],
        message: 'duplicate package name',
      });
    }
    if (new Set(packageRoots).size !== packageRoots.length) {
      context.addIssue({
        code: 'custom',
        path: ['packages'],
        message: 'duplicate package root',
      });
    }
    const factLanguages = new Set(snapshot.files.flatMap((file) => file.languages));
    if (
      snapshot.project.languages.length !== factLanguages.size ||
      snapshot.project.languages.some((language) => !factLanguages.has(language)) ||
      new Set(snapshot.project.languages).size !== snapshot.project.languages.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['project', 'languages'],
        message: 'project languages must be a unique projection of retained file facts',
      });
    }
  });

const selectedTestSchema = z
  .object({
    path: relativePathSchema,
    basis: z.enum([
      'direct-call',
      'transitive-call',
      'module-import',
      'target-convention',
      'co-located',
    ]),
    confidence: z.enum(['exact', 'high', 'medium', 'low']),
    proof: z.array(safeText(1024)).max(6),
    observed: z.literal(false),
  })
  .strict();

export const testSelectionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(TEST_SELECTION_SCHEMA_VERSION),
    snapshotId: testSelectionIdentitySchema,
    files: z.array(relativePathSchema).max(128),
    tests: z.array(selectedTestSchema).max(500),
    commands: z.array(verificationCommandSchema).max(100),
    uncoveredFiles: z.array(relativePathSchema).max(128),
    trust: z
      .object({
        status: z.enum(['complete', 'partial', 'fallback']),
        reasonCodes: z.array(reasonCodeSchema).max(32),
        fallbackTier: z.enum(['focused', 'package', 'full']),
      })
      .strict(),
    graphIdentity: graphIdentitySchema,
    inventoryIdentity: inventoryIdentitySchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    for (const [path, values] of [
      ['files', snapshot.files],
      ['uncoveredFiles', snapshot.uncoveredFiles],
      ['tests', snapshot.tests.map((test) => test.path)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          path: [path],
          message: `duplicate ${path} entry`,
        });
      }
    }
  });
