/**
 * @fileoverview error-discarded-failure-detail — a `catch` block must not reduce
 *               the caught failure to a LOSSY LABEL. If the only thing the block
 *               ever reads off the binding is `error.name` (or
 *               `error.constructor.name`), then the message, the `.code`, the
 *               `.cause` chain and the stack are all gone by the time the
 *               diagnostic reaches a human — the boundary reports *that*
 *               something failed and destroys *why*. Project-local SELF-check.
 *
 * WHY THIS IS AN OPENSIP-INTERNAL RULE (and therefore lives here, not in a
 * shipped `@opensip-cli/checks-*` pack):
 *
 * opensip-cli has a first-party failure envelope. `ToolError` and its subclasses
 * carry a stable `code` (`SYSTEM.SCOPE.NOT_ENTERED`, `ENOENT`-derived classes,
 * …); `normalizeFailure` / `prepareErrorPlan` in
 * `packages/core/src/lib/failure-envelope.ts` turn a caught value into a
 * classified, exposure-tagged failure; `fromNativeError` in
 * `failure-envelope-builders.ts` maps a native `errno` onto that taxonomy. The
 * whole point of that machinery is that a failure keeps its identity all the way
 * to stderr / SARIF / the stored session. A catch that projects `error.name` and
 * nothing else opts the site OUT of the envelope: `name` is almost always the
 * useless constant `'Error'` or `'TypeError'`, `'UnknownError'` when the value
 * is not an `Error` at all — it discriminates nothing and cannot be mapped back
 * to a code. An adopter who runs `fit` on their own repo has no such envelope
 * and no such contract, so the rule is not universal — per
 * `opensip-cli/fit/checks/README.md` local-facts rules stay here as dogfood
 * (and `shipped-checks-must-be-generic` steers exactly this shape local).
 *
 * The concrete damage this guards: an intermittent, environment-dependent
 * failure (EACCES vs ENOENT vs EMFILE, an abort vs a timeout) is exactly the
 * class of bug where the errno IS the bug report. A log line that says
 * `errorName: 'Error'` is indistinguishable across all of them, and the
 * investigation has to be re-run with instrumentation that should have been
 * there the first time.
 *
 * WHAT IT FLAGS — two variants of one invariant ("the binding was in hand and
 * every bit of detail evaporated anyway"), severity-calibrated by how certain
 * the loss is:
 *
 *   1. `error` — LABEL-ONLY. The body reads `e.name` / `e.constructor.name` and
 *      nothing else. This one is airtight: `name` is a constant for a whole
 *      class of failures, so the loss is provable from the shape alone, with no
 *      judgement about intent.
 *
 *   2. `warning` — NARROWED THEN DROPPED. The body references `e` ONLY inside
 *      type/identity narrowing (`e instanceof X`, `typeof e`, `e === undefined`,
 *      `e ? … : …`) and never afterwards. The author demonstrably had a live,
 *      inspectable failure, classified it, and then let every branch — including
 *      the fall-through bucket — return or throw a value built from nothing but
 *      a literal. It is a warning rather than an error because the fall-through
 *      usually still produces a coded envelope, which is a partial (not total)
 *      mitigation: the bucket code survives, the originating detail does not.
 *
 * WHAT IT DELIBERATELY DOES **NOT** FLAG (precision is the landing bar here —
 * a check that fires on correct code gets disabled, which is worse than no
 * check):
 *   - A catch that FORWARDS the value: `throw error`, `{ cause: error }`,
 *     `reportFailure({ error })`, `normalizeFailure(error)`, `logger.error({ error })`,
 *     or any other use of the bare binding. Forwarding is the correct shape,
 *     and it stays correct even when it ALSO logs `error.name` for a metric
 *     label (see `packages/external-tool-adapter/src/run-loop-helpers.ts`, which
 *     records `detail: error.name` and then rethrows — clean by construction).
 *   - A catch that reads `.message`, `.code`, `.errno`, `.stack` or `.cause` —
 *     the detail survives, which is all this rule asks for. `error.name`
 *     ALONGSIDE `error.message` is a richer log line, not a loss (see
 *     `packages/fitness/engine/src/cli/fit-modes.ts`).
 *   - `String(error)` / `` `${error}` `` — those pass the binding whole and
 *     stringify the message with it. They may still drop a `.code`, but
 *     deciding that requires knowing whether a coded error could reach the site;
 *     that is a semantic judgement, not a syntactic one, so it is left to human
 *     review rather than guessed at here.
 *   - A bare `catch { … }` with no binding. Structurally that is a total loss,
 *     but it is also the idiomatic best-effort-cleanup form
 *     (`try { unlinkSync(p) } catch {}`) and there are ~600 of them in this
 *     tree; flagging the shape wholesale would be noise, not a signal. The
 *     narrower "bare catch that throws a replacement error with no `cause`"
 *     variant is a genuine sibling defect and belongs in its own rule with its
 *     own fixtures.
 *   - A discarding fallback in an ordinary FUNCTION (e.g. an `handleError(error)`
 *     whose default arm prints a fixed sentence). That is the same disease one
 *     frame further out, but recognising it needs call-graph reasoning; `graph`
 *     evidence is the right tool, not a text check.
 *   - Test files, fixtures, `.d.ts`, `dist/`, and non-first-party paths.
 *
 * IMPLEMENTATION NOTE — comments, strings and template literals are masked
 * (blanked in place, length- and line-preserving) BEFORE anything is scanned, so
 * (a) prose in a doc comment can never trip the rule, (b) a brace inside a
 * string can never desynchronise the catch-body brace matching, and (c) an
 * `error.message` interpolated inside `${…}` is still seen as real code. This is
 * `contentFilter: 'raw'` on purpose: the engine's own strip filters do not
 * preserve the offsets this analyzer needs.
 */
import { defineCheck, isTestFile } from '@opensip-cli/fitness';

/** Opt-out marker, consistent with the rest of the local check corpus. */
const FILE_IGNORE_RE = /@fitness-ignore-file\s+error-discarded-failure-detail/;

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'new',
  'delete',
  'void',
  'throw',
]);

/** Punctuation after which a `/` starts a regex literal. */
const REGEX_PRECEDING_PUNCT = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
]);

/** True when a `/` at this point opens a regex literal rather than dividing. */
function regexStartsHere(previousChar, previousWord) {
  if (previousChar === '') return true;
  if (/[A-Za-z0-9_$]/.test(previousChar)) return REGEX_PRECEDING_KEYWORDS.has(previousWord);
  return REGEX_PRECEDING_PUNCT.has(previousChar);
}

/** Blank one position, preserving line breaks so offsets and lines stay exact. */
function blankAt(out, k) {
  if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
}

/** Blank `// …` through end of line. Returns the next index. */
function consumeLineComment(source, out, start) {
  let i = start;
  while (i < source.length && source[i] !== '\n') {
    blankAt(out, i);
    i += 1;
  }
  return i;
}

/** Blank a `/* … *\/` comment (newlines survive). Returns the next index. */
function consumeBlockComment(source, out, start) {
  let i = start + 2;
  blankAt(out, start);
  blankAt(out, start + 1);
  while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
    blankAt(out, i);
    i += 1;
  }
  if (i >= source.length) return i;
  blankAt(out, i);
  blankAt(out, i + 1);
  return i + 2;
}

/** Blank a `'…'` / `"…"` literal body. Returns the next index. */
function consumeQuoted(source, out, start) {
  const quote = source[start];
  let i = start + 1;
  blankAt(out, start);
  while (i < source.length && source[i] !== quote && source[i] !== '\n') {
    const escaped = source[i] === '\\';
    blankAt(out, i);
    i += 1;
    if (escaped && i < source.length) {
      blankAt(out, i);
      i += 1;
    }
  }
  if (i < source.length && source[i] === quote) {
    blankAt(out, i);
    i += 1;
  }
  return i;
}

/** Blank a `/…/flags` regex literal. Returns the next index. */
function consumeRegex(source, out, start) {
  let i = start + 1;
  let inCharClass = false;
  blankAt(out, start);
  while (i < source.length && source[i] !== '\n') {
    const c = source[i];
    if (c === '\\') {
      blankAt(out, i);
      blankAt(out, i + 1);
      i += 2;
      continue;
    }
    if (c === '[') inCharClass = true;
    else if (c === ']') inCharClass = false;
    blankAt(out, i);
    i += 1;
    if (c === '/' && !inCharClass) break;
  }
  while (i < source.length && /[dgimsuvy]/.test(source[i])) {
    blankAt(out, i);
    i += 1;
  }
  return i;
}

/**
 * One step inside template TEXT. Blanks the literal chunk, closes on a backtick,
 * and on `${` blanks only the `$` — the `{` stays so brace depth remains
 * balanced and the interpolated expression is scanned as ordinary code.
 */
function stepTemplateText(source, out, i, stack) {
  const c = source[i];
  if (c === '\\') {
    blankAt(out, i);
    blankAt(out, i + 1);
    return i + 2;
  }
  blankAt(out, i);
  if (c === '`') {
    stack.pop();
    return i + 1;
  }
  if (c === '$' && source[i + 1] === '{') {
    stack.push('expr');
    return i + 2;
  }
  return i + 1;
}

/** One step in code context. Returns the next index. */
function stepCode(source, out, i, stack, cursor) {
  const c = source[i];
  const d = source[i + 1];
  if (c === '/' && d === '/') return consumeLineComment(source, out, i);
  if (c === '/' && d === '*') return consumeBlockComment(source, out, i);
  if (c === "'" || c === '"') {
    cursor.previousChar = 'x';
    cursor.previousWord = '';
    return consumeQuoted(source, out, i);
  }
  if (c === '`') {
    blankAt(out, i);
    stack.push('tpl');
    return i + 1;
  }
  if (c === '/' && regexStartsHere(cursor.previousChar, cursor.previousWord)) {
    cursor.previousChar = 'x';
    cursor.previousWord = '';
    return consumeRegex(source, out, i);
  }
  if (c === '{' || c === '}') {
    // A `}` popping an 'expr' frame returns the scanner to template text.
    if (c === '{') stack.push('brace');
    else stack.pop();
    cursor.previousChar = c;
    cursor.previousWord = '';
    return i + 1;
  }
  if (!/\s/.test(c)) {
    cursor.previousChar = c;
    cursor.previousWord = /[A-Za-z0-9_$]/.test(c) ? cursor.previousWord + c : '';
  }
  return i + 1;
}

/**
 * Blank every comment body, string body and template-literal chunk, in place.
 * Length and newlines are preserved so offsets/line numbers stay exact, and
 * `${…}` interpolations are KEPT as code (their braces stay balanced), so an
 * `error.message` inside a template is still visible to the scanner.
 */
export function maskLiteralsAndComments(source) {
  // `split('')` (UTF-16 code units), NOT `[...source]` (code points): every index
  // in this analyzer comes from `String#matchAll` / `String#indexOf`, which are
  // UTF-16 based. Splitting by code point would shift every offset after the
  // first astral character (the emoji in the checks-* `display/` tables are real
  // instances) and silently desynchronise both the line numbers and the
  // catch-body brace matching.
  const out = source.split('');
  // Context stack: 'tpl' = template text, 'expr' = inside `${…}`, 'brace' = an
  // ordinary `{…}`. The top of the stack decides which stepper runs.
  const stack = [];
  const cursor = { previousChar: '', previousWord: '' };
  let i = 0;
  while (i < source.length) {
    i =
      stack.at(-1) === 'tpl'
        ? stepTemplateText(source, out, i, stack)
        : stepCode(source, out, i, stack, cursor);
  }
  return out.join('');
}

/** Index of the `}` closing the `{` at `open`, or -1. Masked input only. */
function matchBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** A plain identifier — the only catch parameter this rule can trace. */
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The binding name of a catch parameter, or `undefined` when there is none to
 * trace. Accepts the TypeScript annotation the language permits there
 * (`catch (e: unknown)`) by taking the text before the `:`. A DESTRUCTURED
 * parameter (`catch ({ code })`) yields `undefined`: it has no single binding,
 * and destructuring is already a deliberate statement about which detail to
 * keep. Split rather than matched, so no regex backtracks over the annotation.
 */
function catchBindingOf(parameterText) {
  const head = parameterText.split(':', 1)[0].trim();
  return IDENTIFIER_RE.test(head) ? head : undefined;
}

/** Advance past whitespace from `i`. */
function skipWhitespace(masked, i) {
  let k = i;
  while (k < masked.length && /\s/.test(masked[k])) k += 1;
  return k;
}

/** Parse one `catch` occurrence into a block, or `undefined` if it is not one. */
function parseCatchBlock(masked, keywordIndex) {
  const parenOpen = skipWhitespace(masked, keywordIndex + 'catch'.length);
  if (masked[parenOpen] !== '(') return;
  const parenClose = masked.indexOf(')', parenOpen);
  if (parenClose === -1) return;
  const binding = catchBindingOf(masked.slice(parenOpen + 1, parenClose));
  if (binding === undefined) return;
  const braceOpen = skipWhitespace(masked, parenClose + 1);
  if (masked[braceOpen] !== '{') return;
  const bodyEnd = matchBrace(masked, braceOpen);
  if (bodyEnd === -1) return;
  return { binding, bodyStart: braceOpen + 1, bodyEnd, keywordIndex };
}

/**
 * Every `catch (binding) { … }` in the masked source. Bare `catch { … }` and
 * destructured bindings are skipped (see the @fileoverview for why).
 */
function findBoundCatchBlocks(masked) {
  const blocks = [];
  for (const match of masked.matchAll(/\bcatch\b/g)) {
    const block = parseCatchBlock(masked, match.index ?? 0);
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

/** `.name` / `.constructor.name` — a label, not a failure detail. */
const LOSSY_PROJECTION_RE = /^\s*(?:\?\.|\.)\s*(?:name\b|constructor\s*(?:\?\.|\.)\s*name\b)/;

/**
 * A use of the binding that inspects its TYPE or identity without carrying any
 * detail forward: `e instanceof X`, `typeof e`, `e === undefined`, `e ? a : b`.
 * Narrowing alone neither preserves nor destroys the detail — it only proves the
 * value was live and inspectable at this point (which is what makes variant 2
 * meaningful when nothing else ever reads it).
 */
function isTypeOrIdentityTest(body, start, end) {
  const before = body.slice(Math.max(0, start - 24), start);
  const after = body.slice(end, end + 24);
  if (/\b(?:typeof|instanceof)\s*$/.test(before)) return true;
  if (/^\s*instanceof\b/.test(after)) return true;
  if (/(?:===|!==|==|!=)\s*$/.test(before)) return true;
  if (/^\s*(?:===|!==|==|!=)/.test(after)) return true;
  if (/^\s*\?(?!\.)/.test(after)) return true; // `e ? … : …` truthiness test
  return false;
}

/**
 * Classify one catch block:
 *   `'label-only'`      — the binding is read only through `.name` (variant 1)
 *   `'narrowed-only'`   — the binding is read only inside type/identity tests,
 *                         and it IS read at least once (variant 2)
 *   `'preserving'`      — some use carries the detail forward: clean
 *   `'unreferenced'`    — the binding is never mentioned; the `catch {}` family,
 *                         deliberately out of scope (see the @fileoverview)
 */
function classifyCatchBody(body, binding) {
  const references = [...body.matchAll(new RegExp(`\\b${binding}\\b`, 'g'))];
  if (references.length === 0) return 'unreferenced';
  let lossy = 0;
  let narrowing = 0;
  for (const reference of references) {
    const start = reference.index ?? 0;
    const end = start + binding.length;
    if (LOSSY_PROJECTION_RE.test(body.slice(end, end + 40))) {
      lossy += 1;
      continue;
    }
    if (isTypeOrIdentityTest(body, start, end)) {
      narrowing += 1;
      continue;
    }
    return 'preserving';
  }
  if (lossy > 0) return 'label-only';
  return narrowing > 0 ? 'narrowed-only' : 'unreferenced';
}

/** Per-variant finding text. Keeps the analyzer body free of prose. */
const VARIANTS = {
  'label-only': (binding) => ({
    severity: 'error',
    message:
      `This catch reduces the failure to a label: \`${binding}.name\` is the only thing read off ` +
      `\`${binding}\`, so the message, the \`.code\`, the \`.cause\` chain and the stack are ` +
      'discarded at this boundary. `name` is almost always the constant "Error" (or ' +
      '"UnknownError" for a non-Error value), so the diagnostic cannot distinguish ENOENT from ' +
      'EACCES from an abort — precisely the failures where the detail IS the bug report.',
    suggestion:
      `Carry the failure forward instead of labelling it: rethrow (\`throw ${binding}\`), attach ` +
      `it (\`{ cause: ${binding} }\`), normalize it through the failure envelope, or at minimum ` +
      `log \`${binding}.message\` and any \`.code\` alongside the name. Keeping \`.name\` as an ` +
      'extra metric label is fine once the detail also escapes.',
  }),
  'narrowed-only': (binding) => ({
    severity: 'warning',
    message:
      `This catch narrows \`${binding}\` (instanceof / typeof / identity test) and then never ` +
      'reads it again, so every branch — including the unclassified fall-through — reports a ' +
      'value built entirely from literals. The originating message, `.code` and `.cause` are ' +
      'dropped while the binding was still in hand: an unexpected EACCES, a corrupt input and an ' +
      'out-of-memory all collapse into the same generic outcome.',
    suggestion:
      `Give the fall-through the detail it is missing: attach the original (\`{ cause: ` +
      `${binding} }\`), include \`${binding}.message\` / any \`.code\` in the reported failure, ` +
      `or rethrow (\`throw ${binding}\`) once the branches you DO classify have returned. ` +
      'Narrowing a failure is not the same as explaining it.',
  }),
};

/**
 * First-party production TypeScript only.
 *
 * `.tsx` is deliberately EXCLUDED. In JSX a `</Close>` tag is indistinguishable
 * from the start of a regex literal by the lexical heuristic this masker uses,
 * so the mask (and therefore the catch-body brace matching) is not trustworthy
 * there. An unreliable mask produces unreliable findings, and this rule would
 * rather miss a `.tsx` site than report a fabricated one — the Ink view layer is
 * also not where failure boundaries live.
 */
function isInScope(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (!normalized.endsWith('.ts') || normalized.endsWith('.d.ts')) return false;
  if (isTestFile(normalized)) return false;
  if (
    normalized.includes('/node_modules/') ||
    normalized.includes('/dist/') ||
    normalized.includes('/coverage/') ||
    normalized.includes('/__tests__/') ||
    normalized.includes('/__fixtures__/') ||
    normalized.includes('/fixtures/') ||
    normalized.includes('/test-support/')
  ) {
    return false;
  }
  return normalized.includes('/packages/') || normalized.startsWith('packages/');
}

/** Pure analysis. Exported so a harness (or another check) can exercise it directly. */
export function analyzeErrorDiscardedFailureDetail(content, filePath) {
  if (!isInScope(filePath)) return [];
  if (!content.includes('catch')) return [];
  if (content.split('\n', 60).some((line) => FILE_IGNORE_RE.test(line))) return [];

  const masked = maskLiteralsAndComments(content);
  const violations = [];
  for (const block of findBoundCatchBlocks(masked)) {
    const body = masked.slice(block.bodyStart, block.bodyEnd);
    const variant = VARIANTS[classifyCatchBody(body, block.binding)];
    if (variant === undefined) continue;
    const before = content.slice(0, block.keywordIndex);
    violations.push({
      line: before.split('\n').length,
      column: block.keywordIndex - (before.lastIndexOf('\n') + 1) + 1,
      ...variant(block.binding),
      type: 'error-discarded-failure-detail',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '3f2a7c14-6d58-4b0e-9c31-8ae5d6b40f27',
    slug: 'error-discarded-failure-detail',
    // Phase A.4: ships disabled; runs only via the error-migration ratchet lane until its
    // ledger slice is closed. Enabling it today would take the dogfood gate red on the
    // existing backlog, which is how a new guardrail gets waived instead of adopted.
    disabled: true,
    description:
      'A catch block must not reduce the caught failure to `error.name` alone — the message, `.code`, `.cause` and stack are discarded at the boundary. Forwarding the error (rethrow / `cause` / failure envelope) or logging `.message`/`.code` alongside the name is clean.',
    scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
    tags: ['resilience', 'errors', 'observability'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeErrorDiscardedFailureDetail(content, filePath),
  }),
];
