import { z } from 'zod';

import {
  MAX_TASK_CONTEXT_FILES,
  MAX_TASK_CONTEXT_MANIFEST_BYTES,
  MAX_TASK_CONTEXT_PLANES,
  TASK_CONTEXT_MANIFEST_SCHEMA_VERSION,
  TEST_SELECTION_PLANE_KIND,
} from './task-context-model.js';
import {
  contextCoverageSchema,
  contextPointerIdentitySchema,
  gitObjectIdentitySchema,
  graphIdentitySchema,
  inventoryIdentitySchema,
  reasonCodeSchema,
  safeText,
  sha256IdentitySchema,
  taskContextFollowUpReadSchema,
  taskContextNextActionSchema,
  taskContextRunIdSchema,
  taskContextStepIdSchema,
  testSelectionIdentitySchema,
} from './task-context-schema-shared.js';

import type {
  TaskContextManifest,
  TaskContextPlane,
  TaskContextPlaneKind,
} from './task-context-model.js';

const sourceIdentitySchema = z.discriminatedUnion('status', [
  z
    .object({
      configIdentity: sha256IdentitySchema,
      gitHead: gitObjectIdentitySchema,
      worktreeIdentity: sha256IdentitySchema,
      dirty: z.boolean(),
      status: z.literal('captured'),
      reasonCodes: z.tuple([]),
    })
    .strict(),
  z
    .object({
      configIdentity: sha256IdentitySchema,
      status: z.literal('unsupported'),
      reasonCodes: z.array(reasonCodeSchema).min(1).max(16),
    })
    .strict(),
  z
    .object({
      configIdentity: sha256IdentitySchema,
      status: z.literal('failed'),
      reasonCodes: z.array(reasonCodeSchema).min(1).max(16),
    })
    .strict(),
]);

const runStepReferenceSchema = z
  .object({
    runId: taskContextRunIdSchema,
    stepId: taskContextStepIdSchema,
    logicalStepKey: safeText(512),
    ordinal: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
  })
  .strict();

export const taskContextPlaneSchema = z
  .object({
    kind: z.enum(['inventory', 'graph', TEST_SELECTION_PLANE_KIND]),
    required: z.boolean(),
    status: z.enum(['rebuilt', 'reused', 'partial', 'unsupported', 'failed', 'cancelled']),
    producer: z
      .object({
        toolId: safeText(214),
        command: safeText(128),
        version: safeText(128),
      })
      .strict(),
    pointer: z
      .object({
        owner: z.literal('graph'),
        kind: z.enum(['inventory', 'graph', TEST_SELECTION_PLANE_KIND]),
        id: contextPointerIdentitySchema,
        schemaVersion: z.number().int().positive(),
      })
      .strict()
      .optional(),
    step: runStepReferenceSchema,
    freshness: z
      .object({
        status: z.enum(['current', 'stale', 'unknown']),
        reasonCodes: z.array(reasonCodeSchema).max(32),
      })
      .strict(),
    coverage: contextCoverageSchema,
    caps: z
      .object({
        status: z.enum(['not-hit', 'hit', 'unknown']),
        reasonCodes: z.array(reasonCodeSchema).max(32),
      })
      .strict(),
    reasonCodes: z.array(reasonCodeSchema).max(32),
    followUpReads: z.array(taskContextFollowUpReadSchema).max(16),
  })
  .strict()
  .superRefine((plane, context) => {
    if (
      (plane.status === 'rebuilt' || plane.status === 'reused' || plane.status === 'partial') &&
      plane.pointer === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['pointer'],
        message: 'durable task-context plane status requires a snapshot pointer',
      });
    }
    if (plane.pointer !== undefined && plane.pointer.kind !== plane.kind) {
      context.addIssue({
        code: 'custom',
        path: ['pointer', 'kind'],
        message: 'task-context plane and pointer kinds must match',
      });
    }
    const pointerIdentityMatches =
      plane.pointer === undefined ||
      (plane.pointer.kind === 'inventory' &&
        inventoryIdentitySchema.safeParse(plane.pointer.id).success) ||
      (plane.pointer.kind === 'graph' && graphIdentitySchema.safeParse(plane.pointer.id).success) ||
      (plane.pointer.kind === TEST_SELECTION_PLANE_KIND &&
        testSelectionIdentitySchema.safeParse(plane.pointer.id).success);
    if (!pointerIdentityMatches) {
      context.addIssue({
        code: 'custom',
        path: ['pointer', 'id'],
        message: 'task-context pointer identity does not match its plane kind',
      });
    }
  });

export const taskContextFileScopeSchema = z
  .object({
    mode: z.enum(['project', 'explicit']),
    fileCount: z.number().int().nonnegative().max(MAX_TASK_CONTEXT_FILES),
    filesIdentity: sha256IdentitySchema,
  })
  .strict()
  .superRefine((scope, context) => {
    if (scope.mode === 'project' && scope.fileCount !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['fileCount'],
        message: 'project task-context scope must have zero explicit files',
      });
    }
    if (scope.mode === 'explicit' && scope.fileCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['fileCount'],
        message: 'explicit task-context scope must contain at least one file',
      });
    }
  });

interface TaskContextManifestIssue {
  readonly path?: readonly (string | number)[];
  readonly message: string;
}

function planeKindIssues(manifest: TaskContextManifest): readonly TaskContextManifestIssue[] {
  const issues: TaskContextManifestIssue[] = [];
  const kinds = new Set<string>();
  for (const plane of manifest.planes) {
    if (kinds.has(plane.kind)) {
      issues.push({
        path: ['planes'],
        message: `duplicate task-context plane '${plane.kind}'`,
      });
    }
    kinds.add(plane.kind);
  }
  const expectedKinds: readonly TaskContextPlaneKind[] = [
    'inventory',
    'graph',
    TEST_SELECTION_PLANE_KIND,
  ];
  if (manifest.readiness !== 'unavailable' && expectedKinds.some((kind) => !kinds.has(kind))) {
    issues.push({
      path: ['planes'],
      message: 'ready or degraded task context requires every v1 plane',
    });
  }
  return issues;
}

function planePolicyIssues(manifest: TaskContextManifest): readonly TaskContextManifestIssue[] {
  const issues: TaskContextManifestIssue[] = [];
  for (const plane of manifest.planes) {
    const expectedRequired =
      plane.kind !== TEST_SELECTION_PLANE_KIND || manifest.fileScope.mode === 'explicit';
    if (plane.required !== expectedRequired) {
      issues.push({
        path: ['planes'],
        message: `task-context required policy is invalid for '${plane.kind}'`,
      });
    }
    const requiredNegative =
      plane.required &&
      (plane.status === 'failed' || plane.status === 'cancelled' || plane.status === 'unsupported');
    if (manifest.readiness !== 'unavailable' && requiredNegative) {
      issues.push({
        path: ['readiness'],
        message: 'required negative evidence makes task context unavailable',
      });
    }
  }
  return issues;
}

function planeIsReady(plane: TaskContextPlane): boolean {
  return (
    (plane.status === 'rebuilt' || plane.status === 'reused') &&
    plane.freshness.status === 'current' &&
    plane.freshness.reasonCodes.length === 0 &&
    plane.coverage.status === 'complete' &&
    plane.coverage.reasonCodes.length === 0 &&
    plane.caps.status === 'not-hit' &&
    plane.caps.reasonCodes.length === 0 &&
    plane.reasonCodes.length === 0
  );
}

function readySourcesMatch(manifest: TaskContextManifest): boolean {
  return (
    manifest.sourceStart.status === 'captured' &&
    manifest.sourceEnd.status === 'captured' &&
    manifest.sourceStart.configIdentity === manifest.sourceEnd.configIdentity &&
    manifest.sourceStart.gitHead === manifest.sourceEnd.gitHead &&
    manifest.sourceStart.worktreeIdentity === manifest.sourceEnd.worktreeIdentity &&
    manifest.sourceStart.dirty === manifest.sourceEnd.dirty
  );
}

function readyManifestIssues(manifest: TaskContextManifest): readonly TaskContextManifestIssue[] {
  if (manifest.readiness !== 'ready') return [];
  const valid =
    manifest.planes.every(planeIsReady) &&
    readySourcesMatch(manifest) &&
    manifest.reasonCodes.length === 0 &&
    manifest.graphIdentity !== undefined &&
    manifest.inventoryIdentity !== undefined;
  return valid
    ? []
    : [
        {
          path: ['readiness'],
          message: 'ready task context must contain complete current bound evidence',
        },
      ];
}

function pointerIdentityIssues(manifest: TaskContextManifest): readonly TaskContextManifestIssue[] {
  const issues: TaskContextManifestIssue[] = [];
  for (const [kind, identity] of [
    ['graph', manifest.graphIdentity],
    ['inventory', manifest.inventoryIdentity],
  ] as const) {
    if (identity === undefined) continue;
    const pointer = manifest.planes.find((plane) => plane.kind === kind)?.pointer;
    if (pointer?.id !== identity) {
      issues.push({
        path: [`${kind}Identity`],
        message: `${kind} identity must name the exact recorded plane pointer`,
      });
    }
  }
  return issues;
}

function taskContextManifestIssues(
  manifest: TaskContextManifest,
): readonly TaskContextManifestIssue[] {
  return [
    ...planeKindIssues(manifest),
    ...planePolicyIssues(manifest),
    ...readyManifestIssues(manifest),
    ...pointerIdentityIssues(manifest),
    ...(Buffer.byteLength(JSON.stringify(manifest), 'utf8') <= MAX_TASK_CONTEXT_MANIFEST_BYTES
      ? []
      : [{ message: 'task-context manifest exceeds 64 KiB' }]),
  ];
}

export const taskContextManifestSchema = z
  .object({
    schemaVersion: z.literal(TASK_CONTEXT_MANIFEST_SCHEMA_VERSION),
    suite: z.literal('agent-context'),
    runId: taskContextRunIdSchema,
    createdAt: safeText(64).refine((value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
    }),
    projectIdentity: sha256IdentitySchema,
    readiness: z.enum(['ready', 'degraded', 'unavailable']),
    sourceStart: sourceIdentitySchema,
    sourceEnd: sourceIdentitySchema,
    fileScope: taskContextFileScopeSchema,
    graphIdentity: graphIdentitySchema.optional(),
    inventoryIdentity: inventoryIdentitySchema.optional(),
    planes: z.array(taskContextPlaneSchema).max(MAX_TASK_CONTEXT_PLANES),
    reasonCodes: z.array(reasonCodeSchema).max(32),
    nextActions: z.array(taskContextNextActionSchema).max(16),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const issue of taskContextManifestIssues(manifest)) {
      context.addIssue({
        code: 'custom',
        ...(issue.path === undefined ? {} : { path: [...issue.path] }),
        message: issue.message,
      });
    }
  });

export function parseTaskContextManifest(value: unknown): TaskContextManifest {
  return taskContextManifestSchema.parse(value);
}
