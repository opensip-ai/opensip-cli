// @fitness-ignore-file shipped-checks-must-be-generic -- opensip-internal dogfood check (plan 09 Task 1.3, ADR-paired): path-gated to opensip's own check packs; inert for adopters.
/**
 * @fileoverview String pre-filter ⊇ authoritative matcher (the superset
 * invariant, plan 09 Phase 1 / ADR-paired).
 *
 * A check that gates its authoritative AST/regex pass on a hand-authored
 * substring pre-filter must keep the filter a strict SUPERSET of what the
 * matcher can match — a narrower filter is a latent false-negative that
 * green-passes real findings (the shipped `no-any-types` bug: `': any'`
 * required a space, so `:any` returned CLEAN without running the checker).
 *
 * The invariant is semantic; this check mechanizes its two proven
 * high-confidence violation classes:
 *  A. a QUICK_FILTER keyword list containing an element with LEADING or
 *     TRAILING whitespace — formatting-variant-sensitive by construction
 *     (a formatter rewrite defeats it);
 *  B. an END-anchored regex tested against whole-file `content` — `/x$/`
 *     only matches a file whose final bytes are `x` (the
 *     in-memory-repository-detection dead-gate bug); anchors belong on the
 *     extracted name, never the content gate.
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

const CHECK_PACK_PATH = /(?:^|\/)packages\/fitness\/checks-[^/]+\/src\/checks\//;
const NON_SOURCE = /(?:\.test\.tsx?$|\/__tests__\/|\/__fixtures__\/)/;

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isEndAnchoredNonMultilineRegex(node: ts.Node): boolean {
  if (!ts.isRegularExpressionLiteral(node)) return false;
  const match = /^\/(.*)\/([a-z]*)$/s.exec(node.text);
  if (match === null || (match[2] ?? '').includes('m')) return false;
  const pattern = match[1] ?? '';
  if (!pattern.endsWith('$')) return false;
  let precedingBackslashes = 0;
  for (let index = pattern.length - 2; index >= 0 && pattern[index] === '\\'; index -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 0;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function analyzeStringPrefilterSuperset(
  content: string,
  filePath: string,
): CheckViolation[] {
  const normalized = filePath.replaceAll('\\', '/');
  if (!CHECK_PACK_PATH.test(normalized) || NON_SOURCE.test(normalized)) return [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return [];
  const violations: CheckViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.includes('QUICK_FILTER') &&
      node.initializer !== undefined
    ) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrayLiteralExpression(initializer)) {
        const whitespaceElement = initializer.elements.find(
          (element): element is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
            (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) &&
            element.text !== element.text.trim(),
        );
        if (whitespaceElement !== undefined) {
          const value = whitespaceElement.text;
          violations.push({
            line: lineOf(sourceFile, node),
            filePath,
            message:
              `Quick-filter keyword '${value}' carries leading/trailing whitespace — a ` +
              'formatting variant a formatter would rewrite defeats it, so the filter is ' +
              'NARROWER than the authoritative matcher (latent false-negative).',
            severity: 'error',
            suggestion:
              'Make the pre-filter a strict superset of the matcher: gate on the bare ' +
              'token substring and let the authoritative AST/regex pass be the arbiter.',
            type: 'string-prefilter-superset',
          });
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'test' &&
      isEndAnchoredNonMultilineRegex(unwrapExpression(node.expression.expression)) &&
      node.arguments.length > 0
    ) {
      const argument = unwrapExpression(node.arguments[0]);
      if (ts.isIdentifier(argument) && argument.text === 'content') {
        violations.push({
          line: lineOf(sourceFile, node),
          filePath,
          message:
            'End-anchored regex tested against whole-file content — `/x$/` only matches a ' +
            'file whose final bytes are `x`, so this gate is dead or near-dead on real ' +
            '(newline-terminated) files.',
          severity: 'error',
          suggestion:
            'Test the anchored pattern against the extracted NAME (class/function/identifier); ' +
            'gate on an unanchored stem substring for the content pre-filter.',
          type: 'string-prefilter-superset',
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return violations;
}

export const stringPrefilterSuperset = defineCheck({
  id: 'c8a4b7d2-1e0f-4c53-8d26-6b9e4a7f0d11',
  slug: 'string-prefilter-superset',
  description:
    'Check-pack string pre-filters must stay a strict superset of the authoritative matcher they gate',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'quality'],
  fileTypes: ['ts'],
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeStringPrefilterSuperset(content, filePath),
});
