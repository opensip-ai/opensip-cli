/**
 * @fileoverview error-floating-async-operation — a promise that is deliberately
 *               DETACHED (started in statement position, with or without a
 *               `void` marker) must carry a rejection handler. Project-local
 *               SELF-check for opensip-cli.
 *
 * ## What it forbids
 *
 * Two shapes, both of which start an async operation and then drop the only
 * handle that could ever observe its failure:
 *
 *   R1 — a detached thenable chain with no rejection arm:
 *          `void p.then(() => { … });`
 *          `p.then(onFulfilled);`
 *        The `.then(` token is itself the proof that the receiver is a thenable
 *        — no type inference is needed. A chain that terminates in `.catch(…)`
 *        (anywhere) or supplies the two-argument `.then(onFulfilled, onRejected)`
 *        form is handled and is NOT flagged. `.finally(…)` does not count: it
 *        re-throws.
 *
 *   R2 — `void someAsyncCall();` where `someAsyncCall` is PROVABLY async in the
 *        same file (`async function f`, `const f = async …`, `async f(…)` class
 *        or object method, or an explicit `f(…): Promise<…>` annotation) and the
 *        statement carries no rejection handler.
 *
 * ## Why `void` is not a defence (the core of the rule)
 *
 * `void expr` IS this repo's deliberate fire-and-forget marker, and it is
 * respected as such — this check never complains that the *value* was
 * discarded. But `void` disclaims the value, not the REJECTION. The promise is
 * still live; when it rejects there is no handler, so under Node's default
 * `--unhandled-rejections=throw` mode the process dies. In a CLI that is the
 * worst possible failure mode: the run terminates outside the diagnosed-failure
 * path, so the host never renders a `status:'error'` outcome and never sets the
 * documented exit code (ADR-0020/ADR-0035) — the caller sees a bare crash where
 * the contract promised a structured signal. The confirmed sites this rule was
 * derived from are exactly that: settlement/cleanup work that is detached on
 * purpose but whose failure has no reporting path at all.
 *
 * ## Why this is opensip-cli-LOCAL and not a shipped pack rule
 *
 * The shipped `@opensip-cli/checks-typescript` sibling `detached-promises`
 * covers the neighbouring-but-DISJOINT case — an unmarked, un-awaited
 * promise-returning call inside an async function — and it explicitly returns
 * early on BOTH shapes this check owns: it skips every `VoidExpression`
 * statement, and `hasPromiseChainHandling` skips every statement whose
 * top-level call is `.then` / `.catch` / `.finally`. Its own suggestion string
 * even tells the author to "use void with error handling if intentionally
 * fire-and-forget" — but nothing verifies the "with error handling" half. This
 * check is that verification, and nothing else.
 *
 * It stays project-local because the *severity argument* above is an
 * opensip-cli fact, not a universal one: it is grounded in this repo's
 * host-owned outcome/exit-code contract and its last-resort failure net. An
 * adopter with a long-running server may legitimately run a detached
 * `void p.then(...)` under a process-level `unhandledRejection` handler. Per
 * `opensip-cli/fit/checks/README.md`, a rule whose justification depends on
 * local facts belongs HERE rather than in a shipped pack (the boundary
 * `shipped-checks-must-be-generic` enforces). If it is ever generalized, the
 * promotion path is the first-party `resilience/` category next to
 * `detached-promises`.
 *
 * ## What it deliberately does NOT flag
 *
 * - `await p…`, `return p…`, `const x = p…`, `p` passed as a call argument, an
 *   array element, an object-property value, or a concise arrow body. In every
 *   one of those the promise has an owner; whether that owner handles the
 *   rejection is a different (interprocedural) question this check does not ask.
 * - Any chain containing `.catch(` or a two-argument `.then(…, …)`. Whether the
 *   handler is *adequate* (a swallowing `.catch(() => {})` is its own defect
 *   class) is deliberately out of scope — that is a judgement call, and mixing
 *   it in here would cost the precision that makes this rule enforceable.
 * - `void <call>()` whose callee cannot be proven async FROM THE SAME FILE. No
 *   type inference, no cross-file resolution, no name heuristics — an
 *   unprovable callee is simply not this check's business. That is why R2 is
 *   narrow by construction.
 * - Bare `void someIdentifier;` (discarding a variable, e.g. `void closeError;`
 *   to satisfy no-unused rules) — there is no call, so nothing was started.
 * - Test files, fixtures, `.d.ts` declarations.
 *
 * ## Content handling
 *
 * The analyzer runs on `stripStringsAndCommentsPreservingPositions(content)`:
 * comment prose and string-literal bodies are blanked (positions preserved), so
 * documentation that *describes* `void p.then(...)` — including this header —
 * can never trip the gate, and a `';'` or `'{'` inside a literal cannot break
 * the balanced-delimiter scan. `contentFilter` is left at `raw` because the
 * analyzer does its own position-preserving pass and needs real line numbers.
 */
import { defineCheck, stripStringsAndCommentsPreservingPositions } from '@opensip-cli/fitness';

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

/** Test / fixture / declaration files are not production async paths. */
const NON_PRODUCTION_PATH_RE =
  /(?:\.test\.[cm]?tsx?$|\.d\.ts$|\/__tests__\/|\/__fixtures__\/|\/fixtures?\/|\/test-support\/|\/dist\/)/;

/**
 * This check's OWN synthetic pass/fail tree stays analyzable (same carve-out
 * `no-module-singleton.mjs` uses) so `fit --config …/fit.fixture.config.yml`
 * can exercise the rule. The repo-level `globalExcludes` keeps `__fixtures__`
 * out of the normal gate, so this does not add findings to `pnpm fit`.
 */
const SELF_FIXTURE_PATH_RE =
  /opensip-cli\/fit\/checks\/__fixtures__\/error-floating-async-operation\//;

/**
 * Leading keywords that prove the expression is NOT detached — someone owns the
 * promise (awaited it, returned it, bound it, threw it). `void` is absent on
 * purpose: `void` is the marker this check exists to look past.
 */
const OWNED_STATEMENT_RE =
  /^(?:return|await|yield|throw|export|import|const|let|var|case|default|new|typeof|delete)\b/;

/**
 * Names this file declares `async` (or annotates `: Promise<…>`). Deliberately
 * in-file only: proving asyncness across module boundaries needs a type checker,
 * and guessing from a name is how a resilience rule earns a reputation for false
 * positives and gets switched off.
 */
function locallyProvableAsyncNames(code) {
  const names = new Set();
  // `async function foo(` / `async function* foo(`
  // (each optional part is anchored on a literal so the scan cannot backtrack)
  for (const m of code.matchAll(/\basync\s+function\s*(?:\*\s*)?([A-Za-z_$][\w$]*)/g))
    names.add(m[1]);
  // `const foo = async (` / `let foo: T = async function`
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*async\b/g,
  ))
    names.add(m[1]);
  // class / object method: `private async foo(`, `async foo<T>(`
  for (const m of code.matchAll(/\basync\s+([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>\s*)?\(/g)) {
    if (m[1] !== 'function') names.add(m[1]);
  }
  // explicit promise-returning signature: `foo(a, b): Promise<void>`
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*:\s*Promise\s*</g))
    names.add(m[1]);
  return names;
}

/**
 * Decide what a character sitting at depth 0 — i.e. one that genuinely encloses
 * the expression, rather than belonging to some bracketed group beside it —
 * proves about ownership. Three outcomes:
 *
 *   `i + 1`     the character CLOSES the enclosing context, so our statement
 *               begins right after it: the previous statement's `;`, or the `{`
 *               of the block we are the first statement of. Detached.
 *   `-1`        the expression is OWNED by something larger — a call argument or
 *               array element (`(` / `[`), or an operand of an assignment,
 *               ternary, short-circuit, arrow body, or list/property position.
 *   `undefined` undecided; the caller keeps scanning left.
 */
function verdictAtDepthZero(code, i) {
  const char = code[i];
  if (char === '{') return i + 1; // we are the first statement of a block
  if (char === ';') return i + 1; // previous statement's terminator
  if (char === '(' || char === '[') return -1; // call argument / array element
  if (char === ',' || char === ':') return -1; // list element / property value
  if (char === '=') return -1; // assignment, or the `=` of `=>`
  if (char === '>' && code[i - 1] === '=') return -1; // concise arrow body
  if (char === '?' && code[i + 1] !== '.') return -1; // ternary (but not `?.`)
  if (char === '&' || char === '|') return -1; // short-circuit operand
  // Undecided: falls off the end as `undefined`, and the caller keeps scanning left.
}

/**
 * Walk BACKWARDS from `index` to the first character of the enclosing statement,
 * or return -1 when the expression is not in statement position.
 *
 * This function owns exactly one concern: the delimiter-balanced walk, which is
 * what makes "statement position" decidable without a parser. A bracket that
 * closes to our right is skipped together with everything it encloses, so the
 * only delimiters that reach `verdictAtDepthZero` are the ones that actually
 * enclose US — and interpreting those is that helper's concern, not this one's.
 */
function statementStart(code, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const char = code[i];
    if (CLOSERS.has(char)) {
      depth++;
      continue;
    }
    if (OPENERS.has(char) && depth > 0) {
      depth--;
      continue;
    }
    if (depth > 0) continue;
    const verdict = verdictAtDepthZero(code, i);
    if (verdict !== undefined) return verdict;
  }
  return 0;
}

/** Scan FORWARDS to the statement terminator (depth-0 `;`, or the closing `}`). */
function statementEnd(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const char = code[i];
    if (OPENERS.has(char)) {
      depth++;
      continue;
    }
    if (CLOSERS.has(char)) {
      if (depth === 0) return i;
      depth--;
      continue;
    }
    if (depth === 0 && char === ';') return i;
  }
  return code.length;
}

/**
 * True when some `.then(` in `text` supplies the two-argument
 * `.then(onFulfilled, onRejected)` form. Segments are split on depth-1 commas
 * and blank segments are ignored, so Prettier's trailing comma in a multi-line
 * argument list is not mistaken for a rejection handler.
 */
function hasTwoArgThen(text) {
  for (let i = text.indexOf('.then('); i !== -1; i = text.indexOf('.then(', i + 6)) {
    let depth = 0;
    let segmentStart = i + 6;
    const segments = [];
    for (let j = i + 5; j < text.length; j++) {
      const char = text[j];
      if (OPENERS.has(char)) depth++;
      else if (CLOSERS.has(char)) {
        depth--;
        if (depth === 0) {
          segments.push(text.slice(segmentStart, j));
          break;
        }
      } else if (char === ',' && depth === 1) {
        segments.push(text.slice(segmentStart, j));
        segmentStart = j + 1;
      }
    }
    if (segments.filter((segment) => segment.trim().length > 0).length >= 2) return true;
  }
  return false;
}

/** A statement whose chain observes rejection. `.finally` re-throws — it does not. */
function handlesRejection(statement) {
  return statement.includes('.catch(') || hasTwoArgThen(statement);
}

/** 1-based line + column of `offset`. */
function positionOf(code, offset) {
  const before = code.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastNewline };
}

/**
 * Resolve the detached statement that encloses `anchor`, or undefined when the
 * expression is owned (awaited/returned/assigned/argument).
 */
function detachedStatementAt(code, anchor) {
  const start = statementStart(code, anchor);
  if (start < 0) return;
  const end = statementEnd(code, start);
  if (end <= anchor) return;
  const raw = code.slice(start, end);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || OWNED_STATEMENT_RE.test(trimmed)) return;
  return { start: start + (raw.length - raw.trimStart().length), text: raw };
}

/** R1 — a detached `.then(…)` chain with no rejection arm. */
function findUnguardedChains(code, seen) {
  const violations = [];
  for (let i = code.indexOf('.then('); i !== -1; i = code.indexOf('.then(', i + 6)) {
    const statement = detachedStatementAt(code, i);
    if (!statement || seen.has(statement.start)) continue;
    if (handlesRejection(statement.text)) continue;
    seen.add(statement.start);
    const { line, column } = positionOf(code, statement.start);
    violations.push({
      line,
      column,
      severity: 'error',
      type: 'floating-async-operation',
      message:
        'Detached promise chain has no rejection handler — the `.then(...)` result is dropped in ' +
        'statement position, so a rejection becomes an unhandled rejection (process-fatal under ' +
        "Node's default mode) and bypasses the host's structured-outcome and exit-code contract. " +
        '`void` marks the VALUE as intentionally discarded; it does not observe the rejection.',
      suggestion:
        'Terminate the chain in a rejection handler that reports the failure — `.catch((error) => ' +
        'log.error({ evt: ..., error }))` — or supply `.then(onFulfilled, onRejected)`. If the ' +
        'operation must be awaited, await it instead of detaching it.',
    });
  }
  return violations;
}

/**
 * R2 — `void asyncCall();` where the callee is provably async in this file.
 * Anchored on the `void` token so the receiver chain (`this.foo?.bar(`) can be
 * walked to its final callee name.
 */
const VOID_CALL_RE = /(?:^|[;{}])\s*void\s+((?:[A-Za-z_$][\w$]*\??\.)*)([A-Za-z_$][\w$]*)\??\s*\(/g;

function findUnguardedVoidAsyncCalls(code, seen) {
  const violations = [];
  const asyncNames = locallyProvableAsyncNames(code);
  if (asyncNames.size === 0) return violations;

  VOID_CALL_RE.lastIndex = 0;
  let match;
  while ((match = VOID_CALL_RE.exec(code)) !== null) {
    const callee = match[2];
    if (!asyncNames.has(callee)) continue;
    const voidOffset = match.index + match[0].indexOf('void');
    if (seen.has(voidOffset)) continue;
    const end = statementEnd(code, voidOffset);
    const statement = code.slice(voidOffset, end);
    // `.then(` statements are R1's territory; never report the same site twice.
    if (statement.includes('.then(') || handlesRejection(statement)) continue;
    seen.add(voidOffset);
    const { line, column } = positionOf(code, voidOffset);
    violations.push({
      line,
      column,
      severity: 'error',
      type: 'floating-async-operation',
      message:
        `Detached async call \`${callee}(...)\` has no rejection handler — \`${callee}\` is declared ` +
        'async in this file, so `void` starts it and immediately drops the only handle that could ' +
        "observe a failure. A rejection becomes an unhandled rejection (process-fatal under Node's " +
        "default mode) and bypasses the host's structured-outcome and exit-code contract.",
      suggestion:
        `Attach a reporting rejection handler — \`void ${callee}(...).catch((error) => log.error({ ` +
        'evt: ..., error }))` — or await the call so the enclosing try/catch can diagnose it.',
    });
  }
  return violations;
}

/**
 * Pure analysis. Exported so the rule can be exercised directly (fixtures under
 * `__fixtures__/error-floating-async-operation/`).
 */
export function analyzeErrorFloatingAsyncOperation(content, filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  if (NON_PRODUCTION_PATH_RE.test(normalized) && !SELF_FIXTURE_PATH_RE.test(normalized)) return [];
  if (!content.includes('void ') && !content.includes('.then(')) return [];

  // Positions preserved so reported line/column match the real file; string and
  // comment bodies blanked so prose and literals cannot fabricate a match.
  const code = stripStringsAndCommentsPreservingPositions(content);

  const seen = new Set();
  return [...findUnguardedChains(code, seen), ...findUnguardedVoidAsyncCalls(code, seen)].toSorted(
    (a, b) => a.line - b.line || a.column - b.column,
  );
}

export const checks = [
  defineCheck({
    id: 'b50f2b98-1051-4651-83ef-d77f6d9830a1',
    slug: 'error-floating-async-operation',
    // Phase A.4: ships disabled; runs only via the error-migration ratchet lane until its
    // ledger slice is closed. Enabling it today would take the dogfood gate red on the
    // existing backlog, which is how a new guardrail gets waived instead of adopted.
    disabled: true,
    description:
      'A detached promise (statement position, with or without `void`) must carry a rejection handler — `void` discards the value, not the rejection.',
    // Empty `concerns` matches every target (TargetRegistry.findByScope), so the
    // rule reaches the NESTED tool-engine packages (packages/<tool>/*/src) that
    // the flat `backend` glob misses. Test files are excluded by the analyzer.
    scope: { languages: ['typescript'], concerns: [] },
    tags: ['resilience', 'async', 'promises', 'error-handling'],
    fileTypes: ['ts', 'tsx', 'mts'],
    confidence: 'high',
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeErrorFloatingAsyncOperation(content, filePath),
  }),
];
