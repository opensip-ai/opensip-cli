import { lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, parse } from 'node:path';

import { validateEvalReport } from './report/model.js';
import { renderMarkdown } from './report/render-markdown.js';
import { HarnessPrerequisiteError } from './runner/spawn.js';

import type { EvalReport, SourceState } from './report/model.js';

const MAX_DEFAULT_COLLISIONS = 10_000;
const PARTIAL_JSON_WARNING =
  'A failed report pair could not remove its partial JSON; manual cleanup may be required.';
const REPORT_COLLISION_MESSAGE = 'A report artifact already exists; choose a new --json path.';
const REPORT_WRITE_FAILURE_MESSAGE =
  'The report pair could not be written; check output permissions.';
const ROLLBACK_FAILURES = new WeakMap<Error, unknown>();

export interface ArtifactPaths {
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly warnings?: readonly string[];
}

export interface ArtifactFileSystem {
  readonly exists: (path: string) => Promise<boolean>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly writeExclusive: (path: string, content: string) => Promise<void>;
}

export class CliHarnessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliHarnessError';
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

export const NODE_ARTIFACT_FILE_SYSTEM: ArtifactFileSystem = Object.freeze({
  exists: async (path: string) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    }
    return false;
  },
  mkdir: async (path: string) => {
    await mkdir(path, { recursive: true });
  },
  remove: async (path: string) => {
    await unlink(path);
  },
  writeExclusive: async (path: string, content: string) => {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  },
});

/**
 * Render a valid clock value as a portable UTC filename segment.
 *
 * @throws {CliHarnessError} When the supplied date is invalid.
 */
function colonFreeUtc(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new CliHarnessError('The run clock is invalid.');
  return date
    .toISOString()
    .replaceAll(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
}

/**
 * Validate one externally derived report-identity segment.
 *
 * @throws {HarnessPrerequisiteError} When the value is unsafe for a portable filename.
 */
function requireFilenameSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value)) {
    throw new HarnessPrerequisiteError(
      `${label} is not safe for report identity; rebuild and retry.`,
    );
  }
  return value;
}

/** Build the portable, self-identifying default JSON report path. */
export function defaultJsonPath(
  resultsRoot: string,
  startedAt: Date,
  cliVersion: string,
  gitSha: string,
  sourceState: SourceState,
): string {
  const version = requireFilenameSegment(cliVersion, 'OpenSIP CLI version');
  const sha = requireFilenameSegment(gitSha, 'Git revision').slice(0, 12);
  const sourceSuffix = sourceState === 'clean' ? '' : '-dirty';
  return join(resultsRoot, `${colonFreeUtc(startedAt)}-v${version}-${sha}${sourceSuffix}.json`);
}

/** Derive the mandatory sibling markdown path from an explicit or default JSON path. */
export function markdownPathFor(jsonPath: string): string {
  const details = parse(jsonPath);
  const basename = extname(details.base).toLowerCase() === '.json' ? details.name : details.base;
  return join(details.dir, `${basename}.md`);
}

export function outputPaths(jsonPath: string): ArtifactPaths {
  return { jsonPath, markdownPath: markdownPathFor(jsonPath) };
}

async function pairExists(paths: ArtifactPaths, fileSystem: ArtifactFileSystem): Promise<boolean> {
  const [jsonExists, markdownExists] = await Promise.all([
    fileSystem.exists(paths.jsonPath),
    fileSystem.exists(paths.markdownPath),
  ]);
  return jsonExists || markdownExists;
}

/**
 * Remove the JSON half of a failed pair write without replacing its primary failure.
 */
async function removePartialJson(
  path: string,
  fileSystem: ArtifactFileSystem,
): Promise<{ readonly ok: true } | { readonly error: unknown; readonly ok: false }> {
  try {
    await fileSystem.remove(path);
    return { ok: true };
  } catch (error) {
    return { error, ok: false };
  }
}

function retainRollbackFailure(primary: unknown, rollback: unknown): unknown {
  if (primary instanceof Error) {
    ROLLBACK_FAILURES.set(primary, rollback);
    return primary;
  }
  return new CliHarnessError(PARTIAL_JSON_WARNING);
}

function rollbackWarning(error: unknown): string | undefined {
  return error instanceof Error && ROLLBACK_FAILURES.has(error) ? PARTIAL_JSON_WARNING : undefined;
}

function appendWarning(message: string, warning: string | undefined): string {
  return warning === undefined ? message : `${message} ${warning}`;
}

function terminalWriteError(error: unknown, warning: string | undefined): CliHarnessError {
  if (error instanceof CliHarnessError && warning === undefined) return error;
  const message = error instanceof CliHarnessError ? error.message : REPORT_WRITE_FAILURE_MESSAGE;
  return new CliHarnessError(appendWarning(message, warning));
}

function retainDefaultWriteFailure(error: unknown, warnings: Set<string>): void {
  const warning = rollbackWarning(error);
  if (warning !== undefined) warnings.add(warning);
  if (!isCollision(error)) throw terminalWriteError(error, warning);
}

async function writeExclusivePair(
  paths: ArtifactPaths,
  json: string,
  markdown: string,
  fileSystem: ArtifactFileSystem,
): Promise<void> {
  let jsonWritten = false;
  try {
    // @fitness-ignore-next-line async-waterfall-detection -- Directory creation and the two exclusive writes are ordered so a Markdown collision can roll back only the JSON created by this run.
    await fileSystem.mkdir(dirname(paths.jsonPath));
    // @fitness-ignore-next-line async-waterfall-detection -- JSON must exist before the companion write so this scope knows whether rollback owns it.
    await fileSystem.writeExclusive(paths.jsonPath, json);
    jsonWritten = true;
    await fileSystem.writeExclusive(paths.markdownPath, markdown);
  } catch (error) {
    if (jsonWritten) {
      const rollback = await removePartialJson(paths.jsonPath, fileSystem);
      if (!rollback.ok) throw retainRollbackFailure(error, rollback.error);
    }
    throw error;
  }
}

function isCollision(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function withCollisionSuffix(path: string, collision: number): string {
  if (collision === 0) return path;
  const details = parse(path);
  return join(details.dir, `${details.name}-${String(collision + 1)}${details.ext}`);
}

/**
 * Verify that neither artifact in an explicitly requested pair exists.
 *
 * @throws {CliHarnessError} When either requested artifact already exists.
 */
export async function requireExplicitPairAvailable(
  paths: ArtifactPaths,
  fileSystem: ArtifactFileSystem,
): Promise<void> {
  if (await pairExists(paths, fileSystem)) {
    throw new CliHarnessError('A report artifact already exists; choose a new --json path.');
  }
}

/**
 * Persist an explicitly named report pair without overwriting either path.
 *
 * @throws {CliHarnessError} When a collision or filesystem failure prevents the pair write.
 */
async function writeExplicitReport(
  paths: ArtifactPaths,
  json: string,
  markdown: string,
  fileSystem: ArtifactFileSystem,
): Promise<ArtifactPaths> {
  try {
    await writeExclusivePair(paths, json, markdown, fileSystem);
    return paths;
  } catch (error) {
    const warning = rollbackWarning(error);
    if (isCollision(error)) {
      throw new CliHarnessError(appendWarning(REPORT_COLLISION_MESSAGE, warning));
    }
    throw terminalWriteError(error, warning);
  }
}

/**
 * Persist a report pair using the first available bounded collision suffix.
 *
 * @throws {CliHarnessError} When writing fails or no bounded filename remains available.
 */
async function writeDefaultReport(
  baseJsonPath: string,
  json: string,
  markdown: string,
  fileSystem: ArtifactFileSystem,
): Promise<ArtifactPaths> {
  const warnings = new Set<string>();
  for (let collision = 0; collision < MAX_DEFAULT_COLLISIONS; collision += 1) {
    const paths = outputPaths(withCollisionSuffix(baseJsonPath, collision));
    try {
      await writeExclusivePair(paths, json, markdown, fileSystem);
      return warnings.size === 0 ? paths : { ...paths, warnings: [...warnings] };
    } catch (error) {
      retainDefaultWriteFailure(error, warnings);
    }
  }
  throw new CliHarnessError('No unused default report filename is available.');
}

/**
 * Validate and atomically persist the JSON and Markdown report pair.
 *
 * @throws {CliHarnessError} When validation or either artifact write fails.
 */
export async function persistReport(
  report: EvalReport,
  requestedPaths: ArtifactPaths | undefined,
  defaultPath: string,
  fileSystem: ArtifactFileSystem,
): Promise<ArtifactPaths> {
  if (!validateEvalReport(report)) {
    throw new CliHarnessError('The harness produced an invalid report; no artifacts were written.');
  }
  const json = `${JSON.stringify(report, undefined, 2)}\n`;
  const markdown = renderMarkdown(report);
  return requestedPaths === undefined
    ? writeDefaultReport(defaultPath, json, markdown, fileSystem)
    : writeExplicitReport(requestedPaths, json, markdown, fileSystem);
}
