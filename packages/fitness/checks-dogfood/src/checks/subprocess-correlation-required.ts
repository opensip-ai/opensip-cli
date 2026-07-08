/**
 * @fileoverview Guard that every CLI worker spawn/fork forwards the RunCorrelation bag.
 *
 * The subprocess-correlation-telemetry spec (and ADR-0054 readiness) requires
 * that when the CLI spawns or forks a child CLI *worker* subcommand (e.g.
 * `graph-shard-worker`, `graph-run-worker`, any future `*-run-worker`), the
 * parent forwards its {@link RunCorrelation} bag so a child failure is
 * attributable to the parent run/trace from JSONL logs alone. `runId` travels
 * via `OPENSIP_RUN_ID` env (merged through `correlationToEnv`); the rest travels
 * via env + the worker spec/descriptor's `correlation` field.
 *
 * This check fires on a spawn/fork of a `*-worker` subcommand that forwards env
 * (so it clearly inherits the parent environment) but does NOT reference
 * `correlationToEnv` or write a `correlation` field anywhere in the enclosing
 * function — i.e. the parent forgot to carry correlation. It is bounded to the
 * two host packages that own real worker spawn/fork sites (`packages/graph` and
 * `packages/cli`); the generic fork transport (`packages/core`) is out of scope
 * by design.
 */
// @fitness-ignore-file shipped-checks-must-be-generic -- dogfood check for this repo's subprocess-correlation-telemetry migration boundary; AST precision keeps the worker-spawn correlation requirement mechanically narrow.
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-cli/fitness';
import { getSharedSourceFile } from '@opensip-cli/lang-typescript';
import * as ts from 'typescript';

/** Host packages that own real CLI worker spawn/fork sites. */
const GATED_PATHS = ['packages/graph/', 'packages/cli/'];

/** The child-process primitives a worker is launched through. */
const SPAWN_CALLEES = new Set(['spawn', 'fork']);

/**
 * A CLI worker subcommand is named `<tool>-...-worker` (`graph-shard-worker`,
 * `graph-run-worker`, future `*-run-worker`). The plain `graph` subcommand
 * spawn (workspace fan-out) and a same-process re-exec (`process.argv.slice(1)`,
 * heap preflight) are deliberately NOT worker subcommands — they carry no
 * literal `*-worker` argv string and so are not matched.
 */
const WORKER_SUBCOMMAND_SUFFIX = '-worker';

/** Evidence that correlation is being forwarded into the child. */
const CORRELATION_TO_ENV = 'correlationToEnv';
const CORRELATION_PROP = 'correlation';

function normalized(path: string): string {
  return path.replaceAll('\\', '/');
}

function isGatedFile(filePath: string): boolean {
  const p = normalized(filePath);
  return GATED_PATHS.some((prefix) => p.includes(prefix));
}

/** A string literal (`'graph-shard-worker'`) whose text matches `*-worker`. */
function isWorkerSubcommandLiteral(node: ts.Node): boolean {
  return (
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    node.text.endsWith(WORKER_SUBCOMMAND_SUFFIX)
  );
}

/** True when any descendant of `node` is a `*-worker` subcommand string. */
function referencesWorkerSubcommand(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isWorkerSubcommandLiteral(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** True when any descendant references `correlationToEnv` or a `correlation` key/property. */
function referencesCorrelation(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === CORRELATION_TO_ENV) {
      found = true;
      return;
    }
    // A `correlation:` property assignment / shorthand on the spec or descriptor.
    if (
      (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
      ts.isIdentifier(n.name) &&
      n.name.text === CORRELATION_PROP
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Walk outward to the nearest enclosing function/method body (the spawn site's scope). */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** Callee identifier text of a call expression, if the callee is a bare identifier. */
function calleeName(call: ts.CallExpression): string | undefined {
  return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

/**
 * Pure analysis over a parsed source file. Exported for unit tests. Returns one
 * error per spawn/fork of a CLI `*-worker` subcommand whose enclosing function
 * shows no correlation forwarding.
 */
export function analyzeSubprocessCorrelationRequired(
  content: string,
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const sourceFile = getSharedSourceFile(filePath, content);
  if (!sourceFile) return violations;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      if (callee !== undefined && SPAWN_CALLEES.has(callee)) {
        // Only worker subcommand spawns/forks carry the correlation requirement;
        // a plain `graph` subcommand spawn or a same-process re-exec is exempt.
        const isWorkerLaunch = node.arguments.some((arg) => referencesWorkerSubcommand(arg));
        if (isWorkerLaunch) {
          const scope = enclosingFunction(node) ?? sourceFile;
          if (!referencesCorrelation(scope)) {
            const line =
              sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
            violations.push({
              message:
                `CLI worker spawn/fork in ${normalized(filePath)} forwards env to a child worker ` +
                `subcommand but does not forward the RunCorrelation bag — a child failure cannot be ` +
                `attributed to the parent run.`,
              severity: 'error',
              line,
              suggestion:
                'Merge correlationToEnv(currentScope()?.correlation) into the child env and write ' +
                'the correlation onto the spec/descriptor (subprocess-correlation-telemetry spec).',
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

export const subprocessCorrelationRequired = defineCheck({
  id: '822a0ca0-2c29-467b-9286-b2d3798b3810',
  slug: 'subprocess-correlation-required',
  description:
    'CLI subprocess spawn/fork sites must forward the RunCorrelation bag (runId via env, other fields via env+spec) so child failures are attributable',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  analyze: (content, filePath) => {
    if (!isGatedFile(filePath) || isTestFile(filePath)) return [];
    return analyzeSubprocessCorrelationRequired(content, filePath);
  },
});
