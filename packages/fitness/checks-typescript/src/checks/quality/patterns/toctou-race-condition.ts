/**
 * @fileoverview TOCTOU Race Condition Detection Check
 *
 * Detects Time-of-Check-Time-of-Use race conditions where data is read,
 * then updated without passing version/condition for atomic updates.
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

import { classifyFunctionCalls } from './toctou-race-condition-classify.js';
import {
  collectClassInMemoryFieldNames,
  collectEnclosingLocalCollectionNames,
  collectInterfaceCollectionFields,
  collectLocalCollectionNames,
  collectLocalObjectCollectionFieldKeys,
  collectThisCollectionFieldAliases,
  isFunctionLikeNode,
  type FunctionLikeNode,
} from './toctou-race-condition-collection.js';
import {
  buildEffectiveSafePaths,
  hasAtomicPatterns,
  isSafeToctouPath,
} from './toctou-race-condition-constants.js';

function getFunctionNameFromNode(node: FunctionLikeNode, sourceFile: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
    return node.name?.getText(sourceFile) ?? 'anonymous';
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.getText(sourceFile);
    }
  }
  return 'anonymous';
}

interface CheckFunctionForToctouOptions {
  node: FunctionLikeNode;
  sourceFile: ts.SourceFile;
  interfaceCollectionFields: ReadonlyMap<string, Set<string>>;
}

function checkFunctionForToctou(options: CheckFunctionForToctouOptions): CheckViolation | null {
  const { node, sourceFile, interfaceCollectionFields } = options;
  if (!node.body) return null;

  const funcText = node.getText(sourceFile);
  if (hasAtomicPatterns(funcText)) return null;

  const localCollections = collectLocalCollectionNames(node);
  for (const name of collectEnclosingLocalCollectionNames(node)) {
    localCollections.add(name);
  }
  const classCacheFields = collectClassInMemoryFieldNames(node);
  for (const alias of collectThisCollectionFieldAliases(node, classCacheFields)) {
    localCollections.add(alias);
  }
  const localObjectCollectionKeys = collectLocalObjectCollectionFieldKeys(
    node,
    interfaceCollectionFields,
  );
  const { hasSharedReadAndUpdateOnSameReceiver } = classifyFunctionCalls(
    node,
    localCollections,
    classCacheFields,
    localObjectCollectionKeys,
  );

  if (!hasSharedReadAndUpdateOnSameReceiver) return null;

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const lineNum = line + 1;
  const funcName = getFunctionNameFromNode(node, sourceFile);

  return {
    line: lineNum,
    column: character + 1,
    message: `Function '${funcName}' has read-then-update pattern without atomic guarantees`,
    severity: 'warning',
    suggestion:
      'Use optimistic locking: pass expectedVersion to update, or use ConditionExpression for DynamoDB, or wrap in a transaction with SELECT FOR UPDATE for SQL',
    match: funcName,
  };
}

/**
 * Analyze a file for TOCTOU race conditions. Exported for the FP-regression
 * suite (see `__tests__/toctou-fp.test.ts`).
 */
export function analyzeFileForToctou(filePath: string, content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];

  const safePaths = buildEffectiveSafePaths();
  if (isSafeToctouPath(filePath, safePaths)) {
    return violations;
  }

  if (hasAtomicPatterns(content)) {
    return violations;
  }

  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return [];

  const interfaceCollectionFields = collectInterfaceCollectionFields(sourceFile);

  const visit = (node: ts.Node): void => {
    if (isFunctionLikeNode(node)) {
      const violation = checkFunctionForToctou({ node, sourceFile, interfaceCollectionFields });
      if (violation) {
        violations.push(violation);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

/**
 * Check: quality/toctou-race-condition
 *
 * Detects read-then-update patterns without atomic guarantees.
 */
export const toctouRaceCondition = defineCheck({
  id: 'eb67d6f3-c984-485d-b077-1ebabea0d894',
  slug: 'toctou-race-condition',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detects read-then-update patterns without atomic guarantees',
  longDescription: `**Purpose:** Detects Time-of-Check-Time-of-Use (TOCTOU) race conditions where data is read then updated without atomic guarantees.

**Detects:** Walks the TypeScript AST per-function. Flags a function only when both (a) at least one read call (\`.get(\`, \`.find(\`, \`.findOne(\`, \`.findFirst(\`, \`.findMany(\`, \`.getById(\`, \`.fetch(\`, \`.load(\`, \`.read(\`) and (b) at least one update call (\`.update(\`, \`.save(\`, \`.put(\`, \`.set(\`, \`.patch(\`, \`.modify(\`) target a *shared* receiver — i.e. neither a local \`Map\`/\`Set\` declared in the function nor a parameter typed \`Map<...>\`/\`Set<...>\`, nor a class field initialized to \`new Map()\`/\`new Set()\`, nor a cache-named field (\`this.cache\`, \`this.#cache\`, \`this.<X>Cache\`). Single-statement atomic SQL writes (\`tx.execute(sql\`UPDATE...\`)\`, \`tx.update(table)\`, \`tx.insert(table)\`, \`tx.delete(table)\`) are not counted as the "update" side. Skips safe contexts: in-memory caches, rate limiters, CLI/scripts, config/registry files, and functions whose body documents atomic / single-threaded semantics (\`single-threaded coalesce\`, \`Node single-threaded\`, \`event-loop semantics\`).

**Why it matters:** TOCTOU bugs allow concurrent requests to overwrite each other's changes, causing silent data loss that only manifests under load.

**Scope:** General best practice`,
  tags: ['quality', 'performance', 'best-practices'],
  fileTypes: ['ts'],
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180_000,

  analyze(content, filePath) {
    if (isTestFile(filePath)) return [];
    return analyzeFileForToctou(filePath, content);
  },
});

export { type TocTouConfig } from './toctou-race-condition-constants.js';
