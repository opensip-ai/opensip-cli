/**
 * @fileoverview Null-safety analysis — convention and type-aware detectors.
 */

import { type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';
import {
  getSharedSourceFile,
  isTypeNullable,
  type TypeCheckedProgram,
} from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

import {
  buildEffectiveSafeBuilders,
  buildEffectiveSafePaths,
  isSafeNullPath,
  SAFE_PATTERNS,
} from './null-safety-config.js';
import {
  getChainDepth,
  isFluentChain,
  isGuardedByEnclosingCondition,
  isSafeBuilderPattern,
  isSafeFluentMethod,
  isThisAccess,
  isZodBuilderChain,
} from './null-safety-heuristics.js';

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
 * Type-aware variant (D2): walk the Program's SourceFile and flag a property
 * access on a call/element-access result ONLY when the receiver's actual type
 * includes `null`/`undefined`. The TypeChecker subsumes every heuristic the
 * convention path uses — control-flow narrowing (guards), builder/Zod return
 * types, and chain depth all fall out of real types — so this detector is
 * deliberately minimal. Fail-open: `any`/`unknown`/unresolved types are not
 * nullable per `isTypeNullable`, so "the compiler doesn't know" never flags.
 *
 * Reads the same path skip + escape-hatch config as the convention path
 * (`additionalSafeNullPaths`, `additionalSafeBuilders`). Exported for the
 * type-aware test suite.
 */
export function analyzeNullSafetyTyped(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = [];

  const safePaths = buildEffectiveSafePaths();
  if (isSafeNullPath(filePath, safePaths)) return violations;

  // Manual escape hatch for symbols the checker can't resolve (untyped JS
  // boundaries, ambient factories): a matching receiver call-text is trusted.
  const safeBuilders = buildEffectiveSafeBuilders();

  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, visit);

    if (!ts.isPropertyAccessExpression(node) || ts.isOptionalChain(node)) return;
    const expression = node.expression;
    if (!ts.isCallExpression(expression) && !ts.isElementAccessExpression(expression)) return;
    // No `isThisAccess` skip here (unlike the convention path): the checker types
    // `this`-rooted chains correctly — `this.prop` isn't a candidate (receiver is
    // not a call), and `this.getThing()` where getThing() returns nullable SHOULD
    // flag — so the heuristic would only cause false negatives.

    const propName = node.name.text;
    if (['length', 'toString', 'valueOf'].includes(propName)) return;

    const receiverText = expression.getText(sourceFile);
    if (safeBuilders.some((prefix) => receiverText.startsWith(prefix))) return;

    // The one decision: does the receiver's ACTUAL type include null/undefined?
    if (!isTypeNullable(checker.getTypeAtLocation(expression))) return;

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    violations.push({
      line: line + 1,
      column: character + 1,
      message: `Potentially unsafe property access '.${propName}' without null check`,
      severity: 'warning',
      type: 'unsafe-access',
      suggestion: `Use optional chaining: change '.${propName}' to '?.${propName}', or add an explicit null/undefined check before accessing the property`,
      match: node.getText(sourceFile),
    });
  };

  visit(sourceFile);
  return violations;
}

/** Type-aware per-file analysis (D2): flag via the shared Program's checker. */
export function analyzeFileTyped(program: TypeCheckedProgram, filePath: string): CheckViolation[] {
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) return []; // not in the Program (e.g. excluded) — skip
  return analyzeNullSafetyTyped(sourceFile, program.checker, filePath);
}

/** Convention per-file analysis (default): scan the filtered content (no types). */
export async function analyzeFileConvention(
  files: FileAccessor,
  filePath: string,
): Promise<CheckViolation[]> {
  try {
    // FileAccessor.read applies this check's `strip-strings` contentFilter, so
    // `content` matches what the prior per-file `analyze` mode received.
    const content = await files.read(filePath);
    return analyzeNullSafety(content, filePath);
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- an unreadable target file is an expected skip (the engine's own analyze mode does the same — see define-check.ts executeAnalyzeMode); a pure check has no actionable error to surface here.
    return []; // unreadable file — skip, matching per-file analyze resilience
  }
}
