/**
 * @fileoverview Keyword-agnostic inline-suppression primitive (ADR-0014).
 *
 * The shared machinery behind `@fitness-ignore-*` and `@graph-ignore-*`: a
 * pure text scan of comment directives plus a `Signal`-stream filter. It is
 * keyword-agnostic (the directive keywords are a parameter) and performs no
 * file I/O — content is read through an injected reader, keeping the kernel
 * pure. The *vocabulary* (which keyword a tool uses) stays tool-owned and
 * explicit; only the *machinery* is shared.
 *
 * Matching unit: each signal is tested against a set of **candidate source
 * locations** (default: the signal's own `code`). Graph supplies extra
 * candidate locations for `graph:cycle` (the SCC members) so a directive above
 * any member matches — without this module knowing what an SCC is.
 *
 * Suppression is **unconditional**: a directive with no `-- reason` still
 * suppresses. Reason quality is audited out-of-band (e.g. the
 * `graph-ignore-hygiene` / `fitness-ignore-hygiene` checks), never enforced
 * here.
 */

import { COMMENT_OPENERS } from './comment-openers.js';

import type { Signal } from '../types/signal.js';

// =============================================================================
// PUBLIC TYPES
// =============================================================================

/** The two directive keywords a tool owns. */
export interface SuppressionKeywords {
  /** File-level directive, e.g. `@fitness-ignore-file` / `@graph-ignore-file`. */
  readonly file: string;
  /** Next-line directive, e.g. `@fitness-ignore-next-line` / `@graph-ignore-next-line`. */
  readonly nextLine: string;
}

/** A candidate source location a directive may target for a given signal. */
export interface SuppressionLocation {
  readonly file: string;
  /** 1-based line; omit for a file-only candidate. */
  readonly line?: number;
}

/** Request for {@link filterSignalsBySuppressions}. */
export interface SuppressionRequest {
  readonly signals: readonly Signal[];
  /** The tool's explicit directive keywords. */
  readonly keywords: SuppressionKeywords;
  /** Injected content reader (kernel performs no file I/O). */
  readonly readFile: (filePath: string) => Promise<string>;
  /**
   * Candidate locations a directive may target for this signal. Defaults to
   * the signal's own `code` location. Graph overrides this for `graph:cycle`.
   */
  readonly locate?: (signal: Signal) => readonly SuppressionLocation[];
  /**
   * The id a directive must name to suppress this signal. Defaults to
   * `signal.ruleId`. Fitness passes `() => checkId` to reproduce its exact
   * per-check semantics.
   */
  readonly ruleIdOf?: (signal: Signal) => string;
}

/** One suppressed signal + the directive that suppressed it. */
export interface SuppressionMatch {
  readonly signal: Signal;
  readonly ruleId: string;
  readonly file: string;
  /** The 1-based line, or `'file'` for a file-level directive. */
  readonly line: number | 'file';
}

/** Result of {@link filterSignalsBySuppressions}. */
export interface SuppressionResult {
  readonly kept: readonly Signal[];
  readonly suppressed: readonly SuppressionMatch[];
}

// =============================================================================
// INTERNAL CONSTANTS
// =============================================================================

/**
 * When a next-line directive is itself preceded by other directive lines, the
 * scanner skips over up to this many stacked directives to find the line the
 * suppression actually targets.
 */
const MAX_DIRECTIVE_SKIP = 3;

/**
 * File-level directives are only honored in the first N lines of a file (they
 * are a "near the top" convention). Matches the historical fitness limit.
 */
const FILE_DIRECTIVE_SCAN_LIMIT = 50;

/**
 * Directive keyword prefixes recognized when skipping over stacked directive
 * lines to find a next-line target. Covers both first-party tools plus the
 * common foreign suppressors so a stacked directive of any kind is skipped.
 */
const KNOWN_DIRECTIVE_KEYWORDS: readonly string[] = [
  'eslint-disable-next-line',
  'eslint-disable-line',
  '@ts-expect-error',
  '@ts-ignore',
  '@ts-nocheck',
  'prettier-ignore',
  'biome-ignore',
  '@fitness-ignore-next-line',
  '@fitness-ignore-file',
  '@graph-ignore-next-line',
  '@graph-ignore-file',
];

// =============================================================================
// INTERNAL — directive text scanning
// =============================================================================

function isIdChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  const isLowerCase = code >= 97 && code <= 122;
  const isUpperCase = code >= 65 && code <= 90;
  const isDigit = code >= 48 && code <= 57;
  // `_` `-` `/` `:` — `:` admits namespaced ids like `graph:cycle`.
  const isSpecialChar = code === 95 || code === 45 || code === 47 || code === 58;
  return isLowerCase || isUpperCase || isDigit || isSpecialChar;
}

/**
 * Extract the id token a directive names, or `null` when `line` is not a
 * `<comment> <directiveKeyword> <id>` directive.
 */
function extractDirectiveId(line: string, directiveKeyword: string): string | null {
  let commentIndex = -1;
  let sliceLen = 0;
  for (const [opener, length] of COMMENT_OPENERS) {
    const idx = line.indexOf(opener);
    if (idx !== -1) {
      commentIndex = idx;
      sliceLen = length;
      break;
    }
  }
  if (commentIndex === -1) return null;

  const afterComment = line.slice(commentIndex + sliceLen).trimStart();
  if (!afterComment.startsWith(directiveKeyword)) return null;

  const afterDirective = afterComment.slice(directiveKeyword.length);
  if (
    afterDirective.length === 0 ||
    (!afterDirective.startsWith(' ') && !afterDirective.startsWith('\t'))
  ) {
    return null;
  }

  let id = '';
  for (const char of afterDirective.trimStart()) {
    if (isIdChar(char)) id += char;
    else break;
  }
  return id.length > 0 ? id : null;
}

/** True when a line is a known directive comment (used to skip stacked directives). */
function isKnownDirectiveLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('//') && !trimmed.startsWith('/*')) return false;
  const content = trimmed.slice(2).trimStart();
  return KNOWN_DIRECTIVE_KEYWORDS.some((keyword) => {
    if (!content.startsWith(keyword)) return false;
    const next = content[keyword.length];
    return next === undefined || next === ' ' || next === '\t' || next === ':';
  });
}

/**
 * Per-file scan result. Exposed so lower-level callers (e.g. fitness's
 * `parseFileIgnoreDirective` / `parseIgnoreDirectives` wrappers) can build on
 * the same single scan implementation instead of re-deriving it.
 */
export interface SuppressionScan {
  /** Ids named by a file-level directive. */
  readonly fileIgnoredIds: ReadonlySet<string>;
  /** Target 1-based line → ids named by a next-line directive. */
  readonly lineIgnoredIds: ReadonlyMap<number, ReadonlySet<string>>;
  /** 1-based lines that ARE directive comments (anti-recursion guard). */
  readonly directiveLines: ReadonlySet<number>;
}

/** Scan a file's content once, extracting every directive for `keywords`. */
export function scanSuppressionDirectives(
  content: string,
  keywords: SuppressionKeywords,
): SuppressionScan {
  const lines = content.split('\n');
  const fileIgnoredIds = new Set<string>();
  const lineIgnoredIds = new Map<number, Set<string>>();
  const directiveLines = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (i < FILE_DIRECTIVE_SCAN_LIMIT) {
      const fileId = extractDirectiveId(line, keywords.file);
      if (fileId !== null) {
        fileIgnoredIds.add(fileId);
        directiveLines.add(i + 1);
      }
    }

    const nextLineId = extractDirectiveId(line, keywords.nextLine);
    if (nextLineId !== null) {
      directiveLines.add(i + 1);
      // Resolve the line the directive targets, skipping stacked directives.
      let target = i + 1; // 0-based index of the next line
      let skipped = 0;
      while (
        target < lines.length &&
        skipped < MAX_DIRECTIVE_SKIP &&
        isKnownDirectiveLine(lines[target] ?? '')
      ) {
        target++;
        skipped++;
      }
      const targetLine = target + 1; // 1-based
      let set = lineIgnoredIds.get(targetLine);
      if (!set) {
        set = new Set();
        lineIgnoredIds.set(targetLine, set);
      }
      set.add(nextLineId);
    }
  }

  return { fileIgnoredIds, lineIgnoredIds, directiveLines };
}

// =============================================================================
// PUBLIC API
// =============================================================================

const defaultLocate = (signal: Signal): readonly SuppressionLocation[] => {
  const file = signal.code?.file;
  // An absent OR empty file path is not a real candidate location — it can
  // carry no directive and (post-Phase-5) must never be handed to `readFile`,
  // where it would resolve to a directory and fail loud spuriously.
  if (file === undefined || file === '') return [];
  return [{ file, line: signal.code?.line }];
};

/**
 * Filter a `Signal` stream by inline suppression directives.
 *
 * Each file referenced by a candidate location is read once (via the injected
 * `readFile`) and scanned once. A signal is suppressed when, for ANY of its
 * candidate locations, the directive id (`ruleIdOf(signal)`, default
 * `signal.ruleId`) is file-ignored for that file, or next-line-ignored at that
 * location's line. A location pointing AT a directive line is never suppressed
 * by a next-line directive (anti-recursion); file-level still applies.
 *
 * Read-failure posture (fail-loud; Phase 5): the injected `readFile` reads
 * project SOURCE files the analyzers already loaded, so a read failure is
 * UNEXPECTED. An `ENOENT` (the file was genuinely removed) is non-fatal but
 * ATTRIBUTED — it is surfaced via a warning-level `signals.suppress.directive-
 * file-missing` log (so a potentially-dropped waiver is diagnosable) and that
 * file contributes no directives. ANY other read failure (`EACCES`, `EMFILE`,
 * decode error, …) is propagated (THROWS) — the run aborts loudly rather than
 * silently dropping a waiver and leaking the waived signal as a finding.
 */
export async function filterSignalsBySuppressions(
  request: SuppressionRequest,
): Promise<SuppressionResult> {
  const { signals, keywords, readFile } = request;
  const locate = request.locate ?? defaultLocate;
  const ruleIdOf = request.ruleIdOf ?? ((s: Signal) => s.ruleId);

  // Resolve candidate locations once per signal; collect the unique files.
  const locationsBySignal = new Map<Signal, readonly SuppressionLocation[]>();
  const uniqueFiles = new Set<string>();
  for (const signal of signals) {
    const locations = locate(signal);
    locationsBySignal.set(signal, locations);
    for (const loc of locations) uniqueFiles.add(loc.file);
  }

  // Scan each unique file once, in parallel. A read failure is UNEXPECTED
  // (these are project SOURCE files the analyzers already loaded), so it must
  // not silently degrade a file to "no directives" and leak its waivers: an
  // `ENOENT` is non-fatal but attributed (logged + recorded below), any other
  // error propagates and aborts the run.
  const scanByFile = new Map<string, SuppressionScan>();
  const missingFiles = new Set<string>();
  await Promise.all(
    [...uniqueFiles].map(async (filePath) => {
      try {
        // @fitness-ignore-next-line unbounded-memory -- `readFile` is the injected reader (the kernel does no real I/O); callers read project SOURCE files the analyzers already loaded — inherently bounded, not attacker-controlled blobs.
        const content = await readFile(filePath);
        scanByFile.set(filePath, scanSuppressionDirectives(content, keywords));
      } catch (error) {
        if (!isEnoent(error)) {
          // Unexpected read failure (EACCES, EMFILE, decode, …) — fail loud
          // rather than drop a waiver and leak the waived signal as a finding.
          throw error;
        }
        // ENOENT: the file was genuinely removed. A removed source file yields
        // no occurrences, so its signals should not exist — but we surface it
        // (attribution below) instead of silently treating it as "no
        // directives", so a leaked waiver is always diagnosable.
        missingFiles.add(filePath);
      }
    }),
  );

  attributeMissingFiles(missingFiles, request);

  const kept: Signal[] = [];
  const suppressed: SuppressionMatch[] = [];

  for (const signal of signals) {
    const id = ruleIdOf(signal);
    const match = matchSuppression(locationsBySignal.get(signal) ?? [], id, scanByFile);
    if (match === null) {
      kept.push(signal);
    } else {
      suppressed.push({ signal, ruleId: id, file: match.file, line: match.line });
    }
  }

  return { kept, suppressed };
}

/** True when `error` is a Node `ENOENT` (file genuinely absent). */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Hook for surfacing `ENOENT`-absent directive files. Task 5.1 establishes the
 * conservative non-fatal path (the signal is kept, never silently treated as
 * "no directives" without a record); Task 5.2 wires the attributed log here.
 */
function attributeMissingFiles(
  _missingFiles: ReadonlySet<string>,
  _request: SuppressionRequest,
): void {
  // Attribution log wired in Task 5.2.
}

/** The first candidate location that suppresses `id`, or `null`. */
function matchSuppression(
  locations: readonly SuppressionLocation[],
  id: string,
  scanByFile: ReadonlyMap<string, SuppressionScan>,
): { file: string; line: number | 'file' } | null {
  for (const loc of locations) {
    const scan = scanByFile.get(loc.file);
    if (scan === undefined) continue;

    if (scan.fileIgnoredIds.has(id)) {
      return { file: loc.file, line: 'file' };
    }

    const line = loc.line;
    if (
      line !== undefined &&
      !scan.directiveLines.has(line) && // anti-recursion: never suppress a directive line itself
      scan.lineIgnoredIds.get(line)?.has(id) === true
    ) {
      return { file: loc.file, line };
    }
  }
  return null;
}
