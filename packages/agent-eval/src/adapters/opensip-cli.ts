import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildDeterministicEnv } from '../runner/env.js';
import {
  HarnessPrerequisiteError,
  spawnCli,
  tailForDiagnostics,
  type SpawnOptions,
  type SpawnResult,
} from '../runner/spawn.js';

import type { SetupRecord, SetupStageRecord } from '../model/record.js';

const FIXTURE_HOME_DIRECTORY = '.agent-eval-home';
const INIT_EXIT_CODES = new Set([0]);
const GRAPH_EXIT_CODES = new Set([0, 1]);

/** Bounded CLI-spawn seam used by fixture setup. */
export type SetupSpawnCli = (
  args: readonly string[],
  options?: SpawnOptions,
) => Promise<SpawnResult>;

/** Injectable environment and process effects for fixture setup. */
export interface SetupFixtureProjectDependencies {
  readonly buildEnv: typeof buildDeterministicEnv;
  readonly prepareHome: (path: string) => void;
  readonly spawnCli: SetupSpawnCli;
}

/** Default effects record; tests replace individual boundaries without module mocking. */
export const DEFAULT_SETUP_FIXTURE_PROJECT_DEPENDENCIES: SetupFixtureProjectDependencies =
  Object.freeze({
    buildEnv: buildDeterministicEnv,
    prepareHome: (path: string) => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    spawnCli,
  });

/** Build the exact headless init argv. Array elements preserve paths containing spaces. */
export function buildInitArgv(projectRoot: string, language: string): readonly string[] {
  return ['init', '--cwd', projectRoot, '--language', language, '--json'];
}

/**
 * Build the exact graph argv. `--no-cloud` is a root flag and must precede the
 * command so an operator's saved API key can never make the evaluation egress.
 */
export function buildGraphArgv(projectRoot: string, language: string): readonly string[] {
  return ['--no-cloud', 'graph', '--json', '--cwd', projectRoot, '--language', language];
}

/** One load-bearing HOME path shared by fixture CLI setup and its MCP process. */
export function fixtureHomePath(projectRoot: string): string {
  return join(projectRoot, FIXTURE_HOME_DIRECTORY);
}

function diagnosticSuffix(result: SpawnResult): string {
  const output = result.stderr.trim().length > 0 ? result.stderr : result.stdout;
  const tail = tailForDiagnostics(output.trim());
  return tail.length === 0 ? '' : `\nDiagnostic tail:\n${tail}`;
}

function failureReason(
  result: SpawnResult,
  acceptedExitCodes: ReadonlySet<number>,
): string | undefined {
  if (result.timedOut) return 'timed out';
  if (result.outputLimitExceeded) return 'exceeded the output limit';
  if (result.error !== undefined) return `could not be spawned: ${result.error}`;
  if (result.exitCode === null) {
    return result.signal === null
      ? 'closed without an exit code'
      : `was terminated by ${result.signal}`;
  }
  if (!acceptedExitCodes.has(result.exitCode)) return `exited with code ${result.exitCode}`;
  return undefined;
}

/**
 * Convert an accepted setup process result into durable stage provenance.
 *
 * @throws {HarnessPrerequisiteError} When setup times out, truncates, fails, or exits unexpectedly.
 */
function requireSuccessfulStage(
  name: string,
  result: SpawnResult,
  acceptedExitCodes: ReadonlySet<number>,
): SetupStageRecord {
  const reason = failureReason(result, acceptedExitCodes);
  if (reason !== undefined || result.exitCode === null) {
    throw new HarnessPrerequisiteError(
      `OpenSIP ${name} setup ${reason ?? 'failed'}.${diagnosticSuffix(result)}`,
    );
  }
  return {
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    name,
  };
}

/**
 * Initialize and graph a fresh fixture through the built CLI. No datastore or
 * runtime files are read by the harness; the subsequent MCP process is the
 * only evidence-serving path.
 */
export async function setupFixtureProject(
  projectRoot: string,
  language: string,
  dependencies: SetupFixtureProjectDependencies = DEFAULT_SETUP_FIXTURE_PROJECT_DEPENDENCIES,
): Promise<SetupRecord> {
  const home = fixtureHomePath(projectRoot);
  dependencies.prepareHome(home);
  const env = dependencies.buildEnv({ HOME: home });
  const options: SpawnOptions = { cwd: projectRoot, env };

  const init = requireSuccessfulStage(
    'init',
    await dependencies.spawnCli(buildInitArgv(projectRoot, language), options),
    INIT_EXIT_CODES,
  );
  const graph = requireSuccessfulStage(
    'graph',
    await dependencies.spawnCli(buildGraphArgv(projectRoot, language), options),
    GRAPH_EXIT_CODES,
  );

  return {
    mode: 'fixture',
    stages: [init, graph],
  };
}
