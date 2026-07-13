import type { DogfoodGroundTruth } from './types.js';

/**
 * Small, non-exhaustive anchors for evaluating OpenSIP against its own repo.
 * These are deliberately durable must-include facts, not complete caller sets.
 */
export const dogfoodGroundTruth = {
  packageManager: 'pnpm',
  buildSystem: 'turbo',
  lockfile: 'pnpm-lock.yaml',
  buildCommand: 'pnpm build',
  testCommand: 'pnpm test',
  anchors: [
    {
      symbol: 'RunScope',
      declarationKind: 'class',
      // The class moved out of run-scope.ts; this is its current definition.
      definingFile: 'packages/core/src/lib/run-scope-class.ts',
      publicExportFile: 'packages/core/src/lib/run-scope.ts',
      referenceFiles: [
        'packages/cli/src/bootstrap/build-per-run-scope.ts',
        'packages/fitness/engine/src/recipes/service.ts',
        'packages/tool-test-kit/src/scope.ts',
      ],
    },
    {
      symbol: 'computeImpact',
      declarationKind: 'function',
      definingFile: 'packages/contracts/src/graph-impact-compute.ts',
      referenceFiles: [
        'packages/fitness/engine/src/cli/fit/changed-targeting.ts',
        'packages/graph/engine/src/cli/impact.ts',
      ],
    },
  ],
} as const satisfies DogfoodGroundTruth;
