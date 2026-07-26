/**
 * @fileoverview error-code-must-be-registered — an error code that reaches a
 *               runtime error construction must be REGISTERED: its DOMAIN head
 *               must belong to a real `defineErrorCatalog(...)` in this repo or
 *               to the `legacyFamilyCode` family map, and the code must be a
 *               fixed literal (never assembled from template substitutions).
 *               Project-local SELF-check for opensip-cli (maintainer ruling D11).
 *
 * WHY THIS IS LOCAL, NOT SHIPPED
 * The whole rule is a statement about THIS repository's error registry. The
 * allowed DOMAIN heads are not a universal vocabulary — they are derived, at
 * analysis time, from opensip-cli source: every `code:` literal and every
 * quoted object key inside a `*error-catalog.ts` / `error-definition.ts`
 * catalog, plus the `case 'HEAD':` arms of `legacyFamilyCode()` in
 * `packages/core/src/lib/error-definition.ts`. An adopter who installs
 * opensip-cli and runs `fit` on their own code has no `defineErrorCatalog`, no
 * `ToolError`, and no `legacyFamilyCode` — the rule would be inert or, worse,
 * wrong. Per `opensip-cli/fit/checks/README.md` such "local facts" checks live
 * here as dogfood self-checks, which is also what `shipped-checks-must-be-generic`
 * steers this shape toward. Being project-local additionally keeps the check
 * from scanning its own source, where the detection vocabulary appears as
 * string literals.
 *
 * WHY IT MATTERS (the defect, not the style)
 * `ToolError` resolves every code through `definitionFromLegacyCode(code)`:
 * exact catalog hit → `legacyFamilyCode(head)` family bucket → otherwise
 * `coreSystemErrorCatalog.require('UNKNOWN_FAILURE')`. That terminal fallback is
 * severity `fatal`, exposure `operator-only`, responsibility `unknown`,
 * exitClass `fatal`. So a code with an unregistered head does not merely lack
 * documentation — it silently re-classifies the failure. The canonical proof is
 * `packages/core/src/config-resolution.ts`: `code: 'ERRORS.CONFIG.NOT_FOUND'`
 * has head `ERRORS`, which `legacyFamilyCode` does not map, so the most common
 * first-run failure (no `opensip-cli.config.yml`) is demoted from a user
 * configuration error to an operator-only fatal internal failure.
 * A code built by template substitution (``code: `CONFIG.GRAPH.${reason}` ``)
 * cannot appear in any catalog by construction, so it can never be reviewed,
 * documented, or given axes — it is unregisterable, not merely unregistered.
 *
 * WHAT IT FLAGS (two precise shapes, both inside a real error construction)
 *   1. `new <X>Error(…, { code: 'HEAD.AREA.REASON' })` where `HEAD` is not in
 *      the derived allowed set.
 *   2. `new ToolError(message, 'HEAD.AREA.REASON', …)` — the legacy positional
 *      code form. Restricted to `ToolError` because every subclass
 *      (`ValidationError`, `SystemError`, `ConfigurationError`, …) takes
 *      `(message, options)`; only the base class takes a positional code, so no
 *      innocent second string argument can be mistaken for one.
 *   3. Either of the above where the code is a template literal carrying a
 *      `${…}` substitution, or a string literal followed by `+` — a code
 *      assembled at runtime.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG
 *   • Built-in JS errors (`new Error`, `TypeError`, `RangeError`, `SyntaxError`,
 *     …). They carry no `code` parameter; the reviewed negative corpus for this
 *     shard is full of `throw new RangeError(msg)` / `new TypeError(msg)` in
 *     `packages/targeting/src/bounded-resolve-inputs.ts` that were rejected as
 *     false positives, and excluding the builtins removes that class entirely.
 *   • Non-literal code values (`{ code }`, `code: someConst`, `code: opts.code ?? X`).
 *     Whether those resolve to a registered code is a data-flow question this
 *     text-level check cannot answer, and guessing would fire on correct code.
 *   • A registered HEAD with an unregistered leaf (`CORE.ERROR_DEFINITION.INVALID`,
 *     `CORE.RUNTIME_LEASE.CANCELLED`). D11 is head-granular on purpose:
 *     `legacyFamilyCode` genuinely resolves those through their family bucket,
 *     so they are classified — arguably MIS-classified, which is a separate
 *     ruling with a separate check. Widening this check to leaf granularity
 *     would fire on ~240 SYSTEM.* sites that the family map handles by design.
 *   • Catalog definitions themselves. A `code:` inside `defineErrorCatalog(...)`
 *     is a registration, not a construction, and is never inside a `new …Error(`
 *     argument list, so it is structurally out of reach.
 *   • Tests, fixtures, `dist/`, and non-TypeScript files.
 *
 * HOW IT READS THE SOURCE
 * The file is lexed once (quote-, template-, regex- and comment-aware) into a
 * MASKED copy where comment bodies and string/template interiors are blanked to
 * spaces of equal length. Line numbers therefore survive, paren/brace balancing
 * cannot be broken by a `)` inside a string or a regex, and — critically —
 * documentation prose can never trip the rule: the JSDoc in
 * `packages/core/src/tools/types.ts` that spells out `CONFIGURATION_ERROR` and
 * friends is blanked before scanning. Mis-lexing can only blank MORE text, so
 * every lexer imprecision costs recall, never precision.
 *
 * HOW IT LOCATES THE REGISTRY
 * The repo root is derived from the analyzed file's own path — walk up from its
 * directory until `packages/core/src/lib/error-definition.ts` is found. The
 * check never consults the process working directory: at check time the cwd is
 * not guaranteed to be the project root, so a cwd-anchored resolution would
 * read a different repo's registry (or none) and silently mis-classify heads.
 * When no anchor is found the allowed-head set is empty and the rule goes
 * inert, which is the only safe posture outside opensip-cli.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { defineCheck } from '@opensip-cli/fitness';

/** Anchor that identifies the opensip-cli repo root from any analyzed file. */
const ROOT_ANCHOR = path.join('packages', 'core', 'src', 'lib', 'error-definition.ts');

/** Directories never worth walking when hunting for catalog sources. */
const PRUNED_DIRS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
  '.git',
  '__tests__',
  '__fixtures__',
]);

/** Built-in JS error constructors — no `code` parameter, never a code carrier. */
const BUILTIN_ERRORS = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
]);

/** Only the base `ToolError` accepts a positional code as its second argument. */
const POSITIONAL_CODE_CTORS = new Set(['ToolError']);

/** `new SomethingError(` — first-party error constructions. */
const ERROR_CONSTRUCTION = /\bnew\s+([A-Z][A-Za-z0-9_$]*Error)\s*\(/g;

/** A `code:` property key inside an options bag. */
const CODE_PROPERTY = /\bcode\s*:/g;

/** Fully-anchored error-code shape: HEAD.SEGMENT[.SEGMENT…]. */
const CODE_LIKE = /^[A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)+$/;

/** A template literal whose STATIC prefix already looks like a code head. */
const CODE_SHAPED_PREFIX = /^[A-Z][A-Z0-9_]*\./;

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'instanceof',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

/** Punctuation after which a `/` starts a regex literal. */
const REGEX_PRECEDING_PUNCT = '(,=:[!&|?{};+-*%~^<>';

/** Guard so a pathological balance scan can never walk an entire large file. */
const MAX_CONSTRUCTION_SPAN = 20_000;

/** Single-character classes. No quantifiers, so no backtracking is possible. */
const WHITESPACE_CHAR = /\s/;
const IDENTIFIER_START_CHAR = /[A-Za-z_$]/;
const IDENTIFIER_PART_CHAR = /[A-Za-z0-9_$]/;
const REGEX_FLAG_CHAR = /[dgimsuvy]/;

/** How far back the keyword lookbehind may scan before a `/`. */
const KEYWORD_LOOKBEHIND = 24;

/** Depth bound for the catalog-source directory walk. */
const MAX_CATALOG_WALK_DEPTH = 12;

/** Depth bound for the repo-root walk-up from an analyzed file. */
const MAX_ROOT_WALK_DEPTH = 40;

// ---------------------------------------------------------------------------
// Allowed DOMAIN heads, derived from repo source (never hardcoded)
// ---------------------------------------------------------------------------

/** `code: 'HEAD.…'` inside a catalog definition. */
const CATALOG_CODE_LITERAL = /code\s*:\s*'([A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)+)'/g;
/** `'HEAD.…':` used as a catalog object key. */
const CATALOG_CODE_KEY = /'([A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)+)'\s*:/g;
/** `case 'HEAD':` arm inside `legacyFamilyCode()`. */
const LEGACY_FAMILY_CASE = /case\s+'([A-Z][A-Z0-9_]*)'\s*:/g;

/** root → Set<head>. One derivation per process, memoized. */
const allowedHeadsCache = new Map();
/** filePath dir → repo root (or undefined). */
const rootCache = new Map();

/**
 * Locate the opensip-cli repo root by walking up from an analyzed file.
 *
 * The walk is anchored on the file itself, never on the process working
 * directory: the cwd at check time is not guaranteed to be the project root.
 * A relative `filePath` therefore walks relative segments up to `.`, which is
 * exactly the set of directories that could contain it.
 */
function findRepoRoot(filePath) {
  const startDir = path.dirname(filePath);
  const cached = rootCache.get(startDir);
  if (cached !== undefined) return cached === '' ? undefined : cached;

  let dir = startDir;
  let found;
  for (let depth = 0; depth < MAX_ROOT_WALK_DEPTH; depth += 1) {
    if (existsSync(path.join(dir, ROOT_ANCHOR))) {
      found = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  rootCache.set(startDir, found ?? '');
  return found;
}

/** True for a filename that carries error-catalog definitions. */
function isCatalogSourceName(name) {
  if (name.endsWith('.test.ts')) return false;
  return name.endsWith('error-catalog.ts') || name === 'error-definition.ts';
}

/** `readdirSync` that yields nothing rather than throwing on an unreadable dir. */
function readDirectoryEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Visit one directory: queue its sub-directories, collect its catalog files. */
function visitCatalogDirectory(dir, depth, pending, found) {
  for (const entry of readDirectoryEntries(dir)) {
    if (entry.isDirectory()) {
      if (!PRUNED_DIRS.has(entry.name)) pending.push([path.join(dir, entry.name), depth + 1]);
      continue;
    }
    if (entry.isFile() && isCatalogSourceName(entry.name)) {
      found.push(path.join(dir, entry.name));
    }
  }
}

/** Bounded walk of `packages/` collecting every error-catalog source file. */
function collectCatalogSources(root) {
  const found = [];
  const pending = [[path.join(root, 'packages'), 0]];
  while (pending.length > 0) {
    const [dir, depth] = pending.pop();
    if (depth <= MAX_CATALOG_WALK_DEPTH) visitCatalogDirectory(dir, depth, pending, found);
  }
  return found;
}

/** Extract the `legacyFamilyCode()` body so unrelated switches are not read. */
function legacyFamilyBody(source) {
  const start = source.indexOf('function legacyFamilyCode');
  if (start < 0) return '';
  const end = source.indexOf('\n}', start);
  return source.slice(start, end < 0 ? source.length : end);
}

/** Add every DOMAIN head registered by one catalog source file to `heads`. */
function addHeadsFromSource(source, heads) {
  for (const pattern of [CATALOG_CODE_LITERAL, CATALOG_CODE_KEY]) {
    for (const match of source.matchAll(pattern)) {
      heads.add(headOf(match[1]));
    }
  }
  for (const match of legacyFamilyBody(source).matchAll(LEGACY_FAMILY_CASE)) {
    heads.add(match[1]);
  }
}

/**
 * Derive the set of DOMAIN heads that resolve to a real definition in THIS
 * repo. Returns an empty set outside opensip-cli, which makes the check inert
 * rather than wrong.
 */
function allowedHeadsFor(root) {
  if (root === undefined) return new Set();
  const cached = allowedHeadsCache.get(root);
  if (cached !== undefined) return cached;

  const heads = new Set();
  for (const file of collectCatalogSources(root)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    addHeadsFromSource(source, heads);
  }
  allowedHeadsCache.set(root, heads);
  return heads;
}

// ---------------------------------------------------------------------------
// Lexing
// ---------------------------------------------------------------------------

/**
 * The identifier immediately before `index`, skipping intervening whitespace,
 * within a bounded lookbehind window.
 *
 * Written as an explicit backward scan rather than an `(ident)\s*$` regex: the
 * regex form is super-linear (the engine retries the match from every start
 * offset in the window on every failure), while this is one linear pass over at
 * most `KEYWORD_LOOKBEHIND` characters. Leading digits are dropped so the
 * result is a well-formed identifier, matching what the anchored regex captured.
 */
function precedingIdentifier(source, index) {
  const floor = Math.max(0, index - KEYWORD_LOOKBEHIND);
  let end = index;
  while (end > floor && WHITESPACE_CHAR.test(source[end - 1])) end -= 1;
  let start = end;
  while (start > floor && IDENTIFIER_PART_CHAR.test(source[start - 1])) start -= 1;
  while (start < end && !IDENTIFIER_START_CHAR.test(source[start])) start += 1;
  return source.slice(start, end);
}

/** Decide whether a `/` at index `i` opens a regex literal. */
function opensRegex(source, index, previousSignificant) {
  if (previousSignificant === '') return true;
  if (REGEX_PRECEDING_PUNCT.includes(previousSignificant)) return true;
  return REGEX_PRECEDING_KEYWORDS.has(precedingIdentifier(source, index));
}

/** Scan a quoted string starting at `start`; returns the index past its close. */
function scanQuoted(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === quote || ch === '\n') break;
    index += 1;
  }
  return index;
}

/** Scan a template literal, tracking `${…}` nesting depth. */
function scanTemplate(source, start) {
  let index = start + 1;
  let depth = 0;
  let hasSubstitution = false;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (depth === 0 && ch === '`') break;
    if (ch === '$' && source[index + 1] === '{') {
      hasSubstitution = true;
      depth += 1;
      index += 2;
      continue;
    }
    if (depth > 0) {
      switch (ch) {
        case '{': {
          depth += 1;
          break;
        }
        case '}': {
          depth -= 1;
          break;
        }
        case "'":
        case '"':
        case '`': {
          index = scanQuoted(source, index, ch) + 1;
          continue;
        }
        // No default
      }
    }
    index += 1;
  }
  return { close: index, hasSubstitution };
}

/** Index just past a `//` line comment that starts at `index`. */
function endOfLineComment(source, index) {
  let end = index;
  while (end < source.length && source[end] !== '\n') end += 1;
  return end;
}

/** Index just past a block comment that starts at `index`. */
function endOfBlockComment(source, index) {
  let end = index + 2;
  while (end < source.length && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
  return Math.min(source.length, end + 2);
}

/** Index just past a comment starting at `index`, or -1 when none starts there. */
function endOfComment(source, index) {
  if (source[index] !== '/') return -1;
  const next = source[index + 1];
  if (next === '/') return endOfLineComment(source, index);
  if (next === '*') return endOfBlockComment(source, index);
  return -1;
}

/** Index past the trailing flag characters of a regex literal. */
function skipRegexFlags(source, index) {
  let end = index;
  while (end < source.length && REGEX_FLAG_CHAR.test(source[end])) end += 1;
  return end;
}

/**
 * Index past a regex literal whose opening `/` sits at `index`, or -1 when the
 * literal is unterminated on its line.
 */
function scanRegexLiteral(source, index) {
  let end = index + 1;
  let inClass = false;
  while (end < source.length) {
    const ch = source[end];
    if (ch === '\\') {
      end += 2;
      continue;
    }
    if (ch === '\n') break;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return skipRegexFlags(source, end + 1);
    end += 1;
  }
  return -1;
}

/**
 * Index past a regex literal starting at `index`, or -1 when a `/` there is not
 * a regex opener (or opens an unterminated literal).
 */
function regexLiteralEnd(source, index, previousSignificant) {
  if (source[index] !== '/') return -1;
  if (!opensRegex(source, index, previousSignificant)) return -1;
  return scanRegexLiteral(source, index);
}

/** Blank `[from, to)` in the masked character array, preserving newlines. */
function blankRange(masked, limit, from, to) {
  for (let k = Math.max(0, from); k < Math.min(limit, to); k += 1) {
    if (masked[k] !== '\n') masked[k] = ' ';
  }
}

/** Record for one string/template literal token. */
function literalToken(source, start, close, kind, hasSubstitution) {
  return {
    start,
    end: Math.min(source.length, close + 1),
    kind,
    value: source.slice(start + 1, close),
    hasSubstitution,
  };
}

/** Read the string or template literal opened by `quote` at `index`. */
function readLiteral(source, index, quote) {
  if (quote === '`') {
    const { close, hasSubstitution } = scanTemplate(source, index);
    return { close, token: literalToken(source, index, close, 'template', hasSubstitution) };
  }
  const close = scanQuoted(source, index, quote);
  return { close, token: literalToken(source, index, close, 'string', false) };
}

/**
 * Produce a masked copy of the module (comment bodies and string/template
 * interiors blanked, newlines preserved) plus the recorded literal tokens.
 * Mis-lexing can only blank more text, so it costs recall and never precision.
 */
function lexModule(source) {
  const masked = [...source];
  const literals = [];
  const blank = (from, to) => blankRange(masked, source.length, from, to);

  let index = 0;
  let previousSignificant = '';
  while (index < source.length) {
    const ch = source[index];

    const commentEnd = endOfComment(source, index);
    if (commentEnd >= 0) {
      blank(index, commentEnd);
      index = commentEnd;
      continue;
    }

    const regexEnd = regexLiteralEnd(source, index, previousSignificant);
    if (regexEnd >= 0) {
      blank(index + 1, regexEnd - 1);
      index = regexEnd;
      previousSignificant = '/';
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const { close, token } = readLiteral(source, index, ch);
      literals.push(token);
      blank(index + 1, close);
      index = close + 1;
      previousSignificant = ch;
      continue;
    }

    if (!WHITESPACE_CHAR.test(ch)) previousSignificant = ch;
    index += 1;
  }

  return { masked: masked.join(''), literals };
}

// ---------------------------------------------------------------------------
// Construction analysis
// ---------------------------------------------------------------------------

/** Index of the `)` closing the `(` at `open`, or -1 when unbalanced/oversized. */
function matchingParen(masked, open) {
  let depth = 0;
  const limit = Math.min(masked.length, open + MAX_CONSTRUCTION_SPAN);
  for (let i = open; i < limit; i += 1) {
    const ch = masked[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a call's argument region into top-level `[start,end)` spans. */
function splitArguments(masked, open, close) {
  const spans = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      spans.push([start, i]);
      start = i + 1;
    }
  }
  spans.push([start, close]);
  return spans;
}

/** First non-whitespace index at or after `from`, bounded by `to`. */
function firstNonSpace(masked, from, to) {
  let i = from;
  while (i < to && WHITESPACE_CHAR.test(masked[i])) i += 1;
  return i;
}

/** 1-based line/column for a source index. */
function positionOf(source, index) {
  let line = 1;
  let lastBreak = -1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: index - lastBreak };
}

/** The verdict for a code that is assembled at runtime rather than written out. */
function unregisterableVerdict(reason) {
  return {
    reason,
    consequence:
      'no such code can ever appear in a catalog, so it can never be reviewed, documented, ' +
      'given failure axes, or matched by an exact-code consumer',
  };
}

/** The verdict for a fixed code whose DOMAIN head is in no catalog. */
function unregisteredHeadVerdict(code, allowedHeads) {
  if (allowedHeads.has(headOf(code))) return;
  return {
    reason: `its DOMAIN head '${headOf(code)}' belongs to no catalog and to no legacyFamilyCode family`,
    consequence:
      'definitionFromLegacyCode() therefore falls through to CORE.SYSTEM.UNKNOWN_FAILURE ' +
      '(severity fatal, exposure operator-only, responsibility unknown, exitClass fatal), ' +
      'silently reclassifying this failure',
  };
}

/** Classify a template literal sitting in a code position. */
function classifyTemplateLiteral(literal, allowedHeads) {
  if (!literal.hasSubstitution) {
    return CODE_LIKE.test(literal.value)
      ? unregisteredHeadVerdict(literal.value, allowedHeads)
      : undefined;
  }
  return CODE_SHAPED_PREFIX.test(literal.value)
    ? unregisterableVerdict('it is assembled from a template substitution at runtime')
    : undefined;
}

/**
 * Classify one literal sitting in a code position.
 * Returns a reason record, or undefined when the code is properly registered.
 */
function classifyCodeLiteral(literal, masked, allowedHeads) {
  if (literal.kind === 'template') return classifyTemplateLiteral(literal, allowedHeads);
  if (!CODE_LIKE.test(literal.value)) return;
  const after = firstNonSpace(masked, literal.end, masked.length);
  if (masked[after] === '+') {
    return unregisterableVerdict('it is assembled by string concatenation at runtime');
  }
  return unregisteredHeadVerdict(literal.value, allowedHeads);
}

/** DOMAIN head of a dotted code. */
function headOf(code) {
  return code.slice(0, code.indexOf('.'));
}

/** Literal token that begins exactly at `index`, when one exists. */
function literalAt(literals, index) {
  return literals.find((literal) => literal.start === index);
}

/** The literal in `new ToolError(msg, 'CODE')`'s positional code slot, if any. */
function positionalCodeLiteral(masked, literals, open, close) {
  const second = splitArguments(masked, open, close)[1];
  if (second === undefined) return;
  const literal = literalAt(literals, firstNonSpace(masked, second[0], second[1]));
  if (literal === undefined) return;
  // The literal must BE the whole argument — `new ToolError(msg, 'CODE')`,
  // not merely start it — so an expression is never read as a code.
  return masked.slice(literal.end, second[1]).trim().length === 0 ? literal : undefined;
}

/** Every literal in a code position for one `new …Error(...)` construction. */
function codePositionLiterals(constructorName, masked, literals, open, close) {
  const found = [];

  for (const match of [...masked.slice(open, close).matchAll(CODE_PROPERTY)]) {
    const colonEnd = open + match.index + match[0].length;
    const literal = literalAt(literals, firstNonSpace(masked, colonEnd, close));
    if (literal !== undefined) found.push(literal);
  }

  if (POSITIONAL_CODE_CTORS.has(constructorName)) {
    const positional = positionalCodeLiteral(masked, literals, open, close);
    if (positional !== undefined) found.push(positional);
  }

  return found;
}

/** Every first-party `new …Error(` site in the module, argument span resolved. */
function* errorConstructionSites(masked) {
  ERROR_CONSTRUCTION.lastIndex = 0;
  for (const match of [...masked.matchAll(ERROR_CONSTRUCTION)]) {
    const constructorName = match[1];
    if (BUILTIN_ERRORS.has(constructorName)) continue;
    const open = match.index + match[0].length - 1;
    const close = matchingParen(masked, open);
    if (close >= 0) yield { constructorName, open, close };
  }
}

/** Render the offending literal the way it appears in source. */
function shownLiteral(literal) {
  return literal.kind === 'template' ? `\`${literal.value}\`` : `'${literal.value}'`;
}

/** Build the reported violation for one unregistered code literal. */
function buildViolation({ literal, constructorName, verdict, line, column, allowedHeads }) {
  return {
    severity: 'error',
    line,
    column,
    message:
      `Error code ${shownLiteral(literal)} passed to new ${constructorName}(...) is registered in no catalog: ` +
      `${verdict.reason}. ${verdict.consequence} (maintainer ruling D11).`,
    suggestion:
      'Add the code to the owning package error catalog (defineErrorCatalog in src/errors/*-error-catalog.ts, ' +
      'contributed via ToolExtensionPoints.errorCatalog) and construct the error definition-first — ' +
      `createToolError(catalog.require('...'), message). If a runtime value must vary, put it in ` +
      'the message or metadata, never in the code: a code assembled at runtime can never be registered. ' +
      `Allowed DOMAIN heads today: ${[...allowedHeads].toSorted().join(', ')}.`,
  };
}

// ---------------------------------------------------------------------------
// File gating
// ---------------------------------------------------------------------------

/**
 * True for tests, build output, and fixture corpora — never production error
 * surface. `__fixtures__` is deliberately NOT excluded here: this check's own
 * fixtures must be able to exercise it, and the repo's `globalExcludes` already
 * keeps `**\/__fixtures__\/**` out of every real `fit` run.
 */
function isExcludedFile(normalized) {
  return (
    normalized.includes('/__tests__/') ||
    normalized.includes('/fixtures/') ||
    normalized.includes('/node_modules/') ||
    normalized.includes('/dist/') ||
    normalized.includes('/test-support/') ||
    /\.(test|spec)\.[cm]?tsx?$/.test(normalized)
  );
}

/** True when the file is production TypeScript that could carry an error code. */
function isAnalyzableFile(normalized, content) {
  if (!/\.[cm]?tsx?$/.test(normalized)) return false;
  if (isExcludedFile(normalized)) return false;
  return content.includes('Error(');
}

/**
 * Pure analysis entry point. Exported so the rule can be exercised directly.
 */
export function analyzeErrorCodeMustBeRegistered(content, filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  if (!isAnalyzableFile(normalized, content)) return [];

  const allowedHeads = allowedHeadsFor(findRepoRoot(String(filePath)));
  // Outside opensip-cli (or when the registry cannot be read) the rule has no
  // authority to judge a head. Stay silent rather than guess.
  if (allowedHeads.size === 0) return [];

  const { masked, literals } = lexModule(content);
  const violations = [];
  const seen = new Set();

  for (const { constructorName, open, close } of errorConstructionSites(masked)) {
    for (const literal of codePositionLiterals(constructorName, masked, literals, open, close)) {
      const verdict = classifyCodeLiteral(literal, masked, allowedHeads);
      if (verdict === undefined) continue;
      const { line, column } = positionOf(content, literal.start);
      const key = `${line}:${column}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push(
        buildViolation({ literal, constructorName, verdict, line, column, allowedHeads }),
      );
    }
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: '3f7c1d92-6b48-4a25-9e1c-0d5a7b8e4f31',
    slug: 'error-code-must-be-registered',
    // Phase A.4: ships disabled; runs only via the error-migration ratchet lane until its
    // ledger slice is closed. Enabling it today would take the dogfood gate red on the
    // existing backlog, which is how a new guardrail gets waived instead of adopted.
    disabled: true,
    description:
      'An error code reaching a runtime error construction must be registered: its DOMAIN head must come from a real defineErrorCatalog in this repo or the legacyFamilyCode family map, and the code must be a fixed literal (never assembled from a template substitution). Unregistered heads silently demote to CORE.SYSTEM.UNKNOWN_FAILURE (fatal / operator-only).',
    scope: { languages: ['typescript'], concerns: [] },
    tags: ['resilience', 'errors', 'architecture'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeErrorCodeMustBeRegistered(content, filePath),
  }),
];
