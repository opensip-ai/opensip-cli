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
 * `--language <list>` (comma-separated) overrides detection.
 * Detection inspects filesystem markers (Cargo.toml, pyproject.toml,
 * go.mod, pom.xml/build.gradle, CMakeLists.txt, package.json+tsconfig).
 * When detection is ambiguous AND --language is missing, init exits
 * 2 with a helpful prompt — no partial scaffolding.
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
 *   - `--keep`   — re-scaffold examples; preserve custom files.
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

import { resolveProjectPaths, type ProjectContext, type ProjectPaths } from '@opensip-cli/core';

import { classifyFiles } from './init/file-classifier.js';
import { resolveLanguages } from './init/language-detection.js';
import { runRefresh, runScaffold } from './init/scaffold-writer.js';
import {
  buildPartialStateMessage,
  classifyWorkingDir,
  formatInsideExistingProjectMessage,
} from './init/state-machine.js';

import type { ToolScaffold } from './shared.js';
import type { InitOptions, InitResult } from '@opensip-cli/contracts';

type ExecuteInitArgs = InitOptions & {
  projectContext?: ProjectContext;
  cwdExplicit?: boolean;
  toolScaffolds: readonly ToolScaffold[];
};

type BaseInitResult = Pick<InitResult, 'type' | 'path' | 'cwd' | 'configFilename'>;

function maybeRunConfigRefresh(
  args: ExecuteInitArgs,
  inputs: {
    readonly paths: ProjectPaths;
    readonly baseResult: BaseInitResult;
    readonly state: ReturnType<typeof classifyWorkingDir>;
    readonly keep: boolean;
    readonly remove: boolean;
  },
): InitResult | undefined {
  const { paths, baseResult, state, keep, remove } = inputs;
  if (keep || remove) return undefined;
  if (state !== 'fully-initialized' && state !== 'partial-config-only') return undefined;

  const languageExplicit = args.language !== undefined && args.language.length > 0;
  const resolution = resolveLanguages(args.cwd, args.language);
  if (!resolution.ok && languageExplicit) {
    return {
      ...baseResult,
      created: false,
      ambiguousLanguageError: resolution.error,
    };
  }

  const languages = resolution.ok ? resolution.languages : undefined;
  const preExistingFiles =
    languages === undefined ? [] : classifyFiles(paths, languages, args.toolScaffolds);
  return runRefresh(
    {
      cwd: args.cwd,
      state,
      ...(languages === undefined ? {} : { languages }),
      preExistingFiles,
      toolScaffolds: args.toolScaffolds,
    },
    baseResult,
  );
}

/**
 * Run init for the given args. Returns an InitResult — the caller
 * (CLI render layer) prints it.
 */
export function executeInit(args: ExecuteInitArgs): InitResult {
  const cwd = args.cwd;
  const keep = args.keep === true;
  const remove = args.remove === true;
  const paths = resolveProjectPaths(cwd);
  const baseResult = {
    type: 'init' as const,
    path: paths.configFile,
    cwd,
    configFilename: 'opensip-cli.config.yml',
  };

  // Discovery-aware refusal: if cwd sits inside an existing project and
  // the user did NOT pass --cwd explicitly, offer the three corrective
  // actions instead of silently scaffolding a phantom nested project.
  const project = args.projectContext;
  const cwdExplicit = args.cwdExplicit === true;
  if (project?.scope === 'project' && project.projectRoot !== cwd && !cwdExplicit) {
    const message = formatInsideExistingProjectMessage(project.projectRoot);
    return {
      ...baseResult,
      path: '', // no scaffold target — we refused
      created: false,
      insideExistingProject: {
        discoveredRoot: project.projectRoot,
        message,
      },
    };
  }

  // Mutex: --keep and --remove are mutually exclusive.
  if (keep && remove) {
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

  if (!existsSync(cwd)) {
    // A non-existent target directory is a user error, not a "pristine
    // success". Surface it through `ambiguousLanguageError` (which the
    // register-init layer already maps to CONFIGURATION_ERROR / exit 2)
    // so `opensip init --cwd /nonexistent` returns a nonzero exit
    // code with a clear message instead of silently exiting 0.
    return {
      ...baseResult,
      created: false,
      ambiguousLanguageError: {
        detected: [],
        message: `Target directory does not exist: ${cwd}`,
      },
    };
  }

  const state = classifyWorkingDir(paths);

  // Config-present projects are already configured. A plain repeat init
  // refreshes managed guidance and runtime ignores without rewriting config or
  // scaffold examples. If the user explicitly supplied --language, still
  // validate it so bad flags fail loud.
  const refreshResult = maybeRunConfigRefresh(args, { paths, baseResult, state, keep, remove });
  if (refreshResult !== undefined) return refreshResult;

  const resolution = resolveLanguages(cwd, args.language);
  if (!resolution.ok) {
    return {
      ...baseResult,
      created: false,
      ambiguousLanguageError: resolution.error,
    };
  }
  const { languages } = resolution;

  const preExistingFiles =
    state === 'pristine' ? [] : classifyFiles(paths, languages, args.toolScaffolds);

  // Pristine: scaffold and exit. No flag interaction needed.
  if (state === 'pristine') {
    return runScaffold(
      {
        paths,
        languages,
        cwd,
        state,
        preExistingFiles: [],
        removeFirst: false,
        keepCustom: false,
        toolScaffolds: args.toolScaffolds,
      },
      baseResult,
    );
  }

  // Non-pristine without an explicit flag: only dir-without-config remains an
  // unsafe partial state. Config-present states refresh above.
  if (!keep && !remove) {
    return {
      ...baseResult,
      created: false,
      state,
      languages,
      preExistingFiles,
      partialStateError: {
        state,
        preExistingFiles,
        message: buildPartialStateMessage(state, preExistingFiles, cwd),
      },
    };
  }

  // --remove: blow away the dir, then scaffold from zero.
  if (remove) {
    return runScaffold(
      {
        paths,
        languages,
        cwd,
        state,
        preExistingFiles,
        removeFirst: true,
        keepCustom: false,
        toolScaffolds: args.toolScaffolds,
      },
      baseResult,
    );
  }

  // --keep: re-scaffold examples; preserve custom + stale-scaffolded files.
  return runScaffold(
    {
      paths,
      languages,
      cwd,
      state,
      preExistingFiles,
      removeFirst: false,
      keepCustom: true,
      toolScaffolds: args.toolScaffolds,
    },
    baseResult,
  );
}
