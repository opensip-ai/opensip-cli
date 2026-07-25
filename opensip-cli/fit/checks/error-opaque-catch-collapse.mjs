/**
 * @fileoverview error-opaque-catch-collapse — a `catch` that throws the caught
 *               value away and collapses every distinct failure into ONE opaque
 *               outcome (a constant flag/placeholder, or a bare `continue` /
 *               `break`) must observe the error or carry an explicit swallow
 *               marker. Project-local SELF-check for opensip-cli.
 *
 * WHY THIS IS OPENSIP-INTERNAL (and therefore lives here, not in a shipped
 * `@opensip-cli/checks-*` pack):
 *
 *   1. It mechanizes THIS repo's written standard. `docs/public/80-implementation/
 *      04-coding-standards.md` says a discarded failure must be propagated,
 *      logged, routed through `unwrapOrLog`/`matchLog`, or **marked**
 *      `// @swallow-ok <reason>`. That marker vocabulary is an opensip-cli
 *      convention; an adopter repo has no such marker, so the rule would fire
 *      indiscriminately there and the escape hatch would not exist.
 *   2. It is deliberately shaped around THIS repo's existing check inventory.
 *      The shipped `error-handling-quality` (checks-typescript) already owns two
 *      catch shapes: the fully EMPTY catch, and a `return` of one of its five
 *      sentinels (`null` / `undefined` / `false` / `[]` / `{}`, including a bare
 *      `return;`). Knowing that inventory — and refusing to double-report the
 *      same catch clause — is a local fact about opensip-cli, not a universal
 *      rule. Per `opensip-cli/fit/checks/README.md`, "local facts" checks belong
 *      here as dogfood, and `shipped-checks-must-be-generic` steers them here.
 *
 * WHAT IT FORBIDS — a `catch` clause that (a) DISCARDS the caught value (a bare
 * `catch {`, or a bound `catch (error) {` whose body never mentions the
 * binding), AND (b) whose ENTIRE body is one of these two reason-erasing
 * collapses:
 *
 *   - `state`        — every statement assigns a compile-time CONSTANT to an
 *                      lvalue (`this.failed = true`, `complete = false`,
 *                      `symbol = undefined`, `message = '<unstringifiable>'`).
 *                      The catch records "something broke" and erases WHICH
 *                      thing broke: a missing file (ENOENT), a permission
 *                      denial (EACCES), an aborted run, and a genuine
 *                      programmer error (a TypeError from a refactor) all leave
 *                      exactly the same one-bit trace.
 *   - `control-flow` — the body is only `continue` / `break`. The failing unit
 *                      is silently skipped; the caller cannot tell an
 *                      unreadable input apart from a bug in the reader, and the
 *                      run still reports success over an incomplete inventory.
 *
 * WHAT IT DELIBERATELY DOES **NOT** FLAG:
 *
 *   - A catch that RETHROWS, or that INSPECTS the error (`instanceof`, `.code`,
 *     `.name`), or LOGS it with the value, or wraps it in a typed error.
 *     Structurally impossible to reach: the body grammar below is an ALLOW-list
 *     admitting only constant assignments and `continue`/`break`, so any
 *     reference to the caught value, any call, and any `throw` disqualifies the
 *     clause outright. Precision over recall, on purpose.
 *   - An EMPTY catch, or a catch whose body returns one of the five
 *     `error-handling-quality` sentinels. Those clauses are already reported by
 *     the shipped check; re-reporting them here would double-count one defect
 *     and put two checks in a waiver tug-of-war. If ANY statement in the body is
 *     such a return, the whole clause is ceded to the shipped engine.
 *   - A `return` of some other constant (`return 'unknown'`, `return true`).
 *     Dropped on purpose after reading real sites: `catch { return
 *     '<unstringifiable>'; }` in `failure-envelope.ts` NAMES its outcome rather
 *     than erasing it, and `catch { return true; }` inside a Zod `.refine()` is
 *     a parse-as-predicate idiom. Both are defensible as correct, so the arm was
 *     cut rather than shipped as a coin-flip.
 *   - A clause carrying an explicit swallow marker in its own text:
 *     `@swallow-ok`, `@handles`, `// intentionally …`, `// expected …`. This is
 *     the SAME vocabulary `error-handling-quality` accepts — one repo, one
 *     marker vocabulary. A site the maintainers already annotated as deliberate
 *     is never re-litigated here.
 *   - Test files, fixtures, generated `.d.ts`, and build output.
 *
 * COMMENTS AND LITERALS ARE BLANKED BEFORE STRUCTURAL SCANNING (offsets and
 * newlines preserved, so line numbers stay exact). Documentation prose that
 * merely *describes* the pattern — including this header — can therefore never
 * trip the rule, and a brace or quote inside a string or regex literal cannot
 * desynchronize the brace matcher. The swallow-marker lookup deliberately runs
 * against the RAW text, because the marker lives inside a comment.
 *
 * FIX: keep the failure distinguishable. Bind the error and route it —
 * `logger.warn({ evt: 'x.failed', err })` before the fallback, a typed
 * `createToolError(...)` carrying `cause`, an accumulated reason on the result —
 * or, when the degradation really is a best-effort probe, say so at the site
 * with `// @swallow-ok <reason>`.
 */
import { defineCheck, isTestFile } from '@opensip-cli/fitness';

// =============================================================================
// Source blanking (offset- and line-preserving)
// =============================================================================

/** Overwrite `[from, to)` with spaces, leaving newlines intact. */
function blankRange(chars, from, to) {
  for (let k = from; k < to && k < chars.length; k += 1) {
    if (chars[k] !== '\n') chars[k] = ' ';
  }
}

/** Index of the newline (or EOF) that ends a `//` comment starting at `start`. */
function endOfLineComment(source, start) {
  let j = start + 2;
  while (j < source.length && source[j] !== '\n') j += 1;
  return j;
}

/** Index just past the delimiter that closes a block comment starting at `start`. */
function endOfBlockComment(source, start) {
  let j = start + 2;
  while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j += 1;
  return Math.min(j + 2, source.length);
}

/** Index of the closing quote (or of the line break / EOF that aborts it). */
function endOfQuoted(source, start, quote) {
  let j = start + 1;
  while (j < source.length) {
    if (source[j] === '\\') {
      j += 2;
      continue;
    }
    if (source[j] === quote || source[j] === '\n') break;
    j += 1;
  }
  return j;
}

/**
 * Index of the backtick closing a template literal. `${…}` expressions are
 * counted (so a brace inside them cannot end the scan early) but are blanked
 * along with the text: a `catch` clause cannot appear in a template expression
 * without an intervening function body, and losing that vanishingly rare site is
 * the right trade for never mis-parsing nested interpolation.
 */
function endOfTemplate(source, start) {
  let j = start + 1;
  let expressionDepth = 0;
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (expressionDepth === 0 && c === '`') break;
    if (expressionDepth === 0 && c === '$' && source[j + 1] === '{') {
      expressionDepth = 1;
      j += 2;
      continue;
    }
    if (expressionDepth > 0 && c === '{') expressionDepth += 1;
    if (expressionDepth > 0 && c === '}') expressionDepth -= 1;
    j += 1;
  }
  return j;
}

/** Index of the `/` closing a regex literal, or -1 when this `/` is division. */
function endOfRegex(source, start) {
  let j = start + 1;
  let inCharacterClass = false;
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '\n') return -1;
    if (c === '[') inCharacterClass = true;
    else if (c === ']') inCharacterClass = false;
    else if (c === '/' && !inCharacterClass) return j;
    j += 1;
  }
  return -1;
}

/** Characters after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%~^<>]/u;
const WHITESPACE = /\s/u;

/**
 * Advance past a comment/string/template/regex at `i`, blanking its content.
 * Returns `false` when `i` is an ordinary code character.
 */
function blankLiteralAt(source, chars, i, previousSignificant) {
  const c = source[i];
  const next = source[i + 1];
  if (c === '/' && next === '/') {
    const end = endOfLineComment(source, i);
    blankRange(chars, i, end);
    return { next: end, significant: previousSignificant };
  }
  if (c === '/' && next === '*') {
    const end = endOfBlockComment(source, i);
    blankRange(chars, i, end);
    return { next: end, significant: previousSignificant };
  }
  if (c === '"' || c === "'") {
    const end = endOfQuoted(source, i, c);
    blankRange(chars, i + 1, end);
    return { next: source[end] === c ? end + 1 : end, significant: c };
  }
  if (c === '`') {
    const end = endOfTemplate(source, i);
    blankRange(chars, i + 1, end);
    return { next: end + 1, significant: '`' };
  }
  if (c === '/' && REGEX_PRECEDER.test(previousSignificant)) {
    const end = endOfRegex(source, i);
    if (end !== -1) {
      blankRange(chars, i + 1, end);
      return { next: end + 1, significant: '/' };
    }
  }
  return false;
}

/**
 * Replace the CONTENT of comments, string literals, template literals and regex
 * literals with spaces, preserving every offset and newline. Structural scanning
 * then sees only real code, so prose that names the pattern cannot produce a
 * finding and a brace inside a literal cannot desynchronize brace matching.
 */
function blankNonCode(source) {
  const chars = [...source];
  let i = 0;
  // Last significant (non-whitespace) code character — decides `/` disambiguation.
  let previousSignificant = '(';

  while (i < source.length) {
    const skipped = blankLiteralAt(source, chars, i, previousSignificant);
    if (skipped) {
      i = skipped.next;
      previousSignificant = skipped.significant;
      continue;
    }
    if (!WHITESPACE.test(source[i])) previousSignificant = source[i];
    i += 1;
  }
  return chars.join('');
}

// =============================================================================
// Body classification
// =============================================================================

/**
 * The whole vocabulary an opaque collapse can assign, compared with whitespace
 * removed. String literals arrive here already blanked (`'   '`), so their
 * CONTENT is deliberately irrelevant — only the literal shape matters.
 */
const CONSTANT_KEYWORDS = new Set([
  'null',
  'undefined',
  'void0',
  'false',
  'true',
  'NaN',
  '[]',
  '{}',
]);
/** Sentinels the shipped `error-handling-quality` check reports on `return`. */
const SHIPPED_RETURN_SENTINELS = new Set(['', 'null', 'undefined', 'void0', 'false', '[]', '{}']);

const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?$/u;
/** `x`, `this.x`, `a.b.c`, `map['k']` — an assignment target; nothing callable. */
const LVALUE = /^[A-Za-z_$][\w$.'"[\]]*$/u;
const LOOP_COLLAPSE = /^(?:continue|break)(?:\s+[A-Za-z_$][\w$]*)?$/u;
const ALL_WHITESPACE = /\s+/gu;
const WORD_CHARACTER = /[\w$]/u;
/** Characters that turn a following `=` into a comparison or compound assign. */
const NON_ASSIGNMENT_PREFIX = new Set(['=', '!', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^']);

/**
 * Explicit "this swallow is deliberate" annotations. Identical to the vocabulary
 * the shipped `error-handling-quality` check honors — one repo, one marker set,
 * so an already-annotated site is never re-litigated here.
 */
const SWALLOW_MARKERS = [/@swallow-ok/, /@handles/, /\/\/\s*intentionally/i, /\/\/\s*expected/i];

/**
 * True for a single quoted string literal. Deliberately NOT a regex: an anchored
 * `^'[^']*'$` trips the repo's super-linear-regex gate, and string scanning is
 * both cheaper and clearer. Literal CONTENT is already blanked to spaces, so
 * only the delimiter shape can be — and needs to be — inspected.
 */
function isQuotedLiteral(text) {
  const quote = text[0];
  if (quote !== "'" && quote !== '"') return false;
  if (text.length < 2 || text.at(-1) !== quote) return false;
  return !text.slice(1, -1).includes(quote);
}

/** True for a compile-time constant expression (whitespace-insensitive). */
function isConstantExpression(text) {
  const compact = text.replaceAll(ALL_WHITESPACE, '');
  if (CONSTANT_KEYWORDS.has(compact)) return true;
  if (NUMBER_LITERAL.test(compact)) return true;
  return isQuotedLiteral(text.trim());
}

/**
 * Split `<lvalue> = <expression>` at its assignment operator. Hand-parsed rather
 * than matched: an `\s*=(?!=)\s*(.+)` regex is ambiguous (both sides can absorb
 * whitespace) and trips the repo's super-linear-regex gate. Compound (`+=`) and
 * comparison (`===`, `!==`, `<=`, `=>`) operators are rejected here.
 */
function splitAssignment(statement) {
  for (let i = 1; i < statement.length; i += 1) {
    if (statement[i] !== '=') continue;
    if (statement[i + 1] === '=') return false;
    if (NON_ASSIGNMENT_PREFIX.has(statement[i - 1])) return false;
    return {
      target: statement.slice(0, i).trim(),
      value: statement.slice(i + 1).trim(),
    };
  }
  return false;
}

/**
 * The expression a `return` statement yields (`''` for a bare `return;`), or
 * `false` when the statement is not a return at all.
 */
function returnedExpression(statement) {
  if (!statement.startsWith('return')) return false;
  const rest = statement.slice('return'.length);
  // `returnValue = 1` is an assignment, not a return.
  if (rest.length > 0 && WORD_CHARACTER.test(rest[0])) return false;
  return rest.replaceAll(ALL_WHITESPACE, '');
}

/**
 * Classify one statement of a blanked catch body.
 *
 * `shipped` means the clause belongs to `error-handling-quality`; `other` means
 * the statement is anything richer than a collapse (a call, a throw, an `if`, a
 * reference to the caught value) and disqualifies the clause.
 */
function classifyStatement(statement) {
  if (LOOP_COLLAPSE.test(statement)) return 'control-flow';

  const returned = returnedExpression(statement);
  if (returned !== false) {
    return SHIPPED_RETURN_SENTINELS.has(returned) ? 'shipped' : 'other';
  }

  const assigned = splitAssignment(statement);
  if (assigned !== false && LVALUE.test(assigned.target) && isConstantExpression(assigned.value)) {
    return 'state';
  }

  return 'other';
}

/**
 * Classify a blanked catch body. Returns the collapse kind, or `undefined` when
 * the clause is not an opaque collapse this check owns (including the empty
 * catch, which the shipped `error-handling-quality` check reports).
 */
function classifyCollapse(body) {
  const statements = body
    .split(/[;\n]/u)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  if (statements.length === 0) return;

  let kind;
  for (const statement of statements) {
    const statementKind = classifyStatement(statement);
    if (statementKind === 'other' || statementKind === 'shipped') return;
    // A constant assignment is the stronger signal, so it wins the label.
    if (statementKind === 'state') kind = 'state';
    else kind ??= statementKind;
  }
  return kind;
}

// =============================================================================
// Catch-clause discovery
// =============================================================================

const CATCH_KEYWORD = /\bcatch\b/gu;
const BINDING_NAME = /^\s*([A-Za-z_$][\w$]*)/u;

/** Index of the first non-whitespace character at or after `from`. */
function skipWhitespace(code, from) {
  let i = from;
  while (i < code.length && WHITESPACE.test(code[i])) i += 1;
  return i;
}

/** Index just past the delimiter matching the opener at `open`, or -1. */
function matchDelimiter(code, open, opener, closer) {
  let depth = 1;
  let i = open + 1;
  while (i < code.length && depth > 0) {
    if (code[i] === opener) depth += 1;
    else if (code[i] === closer) depth -= 1;
    i += 1;
  }
  return depth === 0 ? i : -1;
}

/**
 * Read the `catch` clause whose keyword ends at `afterKeyword`, or `undefined`
 * when this `catch` is not a clause at all — notably a promise
 * `.catch((e) => { … })`, where the `=>` breaks `)` → `{` adjacency.
 */
function readCatchClause(code, afterKeyword) {
  let cursor = skipWhitespace(code, afterKeyword);
  let binding;
  if (code[cursor] === '(') {
    const afterParen = matchDelimiter(code, cursor, '(', ')');
    if (afterParen === -1) return;
    binding = BINDING_NAME.exec(code.slice(cursor + 1, afterParen - 1))?.[1];
    cursor = skipWhitespace(code, afterParen);
  }
  if (code[cursor] !== '{') return;
  const afterBlock = matchDelimiter(code, cursor, '{', '}');
  if (afterBlock === -1) return;
  return {
    binding,
    body: code.slice(cursor + 1, afterBlock - 1),
    end: afterBlock,
  };
}

// =============================================================================
// Check
// =============================================================================

const EXCLUDED_SEGMENTS = [
  '/node_modules/',
  '/dist/',
  '/coverage/',
  '/__fixtures__/',
  '/fixtures/',
  '/__tests__/',
];

/** Skip generated output, tests, and fixture corpora. */
function isScannableSource(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.endsWith('.d.ts')) return false;
  if (EXCLUDED_SEGMENTS.some((segment) => normalized.includes(segment))) return false;
  return !isTestFile(filePath);
}

const COLLAPSE_DETAIL = {
  state: 'the body only assigns constants, so every distinct failure leaves the same one-bit trace',
  'control-flow':
    'the body only skips the unit (continue/break), so an unreadable input and a bug in the reader are indistinguishable',
};

const SUGGESTION =
  'Bind the error and keep it distinguishable: log it with the value ' +
  "(`logger.warn({ evt: 'x.failed', err })`), inspect it (`instanceof` / `.code`), wrap it in a " +
  'typed error with `cause`, or — when the degradation really is a best-effort probe — annotate ' +
  'the site `// @swallow-ok <reason>`.';

/**
 * Pure analysis over RAW file content. Exported so the pattern can be exercised
 * directly (fixtures, ad-hoc verification) without standing up the framework.
 */
export function analyzeErrorOpaqueCatchCollapse(content, filePath) {
  const violations = [];
  if (!isScannableSource(filePath)) return violations;
  if (!content.includes('catch')) return violations;

  const code = blankNonCode(content);
  const keyword = new RegExp(CATCH_KEYWORD.source, CATCH_KEYWORD.flags);

  let match;
  while ((match = keyword.exec(code)) !== null) {
    const clause = readCatchClause(code, match.index + match[0].length);
    if (!clause) continue;

    // A bound-and-USED error is observed, not discarded.
    const usesBinding =
      clause.binding !== undefined &&
      new RegExp(String.raw`\b${clause.binding}\b`, 'u').test(clause.body);
    if (usesBinding) continue;

    const kind = classifyCollapse(clause.body);
    if (kind === undefined) continue;

    // Marker lookup runs on RAW text (markers live in comments), over the clause
    // region: the `catch` line through the closing brace.
    const rawRegion = content.slice(content.lastIndexOf('\n', match.index) + 1, clause.end);
    if (SWALLOW_MARKERS.some((marker) => marker.test(rawRegion))) continue;

    const before = content.slice(0, match.index);
    violations.push({
      line: before.split('\n').length,
      column: before.length - before.lastIndexOf('\n'),
      severity: 'warning',
      type: `opaque-catch-${kind}-collapse`,
      message:
        'This catch discards the caught value and collapses every failure into one opaque outcome — ' +
        `${COLLAPSE_DETAIL[kind]}. An I/O fault, an aborted run, and a programmer error become the same non-event.`,
      suggestion: SUGGESTION,
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '0c84bd14-f407-46dd-9b53-796f0e2f5070',
    slug: 'error-opaque-catch-collapse',
    // Phase A.4: ships disabled; runs only via the error-migration ratchet lane until its
    // ledger slice is closed. Enabling it today would take the dogfood gate red on the
    // existing backlog, which is how a new guardrail gets waived instead of adopted.
    disabled: true,
    description:
      'A catch that discards the caught value and collapses every failure into one opaque outcome (constant-only assignments, or a bare continue/break) must observe the error or carry an explicit @swallow-ok marker',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['resilience', 'errors', 'observability'],
    fileTypes: ['ts', 'tsx'],
    // RAW on purpose: the analyzer does its own offset-preserving blanking for
    // structural scanning, but the `@swallow-ok` marker lookup must see the
    // original comment text.
    contentFilter: 'raw',
    confidence: 'high',
    analyze: (content, filePath) => analyzeErrorOpaqueCatchCollapse(content, filePath),
  }),
];
