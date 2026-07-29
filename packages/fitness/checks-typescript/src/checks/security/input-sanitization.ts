// @fitness-ignore-file no-generic-error -- Generic errors appropriate in this context
/**
 * @fileoverview Detect unsanitized user input usage
 *
 * Uses AST analysis to detect unsanitized user input in HTML injection,
 * command injection, and path traversal contexts. AST context eliminates
 * false positives from regex definitions, string constants, and comments.
 *
 *
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';
import { parseSource, walkNodes, getLineNumber } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/** Names of user input sources on request objects */
const USER_INPUT_PROPERTIES = new Set(['body', 'params', 'query']);

/** Names of request objects */
const REQUEST_OBJECT_NAMES = new Set(['request', 'req']);

/** Dangerous command execution function names */
const EXEC_FUNCTIONS = new Set([
  'exec',
  'execSync',
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
]);

/** Dangerous file system function names */
const FS_FUNCTIONS = new Set([
  'readFile',
  'readFileSync',
  'writeFile',
  'writeFileSync',
  'unlink',
  'unlinkSync',
  'rmdir',
  'rmdirSync',
  'mkdir',
  'mkdirSync',
]);

/** Node's `child_process` module specifiers. */
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);

interface ChildProcessBindings {
  /** Local names bound to a specific cp function (named import / require destructure). */
  readonly directFns: Set<string>;
  /** Local names bound to the cp module object (default/namespace import / require). */
  readonly moduleAliases: Set<string>;
}

function isChildProcessRequire(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    CHILD_PROCESS_MODULES.has(node.arguments[0].text)
  );
}

/**
 * Collect the file's bindings to Node's `child_process` module so the command-
 * injection rule can require provenance instead of matching the bare method name
 * `exec`/`spawn` — which collides with `RegExp.prototype.exec`, ORM `.exec()`,
 * `EventEmitter`-style `.spawn()`, etc.
 */
/** `import ... from 'child_process'` → record named fns + namespace/default aliases. */
function collectCpImportBinding(node: ts.Node, out: ChildProcessBindings): void {
  if (
    !ts.isImportDeclaration(node) ||
    !ts.isStringLiteral(node.moduleSpecifier) ||
    !CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text)
  ) {
    return;
  }
  const clause = node.importClause;
  if (!clause) return;
  if (clause.name) out.moduleAliases.add(clause.name.text); // default import
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    out.moduleAliases.add(named.name.text); // import * as cp from 'child_process'
  } else if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) out.directFns.add(element.name.text); // { exec, spawn as sp }
  }
}

/** `const cp = require('child_process')` / `const { exec } = require(...)`. */
function collectCpRequireBinding(node: ts.Node, out: ChildProcessBindings): void {
  if (
    !ts.isVariableDeclaration(node) ||
    !node.initializer ||
    !isChildProcessRequire(node.initializer)
  ) {
    return;
  }
  if (ts.isIdentifier(node.name)) {
    out.moduleAliases.add(node.name.text); // const cp = require('child_process')
  } else if (ts.isObjectBindingPattern(node.name)) {
    for (const element of node.name.elements) {
      if (ts.isIdentifier(element.name)) out.directFns.add(element.name.text); // const { exec } = require(...)
    }
  }
}

function collectChildProcessBindings(sourceFile: ts.SourceFile): ChildProcessBindings {
  const out: ChildProcessBindings = { directFns: new Set(), moduleAliases: new Set() };
  walkNodes(sourceFile, (node) => {
    collectCpImportBinding(node, out);
    collectCpRequireBinding(node, out);
  });
  return out;
}

/**
 * Guard for the exec rule: a matched exec-family call is a real shell exec only
 * when its callee resolves to a `child_process` binding — a named/destructured
 * function, a module alias's method, or an inline `require('child_process').x`.
 */
function makeChildProcessGuard(
  bindings: ChildProcessBindings,
): (node: ts.CallExpression) => boolean {
  return (node) => {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return bindings.directFns.has(callee.text);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = callee.expression;
      if (ts.isIdentifier(receiver)) return bindings.moduleAliases.has(receiver.text);
      return isChildProcessRequire(receiver);
    }
    return false;
  };
}

/**
 * Check if an expression tree references user input (req.body, req.params, req.query).
 * Walks the subtree of the given node looking for property access chains like
 * `request.body.field` or `req.query.param`.
 */
function referencesUserInput(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    // Check for req.body, req.params, req.query
    if (
      USER_INPUT_PROPERTIES.has(node.name.text) &&
      ts.isIdentifier(node.expression) &&
      REQUEST_OBJECT_NAMES.has(node.expression.text)
    ) {
      return true;
    }
    // Check for deeper access: req.body.field
    if (ts.isPropertyAccessExpression(node.expression)) {
      return referencesUserInput(node.expression);
    }
  }

  // Check children
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && referencesUserInput(child)) {
      found = true;
    }
  });
  return found;
}

/**
 * Check if a node is inside a string literal or regex definition,
 * which would indicate this is a pattern definition, not actual code.
 */
function isInStringOrRegex(node: ts.Node): boolean {
  let current = node.parent;
  while (!ts.isSourceFile(current)) {
    /* v8 ignore next -- defensive AST/type guard */
    if (ts.isStringLiteral(current) || ts.isRegularExpressionLiteral(current)) return true;
    /* v8 ignore next -- defensive AST/type guard */
    if (ts.isNoSubstitutionTemplateLiteral(current)) return true;
    current = current.parent;
  }
  return false;
}

function truncateMatch(node: ts.Node, maxLength = 200): string {
  const text = node.getText();
  /* v8 ignore next -- defensive AST/type guard */
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}

function checkInnerHtmlAssignment(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === 'innerHTML' &&
    referencesUserInput(node.right)
  ) {
    return {
      line: getLineNumber(node, sourceFile),
      column: 0,
      message: 'innerHTML with potential user input - use textContent or sanitize',
      severity: 'error',
      suggestion:
        'Use textContent for plain text: element.textContent = userInput. For HTML, use DOMPurify: element.innerHTML = DOMPurify.sanitize(userInput);',
      match: node.getText(),
      filePath,
    };
  }
  return null;
}

function checkDangerouslySetInnerHTML(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  if (
    ts.isJsxAttribute(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === 'dangerouslySetInnerHTML'
  ) {
    return {
      line: getLineNumber(node, sourceFile),
      column: 0,
      message: 'dangerouslySetInnerHTML usage - ensure input is sanitized',
      severity: 'warning',
      suggestion:
        'Sanitize content before using dangerouslySetInnerHTML: dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }}. Consider using markdown renderers with XSS protection.',
      match: node.getText(),
      filePath,
    };
  }
  return null;
}

function getCallFunctionName(node: ts.CallExpression): string {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  /* v8 ignore next -- defensive AST/type guard */
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

interface UnsanitizedCallRule {
  readonly functionNames: Set<string>;
  readonly message: string;
  readonly suggestion: string;
  /**
   * Optional provenance gate: matched by name, but only a real violation when
   * this returns true (e.g. the exec rule requires a `child_process` callee).
   * Omitted rules match by name alone.
   */
  readonly receiverGuard?: (node: ts.CallExpression) => boolean;
}

function checkUnsanitizedCallArgs(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  rule: UnsanitizedCallRule,
): CheckViolation | null {
  const { functionNames, message, suggestion, receiverGuard } = rule;
  const functionName = getCallFunctionName(node);
  if (!functionNames.has(functionName)) return null;
  if (receiverGuard && !receiverGuard(node)) return null;
  /* v8 ignore next -- defensive AST/type guard */
  if (isInStringOrRegex(node)) return null;
  for (const arg of node.arguments) {
    if (referencesUserInput(arg)) {
      return {
        line: getLineNumber(node, sourceFile),
        column: 0,
        message,
        severity: 'error',
        suggestion,
        match: truncateMatch(node),
        filePath,
      };
    }
  }
  return null;
}

function checkHtmlTemplateInterpolation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation | null {
  if (!ts.isTemplateExpression(node)) return null;
  if (!/^\s*<[a-zA-Z]/.test(node.head.text)) return null;
  for (const span of node.templateSpans) {
    if (referencesUserInput(span.expression)) {
      return {
        line: getLineNumber(node, sourceFile),
        column: 0,
        message: 'Unsanitized user input in HTML template - use html-escaper',
        severity: 'error',
        suggestion:
          'Use html-escaper or DOMPurify to sanitize user input before inserting into HTML: import { escape } from "html-escaper"; const safeHtml = escape(userInput);',
        match: truncateMatch(node),
        filePath,
      };
    }
  }
  return null;
}

/**
 * Check: security/input-sanitization
 *
 * Detects user input used without proper sanitization using AST analysis.
 * Walks the AST to find actual innerHTML assignments, exec/spawn calls,
 * and file operations with user input references.
 *
 *
 */
export const inputSanitization = defineCheck({
  id: '31ef5173-a102-4a37-bc14-3f5bb08f9688',
  slug: 'input-sanitization',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  // 'raw', not 'strip-strings': checkHtmlTemplateInterpolation classifies a
  // template as "HTML" by testing the head.text prefix (/^\s*<[a-zA-Z]/). Under
  // strip-strings the head content is blanked, so all such templates would be
  // silently ignored. The main sinks use AST expression walks (unaffected).
  contentFilter: 'raw',
  description: 'Detect unsanitized user input usage',
  longDescription: `**Purpose:** Detects user input from request objects (req.body, req.params, req.query) flowing unsanitized into dangerous sinks, using AST analysis to avoid false positives.

**Detects:**
- innerHTML assignments with user input: \`element.innerHTML = req.body.content\`
- \`dangerouslySetInnerHTML\` JSX attribute usage
- User input passed to shell commands: \`exec()\`, \`execSync()\`, \`spawn()\`, \`spawnSync()\`, \`execFile()\`, \`execFileSync()\`
- User input in file system operations: \`readFile()\`, \`writeFile()\`, \`unlink()\`, etc. (path traversal)
- User input interpolated into HTML template literals: \`\`<div>\${req.body.name}</div>\`\`

**Why it matters:** Unsanitized user input leads to XSS, command injection, and path traversal vulnerabilities. AST-level detection catches real data flow issues while ignoring string constants and comments.

**Scope:** General best practice. Analyzes each file individually using TypeScript AST.`,
  tags: ['security', 'injection', 'sanitization'],
  fileTypes: ['ts'],
  confidence: 'high',

  analyze(content: string, filePath: string): CheckViolation[] {
    const sourceFile = parseSource(content, filePath);
    /* v8 ignore next -- defensive guard */
    if (!sourceFile) return [];

    const violations: CheckViolation[] = [];
    const childProcessGuard = makeChildProcessGuard(collectChildProcessBindings(sourceFile));

    walkNodes(sourceFile, (node) => {
      const innerHtml = checkInnerHtmlAssignment(node, sourceFile, filePath);
      if (innerHtml) {
        violations.push(innerHtml);
        return;
      }

      const dangerousHtml = checkDangerouslySetInnerHTML(node, sourceFile, filePath);
      if (dangerousHtml) {
        violations.push(dangerousHtml);
        return;
      }

      if (ts.isCallExpression(node)) {
        const cmdInjection = checkUnsanitizedCallArgs(node, sourceFile, filePath, {
          functionNames: EXEC_FUNCTIONS,
          message: 'User input passed to shell command - potential command injection',
          suggestion:
            'Never pass user input directly to shell commands. Use execFile with separate arguments array, or validate input against a strict allowlist. Consider using child_process.spawn with shell: false.',
          receiverGuard: childProcessGuard,
        });
        if (cmdInjection) {
          violations.push(cmdInjection);
          return;
        }

        const pathTraversal = checkUnsanitizedCallArgs(node, sourceFile, filePath, {
          functionNames: FS_FUNCTIONS,
          message: 'User input in file path - potential path traversal vulnerability',
          suggestion:
            'Validate file paths with path.resolve and ensure they stay within allowed directories: const safePath = path.resolve(baseDir, userInput); if (!safePath.startsWith(baseDir)) throw new TypeError("Invalid path");',
        });
        if (pathTraversal) {
          violations.push(pathTraversal);
          return;
        }
      }

      const htmlTemplate = checkHtmlTemplateInterpolation(node, sourceFile, filePath);
      if (htmlTemplate) {
        violations.push(htmlTemplate);
      }
    });

    return violations;
  },
});
