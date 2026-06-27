// @fitness-ignore-file no-unimplemented-markers -- this file's job is to detect "not implemented" stub idioms; the trigger patterns appear here in regex and prose by design
/**
 * @fileoverview Cross-language "not implemented yet" stub-marker detection.
 *
 * Detects the highest-signal indicator of unfinished work: explicit
 * THROW/MACRO idioms that announce the code is not implemented
 * (`throw new Error('not implemented')`, `raise NotImplementedError`,
 * `todo!()`, `unimplemented!()`, `panic("not implemented")`,
 * `throw new UnsupportedOperationException`, `throw std::logic_error("not implemented")`).
 *
 * Uses the `raw` content filter (NOT `strip-strings`): the markers live
 * inside string ARGUMENTS (e.g. `throw new Error('not implemented')`), so
 * stripping string literals would erase the very text we match on.
 *
 * Patterns are dispatched by file extension and tuned for low false
 * positives — each requires an unambiguous construct, not a bare word.
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';

/** Unfinished-work phrasing shared by the message-bearing language patterns. */
const UNIMPLEMENTED_MESSAGE = /not\s*implemented|unimplemented/i;

/** One language's detection: a description for the message + its line matcher. */
interface MarkerPattern {
  readonly marker: string;
  readonly test: (line: string) => boolean;
}

/**
 * True when the idiom at `idx` is opened inside a markdown inline-code span — a
 * backtick precedes it on the same line. A real `throw`/`raise`/`panic`/macro
 * statement is never *introduced* by a backtick; but check `longDescription`
 * strings and docs routinely write `` `throw new Error('not implemented')` `` as
 * prose. We test the prefix only (not the whole line) so a genuine statement
 * that happens to use a template-literal message — `throw new Error(\`not
 * implemented: ${x}\`)` — is still flagged. Zero false positives, no real stub
 * suppressed.
 */
function isMarkdownQuoted(line: string, idx: number): boolean {
  return line.slice(0, idx).includes('`');
}

/**
 * Build a `MarkerPattern.test` from a line regex. The construct matches when the
 * regex hits AND (optionally) its captured argument satisfies `messageTest` AND
 * the hit is not markdown-quoted prose. Centralising the `isMarkdownQuoted`
 * guard here keeps every language consistent: a real statement is flagged, a
 * doc-string quoting the idiom is not.
 */
function lineMatcher(
  re: RegExp,
  messageTest?: (arg: string) => boolean,
): (line: string) => boolean {
  return (line) => {
    const match = re.exec(line);
    if (match === null) return false;
    if (messageTest && !messageTest(match[1] ?? '')) return false;
    return !isMarkdownQuoted(line, match.index);
  };
}

const isUnimplementedArg = (arg: string): boolean => UNIMPLEMENTED_MESSAGE.test(arg);

/** A Go panic whose argument reads as unfinished work (not every panic). */
function isGoPanicArg(arg: string): boolean {
  return UNIMPLEMENTED_MESSAGE.test(arg) || /(^|["'`])\s*TODO|:\s*TODO/.test(arg);
}

const TS_JS_PATTERNS: readonly MarkerPattern[] = [
  {
    marker: "throw new Error('not implemented')",
    test: lineMatcher(/throw\s+new\s+Error\s*\(([^)]*)\)/i, isUnimplementedArg),
  },
  // `throw new NotImplementedError(...)` and a bare `NotImplementedError(` call.
  {
    marker: 'NotImplementedError',
    test: lineMatcher(/\bNotImplementedError\s*\(/),
  },
];

const PYTHON_PATTERNS: readonly MarkerPattern[] = [
  // `raise NotImplementedError` with or without parens/message.
  {
    marker: 'raise NotImplementedError',
    test: lineMatcher(/\braise\s+NotImplementedError\b/),
  },
];

const RUST_PATTERNS: readonly MarkerPattern[] = [
  { marker: 'todo!()', test: lineMatcher(/\btodo!\s*\(/) },
  { marker: 'unimplemented!()', test: lineMatcher(/\bunimplemented!\s*\(/) },
];

const GO_PATTERNS: readonly MarkerPattern[] = [
  {
    marker: 'panic("not implemented")',
    test: lineMatcher(/\bpanic\s*\(([^)]*)\)/, isGoPanicArg),
  },
];

const JAVA_PATTERNS: readonly MarkerPattern[] = [
  // Covers the IDE-generated "Not supported yet." stub.
  {
    marker: 'throw new UnsupportedOperationException',
    test: lineMatcher(/throw\s+new\s+UnsupportedOperationException\b/),
  },
];

const CPP_PATTERNS: readonly MarkerPattern[] = [
  {
    marker: 'throw std::logic_error("not implemented")',
    test: lineMatcher(/throw\s+std::logic_error\s*\(([^)]*)\)/, isUnimplementedArg),
  },
  // `assert(... && "not implemented")` — the common C/C++ stub idiom.
  {
    marker: 'assert(... && "not implemented")',
    test: lineMatcher(/\bassert\s*\((.*)\)/, isUnimplementedArg),
  },
];

/** Extension → language patterns. Extensions absent here are unsupported. */
const PATTERNS_BY_EXTENSION: Readonly<Record<string, readonly MarkerPattern[]>> = {
  ts: TS_JS_PATTERNS,
  tsx: TS_JS_PATTERNS,
  js: TS_JS_PATTERNS,
  jsx: TS_JS_PATTERNS,
  mjs: TS_JS_PATTERNS,
  cjs: TS_JS_PATTERNS,
  py: PYTHON_PATTERNS,
  rs: RUST_PATTERNS,
  go: GO_PATTERNS,
  java: JAVA_PATTERNS,
  c: CPP_PATTERNS,
  cc: CPP_PATTERNS,
  cpp: CPP_PATTERNS,
  h: CPP_PATTERNS,
  hpp: CPP_PATTERNS,
};

/** Map a file extension to the language's marker patterns (null = unsupported). */
function patternsForExtension(filePath: string): readonly MarkerPattern[] | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return PATTERNS_BY_EXTENSION[ext] ?? null;
}

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * logic per-language without standing up the full Check framework.
 */
export function analyzeUnimplementedMarkers(content: string, filePath: string): CheckViolation[] {
  const patterns = patternsForExtension(filePath);
  if (patterns === null) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    for (const { marker, test } of patterns) {
      if (test(line)) {
        violations.push({
          message: `Unimplemented-work marker found (\`${marker}\` idiom): code announces it is not implemented`,
          // Soft shipped default; repos wanting a hard gate set `failOnWarnings`
          // (this repo does — see opensip-cli.config.yml).
          severity: 'warning',
          line: i + 1,
          suggestion:
            'Implement before shipping, or track the work in an issue and remove the placeholder',
          match: line.trim(),
        });
        // One violation per line is enough; avoid double-counting overlapping
        // idioms (e.g. a NotImplementedError throw matching two TS patterns).
        break;
      }
    }
  }
  return violations;
}

export const noUnimplementedMarkers = defineCheck({
  id: 'b8ec0d20-e5b5-487d-8d02-955b0f960cf6',
  slug: 'no-unimplemented-markers',
  description: 'Code must not announce it is unimplemented (throw/macro "not implemented" idioms)',
  longDescription: `**Purpose:** Flags explicit "not implemented yet" stub idioms — the highest-signal indicator of unfinished work — across all six supported languages. Goal: never ship code that announces it isn't implemented.

**Detects (per language):**
- **TS/JS:** \`throw new Error(...)\` whose message matches not-implemented; \`throw new NotImplementedError\`; \`NotImplementedError(\`
- **Python:** \`raise NotImplementedError\`
- **Rust:** \`todo!(\` and \`unimplemented!(\` macros
- **Go:** \`panic(...)\` whose message reads as unfinished work (not every panic)
- **Java:** \`throw new UnsupportedOperationException\` (the IDE "Not supported yet" stub)
- **C/C++:** \`throw std::logic_error(...)\` or \`assert(... && "...")\` mentioning not-implemented

**Why it matters:** These markers are unambiguous declarations that a code path is a placeholder. Surfacing them on every fitness run prevents stubs from reaching production.

**Scope:** Source files only; test files are skipped.`,
  scope: { languages: [], concerns: [] },
  tags: ['quality', 'best-practices'],
  confidence: 'high',
  // Restrict to source files across all six supported languages.
  fileTypes: [
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'py',
    'go',
    'java',
    'rs',
    'c',
    'cc',
    'cpp',
    'h',
    'hpp',
  ],
  // Use 'raw': the markers live inside string ARGUMENTS, so 'strip-strings'
  // would erase them before this check ever sees them.
  contentFilter: 'raw',
  analyze: (content, filePath) => {
    // Test files routinely contain these idioms as fixture content or
    // pedagogical examples (e.g. test cases for this very check).
    if (isTestFile(filePath)) return [];
    return analyzeUnimplementedMarkers(content, filePath);
  },
});
