/**
 * CLEAN fixture — every accepted shape, each reduced from a real site that
 * reviewers explicitly kept.
 *
 *  1. `isTreeAlive`   — inspects the error (`.code === 'EPERM'`). Reduced from
 *     `packages/agent-eval/src/runner/process-tree.ts:465-471`, which the
 *     reviewers annotated "EPERM treated as alive — correct".
 *  2. `terminateGroup` — carries the repo's `@swallow-ok` marker. Reduced from
 *     `packages/core/src/runtime/kill-tree.ts:42-47`.
 *  3. `readManifest`  — logs the caught value before degrading.
 *  4. `parseStrict`   — rethrows as a typed error carrying `cause`.
 *  5. `resolveEntry`  — returns an `error-handling-quality` sentinel; that
 *     shipped check owns the clause, so this one stays silent (no double-report).
 *  6. `isTestOccurrence` — the boolean-disjunction shape reviewers repeatedly
 *     rejected as a false positive (e.g. `packages/graph/graph-rust/src/
 *     walk-helpers.ts:156`). No catch, no error semantics, never a finding here.
 */

interface Logger {
  warn(entry: Readonly<Record<string, unknown>>): void;
}

export function isTreeAlive(processGroupId: number, kill: typeof process.kill): boolean {
  try {
    kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EPERM') return true;
    return false;
  }
}

export function terminateGroup(processGroupId: number, kill: typeof process.kill): boolean {
  try {
    kill(-processGroupId, 'SIGTERM');
    return true;
  } catch {
    // @swallow-ok process may not be a group leader; fall through to direct pid kill
    return false;
  }
}

export function readManifest(raw: string, logger: Logger): Record<string, unknown> | undefined {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    logger.warn({ evt: 'manifest.parse_failed', err: error });
    return undefined;
  }
}

export function parseStrict(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new TypeError('manifest is not valid JSON', { cause: error });
  }
}

export function resolveEntry(raw: string): string | null {
  try {
    return String((JSON.parse(raw) as { main?: string }).main);
  } catch {
    return null;
  }
}

export function isTestOccurrence(fileInTestFile: boolean, hasTestAttribute: boolean): boolean {
  return fileInTestFile || hasTestAttribute;
}
