// @fitness-ignore-file file-length-limit -- cohesive single-check module; splitting risks breaking the detector contract
/**
 * @fileoverview Null/Undefined Safety Check
 *
 * Detects unsafe property and method access without null checks.
 */

import { defineCheck, getCheckConfig, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/**
 * Recipe-config shape for null-safety. Project-specific safe-by-construction
 * paths and factory/builder symbols belong in a recipe's
 * `checks.config['null-safety']` block, not in the check's built-in defaults.
 */
export interface NullSafetyConfig extends Record<string, unknown> {
  /**
   * Additional path patterns whose files are skipped entirely. Each entry
   * is compiled to a case-insensitive RegExp via `new RegExp(entry, 'i')`.
   */
  additionalSafeNullPaths?: readonly string[];
  /**
   * Additional call-text prefixes treated as non-null by construction (a
   * property access on a matching call result is not flagged). Use this for
   * PROJECT-SPECIFIC factory/builder functions whose non-null contract is
   * local to your codebase — do not hardcode them into the shipped check.
   * Matched via `String.prototype.startsWith` against the full call text.
   */
  additionalSafeBuilders?: readonly string[];
}

/**
 * Patterns that indicate the access is already protected
 */
const SAFE_PATTERNS = [
  /\?\./, // Optional chaining
  /!!/, // Double negation
  /\?\?/, // Nullish coalescing
  /if\s*\(/, // Conditional check
  /&&/, // Logical AND guard
];

/**
 * Call prefixes whose results are non-null by construction, so a property
 * access on them needs no guard. Scope is deliberately limited to facts that
 * hold for ANY codebase:
 *
 *   1. Language / runtime guarantees — `Object.*`, `Array.*`, `JSON.*`,
 *      `new URL()`, Node `crypto`/`child_process`, `Intl`, the TS compiler API.
 *   2. Widely-used libraries whose builder/query APIs are documented non-null
 *      — Zod, TypeORM, Drizzle, better-sqlite3, neverthrow `Result`, Express.
 *   3. Generic builder-pattern conventions — `builder.`, `*ResultBuilder.`.
 *
 * PROJECT-SPECIFIC safe symbols must NOT be hardcoded here: baking one
 * codebase's invariants into a generic check silently suppresses real null
 * bugs in every other codebase (e.g. an adopter whose own `getThing()` can
 * return null). Adopters extend this set with their own factories via the
 * `additionalSafeBuilders` recipe-config key — see `buildEffectiveSafeBuilders`.
 */
const SAFE_BUILDER_PREFIXES = [
  // 1. Language / runtime guarantees
  'Object.entries',
  'Object.values',
  'Object.keys',
  'Object.assign',
  'Object.freeze',
  'Array.from',
  'Array.isArray',
  'String(',
  'Number(',
  'Boolean(',
  'Buffer.from',
  'JSON.stringify',
  'JSON.parse',
  'process.memoryUsage',
  'pathToFileURL(',
  'fileURLToPath(',
  'new URL(',
  'spawn(',
  'fork(',
  'createHash(',
  'createHmac(',
  'createCipheriv(',
  'createDecipheriv(',
  'new Intl.',
  'Intl.NumberFormat',
  'Intl.DateTimeFormat',
  // TypeScript compiler API (always return valid objects)
  'sourceFile.getLineAndCharacterOfPosition',
  'node.getText',
  'node.getStart',
  'node.getEnd',
  'node.getWidth',
  'node.getFullWidth',
  // Browser APIs with guaranteed non-null returns
  'window.matchMedia',
  'document.createElement',
  'document.createTextNode',
  // 2. Common library builder / query APIs
  'z.', // Zod schema builder (z.string(), z.object(), …)
  'createQueryBuilder', // TypeORM QueryBuilder
  'getRepository', // TypeORM Repository
  'EntityManager.', // TypeORM EntityManager
  'queryBuilder.', // TypeORM QueryBuilder variable
  'repository.', // TypeORM Repository variable
  'Result.', // Result pattern builder
  'ResultAsync.', // neverthrow ResultAsync
  'prepare(', // better-sqlite3 db.prepare() → Statement
  'drizzle(', // Drizzle instance creation
  'db.select', // Drizzle query builder
  'db.insert',
  'db.update',
  'db.delete',
  'res.status', // Express/Fastify response chaining
  'response.status',
  // 3. Generic builder-pattern conventions
  'builder.',
  'ResultBuilder.',
  'ScenarioResultBuilder.',
];

/**
 * Known safe method names in fluent APIs that always return `this` or non-null values.
 */
const SAFE_FLUENT_METHODS = new Set([
  // Promise methods
  'then',
  'catch',
  'finally',
  // Array methods (iteration)
  'map',
  'filter',
  'reduce',
  'flatMap',
  'forEach',
  'some',
  'every',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'includes',
  'indexOf',
  'lastIndexOf',
  'at',
  'flat',
  'entries',
  'keys',
  'values',
  // Array methods (mutation/creation)
  'slice',
  'concat',
  'sort',
  'reverse',
  'join',
  'push',
  'pop',
  'shift',
  'unshift',
  'fill',
  // String methods
  'trim',
  'trimStart',
  'trimEnd',
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'split',
  'replace',
  'replaceAll',
  'substring',
  'substr',
  'slice',
  'padStart',
  'padEnd',
  'charAt',
  'charCodeAt',
  'startsWith',
  'endsWith',
  'match',
  'search',
  'normalize',
  'repeat',
  // Iterator methods
  'next',
  // Buffer methods
  'toString',
  // HTTP response chaining (Express/Fastify)
  'json',
  'send',
  'status',
  'header',
  'type',
  'code',
  // TypeORM QueryBuilder fluent methods
  'where',
  'andWhere',
  'orWhere',
  'having',
  'orderBy',
  'addOrderBy',
  'groupBy',
  'addGroupBy',
  'select',
  'addSelect',
  'leftJoin',
  'leftJoinAndSelect',
  'innerJoin',
  'innerJoinAndSelect',
  'limit',
  'offset',
  'skip',
  'take',
  'getOne',
  'getMany',
  'getRawOne',
  'getRawMany',
  'execute',
  // Result/Option pattern methods
  'map',
  'mapErr',
  'andThen',
  'orElse',
  'unwrapOr',
  'match',
  // Builder pattern methods
  'set',
  'with',
  'withId',
  'withCode',
  'withMessage',
  'withDetails',
  'withContext',
  'withCause',
  'build',
  'add',
  'remove',
  'update',
  'delete',
  'insert',
  // Event bus / subscription methods
  'subscribe',
  'unsubscribe',
  'emit',
  'on',
  'off',
  'once',
  // Pino logger methods (return this)
  'child',
  'bindings',
  'level',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'fatal',
  // Drizzle ORM column builder methods (always return updated column definition)
  'notNull',
  'default',
  'references',
  'primaryKey',
  'unique',
  '$default',
  '$onUpdate',
  // Drizzle ORM query methods
  'from',
  'where',
  'returning',
  'onConflictDoNothing',
  'onConflictDoUpdate',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  // better-sqlite3 Statement methods (always return valid results)
  'run',
  'all',
  'get',
  'pluck',
  'iterate',
  'bind',
  'columns',
  'expand',
  // TypeScript compiler API methods (always return valid objects)
  'getLineAndCharacterOfPosition',
  'getText',
  'getStart',
  'getEnd',
  'getWidth',
  'getFullWidth',
  'getSourceFile',
  'getChildAt',
  'getChildren',
  'getFirstToken',
  'getLastToken',
  'forEachChild',
  // Map/Set methods
  'get',
  'set',
  'has',
  'delete',
  'clear',
  'size',
  // Singleton/factory return methods
  'getInstance',
  'create',
  'of',
  // Immutable-combinator methods — return a new non-null value built from
  // the receiver (e.g. OTel `Resource.merge`, Immutable.js `.merge`,
  // builder `.concat`/`.assign`). The chain result is never null.
  'merge',
  'mergeWith',
  // Vitest/Jest assertion methods (expect() always returns Assertion object)
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toBeDefined',
  'toBeUndefined',
  'toBeNull',
  'toBeTruthy',
  'toBeFalsy',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
  'toBeInstanceOf',
  'toBeNaN',
  'toContain',
  'toContainEqual',
  'toHaveLength',
  'toHaveProperty',
  'toHaveBeenCalled',
  'toHaveBeenCalledTimes',
  'toHaveBeenCalledWith',
  'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith',
  'toHaveReturned',
  'toHaveReturnedTimes',
  'toHaveReturnedWith',
  'toHaveLastReturnedWith',
  'toHaveNthReturnedWith',
  'toThrow',
  'toThrowError',
  'toMatch',
  'toMatchObject',
  'toMatchSnapshot',
  'toMatchInlineSnapshot',
  'resolves',
  'rejects',
  'not',
  // Vitest/Jest mock methods (vi.fn() always returns Mock object)
  'mockResolvedValue',
  'mockResolvedValueOnce',
  'mockRejectedValue',
  'mockRejectedValueOnce',
  'mockReturnValue',
  'mockReturnValueOnce',
  'mockImplementation',
  'mockImplementationOnce',
  'mockClear',
  'mockReset',
  'mockRestore',
  'mockReturnThis',
  'mockName',
  // Node.js crypto Hash/Hmac fluent methods (always return this or string)
  'update',
  'digest',
  'final',
  // Node.js ChildProcess methods (always exist on ChildProcess)
  'unref',
  'ref',
  'kill',
  // Intl formatter methods (always return formatted string)
  'format',
  'formatToParts',
  'resolvedOptions',
  // neverthrow Result methods (safe after isOk/isErr guard)
  'unwrapOr',
  'unwrapErr',
  '_unsafeUnwrap',
  '_unsafeUnwrapErr',
  // typed-inject Injector chain — every .provide* call returns a new Injector<T>, never null
  'provideValue',
  'provideClass',
  'provideFactory',
  'provide',
  // Drizzle column builder — column.$type<T>() always returns the same column reference
  '$type',
  // Commander.js Command builder — every chained method returns the Command instance
  'command',
  'description',
  'option',
  'requiredOption',
  'action',
  'argument',
  'version',
  'name',
  'alias',
  'aliases',
  'addCommand',
  'addOption',
  'addArgument',
  'hook',
  'usage',
  'summary',
  'helpOption',
  'addHelpText',
  'showHelpAfterError',
  'showSuggestionAfterError',
  'exitOverride',
  'configureOutput',
  'configureHelp',
  'allowExcessArguments',
  'allowUnknownOption',
  'enablePositionalOptions',
  'passThroughOptions',
  'storeOptionsAsProperties',
  'copyInheritedSettings',
  'combineFlagAndOptionalValue',
]);

/**
 * Common method name prefixes that indicate safe (non-null) return values.
 * Methods starting with these prefixes are conventionally designed to always
 * return a value or throw, never return null/undefined.
 */
const SAFE_METHOD_PREFIXES = [
  'get',
  'set',
  'is',
  'has',
  'to',
  'with',
  'from',
  'of',
  'create',
  'build',
  'add',
  'remove',
  'update',
  'delete',
  'find',
  'load',
  'save',
  'parse',
  'format',
  'validate',
  'check',
  'resolve',
  'register',
  'unregister',
  // Reading conventions (returns a value or throws — never null)
  'read',
  'open',
  'compute',
  'make',
  'render',
  'ensure',
  // Functional conventions — pure transforms / current-scope accessors that
  // always return a value (never null). Matches helpers like `classifyCatalog`,
  // `filterContent`, `currentScenarioRegistry`, `pickAdapter`.
  'classify',
  'filter',
  'current',
  'pick',
  'select',
];

/**
 * Check if a call expression is a known safe builder pattern.
 *
 * Two paths:
 *  1. Explicit allowlist (`SAFE_BUILDER_PREFIXES`) — exact-prefix match on the
 *     full call text (e.g. `z.string(`, `pathToFileURL(`).
 *  2. Convention heuristic — when the callee is a bare identifier whose name
 *     starts with a recognised safe verb (`get*`, `read*`, `resolve*`,
 *     `current*`, `create*`, `build*`, etc.). This is the same convention that
 *     already covers fluent-chain methods via `isSafeFluentMethod`; applying it
 *     to standalone calls closes the gap for helpers like `resolveProjectPaths`,
 *     `readScope`, `currentScenarioRegistry`, etc. whose names convey the same
 *     "returns a value or throws" contract.
 */
function isSafeBuilderPattern(
  expression: ts.CallExpression,
  sourceFile: ts.SourceFile,
  safeBuilders: readonly string[],
): boolean {
  const text = expression.getText(sourceFile);
  if (safeBuilders.some((prefix) => text.startsWith(prefix))) return true;
  if (ts.isIdentifier(expression.expression)) {
    return isSafeFluentMethod(expression.expression.text);
  }
  return false;
}

/**
 * Check if a method name is a known safe fluent API method.
 * Matches either an exact entry in SAFE_FLUENT_METHODS or a method whose name
 * starts with a common safe prefix (get, set, is, has, to, etc.).
 */
function isSafeFluentMethod(methodName: string): boolean {
  if (SAFE_FLUENT_METHODS.has(methodName)) return true;
  return SAFE_METHOD_PREFIXES.some((prefix) => methodName.startsWith(prefix));
}

/**
 * Walk ancestors to find an enclosing truthiness guard whose condition
 * references the access's base expression — an `if (...)`, a `cond ? … : …`,
 * or the left side of a `&&` chain (e.g. `if (candidates.length === 1 &&
 * candidates[0]) { … candidates[0].bodyHash … }`).
 *
 * The line-local {@link SAFE_PATTERNS} scan only inspects the physical line
 * of the access, so a guard placed on a *previous* line is missed. This
 * closes that cross-line gap. Substring matching is intentionally lenient:
 * the check errs toward treating a guarded access as safe (fewer false
 * positives), consistent with the existing line-local guard handling.
 */
function isGuardedByEnclosingCondition(
  node: ts.PropertyAccessExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const baseText = node.expression.getText(sourceFile);
  let current: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isIfStatement(parent) && parent.expression.getText(sourceFile).includes(baseText)) {
      return true;
    }
    if (
      ts.isConditionalExpression(parent) &&
      parent.condition.getText(sourceFile).includes(baseText)
    ) {
      return true;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === current &&
      parent.left.getText(sourceFile).includes(baseText)
    ) {
      return true;
    }
    current = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Check if a property access originates from `this`.
 * Accessing properties on `this` is always safe — the object exists within its own methods.
 */
function isThisAccess(node: ts.PropertyAccessExpression): boolean {
  let current: ts.Expression = node.expression;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    current = current.expression;
  }
  return current.kind === ts.SyntaxKind.ThisKeyword;
}

/**
 * Count the depth of a method chain (number of chained property accesses / calls).
 * e.g. `a.b().c().d` has depth 3.
 */
function getChainDepth(node: ts.PropertyAccessExpression): number {
  let depth = 0;
  let current: ts.Expression = node.expression;
  while (ts.isCallExpression(current) || ts.isPropertyAccessExpression(current)) {
    if (ts.isCallExpression(current)) {
      depth++;
      current = current.expression;
    } else {
      current = current.expression;
    }
  }
  return depth;
}

/**
 * Check if a property access chain is on a Zod method call
 * Handles chained calls like z.string().min(1).optional()
 */
function isZodBuilderChain(node: ts.PropertyAccessExpression, sourceFile: ts.SourceFile): boolean {
  // Walk the full expression chain to find if it originates from z.xxx()
  // Handles arbitrary depth: z.string().regex().optional().superRefine().pipe()
  let current: ts.Expression = node.expression;

  while (current) {
    if (ts.isCallExpression(current)) {
      const result = checkZodCallExpression(current, sourceFile);
      if (result.resolved) return result.isZod;
      current = result.next;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      if (current.expression.getText(sourceFile) === 'z') return true;
      current = current.expression;
      continue;
    }
    if (ts.isIdentifier(current)) {
      return current.text === 'z';
    }
    break;
  }
  return false;
}

/** Check if a call expression callee originates from z.xxx() */
function checkZodCallExpression(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
): { resolved: true; isZod: boolean } | { resolved: false; next: ts.Expression } {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.getText(sourceFile).startsWith('z.')) return { resolved: true, isZod: true };
    return { resolved: false, next: callee.expression };
  }
  if (ts.isIdentifier(callee)) {
    return { resolved: true, isZod: callee.text === 'z' };
  }
  return { resolved: false, next: callee };
}

/**
 * Check if a property access is part of a fluent API chain
 * Handles patterns like promise.then().catch() or queryBuilder.where().orderBy()
 */
function isFluentChain(node: ts.PropertyAccessExpression): boolean {
  const expression = node.expression;

  // Check if we're accessing a property on a call expression
  if (!ts.isCallExpression(expression)) return false;

  // Walk the chain — if ANY method in the chain is a known fluent method, the chain is safe
  let current: ts.Expression = expression;

  while (ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current.expression)) {
      const methodName = current.expression.name.text;
      if (isSafeFluentMethod(methodName)) {
        return true;
      }
      // Walk deeper into the chain
      current = current.expression.expression;
      continue;
    }
    break;
  }

  return false;
}

/**
 * Path patterns where null-safety findings are dominated by safe-by-construction
 * builders that the AST analyzer cannot fully resolve:
 *
 * - `**\/di/fragment.ts`, `**\/di/fragments/*.ts` — typed-inject Injector chains
 *   (`.provideValue/.provideClass/...` always return Injector<T>); the chain
 *   is split across many lines so the AST chain-depth heuristic does not always
 *   apply. The whole-file safe-list captures the convention.
 * - `**\/schema/*.ts`, `**\/*-schema.ts` — Drizzle/Zod schema declarations are
 *   pure column/shape builders. No runtime null-access surface to protect.
 *
 * These are deliberately generic path conventions. Project-specific safe paths
 * (e.g. a bespoke schema/DI folder layout) belong in the
 * `additionalSafeNullPaths` recipe-config key, not in these built-in defaults.
 */
const SAFE_NULL_PATHS: readonly RegExp[] = [
  /\/di\/fragment\.ts$/,
  /\/di\/fragments\//,
  /\/schema\//,
  /-schema\.ts$/,
];

/** Merge built-in defaults with the recipe-config slice. */
function buildEffectiveSafePaths(): readonly RegExp[] {
  const cfg = getCheckConfig<NullSafetyConfig>('null-safety');
  const extras = (cfg.additionalSafeNullPaths ?? []).map((src) => new RegExp(src, 'i'));
  return [...SAFE_NULL_PATHS, ...extras];
}

/**
 * Merge the built-in (generic) safe-builder prefixes with any project-specific
 * ones supplied via `checks.config['null-safety'].additionalSafeBuilders`.
 */
function buildEffectiveSafeBuilders(): readonly string[] {
  const cfg = getCheckConfig<NullSafetyConfig>('null-safety');
  return [...SAFE_BUILDER_PREFIXES, ...(cfg.additionalSafeBuilders ?? [])];
}

function isSafeNullPath(filePath: string, paths: readonly RegExp[]): boolean {
  return paths.some((p) => p.test(filePath));
}

/**
 * @param {*} content
 * @param {*} filePath
 * @returns {*}
 * Analyze a file for null safety issues. Exported for the FP-regression
 * suite (see `__tests__/null-safety-fp.test.ts`).
 */
export function analyzeNullSafety(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  // Skip safe-by-construction path families (DI fragments + schema declarations).
  // Built-in defaults are merged with the recipe-config slice once per file.
  const safePaths = buildEffectiveSafePaths();
  if (isSafeNullPath(filePath, safePaths)) return violations;

  // Effective safe-builder prefixes = generic built-ins + project config.
  const safeBuilders = buildEffectiveSafeBuilders();

  try {
    const sourceFile = getSharedSourceFile(filePath, content);
    if (!sourceFile) return [];

    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);

      // Only check property access expressions that aren't optional chains
      if (!ts.isPropertyAccessExpression(node) || ts.isOptionalChain(node)) return;

      const expression = node.expression;

      // Only flag call expressions or element access (potentially nullable)
      if (!ts.isCallExpression(expression) && !ts.isElementAccessExpression(expression)) return;

      // Skip property access on `this` — the object always exists in its own methods
      if (isThisAccess(node)) return;

      // Skip method chains longer than 2 — fluent APIs are designed to return non-null
      if (getChainDepth(node) > 2) return;

      // Skip Zod builder pattern chains (z.string().min(1).optional())
      if (isZodBuilderChain(node, sourceFile)) return;

      // Skip known safe builder patterns
      if (
        ts.isCallExpression(expression) &&
        isSafeBuilderPattern(expression, sourceFile, safeBuilders)
      )
        return;

      // Skip fluent API chains (promise.then().catch(), queryBuilder.where().orderBy())
      if (isFluentChain(node)) return;

      const propName = node.name.text;

      // Skip if accessing a known safe fluent method
      if (isSafeFluentMethod(propName)) return;

      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      const lineText = content.split('\n')[line] ?? '';

      // Skip if line has safety patterns
      if (SAFE_PATTERNS.some((p) => p.test(lineText))) return;

      // Skip if guarded by an enclosing if / ternary / && condition on a
      // previous line (the line-local scan above only sees this line).
      if (isGuardedByEnclosingCondition(node, sourceFile)) return;

      // Skip common safe cases
      if (['length', 'toString', 'valueOf'].includes(propName)) return;

      const lineNum = line + 1;
      const matchText = node.getText(sourceFile);

      violations.push({
        line: lineNum,
        column: character + 1,
        message: `Potentially unsafe property access '.${propName}' without null check`,
        severity: 'warning',
        type: 'unsafe-access',
        suggestion: `Use optional chaining: change '.${propName}' to '?.${propName}', or add an explicit null/undefined check before accessing the property`,
        match: matchText,
      });
    };

    visit(sourceFile);
  } catch {
    // @swallow-ok Skip files that fail to parse
  }

  return violations;
}

/**
 * Check: quality/null-safety
 *
 * Detects unsafe property and method access without null checks.
 */
export const nullSafety = defineCheck({
  id: '011c993e-829b-4423-8032-0b7c9baa22bf',
  slug: 'null-safety',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect unsafe property and method access without null checks',
  longDescription: `**Purpose:** Detects property access on potentially nullable expressions (call results, element access) that lack null/undefined guards, preventing runtime \`TypeError\` crashes.

**Detects:**
- Property access (\`.foo\`) on call expression or element access results without optional chaining (\`?.\`), nullish coalescing (\`??\`), \`&&\` guards, or \`if\` checks
- Skips known safe patterns: Zod builder chains (\`z.string().min()\`), TypeORM QueryBuilder fluent chains, Promise \`.then().catch()\`, and Result pattern methods. Project-specific factories can be added via the \`additionalSafeBuilders\` config key.
- Skips safe property names: \`length\`, \`toString\`, \`valueOf\`
- Excludes contracts, schemas, types, CLI/internal tools, and foundation infrastructure files

**Why it matters:** Accessing a property on a \`null\` or \`undefined\` value causes runtime \`TypeError\` exceptions that crash the process if uncaught.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'code-quality', 'type-safety'],
  fileTypes: ['ts', 'tsx'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files — null safety in tests is low-risk due to controlled inputs
    if (isTestFile(filePath)) return [];
    return analyzeNullSafety(content, filePath);
  },
});
