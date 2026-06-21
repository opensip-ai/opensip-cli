/**
 * @fileoverview Tool command handlers must let the host own output and exit.
 *
 * A Tool plugin declares its commands as `CommandSpec`s via `defineCommand({...})`
 * and the host mounts them — owning rendering, `--json`, and the exit code. The
 * handler receives a host context (`cli`) and must route its results through that
 * seam: it returns a result/envelope and (when it must influence the exit) calls
 * `cli.setExitCode(...)`. A handler that writes run output straight to stdout
 * (`process.stdout.write` / `console.log`), or terminates the process itself
 * (`process.exit`), bypasses the host: the output never reaches a formatter, never
 * honours `--json`, and the process can exit before pending delivery drains.
 *
 * The escape hatch is DECLARED, not implicit: a command that genuinely owns its
 * own output surface (a completion script, a file export, subprocess IPC) sets
 * `output: 'raw-stream'` with a `rawStreamReason`. This check therefore fires only
 * inside a `defineCommand({...})` whose `output` is NOT `'raw-stream'` — exactly
 * where the host-owned-output contract applies. It is generic: it keys on the
 * public command-authoring vocabulary every tool author uses, with no host path
 * gating, so an adopter's own `fit` run enforces the same seam.
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/** The command-authoring factory whose specs the host mounts. */
const DEFINE_COMMAND = 'defineCommand';

/** The declared escape hatch: the handler owns its own output surface. */
const RAW_STREAM = 'raw-stream';

/** Output channels the host owns — a non-raw-stream handler must not write them itself. */
const FORBIDDEN_CALLS: readonly {
  readonly chain: readonly string[];
  readonly label: string;
}[] = [
  { chain: ['process', 'stdout', 'write'], label: 'process.stdout.write' },
  { chain: ['console', 'log'], label: 'console.log' },
  { chain: ['console', 'info'], label: 'console.info' },
  { chain: ['console', 'debug'], label: 'console.debug' },
  { chain: ['process', 'exit'], label: 'process.exit' },
];

function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** The string value of a property assignment whose initializer is a string literal. */
function stringPropValue(obj: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    if (propertyNameText(prop.name) !== key) continue;
    if (ts.isStringLiteral(prop.initializer)) return prop.initializer.text;
  }
  return undefined;
}

/** The handler initializer (arrow / function) of a `defineCommand` object literal. */
function handlerBody(obj: ts.ObjectLiteralExpression): ts.Node | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propertyNameText(prop.name) === 'handler') {
      const init = prop.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
    }
    if (
      ts.isMethodDeclaration(prop) &&
      propertyNameText(prop.name) === 'handler' &&
      prop.body !== undefined
    ) {
      return prop.body;
    }
  }
  return undefined;
}

/** The dotted property chain of a call's callee (`process.stdout.write` → ['process','stdout','write']). */
function calleeChain(expr: ts.Expression): string[] | undefined {
  const parts: string[] = [];
  let node: ts.Expression = expr;
  while (ts.isPropertyAccessExpression(node)) {
    parts.unshift(node.name.text);
    node = node.expression;
  }
  if (!ts.isIdentifier(node)) return undefined;
  parts.unshift(node.text);
  return parts;
}

function chainEquals(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((part, i) => part === expected[i]);
}

/** Find each forbidden host-owned-output call within a handler body subtree. */
function findForbiddenCalls(
  body: ts.Node,
  sourceFile: ts.SourceFile,
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const chain = calleeChain(node.expression);
      if (chain) {
        for (const { chain: forbidden, label } of FORBIDDEN_CALLS) {
          if (chainEquals(chain, forbidden)) {
            const line =
              sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            violations.push({
              filePath,
              line,
              message:
                `Command handler calls ${label} directly. A tool command lets the host own ` +
                `rendering, --json, and the exit code — the handler returns its result and ` +
                `routes output/exit through the host context (cli.render / cli.emitJson / ` +
                `cli.emitEnvelope / cli.setExitCode). Direct stdout/exit bypasses that seam.`,
              severity: 'error',
              suggestion:
                `Return the command result (or a SignalEnvelope) and use the cli context to ` +
                `emit and set the exit code. If this command genuinely owns its own output ` +
                `surface (completion script, file export, subprocess IPC), declare ` +
                `output: 'raw-stream' with a rawStreamReason instead.`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return violations;
}

/** Pure analysis over a parsed source file. Exported for unit tests. */
export function analyzeCommandHandlerHostOwnedOutput(
  content: string,
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === DEFINE_COMMAND &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0];
      if (ts.isObjectLiteralExpression(arg)) {
        const output = stringPropValue(arg, 'output');
        // A raw-stream command DECLARES that it owns its own output surface.
        if (output !== RAW_STREAM) {
          const body = handlerBody(arg);
          if (body) violations.push(...findForbiddenCalls(body, sourceFile, filePath));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export const commandHandlerHostOwnedOutput = defineCheck({
  id: 'c1f4a2e7-6b83-4d59-9e0a-2f7c4b8d1a36',
  slug: 'command-handler-host-owned-output',
  description:
    'A tool command handler must let the host own rendering and exit — no direct stdout/console/process.exit inside a non-raw-stream defineCommand handler',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content, filePath) => {
    if (isTestFile(filePath)) return [];
    // Cheap pre-filter: only files that author a command can violate the rule.
    if (!content.includes(DEFINE_COMMAND)) return [];
    return analyzeCommandHandlerHostOwnedOutput(content, normalized(filePath));
  },
});
