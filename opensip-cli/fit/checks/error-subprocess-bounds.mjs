/**
 * @fileoverview error-subprocess-bounds — a call into one of Node's OUTPUT-
 *               BUFFERING child-process primitives (`exec`, `execSync`,
 *               `execFile`, `execFileSync`, `spawnSync`) must carry at least one
 *               bound in its statically visible options object: `timeout`,
 *               `maxBuffer`, or `signal`. A call with a visible options literal
 *               that names none of the three — or a call with no options
 *               argument at all — is unbounded: the child may run forever and
 *               its output accumulates in the parent's heap until the process
 *               dies. Project-local SELF-check for opensip-cli.
 *
 * WHY LOCAL, not a shipped `@opensip-cli/checks-*` rule: the *pattern* is
 * generic, but the *bar* is an opensip-internal policy decision. opensip-cli is
 * a long-lived CLI that shells out from a kernel watchdog, a process-teardown
 * walk, and a plugin installer — surfaces where a hung `pgrep` / `wmic` / `npm`
 * blocks the event loop with no recovery path and no diagnostic. Plenty of
 * legitimate programs shell out unbounded on purpose (a one-shot build script,
 * an interactive wrapper), so shipping this at error/warning rung into arbitrary
 * customer repos would produce exactly the "fires on correct code, gets
 * disabled" outcome `shipped-checks-must-be-generic` steers away from. It also
 * encodes a local fact: this repo has already converged on the correct form —
 * `packages/core/src/lib/git-changed-files.ts` and
 * `packages/core/src/lib/host-process-identity.ts` set BOTH `maxBuffer` and
 * `timeout` on the same `git`/`/bin/ps` shapes that `kill-tree.ts` and
 * `rss-watchdog.ts` still call bare. The rule ratchets the codebase toward the
 * form it already knows is right.
 *
 * WHAT IT DELIBERATELY DOES NOT FLAG — the precision decisions, each one taken
 * because flagging it would fire on code this repo's reviewers consider correct:
 *
 *   1. Async `spawn` and `fork`. They return a live `ChildProcess` handle and
 *      have NO `maxBuffer` concept at all; the caller bounds them out of band.
 *      Every async spawn site here does exactly that — `shard-runner.ts`,
 *      `workspace-runner.ts`, `repair/verify-runner.ts`,
 *      `fitness/.../abortable-exec.ts` and `mcp/src/repair-write-port.ts` all
 *      arm a `setTimeout(... child.kill ...)` and a bounded stdout capture.
 *      Reading the options bag alone would report all of them as unbounded,
 *      which is false. Whether an async spawn is bounded is a whole-function
 *      judgement this check does not attempt. `spawnSync` IS in scope: it
 *      buffers, takes `maxBuffer`/`timeout`, and cannot be bounded any other way.
 *   2. Any call whose options are not statically visible: a variable
 *      (`execFileSync(cmd, args, opts)`), a spread inside the literal
 *      (`{ ...base, cwd }`), a computed key, or a spread argument. The bound may
 *      well be in there; guessing would trade precision for recall, and this
 *      check is built to be trusted, not to be exhaustive.
 *   3. `killSignal`, `windowsHide`, `stdio`, `encoding`, `cwd`, `env` — none of
 *      these bound anything. `killSignal` only picks WHICH signal is used once
 *      some other bound fires. `stdio: 'ignore'` still leaves the wall clock
 *      unbounded.
 *   4. `exec`/`spawn` that are NOT the child_process ones. The check resolves
 *      real import bindings first (named import, aliased import, namespace,
 *      default, `require` destructure, and `promisify(execFile)` aliases), so
 *      `RegExp.prototype.exec` — pervasive in a static-analysis codebase —
 *      `.spawn()` on some emitter, and a local helper named `exec` are all
 *      structurally out of reach. A file with no child_process binding is never
 *      examined. This mirrors the provenance discipline the shipped
 *      `input-sanitization` check already uses for the same collision.
 *   5. Tests, `__tests__`, fixtures, `.d.ts`, and `dist`. A test that shells out
 *      is bounded by the test runner.
 *
 * Comments cannot trip this rule by construction: detection runs on the parsed
 * TypeScript AST, where a comment is trivia and never a CallExpression. Prose in
 * this file's own header naming `execFileSync` is therefore inert, and so is a
 * doc block in the scanned source explaining why a bound was chosen.
 *
 * Severity is `warning`, matching the sibling local resilience checks under
 * `opensip-cli/fit/checks/resilience/`. The repo gates at `failOnWarnings: 1`,
 * so a warning is still a hard local failure — the rung communicates "resiliency
 * debt", not "advisory".
 */
import { defineCheck } from '@opensip-cli/fitness';
import ts from 'typescript';

/** Module specifiers that yield Node's child-process primitives. */
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);

/**
 * The OUTPUT-BUFFERING primitives only. Node accumulates the child's entire
 * stdout+stderr in the parent's memory for each of these and enforces
 * `timeout`/`maxBuffer` itself, so the options bag is the ONLY place a bound can
 * live — which is what makes "no bound in a visible literal" a provable defect
 * rather than a guess. `spawn`/`fork` are excluded on purpose (see header §1).
 */
const BUFFERING_PRIMITIVES = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawnSync']);

/** Primitives whose signature is `(command, options?, callback?)` — no args array. */
const COMMAND_STRING_FORMS = new Set(['exec', 'execSync']);

/** Primitives that accept a trailing node-style callback (the async forms). */
const CALLBACK_FORMS = new Set(['exec', 'execFile']);

/**
 * Option keys that genuinely bound a buffering child process.
 * - `timeout`  — wall clock; Node kills the child with `killSignal`.
 * - `maxBuffer`— output ceiling; Node kills the child on overflow.
 * - `signal`   — an AbortSignal; the caller's own deadline/cancellation drives it.
 * Any ONE of the three is sufficient. `killSignal` is NOT a bound (header §3).
 */
const BOUND_KEYS = new Set(['timeout', 'maxBuffer', 'signal']);

/**
 * This check's OWN fixture tree, re-admitted so
 * `__fixtures__/error-subprocess-bounds/fit.fixture.config.yml` can run the rule
 * against its synthetic pass/fail pair as live proof. Every OTHER check's
 * fixtures stay excluded — several of them (input-sanitization,
 * adapter-must-use-substrate, external-tool-adapter-contract) contain unbounded
 * subprocess calls ON PURPOSE, as the payload their own rule detects. Same
 * self-fixture carve-out as `no-module-singleton.mjs`.
 */
const SELF_FIXTURE_PATH = /opensip-cli\/fit\/checks\/__fixtures__\/error-subprocess-bounds\//;

/** Files whose subprocess calls are out of scope (tests, fixtures, generated). */
function isOutOfScopeFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return true;
  const p = filePath.replaceAll('\\', '/');
  if (!/\.(?:ts|tsx|mts|cts)$/.test(p)) return true;
  if (p.endsWith('.d.ts')) return true;
  if (p.includes('/__fixtures__/') || p.includes('/fixtures/')) return !SELF_FIXTURE_PATH.test(p);
  return (
    /\.test\.[cm]?tsx?$/.test(p) ||
    p.includes('/__tests__/') ||
    p.includes('/dist/') ||
    p.includes('/node_modules/')
  );
}

/**
 * Bindings a file holds to child_process, resolved from real import/require
 * syntax. `direct` maps a LOCAL name to the canonical primitive it denotes
 * (so `import { execFile as run }` is understood); `namespaces` holds names
 * bound to the whole module object (`cp.execSync(...)`).
 */
function collectBindings(sourceFile) {
  const direct = new Map();
  const namespaces = new Set();

  const fromModuleSpecifier = (node) =>
    ts.isStringLiteral(node) && CHILD_PROCESS_MODULES.has(node.text);

  const bindNamed = (localName, importedName) => {
    if (BUFFERING_PRIMITIVES.has(importedName)) direct.set(localName, importedName);
  };

  /** A call to `fn('child_process')` / `fn('node:child_process')` with one argument. */
  const isSingleArgCallTo = (node, fnName) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === fnName &&
    node.arguments.length === 1;

  /** `import { execFileSync } / { execFile as run } / * as cp / cp from 'node:child_process'` */
  const readImport = (node) => {
    if (!ts.isImportDeclaration(node) || !fromModuleSpecifier(node.moduleSpecifier)) return;
    const clause = node.importClause;
    // A type-only import binds no runtime value — it can never be a call site.
    if (!clause || clause.isTypeOnly) return;
    if (clause.name) namespaces.add(clause.name.text);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      namespaces.add(named.name.text);
      return;
    }
    if (!named || !ts.isNamedImports(named)) return;
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      bindNamed(element.name.text, (element.propertyName ?? element.name).text);
    }
  };

  /** `const cp = require('child_process')` / `const { execSync } = require(...)` */
  const readRequire = (node, init) => {
    if (!isSingleArgCallTo(init, 'require') || !fromModuleSpecifier(init.arguments[0])) return;
    if (ts.isIdentifier(node.name)) {
      namespaces.add(node.name.text);
      return;
    }
    if (!ts.isObjectBindingPattern(node.name)) return;
    for (const element of node.name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const imported = element.propertyName;
      const importedName =
        imported && ts.isIdentifier(imported) ? imported.text : element.name.text;
      bindNamed(element.name.text, importedName);
    }
  };

  /**
   * `const execFileAsync = promisify(execFile)` — the promisified alias keeps the
   * SAME options bag (and the same buffering semantics), so the bound requirement
   * travels with it.
   */
  const readPromisifyAlias = (node, init) => {
    if (!isSingleArgCallTo(init, 'promisify')) return;
    if (!ts.isIdentifier(init.arguments[0]) || !ts.isIdentifier(node.name)) return;
    const source = direct.get(init.arguments[0].text);
    if (source !== undefined) direct.set(node.name.text, source);
  };

  const visit = (node) => {
    readImport(node);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      readRequire(node, node.initializer);
      readPromisifyAlias(node, node.initializer);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { direct, namespaces };
}

/** The canonical buffering primitive this call invokes, or undefined. */
function canonicalPrimitive(call, bindings) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return bindings.direct.get(callee.text);
  // `cp.execSync(...)` — and ONLY when `cp` is a real child_process namespace,
  // which is what keeps `someRegex.exec(...)` structurally out of reach. Anything
  // else (a local helper, a method on some emitter) resolves to nothing.
  const isNamespacedPrimitive =
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    bindings.namespaces.has(callee.expression.text) &&
    ts.isIdentifier(callee.name) &&
    BUFFERING_PRIMITIVES.has(callee.name.text);
  return isNamespacedPrimitive ? callee.name.text : undefined;
}

/**
 * Verdict for a visible options literal: 'bounded', 'unbounded', or 'opaque'
 * (a spread or computed key means the real key set is not statically knowable —
 * skip rather than guess, header §2).
 */
function classifyOptionsLiteral(objectLiteral) {
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) return 'opaque';
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property) &&
      !ts.isMethodDeclaration(property)
    ) {
      continue;
    }
    const name = property.name;
    if (name === undefined) continue;
    if (ts.isComputedPropertyName(name)) return 'opaque';
    const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
    if (text !== undefined && BOUND_KEYS.has(text)) return 'bounded';
  }
  return 'unbounded';
}

/**
 * Verdict for one call. Returns 'bounded' | 'unbounded' | 'opaque'.
 *
 * The options slot is the LAST argument once a trailing node-style callback is
 * dropped. When that slot holds an object literal we read it. When the call is
 * plainly too short to have one — `execSync(cmd)`, `execFile(bin, [..], cb)` —
 * there is provably no options bag, so no bound. Anything else is opaque.
 */
function classifyCall(call, canonical) {
  const args = [...call.arguments];
  if (args.some((argument) => ts.isSpreadElement(argument))) return 'opaque';

  let effective = args;
  const last = args.at(-1);
  if (
    CALLBACK_FORMS.has(canonical) &&
    last !== undefined &&
    (ts.isArrowFunction(last) || ts.isFunctionExpression(last))
  ) {
    effective = args.slice(0, -1);
  }
  if (effective.length === 0) return 'opaque';

  const tail = effective.at(-1);
  if (ts.isObjectLiteralExpression(tail)) return classifyOptionsLiteral(tail);

  // No object literal in the options slot. Only report when the arity PROVES
  // the options bag was omitted entirely.
  if (effective.length === 1) return 'unbounded';
  if (
    !COMMAND_STRING_FORMS.has(canonical) &&
    effective.length === 2 &&
    ts.isArrayLiteralExpression(effective[1])
  ) {
    // `execFileSync(bin, ['--flag'])` — arg 1 is the argv array, so the options
    // slot (arg 2) is genuinely absent.
    return 'unbounded';
  }
  return 'opaque';
}

/**
 * Pure analysis over one file's source. Exported so the pattern can be exercised
 * directly (and read as a worked example by plugin authors).
 */
export function analyzeErrorSubprocessBounds(content, filePath) {
  const violations = [];
  if (isOutOfScopeFile(filePath)) return violations;
  // Cheap prefilter: a file that never names the module cannot hold a binding.
  if (!content.includes('child_process')) return violations;

  const normalized = filePath.replaceAll('\\', '/');
  const sourceFile = ts.createSourceFile(
    normalized,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    normalized.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const bindings = collectBindings(sourceFile);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return violations;

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const canonical = canonicalPrimitive(node, bindings);
      if (canonical !== undefined && classifyCall(node, canonical) === 'unbounded') {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push({
          severity: 'warning',
          line: position.line + 1,
          // Signal columns are 1-based (see signal-column-one-based).
          column: position.character + 1,
          message:
            `\`${canonical}\` runs a child process with no bound: its options carry no ` +
            '`timeout`, no `maxBuffer`, and no `signal`. Node buffers the whole child output in ' +
            'this process and will wait forever, so a hung or chatty binary blocks the run with ' +
            'no recovery and no diagnostic.',
          suggestion:
            'Add a wall-clock `timeout` (plus `killSignal` if the binary traps SIGTERM) and a ' +
            '`maxBuffer` ceiling, or pass an AbortSignal via `signal`. See ' +
            'packages/core/src/lib/git-changed-files.ts for the accepted form. If the child is ' +
            'genuinely long-running, use `spawn` and bound it explicitly instead.',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export const checks = [
  defineCheck({
    id: 'c7d1f4a2-6b93-4e05-9a8f-3d21b0e7c614',
    slug: 'error-subprocess-bounds',
    // Phase A.4: ships disabled; runs only via the error-migration ratchet lane until its
    // ledger slice is closed. Enabling it today would take the dogfood gate red on the
    // existing backlog, which is how a new guardrail gets waived instead of adopted.
    disabled: true,
    description:
      'Buffering child-process calls (exec/execSync/execFile/execFileSync/spawnSync) must set at least one of timeout, maxBuffer, or signal. Options that are not statically visible, and async spawn/fork (bounded out of band), are not flagged.',
    scope: { languages: ['typescript'], concerns: ['backend', 'cli'] },
    tags: ['resilience', 'subprocess', 'timeout'],
    fileTypes: ['ts', 'tsx'],
    // AST detection needs real source; comments are trivia to the parser, so
    // stripping them up front would buy nothing and only shift positions.
    contentFilter: 'raw',
    confidence: 'high',
    analyze: (content, filePath) => analyzeErrorSubprocessBounds(content, filePath),
  }),
];
