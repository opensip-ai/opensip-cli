/**
 * @fileoverview TypeScript Frontend Compiler Check
 *
 * Validates TypeScript compilation for frontend apps (apps/*). Runs
 * `tsc --noEmit` in each discovered `apps/<name>/` that has a `tsconfig.json`,
 * and reports the parsed compiler errors. Because it shells out to an external
 * toolchain (one invocation per app, in that app's own directory so its
 * `tsconfig.json` resolves correctly), it is modelled as `analysisMode:'command'`
 * using the same `sh -c` orchestration idiom as `dependency-vulnerability-audit`.
 */

import { join } from 'node:path';

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

/**
 * Shell program run from the project root (the command's cwd). For each
 * `apps/<name>/` containing a `tsconfig.json` it emits an `::app::` marker, runs
 * `tsc --noEmit` in that directory (merging stderr), then an `::exit::` marker
 * carrying the per-app exit code. We always `exit 0` so the framework treats the
 * run as successful and defers entirely to `parseOutput` (mirrors
 * `dependency-vulnerability-audit`).
 */
const TSC_PER_APP_PROGRAM = `
for d in apps/*/; do
  [ -f "\${d}tsconfig.json" ] || continue
  echo "::app::\${d}"
  (cd "$d" && npx tsc --noEmit 2>&1)
  echo "::exit::$?"
done
exit 0
`;

// Markers emitted by the shell program.
const APP_MARKER_PATTERN = /^::app::(.+)$/;
const EXIT_MARKER_PATTERN = /^::exit::(\d+)$/;
/**
 * A single tsc diagnostic line: `file(line,col): error TSxxxx: message`.
 * ReDoS-safe: `[^(]+` is bounded by the `(` delimiter, the numeric groups match
 * digits only, and each group has a distinct fixed delimiter.
 */
// eslint-disable-next-line sonarjs/slow-regex -- [^(]+ bounded by '(' delimiter; each group has distinct delimiters
const TS_ERROR_LINE_PATTERN = /^([^(]+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;

interface ParsedError {
  file: string;
  line: number;
  code: string;
  message: string;
}

/**
 * Create a generic compilation failure violation (app failed to compile but no
 * structured tsc diagnostics were parsed — e.g. a config error or crash).
 */
function createGenericFailure(appPath: string, app: string): CheckViolation {
  return {
    filePath: appPath,
    line: 1,
    message: `App ${app} compilation failed`,
    severity: 'error',
    suggestion: `Run \`cd apps/${app} && npx tsc --noEmit\` to see the full error output`,
    match: app,
  };
}

/**
 * Convert parsed TypeScript errors to violations (capped at 10 per app to avoid
 * overwhelming output).
 */
function errorsToViolations(appPath: string, errors: readonly ParsedError[]): CheckViolation[] {
  return errors.slice(0, 10).map((err) => ({
    filePath: join(appPath, err.file),
    line: err.line,
    message: `${err.code}: ${err.message}`,
    severity: 'error' as const,
    suggestion: `Fix the TypeScript error: ${err.message}. See https://typescript.tv/errors/#${err.code.toLowerCase()} for explanation`,
    type: err.code,
    match: err.code,
  }));
}

/**
 * Strip the `apps/` prefix and trailing slash to get the bare app name. The
 * shell glob (`apps/<name>/`) yields exactly one trailing slash.
 */
function appNameFromDir(appDir: string): string {
  return appDir.replace(/^apps\//, '').replace(/\/$/, '');
}

/**
 * Parse the combined per-app tsc output into violations. Tracks the current app
 * via `::app::` markers and finalizes it on the matching `::exit::` marker: a
 * non-zero exit with parsed diagnostics yields those; a non-zero exit with no
 * parseable diagnostics yields a single generic failure; a zero exit yields none.
 */
export function parseTscOutput(stdout: string, cwd: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  let currentApp: string | null = null;
  let buffer: ParsedError[] = [];

  const finalize = (appDir: string, exitCode: number): void => {
    if (exitCode !== 0) {
      const appPath = join(cwd, appDir);
      if (buffer.length > 0) {
        violations.push(...errorsToViolations(appPath, buffer));
      } else {
        violations.push(createGenericFailure(appPath, appNameFromDir(appDir)));
      }
    }
    buffer = [];
  };

  for (const line of stdout.split('\n')) {
    const appMatch = APP_MARKER_PATTERN.exec(line);
    if (appMatch?.[1]) {
      currentApp = appMatch[1];
      buffer = [];
      continue;
    }

    const exitMatch = EXIT_MARKER_PATTERN.exec(line);
    if (exitMatch?.[1] && currentApp) {
      finalize(currentApp, Number.parseInt(exitMatch[1], 10));
      currentApp = null;
      continue;
    }

    if (!currentApp) continue;
    const errMatch = TS_ERROR_LINE_PATTERN.exec(line);
    if (errMatch) {
      buffer.push({
        file: errMatch[1] ?? '',
        // @fitness-ignore-next-line numeric-validation -- regex (\d+) guarantees digits only
        line: Number.parseInt(errMatch[2] ?? '0', 10),
        code: errMatch[5] ?? '',
        message: errMatch[6] ?? '',
      });
    }
  }

  return violations;
}

/**
 * Check: quality/typescript-frontend
 *
 * Runs the TypeScript compiler for each frontend app under `apps/*`.
 */
export const typescriptFrontend = defineCheck({
  id: 'a32ab706-f817-404c-835f-da79f64505c7',
  slug: 'typescript-frontend',
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },

  confidence: 'medium',
  description: 'Validates TypeScript compilation for frontend apps',
  longDescription: `**Purpose:** Validates that all frontend apps compile cleanly with the TypeScript compiler, running \`tsc --noEmit\` in each app directory that contains a \`tsconfig.json\`.

**Detects:**
- TypeScript compilation errors parsed from \`tsc --noEmit\` output using the pattern \`file(line,col): error TSxxxx: message\`
- Per-app compilation failures across all apps discovered in the \`apps/\` directory
- Reports up to 10 errors per app to avoid overwhelming output

**Why it matters:** Frontend apps have their own \`tsconfig.json\` settings and dependencies. Compiling each app independently catches type errors specific to that app's configuration and imported modules.

**Scope:** External toolchain check (\`analysisMode:'command'\`). Runs \`tsc --noEmit\` in each discovered \`apps/*\` directory from the project root. General best practice.`,
  tags: ['quality', 'type-safety', 'code-quality'],
  fileTypes: ['ts', 'tsx'],

  command: {
    bin: 'sh',
    args: ['-c', TSC_PER_APP_PROGRAM],
    // The shell program always exits 0; per-app status is carried inline.
    expectedExitCodes: [0],
    parseOutput(stdout, _stderr, _exitCode, _files, cwd): CheckViolation[] {
      return parseTscOutput(stdout, cwd);
    },
  },
});
