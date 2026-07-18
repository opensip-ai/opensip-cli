/**
 * init command — scaffold the project layout.
 *
 * Registry-driven (ADR-0038): `init` scaffolds one directory tree per
 * REGISTERED tool, never a hardcoded fit/sim pair. Each tool owns its own
 * example bytes + config block; the host owns only the directory layout
 * (`pluginLayout`), the document header, and `targets:`. With the bundled
 * fitness + simulation tools registered, a TypeScript project gets:
 *   <cwd>/opensip-cli.config.yml                                    (TRACKED)
 *   <cwd>/opensip-cli/fit/checks/example-check.mjs                  (TRACKED)
 *   <cwd>/opensip-cli/fit/recipes/example-recipe.mjs                (TRACKED)
 *   <cwd>/opensip-cli/sim/scenarios/example-scenario.mjs            (TRACKED)
 *   <cwd>/opensip-cli/sim/recipes/example-recipe.mjs                (TRACKED)
 * A tool with no `pluginLayout` (e.g. `graph`) contributes no directory.
 *
 * Consequence — the scaffolded set equals the REGISTERED set:
 *   - A tool installed AFTER `init` scaffolds on the next `init --keep`.
 *   - Back-compat behavior shift: if a bundled tool fails to load, init
 *     now scaffolds FEWER dirs (vs the old always-fit/sim). A bundled tool
 *     that's expected but absent is surfaced loudly via the
 *     `cli.tool.expected_bundled_absent` diagnostic (bootstrap) so a silent
 *     under-scaffold is observable; a genuinely uninstalled third-party
 *     tool stays silent (correct).
 *
 * Appends `opensip-cli/.runtime/` to <cwd>/.gitignore so the
 * tool-generated state (sessions, logs, dashboards, baselines, plugin
 * installs) stays untracked.
 *
 * Promotion path: when a customer's pack outgrows a handful of .mjs
 * files (shared helpers, tests, more than a dozen checks/scenarios),
 * `opensip-cli/<domain>/` can graduate to a real workspace npm
 * package — fit packs declare the `fit-pack` marker plus target-domain epoch;
 * sim packs use the `scenarios-*` package-name pattern. Add `tsconfig.json` and
 * an `index.ts` re-exporting checks/recipes or scenarios/recipes. Marker-based
 * discovery picks up a fit workspace package automatically regardless of npm
 * scope. The init scaffold stays loose-`.mjs` to
 * preserve the fast first-touch experience; graduation is a manual
 * step the customer takes when their coverage becomes substantial.
 * See docs/public/50-extend/01-plugin-authoring.md.
 *
 * Language selection drives:
 *   - which `targets:` entry shape goes into the YAML config
 *   - the `scope.languages` field on the example check
 *
 * `--language <list>` (comma-separated or repeatable) overrides detection.
 * Detection inspects filesystem markers (Cargo.toml, pyproject.toml,
 * go.mod, pom.xml/build.gradle, CMakeLists.txt, package.json+tsconfig)
 * and accepts every detected language in host-canonical order (polyglot
 * is not an error). When no markers are found and --language is missing,
 * or when --language is empty/unknown, init exits 2 with a helpful prompt
 * — no partial scaffolding.
 *
 * Partial-state handling:
 *
 * After language resolution, init classifies the working directory
 * into one of four states based on the presence of the config file
 * and the `opensip-cli/` directory:
 *
 *   - 'pristine'             — neither present; scaffold everything.
 *   - 'fully-initialized'    — both present; refresh guidance without a flag.
 *   - 'partial-config-only'  — config only; refresh guidance without a flag.
 *   - 'partial-dir-only'     — config XOR dir; refuse without a flag.
 *
 * Two flags express explicit user intent for the non-pristine states:
 *
 *   - `--keep`   — re-scaffold examples; preserve existing config and custom files.
 *   - `--remove` — delete `opensip-cli/` entirely; scaffold fresh.
 *
 * The two flags are mutually exclusive. The legacy `--force` flag is
 * gone; users who scripted it should migrate to `--remove`, the
 * closest semantic match.
 *
 * Implementation is split across `./init/` siblings:
 *   - language-detection.ts — marker scanning + `--language` parsing
 *   - config-templates.ts   — host-owned YAML document skeleton (header +
 *                             targets); per-tool config blocks come from
 *                             each tool's `scaffoldConfigBlock()`
 *   - file-classifier.ts    — scaffolded / stale / custom tagging
 *   - state-machine.ts      — working-dir state + refusal messages
 *   - scaffold-writer.ts    — disk writes, gitignore patching, refresh mode
 *
 * This file is the orchestrator: argument validation → language
 * resolution → state classification → file classification → scaffold
 * (or refuse).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  inspectRuntimePromotionRecoveryHeader,
  resolveProjectPaths,
  type ProjectContext,
} from '@opensip-cli/core';

import { classifyFiles } from './init/file-classifier.js';
import { createInitAuthoredPlan } from './init/init-authored-plan.js';
import {
  canonicalizeLanguages,
  resolveLanguages,
  type SupportedLanguage,
} from './init/language-detection.js';
import { recoverRuntimePromotion } from './init/runtime-promotion-recovery.js';
import { runFreshRuntimePromotion } from './init/runtime-promotion.js';
import { buildPartialStateMessage, classifyWorkingDir } from './init/state-machine.js';

import type { InitAuthoredMode, InitAuthoredPlan } from './init/init-authored-plan.js';
import type { RuntimePromotionRecoveryDependencies } from './init/runtime-promotion-recovery.js';
import type { RuntimePromotionDependencies } from './init/runtime-promotion.js';
import type { ToolScaffold } from './shared.js';
import type {
  AgentGuidanceResult,
  InitOptions,
  InitResult,
  RuntimeAdoptionResult,
} from '@opensip-cli/contracts';
import type { DataStoreLockContext } from '@opensip-cli/datastore';

interface ExecuteInitBaseArgs extends InitOptions {
  projectContext?: ProjectContext;
  cwdExplicit?: boolean;
  datastoreLockContext: DataStoreLockContext;
}

type ExecuteInitArgs = ExecuteInitBaseArgs & {
  toolScaffolds: readonly ToolScaffold[];
};

type BaseInitResult = Pick<InitResult, 'type' | 'path' | 'cwd' | 'configFilename'>;

type FreshInitAttempt =
  | {
      readonly ok: true;
      readonly state: ReturnType<typeof classifyWorkingDir>;
      readonly languages: readonly SupportedLanguage[];
      readonly mode: InitAuthoredMode;
    }
  | {
      readonly ok: false;
      readonly result: InitResult;
    };

const APPLIED_ADOPTION_STATUSES = new Set<RuntimeAdoptionResult['status']>([
  'not-found',
  'promoted',
  'already-project',
  'deduplicated',
  'kept-project',
  'cleanup-pending',
]);

class InitAttemptResolutionError extends Error {
  constructor(readonly result: InitResult) {
    super('Init attempt inputs changed while waiting for exclusive authority');
    this.name = 'InitAttemptResolutionError';
  }
}

function languageResolutionFailure(
  error: NonNullable<InitResult['languageResolutionError']>,
): Pick<InitResult, 'languageResolutionError' | 'ambiguousLanguageError'> {
  // Dual-write: languageResolutionError is the current field;
  // ambiguousLanguageError remains for older --json consumers.
  return {
    languageResolutionError: error,
    ambiguousLanguageError: error,
  };
}

function explicitLanguageResolution(
  cwd: string,
  language: readonly string[] | undefined,
):
  | { readonly ok: true; readonly languages?: readonly SupportedLanguage[] }
  | {
      readonly ok: false;
      readonly error: NonNullable<InitResult['languageResolutionError']>;
    } {
  if (language === undefined || language.length === 0) return { ok: true };
  const resolution = resolveLanguages(cwd, language);
  return resolution.ok
    ? { ok: true, languages: canonicalizeLanguages(resolution.languages) }
    : { ok: false, error: resolution.error };
}

function baseInitResult(cwd: string): BaseInitResult {
  const paths = resolveProjectPaths(cwd);
  return {
    type: 'init',
    path: paths.configFile,
    cwd,
    configFilename: 'opensip-cli.config.yml',
  };
}

function invalidInitInput(
  args: ExecuteInitBaseArgs,
  baseResult: BaseInitResult,
): InitResult | undefined {
  if (args.keep === true && args.remove === true) {
    return {
      ...baseResult,
      created: false,
      partialStateError: {
        state: 'fully-initialized',
        preExistingFiles: [],
        message: '--keep and --remove are mutually exclusive. Pick one.',
      },
    };
  }
  if (!existsSync(args.cwd)) {
    return {
      ...baseResult,
      created: false,
      ...languageResolutionFailure({
        detected: [],
        message: `Target directory does not exist: ${args.cwd}`,
      }),
    };
  }
  return undefined;
}

function resolveFreshInitAttempt(input: {
  readonly args: ExecuteInitArgs;
  readonly baseResult: BaseInitResult;
  readonly cwd: string;
  readonly paths: ReturnType<typeof resolveProjectPaths>;
}): FreshInitAttempt {
  const state = classifyWorkingDir(input.paths);
  const languageExplicit = input.args.language !== undefined && input.args.language.length > 0;
  const mode = authoredModeFor(state, input.args);
  const resolution =
    mode === 'refresh' && !languageExplicit
      ? ({ ok: true, languages: [] } as const)
      : resolveLanguages(input.cwd, input.args.language);
  if (!resolution.ok) {
    return {
      ok: false,
      result: {
        ...input.baseResult,
        created: false,
        ...languageResolutionFailure(resolution.error),
      },
    };
  }
  const languages = canonicalizeLanguages(resolution.languages);
  if (state === 'partial-dir-only' && explicitAuthoredMode(input.args) === undefined) {
    const preExistingFiles = classifyFiles(input.paths, languages, input.args.toolScaffolds);
    return {
      ok: false,
      result: {
        ...input.baseResult,
        created: false,
        state,
        languages,
        preExistingFiles,
        partialStateError: {
          state,
          preExistingFiles,
          message: buildPartialStateMessage(state, preExistingFiles, input.cwd),
        },
      },
    };
  }
  return { ok: true, state, languages, mode };
}

function explicitAuthoredMode(
  args: Pick<ExecuteInitBaseArgs, 'keep' | 'remove'>,
): 'keep' | 'remove' | undefined {
  if (args.keep === true) return 'keep';
  if (args.remove === true) return 'remove';
  return undefined;
}

function authoredModeFor(
  state: ReturnType<typeof classifyWorkingDir>,
  args: Pick<ExecuteInitBaseArgs, 'keep' | 'remove'>,
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

function authoredStateChangedResult(input: {
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

function adoptionApplied(adoption: RuntimeAdoptionResult): boolean {
  return APPLIED_ADOPTION_STATUSES.has(adoption.status);
}

function recoveredPreAttemptState(
  mode: InitAuthoredMode,
): NonNullable<InitResult['state']> | undefined {
  // `fresh` is selected only for a pristine project. The other authored modes
  // can begin from more than one state, and the v1 durable journal intentionally
  // does not serialize that presentation-only value. Do not misreport the
  // post-commit filesystem classification as the state at Init time.
  return mode === 'fresh' ? 'pristine' : undefined;
}

function explicitRecoveryRequest(
  args: ExecuteInitBaseArgs,
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

function recoveryResultLanguages(
  recorded: { readonly languages: readonly SupportedLanguage[] } | undefined,
  explicit: readonly SupportedLanguage[] | undefined,
): readonly SupportedLanguage[] | undefined {
  if (recorded !== undefined) {
    return recorded.languages.length === 0 ? undefined : recorded.languages;
  }
  return explicit;
}

function resultFromFreshAdoption(input: {
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

async function recoveryResult(
  args: ExecuteInitBaseArgs,
  baseResult: BaseInitResult,
  dependencyOverrides: Partial<RuntimePromotionRecoveryDependencies> = {},
): Promise<InitResult> {
  const header = inspectRuntimePromotionRecoveryHeader(baseResult.cwd);
  const explicit =
    header.status === 'valid'
      ? explicitLanguageResolution(baseResult.cwd, args.language)
      : ({ ok: true } as const);
  if (!explicit.ok) {
    return {
      ...baseResult,
      created: false,
      ...languageResolutionFailure(explicit.error),
    };
  }
  let recorded:
    | {
        readonly languages: readonly SupportedLanguage[];
        readonly mode: InitAuthoredMode;
      }
    | undefined;
  const runtimeAdoption = await recoverRuntimePromotion(
    {
      projectRoot: baseResult.cwd,
      datastoreLockContext: args.datastoreLockContext,
      ...explicitRecoveryRequest(args, explicit.languages),
    },
    {
      ...dependencyOverrides,
      onJournal: (journal) => {
        dependencyOverrides.onJournal?.(journal);
        recorded = {
          languages: journal.inputs.languages,
          mode: journal.inputs.authoredMode,
        };
      },
    },
  );
  const successfulRecorded = adoptionApplied(runtimeAdoption) ? recorded : undefined;
  const state =
    successfulRecorded === undefined
      ? undefined
      : recoveredPreAttemptState(successfulRecorded.mode);
  const languages = recoveryResultLanguages(successfulRecorded, explicit.languages);
  return {
    ...baseResult,
    created: successfulRecorded !== undefined && successfulRecorded.mode !== 'refresh',
    ...(successfulRecorded?.mode === 'refresh' ? { refreshed: true } : {}),
    ...(state === undefined ? {} : { state }),
    ...(languages === undefined ? {} : { languages }),
    runtimeAdoption,
  };
}

/**
 * Run init for the given args. Returns an InitResult — the caller
 * (CLI render layer) prints it.
 */
export async function executeInit(
  args: ExecuteInitArgs,
  dependencyOverrides: Partial<RuntimePromotionDependencies> = {},
): Promise<InitResult> {
  const requestedCwd = args.cwd;
  const project = args.projectContext;
  // cwd is a discovery start, not an exact scaffold destination. Bootstrap's
  // canonical project root remains authoritative for initialized and
  // uninitialized projects alike, including explicit nested --cwd calls.
  const cwd = project?.projectRoot ?? requestedCwd;
  const targetArgs = cwd === args.cwd ? args : { ...args, cwd };
  const paths = resolveProjectPaths(cwd);
  const baseResult = baseInitResult(cwd);
  const invalid = invalidInitInput({ ...targetArgs, cwd: requestedCwd }, baseResult);
  if (invalid !== undefined) return invalid;

  const header = inspectRuntimePromotionRecoveryHeader(cwd);
  if (header.status !== 'absent') {
    return recoveryResult(targetArgs, baseResult);
  }

  const languageExplicit = targetArgs.language !== undefined && targetArgs.language.length > 0;
  let attempt = resolveFreshInitAttempt({
    args: targetArgs,
    baseResult,
    cwd,
    paths,
  });
  if (!attempt.ok) return attempt.result;
  let plan: InitAuthoredPlan | undefined;
  let adoption: RuntimeAdoptionResult;
  const createPlan = dependencyOverrides.createPlan ?? createInitAuthoredPlan;
  try {
    adoption = await runFreshRuntimePromotion(
      {
        projectRoot: cwd,
        languages: attempt.languages,
        languageExplicit,
        authoredMode: attempt.mode,
        toolScaffolds: args.toolScaffolds,
        datastoreLockContext: args.datastoreLockContext,
        ...(args.runtimeConflict === undefined ? {} : { conflict: args.runtimeConflict }),
      },
      {
        ...dependencyOverrides,
        createPlan: () => {
          const current = resolveFreshInitAttempt({
            args: targetArgs,
            baseResult,
            cwd,
            paths,
          });
          if (!current.ok) throw new InitAttemptResolutionError(current.result);
          attempt = current;
          plan = createPlan({
            projectRoot: cwd,
            languages: current.languages,
            mode: current.mode,
            toolScaffolds: args.toolScaffolds,
          });
          const snapshotState = plan.presentation?.workingDirState;
          if (snapshotState !== undefined && snapshotState !== current.state) {
            throw new InitAttemptResolutionError(
              authoredStateChangedResult({
                baseResult,
                plan,
                languages: current.languages,
              }),
            );
          }
          return plan;
        },
      },
    );
  } catch (error) {
    if (error instanceof InitAttemptResolutionError) return error.result;
    throw error;
  }
  return resultFromFreshAdoption({
    baseResult,
    state: attempt.state,
    languages: attempt.languages,
    mode: attempt.mode,
    adoption,
    ...(plan === undefined ? {} : { plan }),
  });
}

/**
 * Recovery-only Init entry used before Tool discovery. It can never fall back
 * to a fresh operation if the fixed journal disappears between probe and
 * action.
 */
export async function executeInitRecovery(
  args: ExecuteInitBaseArgs,
  dependencyOverrides: Partial<RuntimePromotionRecoveryDependencies> = {},
): Promise<InitResult> {
  const cwd = args.projectContext?.projectRoot ?? args.cwd;
  const baseResult = baseInitResult(cwd);
  const invalid = invalidInitInput(args, baseResult);
  if (invalid !== undefined) return invalid;
  return recoveryResult({ ...args, cwd }, baseResult, dependencyOverrides);
}
