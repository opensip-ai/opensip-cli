/**
 * @fileoverview error-destructive-path-containment — a RECURSIVE filesystem
 *               deletion (`rm -rf`) must not be aimed at a path this file
 *               cannot prove it owns. Project-local SELF-check for opensip-cli
 *               (resilience / blast-radius family, sibling of
 *               `resilience/require-finally-for-cleanup.mjs`).
 *
 * ── WHY THIS IS PROJECT-LOCAL, NOT A SHIPPED CHECK ──────────────────────────
 * The rule is only decidable because it is keyed to THIS repo's containment
 * vocabulary. opensip-cli owns a small, named set of containment primitives —
 * `isPathInside` (@opensip-cli/core), `assertTargetsContained` /
 * `assertSafeProjectDir` (uninstall), `classifyRuntimePromotionPath` +
 * `assertPromotionRootIdentity` (init runtime promotion), `realpathSync`
 * re-anchoring — and the ONLY reason this check can stay quiet on correct code
 * is that it recognises those exact symbols as proof. An adopter repo has none
 * of them: shipped in `@opensip-cli/checks-*`, the identical logic would flag
 * every legitimate `rm -rf` in every customer codebase, because "proven
 * contained" would have no vocabulary to match. That is exactly the boundary
 * `shipped-checks-must-be-generic` polices, so the rule lives HERE as a dogfood
 * self-check (see opensip-cli/fit/checks/README.md).
 *
 * Being local also means it can hard-skip our own check packs, whose sources
 * carry `rmSync`/`unlink` strings as DETECTION PATTERNS rather than as calls.
 *
 * ── WHAT IT FORBIDS ─────────────────────────────────────────────────────────
 * A call to `rmSync` / `rm` / `rmdirSync` / `rmdir` (bare or namespaced —
 * `fs.rmSync`, `filesystem.rm`, `promises.rm`) whose options literal contains
 * `recursive: true`, AND whose target path expression is rooted in a value this
 * file never derived: a function parameter, a field of a parameter/options bag,
 * or a value traced to `process.argv` / `process.env`. That is an unbounded
 * `rm -rf` of somebody else's string. The canonical instance in this tree is
 * `scripts/release-preflight.mjs` — `rmSync(args.tarballDir, { recursive: true,
 * force: true })` where `--tarball-dir` is accepted from argv after rejecting
 * only the two literals 'undefined' and 'null'; no `isAbsolute`, no ownership
 * marker, no containment. The blast radius of that call is "whatever the caller
 * typed".
 *
 * The remedy is never a try/catch — swallowing EACCES after the tree is gone
 * changes nothing. It is a containment PROOF before the call: re-anchor with
 * `realpathSync` and assert `isPathInside(real, ownedRoot)`, or derive the path
 * locally (`mkdtempSync`, `join(<owned root>, …)`) so it cannot escape.
 *
 * ── WHAT IT DELIBERATELY DOES **NOT** FLAG ──────────────────────────────────
 * Precision is the landing bar here: a resilience check that fires on correct
 * code gets disabled, which is strictly worse than no check. Every exclusion
 * below was derived from a real call site in this repo, not invented:
 *
 *  • `force: true` WITHOUT `recursive: true`. `force` only suppresses ENOENT;
 *    it does not turn a single-file unlink into a tree walk. `rmSync(tmp,
 *    { force: true })` (telemetry/profile-artifact-index.ts, config
 *    global-config.ts) is a normal atomic-write cleanup, not a blast radius.
 *  • Locally-derived roots. `const dir = mkdtempSync(join(tmpdir(), …))` then
 *    `rmSync(dir, { recursive: true, force: true })` — bootstrap/
 *    dispatch-fork-core.ts, capability-worker/supervisor.ts, commands/tools/
 *    validate.ts, graph shard-runner.ts. The process created the directory; it
 *    owns it. Same for `join(...)`/`resolve(...)`/`resolveProjectPaths(...)`
 *    products and for `for (const x of <locally listed dirs>)` bindings
 *    (bootstrap/artifact-retention.ts prunes `stale.full` off its own listing).
 *  • Any file that already speaks containment — either of this repo's two
 *    proof idioms (see `provesContainment` below). Anchoring keeps
 *    `commands/uninstall/project-removal-safety.ts` silent: its
 *    `rmSync(target.path, …)` loop is preceded by `assertTargetsContained`,
 *    which realpath-anchors every target inside the project root or the
 *    user-cache root. Ownership markers keep
 *    `commands/uninstall/user-removal-fs.ts` silent: its
 *    `removeEntry: (path) => rmSync(path, { recursive: true, force: true })`
 *    default op is only ever driven under a verified `markerMatches` digest,
 *    over entries the same function just listed. They also keep
 *    `scripts/bench-partition-strategies.mjs` silent: `--corpus` IS an argv
 *    path, but `rmSync` there is gated on `existsSync(fixtureMarker)`, so an
 *    existing directory that is not one of our generated fixtures is never
 *    touched. All three call sites are CORRECT and must stay green.
 *  • `this.<field>` targets. Ownership was established at construction, in a
 *    different function; a per-file text scan cannot see it and must not guess.
 *  • Call-expression targets (`rmSync(cacheFileFor(...), …)`) — the path is
 *    computed, not forwarded.
 *  • String-literal targets, test files, `__tests__`, fixtures, `dist/`,
 *    `node_modules/`, `.d.ts`, and our own shipped check-pack sources under
 *    `packages/fitness/checks-<lang>/src/checks/`.
 *
 * Comments are stripped and string-literal CONTENTS are blanked before
 * scanning, so a JSDoc line documenting `rmSync({ recursive: true, force:
 * true })` (bootstrap/artifact-retention.ts does exactly that) or a violation
 * message quoting `unlink()` (checks-typescript input-sanitization.ts) can
 * never trip the rule — only real code does. Quotes are preserved so a literal
 * first argument is still recognisable as a literal.
 *
 * Escape hatch: `// destructive-path-ok: <reason>` on the call line or the line
 * above, mirroring the sibling `// resilience-ok` idiom.
 *
 * Severity is `warning`, not `error`, on purpose: containment can legitimately
 * live one call frame away, in a file this check never sees. A hit is a demand
 * for a proof at the deletion site, adjudicated by a human — not a proven bug.
 */
import { defineCheck } from '@opensip-cli/fitness';

/** Deletion primitives whose `recursive: true` form removes a whole subtree. */
const DELETE_CALL = /(?<![\w$])(?:([A-Za-z_$][\w$]*)\s*\.\s*)?(rmSync|rmdirSync|rm|rmdir)\s*\(/g;

/**
 * Producers that make a path THIS file owns. `mkdtempSync`/`mkdir*` create it;
 * `join`/`resolve`/`dirname`/`normalize` derive it from a base already in hand;
 * `realpathSync` re-anchors it; the `resolve*Paths` resolvers are opensip-cli's
 * own managed-layout roots. A root bound from any of these is not "somebody
 * else's string".
 */
const OWNED_PRODUCERS = [
  'mkdtempSync',
  'mkdtemp',
  'mkdirSync',
  'mkdir',
  'join',
  'resolve',
  'normalize',
  'dirname',
  'realpathSync',
  'realpath',
  'tmpdir',
  'resolveProjectPaths',
  'resolveUserPaths',
  'resolveEphemeralPaths',
].join('|');

/**
 * Containment vocabulary of THIS repo (see @fileoverview). opensip-cli proves
 * "we may delete this tree" two ways, and both count:
 *
 *   1. ANCHORING — resolve the path for real and assert it is under a root we
 *      own: `realpathSync` + `isPathInside` / `assertTargetsContained`
 *      (commands/uninstall/project-removal-safety.ts), `classifyRuntimePromotionPath`
 *      + `assertPromotion*Identity` (commands/init/runtime-promotion-*), or the
 *      `relative(root, child).startsWith('..')` escape test.
 *   2. OWNERSHIP MARKERS — establish that a marker file WE wrote is present in
 *      the tree before removing it, so the delete cannot land on a directory we
 *      did not create. This repo names those bindings consistently with
 *      "marker", which is what makes the idiom recognisable:
 *        · `markerMatches(root, expectedDigest)` / `digestMarkerContent`
 *          (commands/uninstall/user-removal-fs.ts) — marker present AND its
 *          sha256 equals the digest we published.
 *        · `existsSync(fixtureMarker)` gating `isRealCorpus`
 *          (scripts/bench-partition-strategies.mjs) — `--corpus` is only
 *          `rm -rf`'d when it carries the generator's own marker file; an
 *          existing directory WITHOUT the marker is treated as a real corpus
 *          and left alone.
 *      A `<something>Marker` identifier used as a guard is therefore proof, and
 *      the check must not claim "nothing here proves ownership" over it.
 *
 * Presence of either vocabulary anywhere in the file means the author reasoned
 * about escape, and the residual judgement is beyond a per-file text scan — so
 * the check stands down rather than assert something false about the code.
 *
 * ── HOW THE VOCABULARY IS MATCHED ───────────────────────────────────────────
 * Two of these idioms are "an identifier SHAPED like X, called as a function":
 * `assert…Contained(`, `…Marker(`. Written as one regex that is what it reads
 * like — `assert[A-Za-z]*(?:Safe|Contained|…)[A-Za-z]*\s*\(` — it puts two
 * unbounded quantifiers either side of a fixed alternation, so a long
 * identifier that does NOT end in `(` makes the engine retry every split point:
 * super-linear backtracking on file text, i.e. a ReDoS surface in a checker that
 * reads whatever is in the repo. They are matched instead by capturing the
 * identifier ONCE with an unambiguous pattern (`someCapture` below) and testing
 * the captured string in JS. Same language, linear scan, no backtracking.
 */
const ANCHORING_PROOF = [
  /\bisPathInside\s*\(/,
  /\bassertTargetsContained\s*\(/,
  /\brealpathSync\s*\(/,
  /\brealpath\s*\(/,
  /\bclassifyRuntimePromotionPath\s*\(/,
  /\brelative\s*\([^)]*\)\s*\.\s*startsWith\s*\(/,
  // There is deliberately NO bare `startsWith('..')` pattern here. Proofs are
  // tested against the BLANKED code (string CONTENTS become spaces — see
  // `blankStringContents`), so the `..` of `.startsWith('..')` never survives
  // to be matched: after blanking, the character following an opening quote is
  // always a space, a newline, or the closing quote. Such a pattern would not
  // be a weak signal, it would be an unreachable branch. The escape test is
  // carried by the `relative(…).startsWith(` entry above, which keys on code
  // rather than on literal contents and therefore does match.
];

/** Callee of a `name(` call site. One unambiguous capture — cannot backtrack. */
const CALL_SITE = /\b([A-Za-z_$][\w$]*)\s*\(/g;

/** `assert<Letters>(` — the assertion half of the anchoring vocabulary. */
const ASSERTION_CALL = /\bassert([A-Za-z]*)\s*\(/g;

/** What an `assert…(` must be asserting ABOUT for it to count as containment. */
const ASSERTION_SUBJECT = /Safe|Contained|Inside|Identity|Owner/;

/** First-argument identifier of a marker guard: `existsSync(fixtureMarker)`. */
const GUARDED_ARGUMENT =
  /\b(?:existsSync|lstatSync|statSync|readFileSync)\s*\(\s*([A-Za-z_$][\w$]*)/g;

/** `markerMatches`, `verifyOwnedMarker`, `fixtureMarker` — but not `marker`. */
const MARKER_NAME = /[Mm]arker/;

/** True when some capture of the (global) `pattern` satisfies `accepts`. */
function someCapture(code, pattern, accepts) {
  pattern.lastIndex = 0;
  let hit;
  while ((hit = pattern.exec(code)) !== null) {
    if (accepts(hit[1])) return true;
  }
  return false;
}

/** True when the file speaks either containment idiom (see the block above). */
function provesContainment(code) {
  return (
    ANCHORING_PROOF.some((re) => re.test(code)) ||
    someCapture(code, ASSERTION_CALL, (subject) => ASSERTION_SUBJECT.test(subject)) ||
    // The marker must be named INSIDE the identifier, not be the whole of it.
    someCapture(code, CALL_SITE, (callee) => MARKER_NAME.test(callee.slice(1))) ||
    someCapture(code, GUARDED_ARGUMENT, (argument) => MARKER_NAME.test(argument.slice(1)))
  );
}

/** Inline, justified opt-out (sibling idiom of `// resilience-ok`). */
const INLINE_OK = /\/\/\s*destructive-path-ok\b/;

const SELF_FIXTURE = /opensip-cli\/fit\/checks\/__fixtures__\/error-destructive-path-containment\//;

/**
 * First-party source we should analyze. Skips tests/fixtures/build output and
 * our own check-pack sources, whose bodies carry `rmSync`/`unlink` as detection
 * patterns rather than as calls.
 */
function isAnalyzableSource(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const p = filePath.replaceAll('\\', '/');
  if (!/\.(?:ts|tsx|mjs|cjs|js)$/.test(p)) return false;
  if (/\.d\.ts$/.test(p)) return false;
  if (/\/(?:node_modules|dist|coverage|__tests__)\//.test(p)) return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(p)) return false;
  if (/\/__fixtures__\//.test(p) && !SELF_FIXTURE.test(p)) return false;
  // Our own project-local checks (this file included) hold the detection
  // patterns as regex literals, which no blanking pass removes.
  if (/opensip-cli\/fit\/checks\//.test(p) && !SELF_FIXTURE.test(p)) return false;
  // Shipped check packs describe fs calls; they do not make them.
  if (/\/checks-[a-z]+\/src\/checks\//.test(p)) return false;
  return true;
}

/** Drop comment bodies while preserving line count (so line numbers hold). */
function stripComments(content) {
  let out = content.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replaceAll(/[^\n]/g, ' '));
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, (m, lead) => lead.padEnd(m.length));
  return out;
}

/** Bracket nesting contribution of a character: +1 opening, -1 closing, 0 else. */
function depthDelta(ch) {
  if (ch === '(' || ch === '[' || ch === '{') return 1;
  if (ch === ')' || ch === ']' || ch === '}') return -1;
  return 0;
}

/**
 * Blank the CONTENTS of string/template literals, preserving the delimiters and
 * the character count. Documentation prose that quotes a deletion call is
 * neutralised; a literal first argument is still visibly a literal.
 */
function blankStringContents(code) {
  return code.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1?/g, (match, quote) => {
    const body = match.slice(1, match.endsWith(quote) && match.length > 1 ? -1 : undefined);
    const blanked = body.replaceAll(/[^\n]/g, ' ');
    return match.length > 1 && match.endsWith(quote)
      ? `${quote}${blanked}${quote}`
      : `${quote}${blanked}`;
  });
}

/** Text between the call's `(` and its matching `)`; undefined when unbalanced. */
function callArguments(code, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < code.length; i++) {
    const delta = depthDelta(code[i]);
    depth += delta;
    if (delta < 0 && depth === 0) return code.slice(openParenIndex + 1, i);
  }
  // Fell off the end: the call's `)` is missing, so there are no arguments to
  // read. Implicitly undefined — the caller skips the call site.
}

/** The first argument expression, split at the first top-level comma. */
function firstArgument(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const delta = depthDelta(args[i]);
    if (delta === 0 && args[i] === ',' && depth === 0) return args.slice(0, i).trim();
    depth += delta;
  }
  return args.trim();
}

/**
 * Root identifier of a path expression; undefined when the expression is not a
 * forwarded value (literal, `this.x`, or a computed call result).
 */
function unprovenRoot(expression) {
  const expr = expression.replace(/^await\s+/, '').trim();
  if (expr.length === 0) return;
  if (/^['"`]/.test(expr)) return; // literal path
  if (/^this\b/.test(expr)) return; // instance state, owned elsewhere
  if (/^[A-Za-z_$][\w$]*\s*\(/.test(expr)) return; // computed
  const match = /^([A-Za-z_$][\w$]*)/.exec(expr);
  return match ? match[1] : undefined;
}

/** A single value expression that yields a path this file derived. */
const OWNED_BRANCH = new RegExp(
  String.raw`^(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:${OWNED_PRODUCERS})\s*\(|^(?:undefined|null)$|^['"\`]`,
);

/** Initializer text of `<id> = …`, from just after `=` to the statement end. */
function initializerAt(code, equalsIndex) {
  let depth = 0;
  for (let i = equalsIndex + 1; i < code.length; i++) {
    const delta = depthDelta(code[i]);
    // An unbalanced closer ends the statement as surely as a `;` does: it is the
    // `)` of the enclosing call or the `}` of the enclosing block.
    if (delta < 0 && depth === 0) return code.slice(equalsIndex + 1, i);
    if (delta === 0 && code[i] === ';' && depth === 0) return code.slice(equalsIndex + 1, i);
    depth += delta;
  }
  return code.slice(equalsIndex + 1);
}

/**
 * Value branches of an initializer. A ternary contributes its two arms; a
 * `??`/`||` chain contributes every operand. This is what separates
 * `cond ? mkdtempSync(…) : undefined` (owned in every branch) from
 * `args.corpus ?? join(tmpdir(), …)` (one branch is the caller's string) —
 * both real shapes in this tree.
 */
function valueBranches(initializer) {
  const ternary = findTernary(initializer);
  const parts = ternary
    ? [
        initializer.slice(ternary.questionAt + 1, ternary.colonAt),
        initializer.slice(ternary.colonAt + 1),
      ]
    : splitFallbackChain(initializer);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** True when the `?` at `i` opens a ternary — not `?.`, and not either `??` half. */
function isTernaryQuestion(text, i) {
  return text[i] === '?' && text[i + 1] !== '.' && text[i + 1] !== '?' && text[i - 1] !== '?';
}

/** True when `??`/`||` starts at `i` — the operators that introduce a fallback. */
function isFallbackOperator(text, i) {
  return (text[i] === '?' && text[i + 1] === '?') || (text[i] === '|' && text[i + 1] === '|');
}

/**
 * Offsets of the first top-level `?` and its `:`, or undefined when the text is
 * not a ternary. Both must be at bracket depth 0 to belong to THIS expression.
 */
function findTernary(text) {
  let depth = 0;
  let questionAt = -1;
  for (let i = 0; i < text.length; i++) {
    const delta = depthDelta(text[i]);
    if (delta !== 0) depth += delta;
    else if (depth !== 0) continue;
    else if (questionAt === -1) {
      if (isTernaryQuestion(text, i)) questionAt = i;
    } else if (text[i] === ':') return { questionAt, colonAt: i };
  }
  // No `?`, or a `?` with no matching top-level `:` — not a ternary. Implicitly
  // undefined, which routes the caller to the `??`/`||` chain split instead.
}

/** Operands of a top-level `??`/`||` chain — the whole text when there is none. */
function splitFallbackChain(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const delta = depthDelta(text[i]);
    if (delta !== 0) depth += delta;
    else if (depth === 0 && isFallbackOperator(text, i)) {
      parts.push(text.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** True when EVERY value branch of the binding is a path this file derived. */
function bindsOwnedPath(code, bindingRegex) {
  bindingRegex.lastIndex = 0;
  let hit;
  while ((hit = bindingRegex.exec(code)) !== null) {
    const equals = code.indexOf('=', hit.index + hit[0].length - 1);
    if (equals === -1) continue;
    const branches = valueBranches(initializerAt(code, equals));
    if (branches.length > 0 && branches.every((branch) => OWNED_BRANCH.test(branch))) return true;
  }
  return false;
}

/** True when the file binds `root` from a path the file itself derived. */
function isLocallyOwned(code, root) {
  const id = root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    // const/let/var x[: T] = <owned in every branch>
    bindsOwnedPath(
      code,
      new RegExp(String.raw`\b(?:const|let|var)\s+${id}\s*(?::[^=\n]*)?=`, 'g'),
    ) ||
    // x = <owned in every branch>  (declared above, assigned inside a try)
    bindsOwnedPath(code, new RegExp(String.raw`(?<![\w$.])${id}\s*=(?!=)`, 'g')) ||
    // for (const x of <locally listed entries>)
    new RegExp(String.raw`\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+${id}\b`).test(code) ||
    // const { x } = resolveProjectPaths(...) / destructured owned bag
    new RegExp(String.raw`\b(?:const|let|var)\s*\{[^}\n]*\b${id}\b[^}\n]*\}\s*=`).test(code) ||
    // import { x } from '...'  (a module-level constant, not caller input)
    new RegExp(String.raw`\bimport\s*\{[^}]*\b${id}\b[^}]*\}\s*from`).test(code)
  );
}

/** Line number (1-based) for an absolute offset. */
function lineAt(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) if (code[i] === '\n') line++;
  return line;
}

/**
 * Pure analysis. Exported so the co-located `__fixtures__` can be exercised
 * directly by the fixture-coverage harness.
 */
export function analyzeDestructivePathContainment(content, filePath) {
  const violations = [];
  if (!isAnalyzableSource(filePath)) return violations;

  const code = blankStringContents(stripComments(content));
  if (!/\brecursive\s*:\s*true\b/.test(code)) return violations;
  // The file already reasons about path escape — residual judgement is human.
  if (provesContainment(code)) return violations;

  const rawLines = content.split('\n');
  DELETE_CALL.lastIndex = 0;
  let match;
  while ((match = DELETE_CALL.exec(code)) !== null) {
    const openParen = code.indexOf('(', match.index + match[0].length - 1);
    const args = callArguments(code, openParen);
    if (args === undefined) continue;
    if (!/\brecursive\s*:\s*true\b/.test(args)) continue;

    const root = unprovenRoot(firstArgument(args));
    if (root === undefined) continue;
    if (isLocallyOwned(code, root)) continue;

    const line = lineAt(code, match.index);
    const here = rawLines[line - 1] ?? '';
    const above = rawLines[line - 2] ?? '';
    if (INLINE_OK.test(here) || INLINE_OK.test(above)) continue;

    violations.push({
      line,
      column: 1,
      severity: 'warning',
      message:
        `Recursive delete (\`${match[2]}(… { recursive: true })\`) targets \`${root}\`, a value this file ` +
        'never derived — a parameter, an options field, or an argv/env string. Nothing here proves the ' +
        'path is inside a root we own, so the blast radius is whatever the caller passed.',
      suggestion:
        `Prove containment at the deletion site: re-anchor with \`realpathSync\` and assert ` +
        `\`isPathInside(real, ownedRoot)\` (see commands/uninstall/project-removal-safety.ts), or derive ` +
        `\`${root}\` locally (\`mkdtempSync\` / \`join(<owned root>, …)\`) so it cannot escape. ` +
        'A try/catch is not a fix — it runs after the tree is gone. ' +
        'If containment is genuinely established elsewhere, annotate with `// destructive-path-ok: <why>`.',
      match: root,
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'c4d1f8a2-6b57-4e93-9a0c-71e2d5b8f3a6',
    slug: 'error-destructive-path-containment',
    // Phase A.4: ships disabled; runs only via the error-migration ratchet lane until its
    // ledger slice is closed. Enabling it today would take the dogfood gate red on the
    // existing backlog, which is how a new guardrail gets waived instead of adopted.
    disabled: true,
    description:
      'A recursive filesystem delete (recursive: true) must not target a path the file never derived — a parameter, an options field, or an argv/env value. Prove containment (realpath + isPathInside) or derive the path locally.',
    scope: { languages: [], concerns: [] },
    tags: ['resilience', 'security', 'blast-radius', 'filesystem'],
    fileTypes: ['ts', 'tsx', 'mjs', 'js'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeDestructivePathContainment(content, filePath),
  }),
];
