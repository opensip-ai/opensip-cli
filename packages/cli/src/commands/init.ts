/**
 * init command — scaffold the project layout.
 *
 * Creates:
 *   <cwd>/opensip-tools.config.yml                                    (TRACKED)
 *   <cwd>/opensip-tools/fit/checks/example-check.mjs                  (TRACKED)
 *   <cwd>/opensip-tools/fit/recipes/example-recipe.mjs                (TRACKED)
 *   <cwd>/opensip-tools/sim/scenarios/example-scenario.mjs            (TRACKED)
 *   <cwd>/opensip-tools/sim/recipes/example-recipe.mjs                (TRACKED)
 *
 * Appends `opensip-tools/.runtime/` to <cwd>/.gitignore so the
 * tool-generated state (sessions, logs, dashboards, baselines, plugin
 * installs) stays untracked.
 *
 * Promotion path: when a customer's pack outgrows a handful of .mjs
 * files (shared helpers, tests, more than a dozen checks/scenarios),
 * `opensip-tools/<domain>/` can graduate to a real workspace npm
 * package — `package.json` with `opensipTools.kind: "fit-pack"` or
 * `"sim-pack"`, `tsconfig.json`, `index.ts` re-exporting checks/recipes.
 * Marker-based discovery picks up the workspace package automatically
 * regardless of npm scope. The init scaffold stays loose-`.mjs` to
 * preserve the fast first-touch experience; graduation is a manual
 * step the customer takes when their coverage becomes substantial.
 * See docs/architecture/70-surfaces/02-plugin-authoring.md.
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
 * and the `opensip-tools/` directory:
 *
 *   - 'pristine'             — neither present; scaffold everything.
 *   - 'fully-initialized'    — both present; refuse without a flag.
 *   - 'partial-config-only'  — config XOR dir; refuse without a flag.
 *   - 'partial-dir-only'     — config XOR dir; refuse without a flag.
 *
 * Two flags express explicit user intent for the non-pristine states:
 *
 *   - `--keep`   — re-scaffold examples; preserve custom files.
 *   - `--remove` — delete `opensip-tools/` entirely; scaffold fresh.
 *
 * The two flags are mutually exclusive. The legacy `--force` flag is
 * gone; users who scripted it should migrate to `--remove`, the
 * closest semantic match.
 *
 * Implementation is split across `./init/` siblings:
 *   - language-detection.ts — marker scanning + `--language` parsing
 *   - config-templates.ts   — YAML / example-source byte generation
 *   - file-classifier.ts    — scaffolded / stale / custom tagging
 *   - state-machine.ts      — working-dir state + refusal messages
 *   - scaffold-writer.ts    — disk writes + gitignore patching
 *
 * This file is the orchestrator: argument validation → language
 * resolution → state classification → file classification → scaffold
 * (or refuse).
 */

import { existsSync } from 'node:fs';

import { resolveProjectPaths, type ProjectContext } from '@opensip-tools/core';

import { classifyFiles } from './init/file-classifier.js';
import { resolveLanguages } from './init/language-detection.js';
import { runScaffold } from './init/scaffold-writer.js';
import { buildPartialStateMessage, classifyWorkingDir, formatInsideExistingProjectMessage } from './init/state-machine.js';

// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs is the bridge type for the legacy executeInit signature until the per-command type rip-out
import type { CliArgs, InitResult } from '@opensip-tools/contracts';

// Re-export the public API of `init` so existing imports (notably the
// test suite) continue to resolve through `commands/init.js`.
export { detectLanguages, parseLanguageFlag } from './init/language-detection.js';
export type { SupportedLanguage } from './init/language-detection.js';

/**
 * Run init for the given args. Returns an InitResult — the caller
 * (CLI render layer) prints it.
 */
// eslint-disable-next-line sonarjs/deprecation -- intentional adapter usage; CliArgs bridge type
export function executeInit(args: CliArgs & { language?: string; keep?: boolean; remove?: boolean; projectContext?: ProjectContext; cwdExplicit?: boolean }): InitResult {
  const cwd = args.cwd;
  const keep = args.keep === true;
  const remove = args.remove === true;
  const paths = resolveProjectPaths(cwd);
  const baseResult = {
    type: 'init' as const,
    path: paths.configFile,
    cwd,
    configFilename: 'opensip-tools.config.yml',
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
    // so `opensip-tools init --cwd /nonexistent` returns a nonzero exit
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

  const resolution = resolveLanguages(cwd, args.language);
  if (!resolution.ok) {
    return { ...baseResult, created: false, ambiguousLanguageError: resolution.error };
  }
  const { languages } = resolution;

  const state = classifyWorkingDir(paths);
  const preExistingFiles = state === 'pristine' ? [] : classifyFiles(paths, languages);

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
      },
      baseResult,
    );
  }

  // Non-pristine without an explicit flag: refuse with partial-state
  // error.
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
    },
    baseResult,
  );
}
