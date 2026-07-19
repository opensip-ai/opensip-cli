import { join } from 'node:path';

import { type classifyWorkingDir } from './state-machine.js';

import type { InitAuthoredMode, InitAuthoredPlan } from './init-authored-plan.js';
import type { SupportedLanguage } from './language-detection.js';
import type {
  AgentGuidanceResult,
  InitOptions,
  InitResult,
  RuntimeAdoptionResult,
} from '@opensip-cli/contracts';

export type BaseInitResult = Pick<InitResult, 'type' | 'path' | 'cwd' | 'configFilename'>;

const APPLIED_ADOPTION_STATUSES = new Set<RuntimeAdoptionResult['status']>([
  'not-found',
  'promoted',
  'already-project',
  'deduplicated',
  'kept-project',
  'cleanup-pending',
]);

export function languageResolutionFailure(
  error: NonNullable<InitResult['languageResolutionError']>,
): Pick<InitResult, 'languageResolutionError'> {
  return { languageResolutionError: error };
}

export function explicitAuthoredMode(
  args: Pick<InitOptions, 'keep' | 'remove'>,
): 'keep' | 'remove' | undefined {
  if (args.keep === true) return 'keep';
  if (args.remove === true) return 'remove';
  return undefined;
}

export function authoredModeFor(
  state: ReturnType<typeof classifyWorkingDir>,
  args: Pick<InitOptions, 'keep' | 'remove'>,
): InitAuthoredMode {
  return (
    explicitAuthoredMode(args) ??
    (state === 'fully-initialized' || state === 'partial-config-only' ? 'refresh' : 'fresh')
  );
}

function createdFilesFromPlan(projectRoot: string, plan: InitAuthoredPlan): readonly string[] {
  return plan.mutations
    .filter(
      (mutation) =>
        mutation.targetType === 'file' &&
        (mutation.action === 'create' || mutation.action === 'replace') &&
        (mutation.path === 'opensip-cli.config.yml' ||
          (mutation.path.startsWith('opensip-cli/') &&
            !mutation.path.startsWith('opensip-cli/.runtime/'))),
    )
    .map((mutation) => join(projectRoot, mutation.path));
}

function guidanceFromPlan(plan: InitAuthoredPlan): AgentGuidanceResult | undefined {
  return plan.presentation?.agentGuidance;
}

export function authoredStateChangedResult(input: {
  readonly baseResult: BaseInitResult;
  readonly plan: InitAuthoredPlan;
  readonly languages: readonly SupportedLanguage[];
}): InitResult {
  const state = input.plan.presentation?.workingDirState ?? 'partial-dir-only';
  const preExistingFiles = input.plan.presentation?.preExistingFiles ?? [];
  return {
    ...input.baseResult,
    created: false,
    state,
    ...(input.languages.length === 0 ? {} : { languages: input.languages }),
    preExistingFiles,
    authoredStateChangedError: {
      observedState: state,
      message:
        'Init-authored files changed while OpenSIP was planning this operation. No files were changed; retry opensip init.',
    },
  };
}

export function adoptionApplied(adoption: RuntimeAdoptionResult): boolean {
  return APPLIED_ADOPTION_STATUSES.has(adoption.status);
}

export function recoveredPreAttemptState(
  mode: InitAuthoredMode,
): NonNullable<InitResult['state']> | undefined {
  // `fresh` is selected only for a pristine project. The other authored modes
  // can begin from more than one state, and the v1 durable journal intentionally
  // does not serialize that presentation-only value. Do not misreport the
  // post-commit filesystem classification as the state at Init time.
  return mode === 'fresh' ? 'pristine' : undefined;
}

export function explicitRecoveryRequest(
  args: Pick<InitOptions, 'keep' | 'remove' | 'runtimeConflict'>,
  languages: readonly SupportedLanguage[] | undefined,
):
  | Record<string, never>
  | {
      readonly explicit: {
        readonly languages?: readonly SupportedLanguage[];
        readonly authoredMode?: ReturnType<typeof explicitAuthoredMode>;
        readonly conflict?: NonNullable<InitOptions['runtimeConflict']>;
      };
    } {
  const authoredMode = explicitAuthoredMode(args);
  if (languages === undefined && authoredMode === undefined && args.runtimeConflict === undefined) {
    return {};
  }
  return {
    explicit: {
      ...(languages === undefined ? {} : { languages }),
      ...(authoredMode === undefined ? {} : { authoredMode }),
      ...(args.runtimeConflict === undefined ? {} : { conflict: args.runtimeConflict }),
    },
  };
}

export function recoveryResultLanguages(
  recorded: { readonly languages: readonly SupportedLanguage[] } | undefined,
  explicit: readonly SupportedLanguage[] | undefined,
): readonly SupportedLanguage[] | undefined {
  if (recorded !== undefined) {
    return recorded.languages.length === 0 ? undefined : recorded.languages;
  }
  return explicit;
}

export function resultFromFreshAdoption(input: {
  readonly baseResult: BaseInitResult;
  readonly state: ReturnType<typeof classifyWorkingDir>;
  readonly languages: readonly SupportedLanguage[];
  readonly mode: InitAuthoredMode;
  readonly adoption: RuntimeAdoptionResult;
  readonly plan?: InitAuthoredPlan;
}): InitResult {
  const applied = adoptionApplied(input.adoption);
  const presentation = input.plan?.presentation;
  const agentGuidance = input.plan === undefined ? undefined : guidanceFromPlan(input.plan);
  const createdFiles =
    applied && input.plan !== undefined
      ? createdFilesFromPlan(input.baseResult.cwd, input.plan)
      : [];
  const gitignoreUpdated =
    applied &&
    input.plan?.mutations.some(
      (mutation) =>
        mutation.path === '.gitignore' &&
        (mutation.action === 'create' || mutation.action === 'replace'),
    );
  const agentsMdCreated =
    applied &&
    input.plan?.mutations.some(
      (mutation) => mutation.path === 'AGENTS.md' && mutation.action === 'create',
    );
  return {
    ...input.baseResult,
    created: applied && input.mode !== 'refresh',
    ...(applied && input.mode === 'refresh' ? { refreshed: true } : {}),
    state: input.state,
    ...(input.languages.length === 0 ? {} : { languages: input.languages }),
    createdFiles,
    gitignoreUpdated,
    ...(applied && agentGuidance !== undefined ? { agentGuidance } : {}),
    ...(applied && agentsMdCreated !== undefined ? { agentsMdCreated } : {}),
    preExistingFiles: presentation?.preExistingFiles ?? [],
    runtimeAdoption: input.adoption,
  };
}
