/**
 * @fileoverview clang-tidy passthrough check.
 *
 * Runs `clang-tidy` against the matched files and surfaces its
 * diagnostics as opensip-cli violations. The user's `.clang-tidy`
 * config (if present) controls which lints fire — we don't override
 * it. Use `--checks=...` in the args if you want a fixed lint set.
 */
import * as path from 'node:path';

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const CLANG_TIDY_LINE =
  // eslint-disable-next-line sonarjs/slow-regex -- input is one bounded line of clang-tidy output; no real ReDoS exposure
  /^(.+?):(\d+):(\d+):\s+(warning|error|note):\s+(.+?)(?:\s+\[([\w\-,.]+)\])?$/;

/**
 * Resolve a captured clang-tidy file path against `cwd` and convert it
 * to project-relative form when the resolved path falls inside `cwd`.
 * Paths outside `cwd` (e.g. system headers under `/usr/include`) are
 * left absolute so they remain unambiguous.
 *
 * Note on empty `cwd`: when called with `cwd === ''`, `path.resolve`
 * falls back to `process.cwd()`. The production `command`-mode caller
 * (`executeCommandMode` in `@opensip-cli/fitness`) always passes a
 * non-empty cwd, so the production contract is well-defined; the
 * pass-through is tolerated only as a convenience for tests and is
 * not part of the public surface.
 */
function resolveFilePath(capturedPath: string, cwd: string): string {
  const absolute = path.resolve(cwd, capturedPath);
  const relative = path.relative(cwd, absolute);
  // `path.relative` returns a `..`-prefixed path (or absolute on Windows
  // when drives differ) when the resolved path is outside `cwd`.
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return absolute;
  }
  return relative;
}

/**
 * Pure parser for clang-tidy stdout. Accepts the diagnostic format:
 *   path/to/file.cpp:LINE:COL: warning: <message> [check-name]
 * Returns one CheckViolation per warning/error line. `note:` lines
 * are dropped today; revisit when adopting `clang-tidy --export-fixes`,
 * where notes are first-class children of diagnostics rather than
 * standalone lines that need re-attachment.
 */
export function parseClangTidyOutput(
  stdout: string,
  _stderr: string,
  _exitCode: number,
  _files: readonly string[],
  cwd: string,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    const match = CLANG_TIDY_LINE.exec(line);
    if (!match) continue;
    const filePath = match[1];
    const lineStr = match[2];
    const colStr = match[3];
    const severity = match[4];
    const message = match[5];
    const lintName = match[6];
    if (severity === 'note') continue;
    // The regex guarantees groups 1 (filePath), 2 (lineStr), 3 (colStr), 4
    // (severity) and 5 (message) are non-empty captures when it matches; the
    // `?` / `??` fallbacks below exist for type-narrowing of `match[n]` (which
    // is typed `string | undefined`) and are not reachable at runtime. Only
    // group 6 (lintName) is optional in the pattern and is exercised by tests.
    violations.push({
      /* v8 ignore next */
      message: lintName ? `[${lintName}] ${message}` : (message ?? 'clang-tidy diagnostic'),
      severity: severity === 'error' ? 'error' : 'warning',
      /* v8 ignore next */
      line: lineStr ? Number.parseInt(lineStr, 10) : 1,
      /* v8 ignore next */
      column: colStr ? Number.parseInt(colStr, 10) : undefined,
      /* v8 ignore next */
      filePath: filePath ? resolveFilePath(filePath, cwd) : undefined,
      suggestion: 'See clang-tidy docs for the named lint',
    });
  }
  return violations;
}

export const clangTidyPassthrough = defineCheck({
  id: 'e9769a00-b576-44a6-b73a-b340c597bc86',
  slug: 'cpp-clang-tidy',
  description: 'Run clang-tidy and surface its diagnostics as opensip-cli violations',
  scope: { languages: ['cpp'], concerns: [] },
  tags: ['quality', 'cpp'],
  // Cap the per-invocation runtime so a slow clang-tidy (or one hung
  // on an unusual TU) can't block the run indefinitely. Most healthy
  // clang-tidy invocations finish within a few seconds; anything
  // taking longer is more useful aborted than awaited.
  timeout: 30_000,
  command: {
    bin: 'clang-tidy',
    args: (files) => [...files, '--quiet'],
    parseOutput: parseClangTidyOutput,
    // clang-tidy returns 1 when warnings are emitted with -warnings-as-errors,
    // but with --quiet and default config, exit 0 means clean run.
    // Diagnostics are present on stdout regardless.
    expectedExitCodes: [0, 1],
  },
});
