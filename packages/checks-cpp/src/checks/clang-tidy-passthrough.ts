/**
 * @fileoverview clang-tidy passthrough check.
 *
 * Runs `clang-tidy` against the matched files and surfaces its
 * diagnostics as opensip-tools violations. The user's `.clang-tidy`
 * config (if present) controls which lints fire — we don't override
 * it. Use `--checks=...` in the args if you want a fixed lint set.
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

const CLANG_TIDY_LINE = /^(.+?):(\d+):(\d+):\s+(warning|error|note):\s+(.+?)(?:\s+\[([\w\-,.]+)\])?$/

/**
 * Pure parser for clang-tidy stdout. Accepts the diagnostic format:
 *   path/to/file.cpp:LINE:COL: warning: <message> [check-name]
 * Returns one CheckViolation per warning/error line. `note:` lines
 * are attached to the prior diagnostic when possible (kept simple
 * for MVP — current implementation skips them).
 */
export function parseClangTidyOutput(
  stdout: string,
  _stderr: string,
  _exitCode: number,
  _files: readonly string[],
  _cwd: string,
): CheckViolation[] {
  const violations: CheckViolation[] = []
  const lines = stdout.split('\n')
  for (const line of lines) {
    const match = CLANG_TIDY_LINE.exec(line)
    if (!match) continue
    const [, _filePath, lineStr, _colStr, severity, message, lintName] = match
    if (severity === 'note') continue
    violations.push({
      message: lintName ? `[${lintName}] ${message}` : message ?? 'clang-tidy diagnostic',
      severity: severity === 'error' ? 'error' : 'warning',
      line: lineStr ? parseInt(lineStr, 10) : 1,
      suggestion: 'See clang-tidy docs for the named lint',
    })
  }
  return violations
}

export const clangTidyPassthrough = defineCheck({
  id: 'e1f2a3b4-9876-4321-eeee-500000000001',
  slug: 'cpp-clang-tidy',
  description: 'Run clang-tidy and surface its diagnostics as opensip-tools violations',
  scope: { languages: ['cpp'], concerns: [] },
  tags: ['quality', 'cpp'],
  command: {
    bin: 'clang-tidy',
    args: (files) => [...files, '--quiet'],
    parseOutput: parseClangTidyOutput,
    // clang-tidy returns 1 when warnings are emitted with -warnings-as-errors,
    // but with --quiet and default config, exit 0 means clean run.
    // Diagnostics are present on stdout regardless.
    expectedExitCodes: [0, 1],
  },
})
