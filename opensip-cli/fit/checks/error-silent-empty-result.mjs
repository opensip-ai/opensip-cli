/**
 * @fileoverview error-silent-empty-result — a FAILURE path must never hand back
 *               an OpenSIP evidence value that reads as a clean, complete pass.
 *               Project-local SELF-check for opensip-cli.
 *
 * THE DEFECT CLASS (false-green). Something goes wrong — a `readdir` throws, a
 * batch member rejects, a bounded walk gives up — and the function returns the
 * empty (or partially-filled) accumulator anyway. The caller receives a value
 * that is byte-identical to "I analysed everything and there was genuinely
 * nothing to report". Zero plugins loaded reads as "this project has no
 * plugins". Zero files prewarmed reads as "no files matched". Zero targets
 * enumerated reads as "nothing to uninstall". The run is green; the evidence is
 * a lie. That is the single worst failure mode for a product whose entire
 * thesis is "humans can trust agent-written code only when evidence is
 * preserved" — an OpenSIP that silently under-reports is worse than an OpenSIP
 * that crashes, because the crash is visible.
 *
 * WHY THIS IS OPENSIP-INTERNAL (and therefore lives HERE, not in a shipped
 * `@opensip-cli/checks-*` pack). The rule is anchored on opensip-cli's OWN
 * evidence contract, not on generic JS hygiene:
 *
 *   - It path-gates to first-party `packages/**\/src/**` — the code that
 *     PRODUCES OpenSIP evidence. In an adopter's repo the rule is inert.
 *   - Sub-rule 3 keys on the literal field vocabulary of the graph read
 *     coverage contract (`complete` / `truncated` / `capped` / `reasons`, see
 *     `packages/graph/engine/src/read/bounded-view.ts`) and of the
 *     SignalEnvelope verdict (`degraded` / `faulted` / `passed`). Those field
 *     names are opensip-cli types. No consumer codebase has them.
 *   - It honours this repo's established `@swallow-ok` / `@silent-ok`
 *     annotation convention as the documented, reviewable opt-out. That
 *     convention is a local fact (100+ call sites under `packages/`), not
 *     something a shipped pack could assume.
 *
 * Per `opensip-cli/fit/checks/README.md`, checks that encode local facts stay
 * project-local; `shipped-checks-must-be-generic` steers exactly this shape
 * here rather than into a customer-facing pack.
 *
 * RELATIONSHIP TO THE SHIPPED `error-handling-quality` CHECK. That check asks
 * "was the ERROR observed?" and accepts a `logger.warn` as sufficient. This
 * check asks a different question: "is the RESULT distinguishable?" A log line
 * does not help the caller — `parseChildSignals` logs its JSON parse failure
 * and STILL returns `[]`, which the workspace aggregator then folds in as
 * "this unit had no findings". So logging is deliberately NOT an exemption
 * here. The two checks are complementary, not duplicates: fix this one by
 * making the failure part of the returned VALUE (a reason code, a `failure`
 * field, a `complete: false`), or by throwing.
 *
 * WHAT IT FLAGS — three mechanically precise shapes, all of them "failure in,
 * clean-looking evidence out":
 *
 *   R1  A `catch` block that returns a collection ACCUMULATOR declared in the
 *       same file as `= []` / `new Map()` / `new Set()`. The caller cannot tell
 *       "scan completed, N items" from "scan died at item N".
 *       Real instance: `discoverLooseFilesInDir` in
 *       `packages/core/src/plugins/discover.ts` — under fd exhaustion or EIO
 *       the user-authored checks/scenarios/recipes tree contributes ZERO
 *       plugins and the run still reports success.
 *
 *   R2  A `Promise.allSettled(...)` batch whose results are consumed only
 *       through `status === 'fulfilled'`, with no reference to the rejected
 *       half (`'rejected'`, `.reason`, a dropped-count). Every failed member
 *       silently evaporates and the surviving count is reported as the total.
 *
 *   R3  An object literal that STAMPS completeness — `complete: true`,
 *       `truncated: false`, `capped: false`, `degraded: false`,
 *       `faulted: false`, `passed: true`, `reasons: []` — returned from inside
 *       a `catch` or a branch guarded on a failure/cap/abort condition, and
 *       carrying no failure discriminator of its own. Completeness must be
 *       DERIVED from the accumulated reasons (`makeFacet(requested, reasons)`),
 *       never hand-asserted on a path reached because something broke.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG:
 *
 *   - An empty return on a legitimate EMPTY-INPUT path. `if (eligible.length <
 *     2) return emptyResult();` in `find-near-duplicates.ts` is honest: nothing
 *     failed, there was genuinely nothing to cluster. Every shape here is
 *     rooted in a `catch` or an explicitly failure-named condition, so
 *     empty-input paths are structurally out of reach.
 *   - Boolean composition. `capped: resultLimitReached || walk.capped`,
 *     `inTestFile: frame.inTestScope || ctx.fileInTestFile` and friends are
 *     merges of already-computed outcome flags, not fallbacks — the `||`
 *     family was reviewed and rejected as a signal, and this check never looks
 *     at `||` at all.
 *   - Errno-narrowed probes that rethrow: `catch (e) { if (code === 'ENOENT')
 *     return false; throw e; }` is precise handling, not a swallow. R1 requires
 *     the catch to contain no `throw`.
 *   - A failure result that IS distinguishable: `{ failure: {...}, truncated:
 *     false }` or `{ violations: [], error: 'Failed to parse output' }` carry
 *     their own discriminator and are exempt under R3.
 *   - Anything already annotated `@swallow-ok` / `@silent-ok` / `@handles` in
 *     the failing region — the repo's reviewed-and-accepted marker.
 *   - Tests, `.d.ts`, `dist/`, and every `__fixtures__/` tree EXCEPT this
 *     check's own (which mirrors a `packages/<pkg>/src` layout so the fixtures
 *     are actually exercisable; the repo-level `globalExcludes` still keeps it
 *     out of the real gate — same precedent as `no-module-singleton`).
 *
 * Comments are stripped (layout-preserving, string-safe) before every scan so
 * prose — including this header, were it ever copied into `packages/` — cannot
 * trip the rule. String literal CONTENT is deliberately preserved because R2
 * and R3 read `'fulfilled'` / `'complete'` as literals; that is why the check
 * runs `contentFilter: 'raw'` rather than `strip-strings` (see
 * `no-strip-strings-reading-literals`).
 */
import { defineCheck, isTestFile } from '@opensip-cli/fitness';

/** Markers this repo already uses to record a reviewed, intentional swallow. */
const ACCEPTED_MARKER_RE = /@swallow-ok|@silent-ok|@handles/;

/** Empty-collection initialisers that make an identifier an accumulator. */
const ACCUMULATOR_INIT = String.raw`(?:\[\s*\]|new\s+Map\s*\(|new\s+Set\s*\(|new\s+Array\s*\(\s*\))`;

/**
 * Conditions that name a FAILURE. Deliberately narrow: `invalid` / `missing` /
 * `empty` are excluded because they routinely guard legitimate empty-INPUT
 * paths, which this rule must not touch.
 */
const FAILURE_CONDITION_RE =
  /\b(?:err|error|errors|failed|failure|aborted|cancelled|canceled|timedOut|capped|truncated|degraded|faulted|rejected|limitReached|exceeded)\b/i;

/** Object-literal keys that ASSERT a clean, complete outcome. */
const COMPLETENESS_ASSERTIONS = [
  { re: /\bcomplete\s*:\s*true\b/, label: 'complete: true' },
  { re: /\btruncated\s*:\s*false\b/, label: 'truncated: false' },
  { re: /\bcapped\s*:\s*false\b/, label: 'capped: false' },
  { re: /\bdegraded\s*:\s*false\b/, label: 'degraded: false' },
  { re: /\bfaulted\s*:\s*false\b/, label: 'faulted: false' },
  { re: /\bpassed\s*:\s*true\b/, label: 'passed: true' },
  { re: /\bpartial\s*:\s*false\b/, label: 'partial: false' },
  { re: /\breasons\s*:\s*\[\s*\]/, label: 'reasons: []' },
  { re: /\bfreshness\s*:\s*['"]complete['"]/, label: "freshness: 'complete'" },
];

/** Keys whose (substantive) presence lets the caller branch on the failure. */
const DISCRIMINATOR_KEY_RE =
  /\b(failure|error|errors|err|reason|reasons|warnings|diagnostics|incomplete)\s*:\s*([^,}\n]*)/g;

/** Degradation flags that are themselves the discriminator. */
const DEGRADATION_TRUE_RE =
  /\b(?:degraded|faulted|truncated|capped|cancelled|aborted|partial)\s*:\s*true\b/;

/** The explicit negations of a clean verdict — equally self-describing. */
const NEGATED_CLEAN_RE = /\bcomplete\s*:\s*false\b|\bpassed\s*:\s*false\b/;

/** Values that explain nothing, so they do not discriminate anything. */
const VACUOUS_VALUE_RE = /^(?:\[\s*\]|\{\s*\}|undefined|null|''|""|``|false|0)?$/;

/**
 * True when a returned literal makes its own failure legible. The value must be
 * SUBSTANTIVE: `reasons: []` and `error: undefined` explain nothing — which is
 * exactly why `reasons: []` is a COMPLETENESS ASSERTION here, not a
 * discriminator.
 */
function hasFailureDiscriminator(text) {
  for (const match of text.matchAll(DISCRIMINATOR_KEY_RE)) {
    if (!VACUOUS_VALUE_RE.test(match[2].trim())) return true;
  }
  return DEGRADATION_TRUE_RE.test(text) || NEGATED_CLEAN_RE.test(text);
}

/** Replace a `//` comment with spaces up to (not including) the newline. */
function blankLineComment(source, i) {
  let out = '';
  let j = i;
  while (j < source.length && source[j] !== '\n') {
    out += ' ';
    j += 1;
  }
  return { out, next: j };
}

/** Replace a block comment with spaces, keeping its newlines. */
function blankBlockComment(source, i) {
  let out = '  ';
  let j = i + 2;
  while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) {
    out += source[j] === '\n' ? '\n' : ' ';
    j += 1;
  }
  return { out: `${out}  `, next: j + 2 };
}

/** Copy a string/template literal through verbatim (escape-aware). */
function copyStringLiteral(source, i) {
  const quote = source[i];
  let out = quote;
  let j = i + 1;
  while (j < source.length && source[j] !== quote) {
    if (source[j] === '\\') {
      out += source.slice(j, j + 2);
      j += 2;
      continue;
    }
    out += source[j];
    j += 1;
  }
  return { out: out + (source[j] ?? ''), next: j + 1 };
}

/**
 * Blank out comments while preserving every newline (so reported line numbers
 * stay accurate) and every string literal (R2/R3 read `'fulfilled'` and
 * `'complete'` as literal values). String-aware, so `'https://x'` survives.
 */
export function stripCommentsPreservingLayout(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    let step;
    if (c === '/' && next === '/') step = blankLineComment(source, i);
    else if (c === '/' && next === '*') step = blankBlockComment(source, i);
    else if (c === '"' || c === "'" || c === '`') step = copyStringLiteral(source, i);
    else {
      out += c;
      i += 1;
      continue;
    }
    out += step.out;
    i = step.next;
  }
  return out;
}

/** Index of the `}` closing the `{` at `open`, or the end of `code`. */
function closingBrace(code, open) {
  let depth = 0;
  for (let j = open; j < code.length; j += 1) {
    if (code[j] === '{') depth += 1;
    else if (code[j] === '}') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return code.length;
}

/** 1-based line number of `index` within `code`. */
function lineAt(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) {
    if (code[i] === '\n') line += 1;
  }
  return line;
}

/** Index of the `)` matching the `(` at `open`, or the end of `code`. */
function matchingParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/** End offset of the balanced, `;`-terminated statement starting at `from`. */
function statementEnd(text, from) {
  let nest = 0;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{' || ch === '(' || ch === '[') nest += 1;
    else if (ch === '}' || ch === ')' || ch === ']') {
      nest -= 1;
      if (nest < 0) return i;
    } else if (ch === ';' && nest === 0) return i;
  }
  return text.length;
}

/** End offset of the block ENCLOSING `from` (where nesting would go negative). */
function enclosingBlockEnd(code, from) {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth < 0) return i;
    }
  }
  return code.length;
}

/** Every `catch` clause body in `code`, as `{ start, end }` offsets. */
function catchBodies(code) {
  const bodies = [];
  for (const match of code.matchAll(/\bcatch\b\s*(?:\([^)]*\)\s*)?\{/g)) {
    const open = match.index + match[0].length - 1;
    bodies.push({ start: open + 1, end: closingBrace(code, open) });
  }
  return bodies;
}

/** Failure-guarded `if` consequents (block or single statement). */
function failureBranches(code) {
  const branches = [];
  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const parenOpen = match.index + match[0].length - 1;
    const parenClose = matchingParen(code, parenOpen);
    if (!FAILURE_CONDITION_RE.test(code.slice(parenOpen + 1, parenClose))) continue;
    let k = parenClose + 1;
    while (k < code.length && /\s/.test(code[k])) k += 1;
    branches.push(
      code[k] === '{'
        ? { start: k + 1, end: closingBrace(code, k) }
        : { start: k, end: statementEnd(code, k) },
    );
  }
  return branches;
}

/** `return <expr>` spans inside `region`, offsets relative to `code`. */
function returnExpressions(code, region) {
  const text = code.slice(region.start, region.end);
  const spans = [];
  for (const match of text.matchAll(/\breturn\b/g)) {
    const start = match.index + 'return'.length;
    const end = statementEnd(text, start);
    spans.push({ text: text.slice(start, end), offset: region.start + start });
  }
  return spans;
}

/** True when the raw source lines spanning `region` carry an accepted marker. */
function regionIsAnnotated(rawLines, code, region) {
  const first = lineAt(code, region.start);
  const last = lineAt(code, region.end);
  return ACCEPTED_MARKER_RE.test(rawLines.slice(Math.max(0, first - 2), last).join('\n'));
}

/**
 * R1 — a `catch` that returns a collection accumulator declared in this file.
 * Skipped when the catch rethrows (errno-narrowed precise handling).
 */
function findAccumulatorReturns(code, rawLines) {
  const violations = [];
  for (const body of catchBodies(code)) {
    const text = code.slice(body.start, body.end);
    if (/\bthrow\b/.test(text)) continue;
    const returned = /\breturn\s+([A-Za-z_$][\w$]*)\s*;/.exec(text);
    if (!returned) continue;
    const identifier = returned[1];
    const declaration = new RegExp(
      String.raw`\b(?:const|let|var)\s+${identifier}\b[^=;\n]*=\s*${ACCUMULATOR_INIT}`,
    );
    if (!declaration.test(code.slice(0, body.start))) continue;
    if (regionIsAnnotated(rawLines, code, body)) continue;
    violations.push({
      severity: 'error',
      message:
        `Failure path returns the collection accumulator '${identifier}' — the caller cannot distinguish ` +
        '"scan completed, nothing found" from "scan failed part-way". Return a value that carries the ' +
        'failure (a reason code, a `failure`/`error` field, `complete: false`) or rethrow. A log line is ' +
        'not enough: the RESULT is what downstream evidence is built from.',
      line: lineAt(code, body.start + returned.index),
      column: 1,
      suggestion:
        `Make the degradation part of the returned value (e.g. \`{ items: ${identifier}, complete: false, reasons: ['read-failed'] }\`), ` +
        'rethrow, or annotate the catch `@swallow-ok <why the empty result is honest>`.',
    });
  }
  return violations;
}

/**
 * R2 — `Promise.allSettled(...)` consumed fulfilled-only. The region scanned is
 * the rest of the enclosing block, so a rejected-half accounting anywhere in
 * the same scope clears the site.
 */
function findDiscardedRejections(code, rawLines) {
  const violations = [];
  for (const match of code.matchAll(/Promise\s*\.\s*allSettled\s*\(/g)) {
    const end = enclosingBlockEnd(code, match.index);
    const region = code.slice(match.index, end);
    if (!/===\s*['"]fulfilled['"]|['"]fulfilled['"]\s*===/.test(region)) continue;
    if (/['"]rejected['"]|\.\s*reason\b|!==\s*['"]fulfilled['"]/.test(region)) continue;
    const span = { start: match.index, end };
    if (regionIsAnnotated(rawLines, code, span)) continue;
    violations.push({
      severity: 'error',
      message:
        'Promise.allSettled results are consumed fulfilled-only — every rejected member is dropped with no ' +
        'count, no reason and no diagnostic, so the surviving total is reported as if it were the whole batch. ' +
        'That is a silent empty/short result on a failure path.',
      line: lineAt(code, match.index),
      column: 1,
      suggestion:
        "Account for the rejected half: collect `result.reason` for the `'rejected'` entries and surface them " +
        '(a reason code, a dropped-count on the returned stats, or a rethrow) so a partial batch is never ' +
        'indistinguishable from a complete one.',
    });
  }
  return violations;
}

/**
 * R3 — completeness stamped inside a failure/cap/abort branch. Completeness on
 * the read surface must be DERIVED (`makeFacet(requested, reasons)`), never
 * hand-asserted on a path reached because something broke.
 */
function findCompletenessOnFailurePath(code, rawLines) {
  const violations = [];
  const regions = [
    ...catchBodies(code).map((r) => ({ ...r, kind: 'catch block' })),
    ...failureBranches(code).map((r) => ({
      ...r,
      kind: 'failure-guarded branch',
    })),
  ];
  for (const region of regions) {
    for (const span of returnExpressions(code, region)) {
      if (!span.text.includes('{')) continue;
      const assertion = COMPLETENESS_ASSERTIONS.find((a) => a.re.test(span.text));
      if (!assertion) continue;
      if (hasFailureDiscriminator(span.text)) continue;
      if (regionIsAnnotated(rawLines, code, region)) continue;
      violations.push({
        severity: 'error',
        message:
          `A ${region.kind} returns a result stamping '${assertion.label}' with no failure discriminator — ` +
          'the caller reads it as "analysed everything, nothing to report". Completeness must be derived from ' +
          'the accumulated reason set, never asserted on a path reached because something failed or was capped.',
        line: lineAt(code, span.offset),
        column: 1,
        suggestion:
          'Derive coverage from the reasons (e.g. `makeFacet(requested, reasons)` in graph/read/bounded-view.ts) ' +
          'or add the discriminator the caller needs (`failure`, `complete: false`, a `-cap` reason code).',
      });
      break;
    }
  }
  return violations;
}

/**
 * This check's OWN synthetic pass/fail tree. It mirrors a `packages/<pkg>/src`
 * layout so the path gate applies to it, and is re-admitted here (the repo-level
 * `globalExcludes: '**\/__fixtures__/**'` still keeps it out of the real gate).
 * Same self-fixture precedent as `no-module-singleton.mjs`.
 */
const SELF_FIXTURE_PATH = /opensip-cli\/fit\/checks\/__fixtures__\/error-silent-empty-result\//;

/** First-party OpenSIP evidence-producing source: `packages/**\/src/**`. */
function isFirstPartySource(filePath) {
  if (typeof filePath !== 'string') return false;
  const normalized = filePath.replaceAll('\\', '/');
  if (!/\.tsx?$/.test(normalized) || normalized.endsWith('.d.ts')) return false;
  if (!normalized.includes('packages/') || !normalized.includes('/src/')) return false;
  if (normalized.includes('/__fixtures__/') && !SELF_FIXTURE_PATH.test(normalized)) return false;
  if (
    normalized.includes('/dist/') ||
    normalized.includes('/node_modules/') ||
    normalized.includes('/__tests__/') ||
    normalized.includes('/test-utils/') ||
    normalized.includes('/test-support/')
  ) {
    return false;
  }
  return !isTestFile(filePath);
}

/** Pure analysis. Exported so the shape can be exercised directly. */
export function analyzeErrorSilentEmptyResult(content, filePath) {
  if (!isFirstPartySource(filePath)) return [];
  if (/@fitness-ignore-file\s+error-silent-empty-result/.test(content)) return [];

  const code = stripCommentsPreservingLayout(content);
  const rawLines = content.split('\n');
  return [
    ...findAccumulatorReturns(code, rawLines),
    ...findDiscardedRejections(code, rawLines),
    ...findCompletenessOnFailurePath(code, rawLines),
  ];
}

export const checks = [
  defineCheck({
    id: '3c9d21ae-7f64-4b18-9a0e-5d8c41b2e7f6',
    slug: 'error-silent-empty-result',
    // Phase A.4: ships disabled; runs only via the error-migration ratchet lane until its
    // ledger slice is closed. Enabling it today would take the dogfood gate red on the
    // existing backlog, which is how a new guardrail gets waived instead of adopted.
    disabled: true,
    description:
      'A failure path must not return an empty or partially-filled result that reads as a clean, complete pass: no accumulator returned from a swallowing catch, no fulfilled-only Promise.allSettled, no completeness stamped inside a failure branch.',
    scope: { languages: ['typescript'], concerns: [] },
    tags: ['resilience', 'error-handling', 'evidence'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeErrorSilentEmptyResult(content, filePath),
  }),
];
