/** Stable evidence classes used by committed fixture ground truth. */
export type CallerEvidenceKind =
  'direct-call' | 'barrel-reexport' | 'dynamic-dispatch' | 'test-call' | 'cross-package';

/** Confidence the current static surface can reasonably attach to a caller. */
export type ExpectedEvidenceConfidence = 'high' | 'medium' | 'low' | 'unresolved';

/** Repository-orientation facts that can be checked against committed files. */
export interface OrientationFacts {
  readonly packageManager: 'pnpm' | 'pip';
  readonly packageManagerDeclaration: string;
  readonly lockfile: string;
  readonly packageCount: number;
  readonly packageNames: readonly string[];
  readonly buildCommand: string;
  readonly testCommand: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceFile?: string;
  readonly workspaceDependencies?: readonly WorkspaceDependencyFact[];
}

/** One declared edge in a fixture workspace's package graph. */
export interface WorkspaceDependencyFact {
  readonly fromPackage: string;
  readonly toPackage: string;
  readonly dependencyKind: 'dependency' | 'devDependency';
}

/** One stable entrypoint-to-implementation trace. */
export interface EntrypointTraceFact {
  readonly feature: string;
  readonly entryFile: string;
  readonly entrySymbol: string;
  readonly implementationFile: string;
  readonly implementationSymbol: string;
  readonly barrelFiles: readonly string[];
}

/** One expected caller of an impact target. */
export interface CallerFact {
  readonly filePath: string;
  readonly symbol: string;
  readonly evidenceKind: CallerEvidenceKind;
  readonly expectedConfidence: ExpectedEvidenceConfidence;
  readonly inTestFile: boolean;
  readonly packageName?: string;
}

/** Ground truth for a changed function and its callers/packages. */
export interface ImpactTargetFact {
  readonly targetFile: string;
  readonly targetSymbol: string;
  readonly callers: readonly CallerFact[];
  readonly impactedPackages: readonly string[];
  readonly unimpactedPackages?: readonly string[];
}

/** Focused tests and the conservative project-wide fallback for one target. */
export interface TestMappingFact {
  readonly irrelevantTestFiles?: readonly string[];
  readonly targetFile: string;
  readonly targetSymbol: string;
  readonly testFiles: readonly string[];
  readonly fallbackCommand: string;
}

/** Typed preconditions for the two mid-edit catalog-staleness cases. */
export interface StalenessFacts {
  readonly targetFile: string;
  readonly targetSymbol: string;
  readonly preEditCallerSymbols: readonly string[];
  readonly addCaller: {
    readonly filePath: string;
    readonly symbol: string;
    readonly content: string;
  };
  readonly postAddCallerSymbols: readonly string[];
  readonly deleteTarget: {
    readonly filePath: string;
    readonly symbolExpectedAbsent: string;
  };
}

/** Complete, fixture-local truth consumed later by gold-task definitions. */
export interface FixtureGroundTruth {
  readonly fixture: 'customer-ts' | 'customer-py' | 'customer-workspace';
  readonly language: 'typescript' | 'python';
  readonly orientation: OrientationFacts;
  readonly entrypoint: EntrypointTraceFact;
  readonly impactTargets: readonly ImpactTargetFact[];
  readonly testMappings: readonly TestMappingFact[];
  readonly staleness?: StalenessFacts;
}

/** Stable codebase anchor for read-only dogfood evaluations. */
export interface DogfoodAnchorFact {
  readonly symbol: string;
  readonly declarationKind: 'class' | 'function';
  readonly definingFile: string;
  readonly publicExportFile?: string;
  readonly referenceFiles: readonly string[];
}

/** Small drift-resistant truth set for the opensip-cli repository itself. */
export interface DogfoodGroundTruth {
  readonly packageManager: 'pnpm';
  readonly buildSystem: 'turbo';
  readonly lockfile: 'pnpm-lock.yaml';
  readonly buildCommand: 'pnpm build';
  readonly testCommand: 'pnpm test';
  readonly anchors: readonly DogfoodAnchorFact[];
}
